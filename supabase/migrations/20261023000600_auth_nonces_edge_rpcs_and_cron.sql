-- =============================================================================
-- Migration 006: Atomic PostgreSQL RPCs for Supabase Deno Edge Functions & pg_cron
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Edge Function RPC: send_message_rpc
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_message_rpc(
  p_sender_id uuid,
  p_conversation_id uuid,
  p_client_message_id uuid,
  p_body text,
  p_kind public.message_kind DEFAULT 'text',
  p_workout_invitation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_other_id uuid;
  v_seq bigint;
  v_msg_id uuid;
  v_created_at timestamptz;
  v_existing record;
BEGIN
  IF length(btrim(COALESCE(p_body, ''))) < 1 OR length(p_body) > 4000 THEN
    RAISE EXCEPTION 'Message body must be between 1 and 4000 characters' USING ERRCODE = '22023';
  END IF;

  IF NOT public.is_conversation_member(p_sender_id, p_conversation_id) THEN
    RAISE EXCEPTION 'Not a member of this conversation' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO v_other_id
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id <> p_sender_id
  LIMIT 1;

  IF v_other_id IS NOT NULL AND public.is_blocked(p_sender_id, v_other_id) THEN
    RAISE EXCEPTION 'Conversation unavailable due to block' USING ERRCODE = '42501';
  END IF;

  -- Deduplicate by (conversation_id, sender_id, client_message_id)
  SELECT id, server_seq, created_at
  INTO v_existing
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND sender_id = p_sender_id
    AND client_message_id = p_client_message_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_existing.id,
      'conversation_id', p_conversation_id,
      'sender_id', p_sender_id,
      'client_message_id', p_client_message_id,
      'server_seq', v_existing.server_seq,
      'kind', p_kind,
      'body', btrim(p_body),
      'workout_invitation_id', p_workout_invitation_id,
      'created_at', v_existing.created_at,
      'deduplicated', true
    );
  END IF;

  UPDATE public.conversations
  SET last_seq = last_seq + 1,
      last_message_at = now()
  WHERE id = p_conversation_id
  RETURNING last_seq INTO v_seq;

  INSERT INTO public.messages (
    conversation_id, sender_id, client_message_id, server_seq, kind, body, workout_invitation_id
  ) VALUES (
    p_conversation_id, p_sender_id, p_client_message_id, v_seq, p_kind, btrim(p_body), p_workout_invitation_id
  )
  RETURNING id, created_at INTO v_msg_id, v_created_at;

  INSERT INTO public.message_read_states (conversation_id, user_id, last_read_seq, last_delivered_seq, read_at)
  VALUES (p_conversation_id, p_sender_id, v_seq, v_seq, now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_seq = GREATEST(message_read_states.last_read_seq, EXCLUDED.last_read_seq),
      last_delivered_seq = GREATEST(message_read_states.last_delivered_seq, EXCLUDED.last_delivered_seq),
      read_at = now();

  INSERT INTO public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  VALUES (
    'chat.message_created',
    'message',
    v_msg_id::text,
    jsonb_build_object(
      'message_id', v_msg_id,
      'conversation_id', p_conversation_id,
      'sender_id', p_sender_id,
      'server_seq', v_seq
    )
  );

  RETURN jsonb_build_object(
    'id', v_msg_id,
    'conversation_id', p_conversation_id,
    'sender_id', p_sender_id,
    'client_message_id', p_client_message_id,
    'server_seq', v_seq,
    'kind', p_kind,
    'body', btrim(p_body),
    'workout_invitation_id', p_workout_invitation_id,
    'created_at', v_created_at,
    'deduplicated', false
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Edge Function RPC: accept_workout_invitation_rpc
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_workout_invitation_rpc(
  p_actor_id uuid,
  p_invitation_id uuid,
  p_expected_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv record;
  v_sess record;
  v_new_version bigint;
BEGIN
  SELECT * INTO v_inv
  FROM public.workout_invitations
  WHERE id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.invitee_id <> p_actor_id THEN
    RAISE EXCEPTION 'Only invitee may accept invitation' USING ERRCODE = '42501';
  END IF;

  IF v_inv.version <> p_expected_version THEN
    RAISE EXCEPTION 'Version conflict' USING ERRCODE = '40001';
  END IF;

  IF v_inv.status <> 'pending' OR v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'Invitation is no longer pending' USING ERRCODE = '23514';
  END IF;

  IF public.is_blocked(v_inv.inviter_id, v_inv.invitee_id) THEN
    RAISE EXCEPTION 'Blocked pair' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sess
  FROM public.workout_sessions
  WHERE id = v_inv.session_id
  FOR UPDATE;

  IF v_sess.status <> 'scheduled' THEN
    RAISE EXCEPTION 'Workout session is no longer scheduled' USING ERRCODE = '23514';
  END IF;

  IF v_sess.confirmed_count >= v_sess.capacity THEN
    RAISE EXCEPTION 'Workout session has reached maximum capacity' USING ERRCODE = '23514';
  END IF;

  UPDATE public.workout_invitations
  SET status = 'accepted',
      responded_at = now(),
      version = version + 1
  WHERE id = p_invitation_id
  RETURNING version INTO v_new_version;

  INSERT INTO public.session_participants (session_id, user_id, role, status, acknowledged_revision)
  VALUES (v_sess.id, p_actor_id, 'participant', 'confirmed', v_sess.revision)
  ON CONFLICT (session_id, user_id) DO UPDATE
  SET status = 'confirmed', acknowledged_revision = v_sess.revision;

  UPDATE public.workout_sessions
  SET confirmed_count = confirmed_count + 1,
      version = version + 1
  WHERE id = v_sess.id;

  INSERT INTO public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  VALUES (
    'workout.invitation_transitioned',
    'workout_invitation',
    p_invitation_id::text,
    jsonb_build_object(
      'invitation_id', p_invitation_id,
      'session_id', v_inv.session_id,
      'action', 'accept',
      'status', 'accepted',
      'actor_id', p_actor_id,
      'inviter_id', v_inv.inviter_id,
      'invitee_id', v_inv.invitee_id
    )
  );

  RETURN jsonb_build_object(
    'id', p_invitation_id,
    'session_id', v_inv.session_id,
    'status', 'accepted',
    'version', v_new_version
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Conditional pg_cron Scheduling for Supabase Managed Environments
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$$;
