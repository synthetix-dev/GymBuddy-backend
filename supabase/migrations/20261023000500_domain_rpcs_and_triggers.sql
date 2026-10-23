-- =============================================================================
-- Migration 005: Triggers, Counter Maintenance & Transactional Domain RPCs
-- =============================================================================

-- 1. Automatic updated_at timestamp trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gyms', 'user_profiles', 'user_settings', 'media_objects', 'user_photos',
    'user_locations', 'user_relationships', 'posts', 'recipes', 'comments',
    'conversations', 'conversation_members', 'workout_sessions',
    'session_participants', 'workout_invitations', 'message_read_states',
    'push_devices', 'admin_users', 'reports', 'moderation_cases', 'account_deletions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
      t, t
    );
  END LOOP;
END
$$;

-- 2. Sync PostGIS geography point automatically when PostGIS is installed
CREATE OR REPLACE FUNCTION public.sync_location_point()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'user_locations' THEN
    NEW.coarse_geohash := public.gb_coarse_geohash(NEW.latitude, NEW.longitude);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_locations_sync_geo ON public.user_locations;
CREATE TRIGGER trg_user_locations_sync_geo
  BEFORE INSERT OR UPDATE ON public.user_locations
  FOR EACH ROW EXECUTE FUNCTION public.sync_location_point();

-- 3. Atomic Post Counters Maintenance (Likes, Saves, Comments) + Reconcile Job RPC
CREATE OR REPLACE FUNCTION public.maintain_post_likes_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_likes_count ON public.post_likes;
CREATE TRIGGER trg_post_likes_count
  AFTER INSERT OR DELETE ON public.post_likes
  FOR EACH ROW EXECUTE FUNCTION public.maintain_post_likes_count();

CREATE OR REPLACE FUNCTION public.maintain_saved_posts_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET saves_count = saves_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET saves_count = GREATEST(0, saves_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_posts_count ON public.saved_posts;
CREATE TRIGGER trg_saved_posts_count
  AFTER INSERT OR DELETE ON public.saved_posts
  FOR EACH ROW EXECUTE FUNCTION public.maintain_saved_posts_count();

CREATE OR REPLACE FUNCTION public.maintain_comments_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' AND NEW.deleted_at IS NULL THEN
    UPDATE public.posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (OLD.deleted_at IS NULL AND OLD.status = 'published')
       AND (NEW.deleted_at IS NOT NULL OR NEW.status <> 'published') THEN
      UPDATE public.posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = NEW.post_id;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.deleted_at IS NULL AND OLD.status = 'published' THEN
    UPDATE public.posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_comments_count ON public.comments;
CREATE TRIGGER trg_comments_count
  AFTER INSERT OR UPDATE OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.maintain_comments_count();

-- Reconcile Post Counters RPC (detects and fixes any drift)
CREATE OR REPLACE FUNCTION public.reconcile_post_counters()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  fixed_rows integer := 0;
BEGIN
  WITH computed AS (
    SELECT
      p.id,
      (SELECT count(*)::bigint FROM public.post_likes pl WHERE pl.post_id = p.id) AS real_likes,
      (SELECT count(*)::bigint FROM public.saved_posts sp WHERE sp.post_id = p.id) AS real_saves,
      (SELECT count(*)::bigint FROM public.comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL AND c.status = 'published') AS real_comments
    FROM public.posts p
  ),
  updated AS (
    UPDATE public.posts p
    SET
      likes_count = c.real_likes,
      saves_count = c.real_saves,
      comments_count = c.real_comments
    FROM computed c
    WHERE p.id = c.id
      AND (p.likes_count <> c.real_likes OR p.saves_count <> c.real_saves OR p.comments_count <> c.real_comments)
    RETURNING p.id
  )
  SELECT count(*)::integer INTO fixed_rows FROM updated;

  RETURN fixed_rows;
END;
$$;

-- 4. Canonical 1:1 Direct Conversation Key Helper
CREATE OR REPLACE FUNCTION public.compute_direct_key(user_a uuid, user_b uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN user_a::text < user_b::text
    THEN 'dm:' || user_a::text || ':' || user_b::text
    ELSE 'dm:' || user_b::text || ':' || user_a::text
  END;
$$;

-- 5. Bilateral Block Execution RPC (11-SECURITY-PRIVACY.md, 07-DISCOVER-WORKOUTS.md)
-- Inserts block, removes relationships, marks 1:1 conversation blocked, revokes pending invitations, cancels 1:1 sessions
CREATE OR REPLACE FUNCTION public.execute_block_user_rpc(
  p_blocker_id uuid,
  p_blocked_id uuid,
  p_reason_code text,
  p_request_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_direct_key text;
  v_session_id uuid;
BEGIN
  IF p_blocker_id = p_blocked_id THEN
    RAISE EXCEPTION 'CANNOT_BLOCK_SELF';
  END IF;

  INSERT INTO public.blocked_users (blocker_id, blocked_id, reason_code)
  VALUES (p_blocker_id, p_blocked_id, COALESCE(NULLIF(p_reason_code, ''), 'user_initiated'))
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  -- Remove bilateral social/discover relationships
  DELETE FROM public.user_relationships
  WHERE (actor_id = p_blocker_id AND target_id = p_blocked_id)
     OR (actor_id = p_blocked_id AND target_id = p_blocker_id);

  -- Mark direct conversation blocked
  v_direct_key := public.compute_direct_key(p_blocker_id, p_blocked_id);
  UPDATE public.conversations
  SET status = 'blocked', updated_at = now()
  WHERE direct_key = v_direct_key;

  -- Revoke any pending workout invitations between the pair
  UPDATE public.workout_invitations
  SET status = 'revoked', responded_at = now(), version = version + 1
  WHERE status = 'pending'
    AND ((inviter_id = p_blocker_id AND invitee_id = p_blocked_id)
      OR (inviter_id = p_blocked_id AND invitee_id = p_blocker_id));

  -- Cancel 1:1 future workout sessions where both are participants/creator
  FOR v_session_id IN
    SELECT ws.id
    FROM public.workout_sessions ws
    WHERE ws.status IN ('draft', 'scheduled', 'reschedule_pending')
      AND ws.capacity = 2
      AND (
        (ws.creator_id = p_blocker_id AND EXISTS (
          SELECT 1 FROM public.session_participants sp WHERE sp.session_id = ws.id AND sp.user_id = p_blocked_id
        ))
        OR
        (ws.creator_id = p_blocked_id AND EXISTS (
          SELECT 1 FROM public.session_participants sp WHERE sp.session_id = ws.id AND sp.user_id = p_blocker_id
        ))
      )
    FOR UPDATE
  LOOP
    UPDATE public.workout_sessions
    SET status = 'cancelled', cancelled_at = now(), version = version + 1
    WHERE id = v_session_id;
  END LOOP;

  -- Audit log
  INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
  VALUES ('user', p_blocker_id, 'user.blocked', 'user_profile', p_blocked_id::text, p_request_id);
END;
$$;

-- 6. Supabase Auth User Provisioning Trigger:
--    auth.users INSERT -> public.user_profiles INSERT -> public.user_settings INSERT
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_public_code text;
  v_display_name text;
BEGIN
  v_public_code := 'GB' || upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 10));
  v_display_name := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'display_name'), ''),
    'GymBuddy Athlete'
  );
  v_display_name := left(v_display_name, 80);

  INSERT INTO public.user_profiles (
    user_id,
    public_code,
    display_name,
    birth_date,
    onboarding_state,
    account_status
  ) VALUES (
    NEW.id,
    v_public_code,
    v_display_name,
    DATE '2000-01-01',
    'profile_required',
    'active'
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- 7. Backup Restore Suppression RPC (11-SECURITY-PRIVACY.md, 14-TESTING-STRATEGY.md)
-- Ensures any user with a completed account_deletion record is re-erased if a backup restore brings them back
CREATE OR REPLACE FUNCTION public.suppress_restored_deleted_accounts_rpc()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_del RECORD;
  v_suppressed integer := 0;
BEGIN
  FOR v_del IN
    SELECT DISTINCT ad.user_id
    FROM public.account_deletions ad
    JOIN public.user_profiles up ON up.user_id = ad.user_id
    WHERE ad.status = 'completed'
      AND (up.account_status <> 'deleted' OR up.deleted_at IS NULL)
  LOOP
    DELETE FROM public.user_locations WHERE user_id = v_del.user_id;
    DELETE FROM public.push_devices WHERE user_id = v_del.user_id;
    DELETE FROM public.notifications WHERE user_id = v_del.user_id;
    DELETE FROM public.saved_posts WHERE user_id = v_del.user_id;
    DELETE FROM public.user_interests WHERE user_id = v_del.user_id;

    UPDATE public.user_profiles
    SET
      display_name = 'Deleted User',
      bio = '',
      visibility = 'hidden',
      account_status = 'deleted',
      deleted_at = COALESCE(deleted_at, now()),
      version = version + 1
    WHERE user_id = v_del.user_id;

    v_suppressed := v_suppressed + 1;
  END LOOP;

  RETURN v_suppressed;
END;
$$;
