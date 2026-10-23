-- =============================================================================
-- Migration 004: Security-Definer Authorization Helpers, RLS Policies & Views
-- (03-DATABASE-DESIGN.md, 11-SECURITY-PRIVACY.md, ACCESS-MATRIX.md)
-- =============================================================================

-- 1. Is the account active and not deleted/suspended?
CREATE OR REPLACE FUNCTION public.is_active_account(target_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.user_id = target_uid
      AND up.account_status = 'active'
      AND up.deleted_at IS NULL
      AND (up.suspended_until IS NULL OR up.suspended_until <= now())
  );
$$;

-- 2. Bilateral Block Check (Symmetric: if A blocked B OR B blocked A -> true)
CREATE OR REPLACE FUNCTION public.is_blocked(user_a uuid, user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN user_a IS NULL OR user_b IS NULL THEN false
    WHEN user_a = user_b THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.blocked_users b
      WHERE (b.blocker_id = user_a AND b.blocked_id = user_b)
         OR (b.blocker_id = user_b AND b.blocked_id = user_a)
    )
  END;
$$;

-- 3. Are two users connected (or following)?
CREATE OR REPLACE FUNCTION public.are_connected(user_a uuid, user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN user_a IS NULL OR user_b IS NULL THEN false
    WHEN user_a = user_b THEN true
    ELSE EXISTS (
      SELECT 1
      FROM public.user_relationships r
      WHERE r.actor_id = user_a
        AND r.target_id = user_b
        AND r.type IN ('connect', 'follow')
    ) OR EXISTS (
      SELECT 1
      FROM public.user_relationships r
      WHERE r.actor_id = user_b
        AND r.target_id = user_a
        AND r.type = 'connect'
    )
  END;
$$;

-- 4. Can viewer see target's public profile?
CREATE OR REPLACE FUNCTION public.can_view_profile(viewer_id uuid, target_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN viewer_id IS NULL OR target_id IS NULL THEN false
    WHEN viewer_id = target_id THEN true
    WHEN NOT public.is_active_account(viewer_id) THEN false
    WHEN public.is_blocked(viewer_id, target_id) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.user_profiles tp
      WHERE tp.user_id = target_id
        AND tp.account_status = 'active'
        AND tp.deleted_at IS NULL
        AND (
          tp.visibility = 'discoverable'
          OR (tp.visibility = 'connections' AND public.are_connected(viewer_id, target_id))
        )
    )
  END;
$$;

-- 5. Can viewer read a given post?
CREATE OR REPLACE FUNCTION public.can_view_post(viewer_id uuid, p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN viewer_id IS NULL OR p_post_id IS NULL THEN false
    WHEN NOT public.is_active_account(viewer_id) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.posts p
      WHERE p.id = p_post_id
        AND p.deleted_at IS NULL
        AND (
          p.author_id = viewer_id
          OR (
            p.status = 'published'
            AND NOT public.is_blocked(viewer_id, p.author_id)
            AND public.can_view_profile(viewer_id, p.author_id)
            AND NOT EXISTS (
              SELECT 1 FROM public.hidden_posts hp
              WHERE hp.user_id = viewer_id AND hp.post_id = p.id
            )
            AND (
              p.visibility = 'community'
              OR (p.visibility = 'connections' AND public.are_connected(viewer_id, p.author_id))
            )
          )
        )
    )
  END;
$$;

-- 6. Is user an active conversation member (and not blocked by peer)?
CREATE OR REPLACE FUNCTION public.is_conversation_member(viewer_id uuid, p_conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN viewer_id IS NULL OR p_conv_id IS NULL THEN false
    WHEN NOT public.is_active_account(viewer_id) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.conversation_members cm
      WHERE cm.conversation_id = p_conv_id
        AND cm.user_id = viewer_id
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_members peer
      WHERE peer.conversation_id = p_conv_id
        AND peer.user_id <> viewer_id
        AND public.is_blocked(viewer_id, peer.user_id)
    )
  END;
$$;

-- 7. Is user authorized to view a workout session?
CREATE OR REPLACE FUNCTION public.can_view_workout_session(viewer_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN viewer_id IS NULL OR p_session_id IS NULL THEN false
    WHEN NOT public.is_active_account(viewer_id) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.workout_sessions ws
      WHERE ws.id = p_session_id
        AND NOT public.is_blocked(viewer_id, ws.creator_id)
        AND (
          ws.creator_id = viewer_id
          OR EXISTS (
            SELECT 1 FROM public.session_participants sp
            WHERE sp.session_id = ws.id AND sp.user_id = viewer_id
          )
          OR EXISTS (
            SELECT 1 FROM public.workout_invitations wi
            WHERE wi.session_id = ws.id AND (wi.invitee_id = viewer_id OR wi.inviter_id = viewer_id)
          )
        )
    )
  END;
$$;

-- 8. Admin RBAC + MFA Check
CREATE OR REPLACE FUNCTION public.has_admin_role(viewer_id uuid, allowed_roles public.admin_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN viewer_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.admin_users au
      WHERE au.user_id = viewer_id
        AND au.status = 'active'
        AND au.mfa_verified = true
        AND au.role = ANY(allowed_roles)
    )
  END;
$$;

-- Restrict execution of security-definer helpers to authenticated & service_role
REVOKE ALL ON FUNCTION public.is_active_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_blocked(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.are_connected(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_profile(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_post(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_conversation_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_workout_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_admin_role(uuid, public.admin_role[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_active_account(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.are_connected(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_post(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_conversation_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_workout_session(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_admin_role(uuid, public.admin_role[]) TO authenticated, service_role;

-- =============================================================================
-- Enable & Force Row Level Security on All Public Tables
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    -- PostGIS installs this extension-owned reference table in public. It is
    -- managed by Supabase/PostGIS, so the project role cannot change its RLS.
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> 'spatial_ref_sys'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Grant base table privileges to authenticated (filtered strictly by RLS) and service_role
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- =============================================================================
-- Row Level Security Policies (O/M/V/S/A per ACCESS-MATRIX.md)
-- =============================================================================

-- gyms & interests: public read for active authenticated users
DROP POLICY IF EXISTS gyms_select_policy ON public.gyms;
CREATE POLICY gyms_select_policy ON public.gyms
  FOR SELECT TO authenticated
  USING (public.is_active_account(auth.uid()));

DROP POLICY IF EXISTS interests_select_policy ON public.interests;
CREATE POLICY interests_select_policy ON public.interests
  FOR SELECT TO authenticated
  USING (active = true AND public.is_active_account(auth.uid()));

-- user_profiles: V read, O update
DROP POLICY IF EXISTS user_profiles_select_policy ON public.user_profiles;
CREATE POLICY user_profiles_select_policy ON public.user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_view_profile(auth.uid(), user_id));

DROP POLICY IF EXISTS user_profiles_update_policy ON public.user_profiles;
CREATE POLICY user_profiles_update_policy ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (user_id = auth.uid());

-- user_settings: strictly O only (never visible to other users!)
DROP POLICY IF EXISTS user_settings_owner_policy ON public.user_settings;
CREATE POLICY user_settings_owner_policy ON public.user_settings
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- user_interests: V read, O write
DROP POLICY IF EXISTS user_interests_select_policy ON public.user_interests;
CREATE POLICY user_interests_select_policy ON public.user_interests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_view_profile(auth.uid(), user_id));

DROP POLICY IF EXISTS user_interests_write_policy ON public.user_interests;
CREATE POLICY user_interests_write_policy ON public.user_interests
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_active_account(auth.uid()));

-- user_photos: V read, O write
DROP POLICY IF EXISTS user_photos_select_policy ON public.user_photos;
CREATE POLICY user_photos_select_policy ON public.user_photos
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (user_id = auth.uid() OR (status = 'ready' AND public.can_view_profile(auth.uid(), user_id)))
  );

DROP POLICY IF EXISTS user_photos_owner_write_policy ON public.user_photos;
CREATE POLICY user_photos_owner_write_policy ON public.user_photos
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_active_account(auth.uid()));

-- user_locations: strictly O only (exact point is NEVER readable by other users!)
DROP POLICY IF EXISTS user_locations_owner_policy ON public.user_locations;
CREATE POLICY user_locations_owner_policy ON public.user_locations
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_active_account(auth.uid()));

-- user_relationships: O only
DROP POLICY IF EXISTS user_relationships_owner_policy ON public.user_relationships;
CREATE POLICY user_relationships_owner_policy ON public.user_relationships
  FOR ALL TO authenticated
  USING (actor_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (actor_id = auth.uid() AND public.is_active_account(auth.uid()));

-- blocked_users: blocker sees own blocks
DROP POLICY IF EXISTS blocked_users_owner_policy ON public.blocked_users;
CREATE POLICY blocked_users_owner_policy ON public.blocked_users
  FOR ALL TO authenticated
  USING (blocker_id = auth.uid())
  WITH CHECK (blocker_id = auth.uid() AND blocker_id <> blocked_id);

-- posts: V read, O write
DROP POLICY IF EXISTS posts_select_policy ON public.posts;
CREATE POLICY posts_select_policy ON public.posts
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), id));

DROP POLICY IF EXISTS posts_owner_insert_policy ON public.posts;
CREATE POLICY posts_owner_insert_policy ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.is_active_account(auth.uid()));

DROP POLICY IF EXISTS posts_owner_update_policy ON public.posts;
CREATE POLICY posts_owner_update_policy ON public.posts
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (author_id = auth.uid());

-- post_media, recipes, recipe_ingredients, recipe_steps, workout_updates: inherit post visibility
DROP POLICY IF EXISTS post_media_select_policy ON public.post_media;
CREATE POLICY post_media_select_policy ON public.post_media
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS recipes_select_policy ON public.recipes;
CREATE POLICY recipes_select_policy ON public.recipes
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS recipe_ingredients_select_policy ON public.recipe_ingredients;
CREATE POLICY recipe_ingredients_select_policy ON public.recipe_ingredients
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), recipe_post_id));

DROP POLICY IF EXISTS recipe_steps_select_policy ON public.recipe_steps;
CREATE POLICY recipe_steps_select_policy ON public.recipe_steps
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), recipe_post_id));

DROP POLICY IF EXISTS workout_updates_select_policy ON public.workout_updates;
CREATE POLICY workout_updates_select_policy ON public.workout_updates
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), post_id));

-- post_likes: V read, O insert/delete when post is visible
DROP POLICY IF EXISTS post_likes_select_policy ON public.post_likes;
CREATE POLICY post_likes_select_policy ON public.post_likes
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS post_likes_insert_policy ON public.post_likes;
CREATE POLICY post_likes_insert_policy ON public.post_likes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS post_likes_delete_policy ON public.post_likes;
CREATE POLICY post_likes_delete_policy ON public.post_likes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- comments: V read, O insert/update
DROP POLICY IF EXISTS comments_select_policy ON public.comments;
CREATE POLICY comments_select_policy ON public.comments
  FOR SELECT TO authenticated
  USING (public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS comments_insert_policy ON public.comments;
CREATE POLICY comments_insert_policy ON public.comments
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS comments_update_policy ON public.comments;
CREATE POLICY comments_update_policy ON public.comments
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() AND public.is_active_account(auth.uid()))
  WITH CHECK (author_id = auth.uid());

-- saved_posts & hidden_posts: strictly O only
DROP POLICY IF EXISTS saved_posts_owner_policy ON public.saved_posts;
CREATE POLICY saved_posts_owner_policy ON public.saved_posts
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND public.can_view_post(auth.uid(), post_id));

DROP POLICY IF EXISTS hidden_posts_owner_policy ON public.hidden_posts;
CREATE POLICY hidden_posts_owner_policy ON public.hidden_posts
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- conversations, conversation_members, messages, message_attachments, message_read_states: M only
DROP POLICY IF EXISTS conversations_member_select_policy ON public.conversations;
CREATE POLICY conversations_member_select_policy ON public.conversations
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(auth.uid(), id));

DROP POLICY IF EXISTS conversation_members_select_policy ON public.conversation_members;
CREATE POLICY conversation_members_select_policy ON public.conversation_members
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(auth.uid(), conversation_id));

DROP POLICY IF EXISTS conversation_members_update_own_policy ON public.conversation_members;
CREATE POLICY conversation_members_update_own_policy ON public.conversation_members
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_member(auth.uid(), conversation_id))
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS messages_member_select_policy ON public.messages;
CREATE POLICY messages_member_select_policy ON public.messages
  FOR SELECT TO authenticated
  USING (
    public.is_conversation_member(auth.uid(), conversation_id)
    AND server_seq > COALESCE(
      (SELECT cm.hidden_before_seq FROM public.conversation_members cm
       WHERE cm.conversation_id = messages.conversation_id AND cm.user_id = auth.uid()),
      0
    )
  );

DROP POLICY IF EXISTS message_attachments_member_select_policy ON public.message_attachments;
CREATE POLICY message_attachments_member_select_policy ON public.message_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_attachments.message_id
        AND public.is_conversation_member(auth.uid(), m.conversation_id)
    )
  );

DROP POLICY IF EXISTS message_read_states_member_select_policy ON public.message_read_states;
CREATE POLICY message_read_states_member_select_policy ON public.message_read_states
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(auth.uid(), conversation_id));

DROP POLICY IF EXISTS message_read_states_owner_update_policy ON public.message_read_states;
CREATE POLICY message_read_states_owner_update_policy ON public.message_read_states
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.is_conversation_member(auth.uid(), conversation_id))
  WITH CHECK (user_id = auth.uid() AND public.is_conversation_member(auth.uid(), conversation_id));

-- workout_sessions, session_participants, workout_invitations: creator / participant / invitee
DROP POLICY IF EXISTS workout_sessions_select_policy ON public.workout_sessions;
CREATE POLICY workout_sessions_select_policy ON public.workout_sessions
  FOR SELECT TO authenticated
  USING (public.can_view_workout_session(auth.uid(), id));

DROP POLICY IF EXISTS workout_session_revisions_select_policy ON public.workout_session_revisions;
CREATE POLICY workout_session_revisions_select_policy ON public.workout_session_revisions
  FOR SELECT TO authenticated
  USING (public.can_view_workout_session(auth.uid(), session_id));

DROP POLICY IF EXISTS session_participants_select_policy ON public.session_participants;
CREATE POLICY session_participants_select_policy ON public.session_participants
  FOR SELECT TO authenticated
  USING (public.can_view_workout_session(auth.uid(), session_id));

DROP POLICY IF EXISTS workout_invitations_select_policy ON public.workout_invitations;
CREATE POLICY workout_invitations_select_policy ON public.workout_invitations
  FOR SELECT TO authenticated
  USING (
    (inviter_id = auth.uid() OR invitee_id = auth.uid())
    AND NOT public.is_blocked(inviter_id, invitee_id)
  );

-- media_objects & media_variants: owner or visible parent resource
DROP POLICY IF EXISTS media_objects_select_policy ON public.media_objects;
CREATE POLICY media_objects_select_policy ON public.media_objects
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      owner_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.user_photos up
        WHERE up.media_object_id = media_objects.id
          AND up.deleted_at IS NULL
          AND public.can_view_profile(auth.uid(), up.user_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.post_media pm
        WHERE pm.media_object_id = media_objects.id
          AND public.can_view_post(auth.uid(), pm.post_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.message_attachments ma
        JOIN public.messages m ON m.id = ma.message_id
        WHERE ma.media_object_id = media_objects.id
          AND public.is_conversation_member(auth.uid(), m.conversation_id)
      )
    )
  );

DROP POLICY IF EXISTS media_variants_select_policy ON public.media_variants;
CREATE POLICY media_variants_select_policy ON public.media_variants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.media_objects mo
      WHERE mo.id = media_variants.media_object_id
    )
  );

-- notifications: strictly O only
DROP POLICY IF EXISTS notifications_owner_policy ON public.notifications;
CREATE POLICY notifications_owner_policy ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_owner_update_policy ON public.notifications;
CREATE POLICY notifications_owner_update_policy ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- push_devices: O can see metadata (never raw token of others)
DROP POLICY IF EXISTS push_devices_owner_policy ON public.push_devices;
CREATE POLICY push_devices_owner_policy ON public.push_devices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- reports: reporter can read own report status; moderators can read assigned/open reports
DROP POLICY IF EXISTS reports_select_policy ON public.reports;
CREATE POLICY reports_select_policy ON public.reports
  FOR SELECT TO authenticated
  USING (
    reporter_id = auth.uid()
    OR public.has_admin_role(auth.uid(), ARRAY['moderator', 'safety_lead', 'super_admin']::public.admin_role[])
  );

-- account_deletions & account_exports: strictly O only
DROP POLICY IF EXISTS account_deletions_owner_policy ON public.account_deletions;
CREATE POLICY account_deletions_owner_policy ON public.account_deletions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS account_exports_owner_policy ON public.account_exports;
CREATE POLICY account_exports_owner_policy ON public.account_exports
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- audit_logs: auditor / safety_lead / super_admin read-only
DROP POLICY IF EXISTS audit_logs_auditor_select_policy ON public.audit_logs;
CREATE POLICY audit_logs_auditor_select_policy ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_admin_role(auth.uid(), ARRAY['auditor', 'safety_lead', 'super_admin']::public.admin_role[])
  );

-- system_announcements: active announcements readable by authenticated users
DROP POLICY IF EXISTS system_announcements_select_policy ON public.system_announcements;
CREATE POLICY system_announcements_select_policy ON public.system_announcements
  FOR SELECT TO authenticated
  USING (active = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()));

-- =============================================================================
-- Curated Privacy-Safe Projection View (Never exposes birth_date or exact coords)
-- =============================================================================

CREATE OR REPLACE VIEW public.public_profiles_v AS
SELECT
  up.user_id AS id,
  up.public_code,
  up.display_name,
  up.bio,
  up.gender_code,
  CASE
    WHEN us.show_age IS DISTINCT FROM false
    THEN EXTRACT(YEAR FROM age(CURRENT_DATE, up.birth_date))::int
    ELSE NULL
  END AS age_years,
  up.experience_level,
  up.preferred_time,
  up.home_gym_id,
  g.name AS home_gym_name,
  up.city_label,
  up.visibility,
  up.version,
  up.created_at
FROM public.user_profiles up
LEFT JOIN public.user_settings us ON us.user_id = up.user_id
LEFT JOIN public.gyms g ON g.id = up.home_gym_id
WHERE up.deleted_at IS NULL
  AND up.account_status = 'active';

GRANT SELECT ON public.public_profiles_v TO authenticated, service_role;
