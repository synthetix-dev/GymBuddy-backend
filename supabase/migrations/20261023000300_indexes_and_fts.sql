-- =============================================================================
-- Migration 003: Keyset Indexes, Partial Unique Constraints, Geo & FTS/Trigram
-- =============================================================================

-- User Profiles & Settings
CREATE INDEX IF NOT EXISTS user_profiles_display_name_trgm_idx
  ON public.user_profiles USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS user_profiles_discover_idx
  ON public.user_profiles (account_status, onboarding_state, visibility, preferred_time, experience_level)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS user_profiles_home_gym_idx
  ON public.user_profiles (home_gym_id)
  WHERE deleted_at IS NULL;

-- Gyms
CREATE INDEX IF NOT EXISTS gyms_name_trgm_idx
  ON public.gyms USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS gyms_coords_idx
  ON public.gyms (latitude, longitude);

-- User Interests
CREATE INDEX IF NOT EXISTS user_interests_interest_user_idx
  ON public.user_interests (interest_id, user_id);

-- User Photos (Partial unique: at most 1 active avatar per user)
CREATE UNIQUE INDEX IF NOT EXISTS user_photos_one_active_avatar_idx
  ON public.user_photos (user_id)
  WHERE is_avatar = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS user_photos_user_pos_idx
  ON public.user_photos (user_id, position)
  WHERE deleted_at IS NULL;

-- User Locations (Spatial B-Tree box + expiry + conditional PostGIS GiST)
CREATE INDEX IF NOT EXISTS user_locations_coords_expires_idx
  ON public.user_locations (expires_at, latitude, longitude);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS user_locations_point_gist_idx ON public.user_locations USING gist (point)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS gyms_point_gist_idx ON public.gyms USING gist (point)';
  END IF;
END
$$;

-- Relationships & Blocks
CREATE INDEX IF NOT EXISTS user_relationships_target_actor_idx
  ON public.user_relationships (target_id, actor_id, type);
CREATE INDEX IF NOT EXISTS blocked_users_reverse_idx
  ON public.blocked_users (blocked_id, blocker_id);

-- Posts & Full-Text Search (Generated tsvector + GIN)
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;

CREATE INDEX IF NOT EXISTS posts_feed_keyset_idx
  ON public.posts (published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_author_keyset_idx
  ON public.posts (author_id, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_search_tsv_gin_idx
  ON public.posts USING gin (search_tsv);

-- Recipes FTS & Trigram & Calories
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(subtitle, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS recipes_search_tsv_gin_idx
  ON public.recipes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS recipes_title_trgm_idx
  ON public.recipes USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS recipes_calories_idx
  ON public.recipes (calories, post_id);

-- Likes, Saves, Comments
CREATE INDEX IF NOT EXISTS post_likes_user_created_idx
  ON public.post_likes (user_id, created_at DESC, post_id DESC);
CREATE INDEX IF NOT EXISTS saved_posts_user_created_idx
  ON public.saved_posts (user_id, created_at DESC, post_id DESC);
CREATE INDEX IF NOT EXISTS comments_post_created_keyset_idx
  ON public.comments (post_id, created_at ASC, id ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS comments_parent_idx
  ON public.comments (parent_id, created_at ASC)
  WHERE parent_id IS NOT NULL;

-- Conversations & Messages
CREATE INDEX IF NOT EXISTS conversations_last_msg_keyset_idx
  ON public.conversations (last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx
  ON public.conversation_members (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS messages_conv_seq_desc_idx
  ON public.messages (conversation_id, server_seq DESC);
CREATE INDEX IF NOT EXISTS messages_conv_seq_asc_idx
  ON public.messages (conversation_id, server_seq ASC);

-- Workout Sessions & Invitations
CREATE INDEX IF NOT EXISTS workout_sessions_creator_starts_idx
  ON public.workout_sessions (creator_id, starts_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS workout_sessions_status_starts_idx
  ON public.workout_sessions (status, starts_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS session_participants_user_status_idx
  ON public.session_participants (user_id, status, session_id);

-- Partial unique index: at most 1 active pending invitation per (session_id, invitee_id)
CREATE UNIQUE INDEX IF NOT EXISTS workout_invitations_active_unique_idx
  ON public.workout_invitations (session_id, invitee_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workout_invitations_invitee_status_idx
  ON public.workout_invitations (invitee_id, status, created_at DESC);

-- Media Objects
CREATE INDEX IF NOT EXISTS media_objects_owner_status_idx
  ON public.media_objects (owner_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Notifications & Push Devices
CREATE INDEX IF NOT EXISTS notifications_user_created_keyset_idx
  ON public.notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS push_devices_user_active_idx
  ON public.push_devices (user_id)
  WHERE revoked_at IS NULL;

-- Reports, Cases & Audit Logs
CREATE UNIQUE INDEX IF NOT EXISTS reports_active_dedupe_idx
  ON public.reports (reporter_id, target_type, target_id)
  WHERE status IN ('new', 'triaged', 'investigating');
CREATE INDEX IF NOT EXISTS reports_status_created_idx
  ON public.reports (status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS moderation_cases_status_severity_idx
  ON public.moderation_cases (status, severity DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx
  ON public.audit_logs (created_at DESC, id DESC);

-- Outbox, Idempotency, Deletions, Exports
CREATE INDEX IF NOT EXISTS outbox_events_claim_idx
  ON public.outbox_events (available_at ASC, id ASC)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
  ON public.idempotency_keys (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS account_deletions_one_pending_idx
  ON public.account_deletions (user_id)
  WHERE status IN ('requested', 'cooling_off', 'processing');
CREATE UNIQUE INDEX IF NOT EXISTS account_exports_one_pending_idx
  ON public.account_exports (user_id)
  WHERE status IN ('requested', 'processing');
