-- =============================================================================
-- Migration 002: Complete Relational Schema (03-DATABASE-DESIGN.md)
-- =============================================================================

-- 1. Gyms catalog
CREATE TABLE IF NOT EXISTS public.gyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  city text NOT NULL DEFAULT 'Kyiv' CHECK (char_length(city) BETWEEN 1 AND 80),
  address text NOT NULL CHECK (char_length(address) BETWEEN 1 AND 250),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Interests catalog
CREATE TABLE IF NOT EXISTS public.interests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_]{2,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  category text NOT NULL DEFAULT 'fitness' CHECK (char_length(category) BETWEEN 1 AND 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. User Profiles (Aggregate Root for Identity/Profile)
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  public_code text NOT NULL UNIQUE CHECK (public_code ~ '^[A-Z0-9]{10,16}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  birth_date date NOT NULL CHECK (birth_date <= (CURRENT_DATE - INTERVAL '18 years') AND birth_date >= DATE '1900-01-01'),
  gender_code text NOT NULL DEFAULT 'prefer_not_to_say' CHECK (gender_code IN ('male', 'female', 'non_binary', 'other', 'prefer_not_to_say')),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  experience_level public.experience_level NOT NULL DEFAULT 'intermediate',
  home_gym_id uuid REFERENCES public.gyms(id) ON DELETE SET NULL,
  city_label text NOT NULL DEFAULT 'Kyiv' CHECK (char_length(city_label) <= 80),
  preferred_time public.preferred_workout_time NOT NULL DEFAULT 'flexible',
  visibility public.profile_visibility NOT NULL DEFAULT 'discoverable',
  onboarding_state public.onboarding_state NOT NULL DEFAULT 'profile_required',
  account_status public.account_status NOT NULL DEFAULT 'active',
  interaction_limited_until timestamptz,
  suspended_until timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 4. User Settings
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  discovery_radius_km integer NOT NULL DEFAULT 15 CHECK (discovery_radius_km BETWEEN 1 AND 100),
  discovery_visible boolean NOT NULL DEFAULT true,
  discover_gender_filter text NOT NULL DEFAULT 'any' CHECK (discover_gender_filter IN ('any', 'male', 'female', 'non_binary')),
  discover_min_age integer NOT NULL DEFAULT 18 CHECK (discover_min_age BETWEEN 18 AND 99),
  discover_max_age integer NOT NULL DEFAULT 65 CHECK (discover_max_age BETWEEN 18 AND 99 AND discover_max_age >= discover_min_age),
  show_age boolean NOT NULL DEFAULT true,
  show_distance boolean NOT NULL DEFAULT true,
  show_online_status boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT true,
  push_messages boolean NOT NULL DEFAULT true,
  push_message_preview boolean NOT NULL DEFAULT false,
  push_workouts boolean NOT NULL DEFAULT true,
  push_social boolean NOT NULL DEFAULT true,
  quiet_hours_start time,
  quiet_hours_end time,
  locale text NOT NULL DEFAULT 'en-US' CHECK (char_length(locale) BETWEEN 2 AND 16),
  timezone text NOT NULL DEFAULT 'Europe/Kyiv' CHECK (char_length(timezone) BETWEEN 2 AND 64),
  analytics_opt_in boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. User Interests (Many-to-Many)
CREATE TABLE IF NOT EXISTS public.user_interests (
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  interest_id uuid NOT NULL REFERENCES public.interests(id) ON DELETE CASCADE,
  proficiency public.experience_level NOT NULL DEFAULT 'intermediate',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, interest_id)
);

-- 7. Media Objects (Private Storage Metadata)
CREATE TABLE IF NOT EXISTS public.media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('avatar', 'profile_photo', 'post_image', 'message_attachment')),
  bucket text NOT NULL CHECK (bucket IN ('profile-originals', 'post-originals', 'message-attachments', 'media-variants')),
  object_path text NOT NULL CHECK (char_length(object_path) BETWEEN 5 AND 512),
  declared_mime text NOT NULL CHECK (declared_mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/webp')),
  sniffed_mime text CHECK (sniffed_mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
  sha256_hex text NOT NULL CHECK (sha256_hex ~ '^[a-f0-9]{64}$'),
  width integer CHECK (width IS NULL OR (width BETWEEN 1 AND 12000)),
  height integer CHECK (height IS NULL OR (height BETWEEN 1 AND 12000)),
  exif_stripped boolean NOT NULL DEFAULT false,
  status public.media_status NOT NULL DEFAULT 'upload_pending',
  visibility public.media_visibility NOT NULL DEFAULT 'private',
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (bucket, object_path)
);

-- 8. Media Variants (Thumbnails / Optimized WebP/JPEG sizes)
CREATE TABLE IF NOT EXISTS public.media_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_object_id uuid NOT NULL REFERENCES public.media_objects(id) ON DELETE CASCADE,
  variant_name text NOT NULL CHECK (variant_name IN ('thumb_256', 'medium_1024', 'full_2048')),
  bucket text NOT NULL DEFAULT 'media-variants',
  object_path text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/jpeg')),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_object_id, variant_name)
);

-- 9. User Photos
CREATE TABLE IF NOT EXISTS public.user_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  media_object_id uuid NOT NULL REFERENCES public.media_objects(id) ON DELETE RESTRICT,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9),
  is_avatar boolean NOT NULL DEFAULT false,
  status public.media_status NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 10. User Locations (Private exact coordinates + 30-day TTL, never exposed directly)
CREATE TABLE IF NOT EXISTS public.user_locations (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
  coarse_geohash text NOT NULL,
  accuracy_m integer NOT NULL DEFAULT 50 CHECK (accuracy_m BETWEEN 0 AND 10000),
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add PostGIS geography column if PostGIS is installed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS point geography(Point, 4326)';
    EXECUTE 'ALTER TABLE public.gyms ADD COLUMN IF NOT EXISTS point geography(Point, 4326)';
  END IF;
END
$$;

-- 11. User Relationships (Discover pass, connect, follow, hide)
CREATE TABLE IF NOT EXISTS public.user_relationships (
  actor_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  type public.relationship_type NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, target_id, type),
  CONSTRAINT user_relationships_no_self CHECK (actor_id <> target_id)
);

-- 12. Blocked Users (Bilateral Safety Exclusion)
CREATE TABLE IF NOT EXISTS public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  reason_code text NOT NULL DEFAULT 'user_initiated' CHECK (char_length(reason_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocked_users_no_self CHECK (blocker_id <> blocked_id)
);

-- 13. Posts (Social Feed Aggregate Root)
CREATE TABLE IF NOT EXISTS public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  type public.post_type NOT NULL,
  status public.post_status NOT NULL DEFAULT 'published',
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  visibility public.post_visibility NOT NULL DEFAULT 'community',
  likes_count bigint NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  comments_count bigint NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  saves_count bigint NOT NULL DEFAULT 0 CHECK (saves_count >= 0),
  published_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 14. Post Media
CREATE TABLE IF NOT EXISTS public.post_media (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  media_object_id uuid NOT NULL REFERENCES public.media_objects(id) ON DELETE RESTRICT,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 3),
  alt_text text NOT NULL DEFAULT '' CHECK (char_length(alt_text) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, media_object_id),
  UNIQUE (post_id, position)
);

-- 15. Recipes (Subtype of Posts)
CREATE TABLE IF NOT EXISTS public.recipes (
  post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  subtitle text NOT NULL DEFAULT '' CHECK (char_length(subtitle) <= 200),
  difficulty public.recipe_difficulty NOT NULL DEFAULT 'medium',
  calories integer NOT NULL CHECK (calories BETWEEN 0 AND 10000),
  protein_g integer NOT NULL DEFAULT 0 CHECK (protein_g BETWEEN 0 AND 1000),
  carbs_g integer NOT NULL DEFAULT 0 CHECK (carbs_g BETWEEN 0 AND 1000),
  fat_g integer NOT NULL DEFAULT 0 CHECK (fat_g BETWEEN 0 AND 1000),
  prep_minutes integer NOT NULL DEFAULT 15 CHECK (prep_minutes BETWEEN 1 AND 1440),
  servings integer NOT NULL DEFAULT 1 CHECK (servings BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 16. Recipe Ingredients
CREATE TABLE IF NOT EXISTS public.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_post_id uuid NOT NULL REFERENCES public.recipes(post_id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0 AND position <= 100),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 250),
  quantity numeric(10,2) CHECK (quantity IS NULL OR quantity >= 0),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 32),
  UNIQUE (recipe_post_id, position)
);

-- 17. Recipe Steps
CREATE TABLE IF NOT EXISTS public.recipe_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_post_id uuid NOT NULL REFERENCES public.recipes(post_id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0 AND position <= 100),
  instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 1000),
  UNIQUE (recipe_post_id, position)
);

-- 18. Workout Updates (Subtype of Posts)
CREATE TABLE IF NOT EXISTS public.workout_updates (
  post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  activity text NOT NULL CHECK (char_length(activity) BETWEEN 1 AND 100),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
  calories_burned integer CHECK (calories_burned IS NULL OR (calories_burned BETWEEN 0 AND 10000)),
  gym_id uuid REFERENCES public.gyms(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 19. Post Likes
CREATE TABLE IF NOT EXISTS public.post_likes (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- 20. Comments (Max nesting depth 2 enforced by command & trigger)
CREATE TABLE IF NOT EXISTS public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  parent_id uuid REFERENCES public.comments(id) ON DELETE RESTRICT,
  depth smallint NOT NULL DEFAULT 1 CHECK (depth IN (1, 2)),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 21. Saved Posts
CREATE TABLE IF NOT EXISTS public.saved_posts (
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- 22. Hidden Posts
CREATE TABLE IF NOT EXISTS public.hidden_posts (
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'not_interested' CHECK (char_length(reason) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- 23. Conversations (1:1 Direct Chat with Canonical direct_key)
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type public.conversation_type NOT NULL DEFAULT 'direct',
  direct_key text NOT NULL UNIQUE CHECK (char_length(direct_key) BETWEEN 32 AND 128),
  initiator_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  status public.conversation_status NOT NULL DEFAULT 'active',
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 24. Conversation Members
CREATE TABLE IF NOT EXISTS public.conversation_members (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  pinned_at timestamptz,
  muted_until timestamptz,
  hidden_before_seq bigint NOT NULL DEFAULT 0 CHECK (hidden_before_seq >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- 25. Workout Sessions (Declared before messages so workout_invitation messages can reference sessions)
CREATE TABLE IF NOT EXISTS public.workout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  activity text NOT NULL CHECK (char_length(activity) BETWEEN 1 AND 80),
  gym_id uuid REFERENCES public.gyms(id) ON DELETE SET NULL,
  coarse_location text NOT NULL DEFAULT 'Kyiv' CHECK (char_length(coarse_location) BETWEEN 1 AND 140),
  starts_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Kyiv' CHECK (char_length(timezone) BETWEEN 2 AND 64),
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
  capacity integer NOT NULL DEFAULT 2 CHECK (capacity BETWEEN 2 AND 20),
  confirmed_count integer NOT NULL DEFAULT 1 CHECK (confirmed_count >= 1 AND confirmed_count <= capacity),
  status public.workout_session_status NOT NULL DEFAULT 'scheduled',
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

-- 26. Workout Session Revisions (Tracks material time/place reschedule history)
CREATE TABLE IF NOT EXISTS public.workout_session_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.workout_sessions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  changed_by uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  old_starts_at timestamptz NOT NULL,
  new_starts_at timestamptz NOT NULL,
  old_gym_id uuid REFERENCES public.gyms(id) ON DELETE SET NULL,
  new_gym_id uuid REFERENCES public.gyms(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, revision)
);

-- 27. Session Participants
CREATE TABLE IF NOT EXISTS public.session_participants (
  session_id uuid NOT NULL REFERENCES public.workout_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
  status public.participant_status NOT NULL DEFAULT 'confirmed',
  acknowledged_revision integer NOT NULL DEFAULT 1,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

-- 28. Workout Invitations
CREATE TABLE IF NOT EXISTS public.workout_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.workout_sessions(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  invitee_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  status public.invitation_status NOT NULL DEFAULT 'pending',
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 500),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workout_invitations_no_self CHECK (inviter_id <> invitee_id)
);

-- 29. Messages
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  sender_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  client_message_id uuid NOT NULL,
  kind public.message_kind NOT NULL DEFAULT 'text',
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  workout_invitation_id uuid REFERENCES public.workout_invitations(id) ON DELETE SET NULL,
  server_seq bigint NOT NULL CHECK (server_seq >= 1),
  status public.message_status NOT NULL DEFAULT 'sent',
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (conversation_id, sender_id, client_message_id),
  UNIQUE (conversation_id, server_seq)
);

-- 30. Message Attachments
CREATE TABLE IF NOT EXISTS public.message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  media_object_id uuid NOT NULL REFERENCES public.media_objects(id) ON DELETE RESTRICT,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 3),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, media_object_id),
  UNIQUE (message_id, position)
);

-- 31. Message Read States
CREATE TABLE IF NOT EXISTS public.message_read_states (
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  last_delivered_seq bigint NOT NULL DEFAULT 0 CHECK (last_delivered_seq >= 0),
  read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversation_members(conversation_id, user_id)
    ON DELETE CASCADE
);

-- 32. Notifications (In-App Inbox)
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  type public.notification_type NOT NULL,
  actor_id uuid REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,
  resource_type text NOT NULL CHECK (char_length(resource_type) <= 64),
  resource_id uuid,
  title text NOT NULL CHECK (char_length(title) <= 140),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 180),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

-- 33. Push Devices (APNs Tokens)
CREATE TABLE IF NOT EXISTS public.push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  encrypted_token text NOT NULL,
  environment public.apns_environment NOT NULL DEFAULT 'sandbox',
  bundle_id text NOT NULL DEFAULT 'com.gymbuddy.app' CHECK (char_length(bundle_id) BETWEEN 3 AND 128),
  device_name text NOT NULL DEFAULT 'iPhone' CHECK (char_length(device_name) <= 120),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, bundle_id, token_hash)
);

-- 34. Admin Users & Roles (12-ADMIN-MODERATION.md)
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email citext NOT NULL UNIQUE,
  role public.admin_role NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 35. Admin Emergency Grants (Time-bound dual-control access for escalations)
CREATE TABLE IF NOT EXISTS public.admin_emergency_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grantee_admin_id uuid NOT NULL REFERENCES public.admin_users(user_id) ON DELETE RESTRICT,
  approver_admin_id uuid NOT NULL REFERENCES public.admin_users(user_id) ON DELETE RESTRICT,
  case_id uuid,
  ticket_ref text NOT NULL CHECK (char_length(ticket_ref) BETWEEN 3 AND 80),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT emergency_grant_dual_control CHECK (grantee_admin_id <> approver_admin_id)
);

-- 36. Reports (Safety & Moderation Intake with Immutable Evidence Snapshot)
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT,
  target_type public.report_target_type NOT NULL,
  target_id uuid NOT NULL,
  reported_user_id uuid REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 64),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  status public.report_status NOT NULL DEFAULT 'new',
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 37. Moderation Cases
CREATE TABLE IF NOT EXISTS public.moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE REFERENCES public.reports(id) ON DELETE RESTRICT,
  target_type public.report_target_type NOT NULL,
  target_id uuid NOT NULL,
  subject_user_id uuid REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,
  assignee_admin_id uuid REFERENCES public.admin_users(user_id) ON DELETE SET NULL,
  status public.report_status NOT NULL DEFAULT 'new',
  severity public.case_severity NOT NULL DEFAULT 'medium',
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- 38. Moderation Actions (Append-Only Sanction & Resolution Log)
CREATE TABLE IF NOT EXISTS public.moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.moderation_cases(id) ON DELETE RESTRICT,
  admin_id uuid NOT NULL REFERENCES public.admin_users(user_id) ON DELETE RESTRICT,
  approved_by_admin_id uuid REFERENCES public.admin_users(user_id) ON DELETE RESTRICT,
  action public.moderation_action_type NOT NULL,
  target_type public.report_target_type NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 39. System Announcements
CREATE TABLE IF NOT EXISTS public.system_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_admin_id uuid NOT NULL REFERENCES public.admin_users(user_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 40. Audit Logs (Immutable Append-Only Security & Admin Trail)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system', 'worker')),
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) BETWEEN 2 AND 120),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 2 AND 80),
  resource_id text,
  request_id text NOT NULL,
  ip_hash text,
  before_hash text,
  after_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 41. Idempotency Keys (24h-7d TTL Command Deduplication Store)
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 2 AND 120),
  user_id uuid NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  PRIMARY KEY (scope, user_id, key)
);

-- 42. Transactional Outbox Events (At-Least-Once Worker Queue)
CREATE TABLE IF NOT EXISTS public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 2 AND 80),
  aggregate_type text NOT NULL CHECK (char_length(aggregate_type) BETWEEN 2 AND 80),
  aggregate_id text NOT NULL,
  dedupe_key text UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  leased_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
  last_error text,
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 43. Account Deletions (GDPR Erasure State Machine)
CREATE TABLE IF NOT EXISTS public.account_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  status public.deletion_status NOT NULL DEFAULT 'cooling_off',
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  reauth_verified boolean NOT NULL DEFAULT true,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  cancelled_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 45. Account Exports (GDPR Data Portability Archive)
CREATE TABLE IF NOT EXISTS public.account_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  status public.export_status NOT NULL DEFAULT 'requested',
  object_path text,
  download_token_hash text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz
);

-- 46. Sliding Window Rate Limit Buckets
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL DEFAULT 1 CHECK (hit_count >= 0),
  expires_at timestamptz NOT NULL
);

-- 47. Privacy-Safe Pseudonymous Analytics Events
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_pseudonym text NOT NULL,
  event_name text NOT NULL CHECK (char_length(event_name) BETWEEN 2 AND 80),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
