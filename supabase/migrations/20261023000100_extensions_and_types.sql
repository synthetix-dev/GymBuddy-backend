-- =============================================================================
-- Migration 001: Extensions, Spatial Helpers & Domain Enums
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Conditionally enable PostGIS when available (e.g. Supabase EU / PostGIS host)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS postgis';
  END IF;
END
$$;

-- =============================================================================
-- Spatial Helper Functions (PostGIS + Haversine Portable Geodesic Implementation)
-- =============================================================================

-- Geodesic distance in meters between two WGS-84 coordinates (lat/lon)
CREATE OR REPLACE FUNCTION public.gb_distance_m(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT 2.0 * 6371008.8 * asin(
    LEAST(
      1.0,
      sqrt(
        power(sin(radians(lat2 - lat1) / 2.0), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) *
        power(sin(radians(lon2 - lon1) / 2.0), 2)
      )
    )
  );
$$;

-- Predicate equivalent to PostGIS ST_DWithin(geography, geography, radius_m)
CREATE OR REPLACE FUNCTION public.gb_dwithin(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision,
  radius_m double precision
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT
    lat1 IS NOT NULL AND lon1 IS NOT NULL AND lat2 IS NOT NULL AND lon2 IS NOT NULL
    AND abs(lat1 - lat2) <= (radius_m / 110574.0) + 0.05
    AND public.gb_distance_m(lat1, lon1, lat2, lon2) <= radius_m;
$$;

-- Privacy-preserving rounded distance in km (never returns sub-km precision)
CREATE OR REPLACE FUNCTION public.gb_rounded_distance_km(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision
)
RETURNS numeric(6,1)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN NULL
    ELSE GREATEST(1.0, ROUND((public.gb_distance_m(lat1, lon1, lat2, lon2) / 1000.0)::numeric, 0))
  END;
$$;

-- Compute coarse geohash prefix (4 chars ~ 20km cell) for privacy-safe area grouping
CREATE OR REPLACE FUNCTION public.gb_coarse_geohash(
  lat double precision,
  lon double precision
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT 'gh4_' ||
    floor(((lat + 90.0) / 180.0) * 64.0)::int::text || '_' ||
    floor(((lon + 180.0) / 360.0) * 64.0)::int::text;
$$;

-- =============================================================================
-- Domain Enum Types (03-DATABASE-DESIGN.md)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status') THEN
    CREATE TYPE public.account_status AS ENUM ('active', 'suspended', 'deletion_pending', 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_state') THEN
    CREATE TYPE public.onboarding_state AS ENUM ('profile_required', 'permissions_required', 'complete');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'profile_visibility') THEN
    CREATE TYPE public.profile_visibility AS ENUM ('discoverable', 'connections', 'hidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'experience_level') THEN
    CREATE TYPE public.experience_level AS ENUM ('beginner', 'intermediate', 'advanced', 'pro');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'preferred_workout_time') THEN
    CREATE TYPE public.preferred_workout_time AS ENUM ('early_morning', 'morning', 'midday', 'afternoon', 'evening', 'late_night', 'flexible');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relationship_type') THEN
    CREATE TYPE public.relationship_type AS ENUM ('pass', 'connect', 'follow', 'hide');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_type') THEN
    CREATE TYPE public.post_type AS ENUM ('text', 'recipe', 'workout');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_status') THEN
    CREATE TYPE public.post_status AS ENUM ('draft', 'processing_media', 'published', 'hidden', 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_visibility') THEN
    CREATE TYPE public.post_visibility AS ENUM ('community', 'connections', 'private');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recipe_difficulty') THEN
    CREATE TYPE public.recipe_difficulty AS ENUM ('easy', 'medium', 'hard');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_type') THEN
    CREATE TYPE public.conversation_type AS ENUM ('direct');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_status') THEN
    CREATE TYPE public.conversation_status AS ENUM ('active', 'request_pending', 'blocked', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_kind') THEN
    CREATE TYPE public.message_kind AS ENUM ('text', 'image', 'workout_invitation', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_status') THEN
    CREATE TYPE public.message_status AS ENUM ('sent', 'delivered', 'read', 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workout_session_status') THEN
    CREATE TYPE public.workout_session_status AS ENUM ('draft', 'scheduled', 'reschedule_pending', 'in_progress', 'completed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'participant_status') THEN
    CREATE TYPE public.participant_status AS ENUM ('confirmed', 'reconfirmation_required', 'declined', 'removed', 'attended');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invitation_status') THEN
    CREATE TYPE public.invitation_status AS ENUM ('pending', 'accepted', 'declined', 'expired', 'revoked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_status') THEN
    CREATE TYPE public.media_status AS ENUM ('upload_pending', 'uploaded', 'processing', 'ready', 'quarantined', 'rejected', 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_visibility') THEN
    CREATE TYPE public.media_visibility AS ENUM ('private', 'conversation', 'authenticated', 'public_cdn');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
    CREATE TYPE public.notification_type AS ENUM (
      'message_received',
      'post_liked',
      'post_commented',
      'comment_replied',
      'connection_created',
      'workout_invited',
      'workout_invitation_accepted',
      'workout_invitation_declined',
      'workout_session_updated',
      'workout_session_cancelled',
      'workout_reminder',
      'moderation_notice',
      'system_announcement'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'apns_environment') THEN
    CREATE TYPE public.apns_environment AS ENUM ('sandbox', 'production');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_target_type') THEN
    CREATE TYPE public.report_target_type AS ENUM ('profile', 'post', 'comment', 'message', 'workout_session');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
    CREATE TYPE public.report_status AS ENUM ('new', 'triaged', 'investigating', 'actioned', 'dismissed', 'appealed', 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'case_severity') THEN
    CREATE TYPE public.case_severity AS ENUM ('low', 'medium', 'high', 'critical');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_action_type') THEN
    CREATE TYPE public.moderation_action_type AS ENUM (
      'no_action',
      'warn',
      'content_hide',
      'interaction_limit',
      'temporary_suspend',
      'permanent_suspend',
      'restore'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_role') THEN
    CREATE TYPE public.admin_role AS ENUM ('support', 'moderator', 'safety_lead', 'ops', 'auditor', 'super_admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deletion_status') THEN
    CREATE TYPE public.deletion_status AS ENUM ('requested', 'cooling_off', 'processing', 'completed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'export_status') THEN
    CREATE TYPE public.export_status AS ENUM ('requested', 'processing', 'ready', 'expired', 'failed');
  END IF;
END
$$;
