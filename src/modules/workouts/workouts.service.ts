import type pg from 'pg';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';
import { encodeKeysetCursor, decodeKeysetCursor } from '../../core/cursor.js';
import { assertActiveAccount, hydrateProfileDTO } from '../identity/identity.service.js';
import { getOrCreateDirectConversationCommand } from '../chat/chat.service.js';
import { createNotificationAndOutbox } from '../notifications/notifications.service.js';
import { realtimeHub } from '../realtime/realtime-hub.js';

export async function updateMyLocationCommand(
  client: pg.PoolClient,
  userId: string,
  body: { latitude: number; longitude: number; accuracy_m?: number }
) {
  await assertActiveAccount(client, userId);

  if (
    typeof body.latitude !== 'number' ||
    Number.isNaN(body.latitude) ||
    body.latitude < -90 ||
    body.latitude > 90 ||
    typeof body.longitude !== 'number' ||
    Number.isNaN(body.longitude) ||
    body.longitude < -180 ||
    body.longitude > 180
  ) {
    throw Problems.validation('Valid WGS-84 latitude (-90..90) and longitude (-180..180) are required.', [
      { field: 'latitude', reason: 'invalid_coordinates' },
    ]);
  }

  const accuracy = Math.min(10000, Math.max(0, Math.round(body.accuracy_m ?? 50)));

  await client.query(
    `INSERT INTO public.user_locations (
       user_id, latitude, longitude, coarse_geohash, accuracy_m, captured_at, expires_at
     ) VALUES (
       $1, $2, $3, public.gb_coarse_geohash($2, $3), $4, now(), now() + INTERVAL '30 days'
     )
     ON CONFLICT (user_id)
     DO UPDATE SET
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       coarse_geohash = EXCLUDED.coarse_geohash,
       accuracy_m = EXCLUDED.accuracy_m,
       captured_at = now(),
       expires_at = now() + INTERVAL '30 days'`,
    [userId, body.latitude, body.longitude, accuracy]
  );

  return {
    data: {
      updated: true,
      coarse_area: 'Kyiv',
      expires_in_days: 30,
    },
  };
}

/**
 * 07-DISCOVER-WORKOUTS.md:
 * - Eligibility always precedes ranking: active + adult, onboarding complete, discoverable,
 *   not self, not blocked either direction, not passed within 30-day cooldown, not hidden.
 * - Uses server-side geodesic distance (ST_DWithin / gb_dwithin); falls back to gym centroid if location denied.
 * - NEVER returns candidate coordinates, geohash, or raw accuracy. Only rounded integer km!
 */
export async function getDiscoverCandidatesQuery(
  client: pg.PoolClient,
  userId: string,
  params: {
    radius_km?: number;
    gym_id?: string;
    preferred_time?: string;
    gender?: string;
    interest_id?: string;
    cursor?: string;
    limit?: number;
  }
) {
  await assertActiveAccount(client, userId);

  const radiusKm = Math.min(100, Math.max(1, params.radius_km ?? 15));
  const radiusM = radiusKm * 1000.0;
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  let cursorId: string | null = null;
  if (params.cursor) {
    const decoded = decodeKeysetCursor(params.cursor);
    cursorId = decoded.id;
  }

  // Resolve requester's reference point: recent valid user_locations OR selected home_gym_id centroid
  const reqOriginRes = await client.query<{
    lat: number | null;
    lon: number | null;
    preferred_time: string;
    experience_level: string;
    home_gym_id: string | null;
  }>(
    `SELECT
       COALESCE(ul.latitude, g.latitude) AS lat,
       COALESCE(ul.longitude, g.longitude) AS lon,
       up.preferred_time::text,
       up.experience_level::text,
       up.home_gym_id
     FROM public.user_profiles up
     LEFT JOIN public.user_locations ul ON ul.user_id = up.user_id AND ul.expires_at > now()
     LEFT JOIN public.gyms g ON g.id = up.home_gym_id
     WHERE up.user_id = $1`,
    [userId]
  );

  const origin = reqOriginRes.rows[0]!;

  const candidatesRes = await client.query<{
    user_id: string;
    distance_km: string | null;
    same_gym: boolean;
    same_time: boolean;
    same_level: boolean;
    has_bio: boolean;
    shared_interests: string;
    total_my_interests: string;
  }>(
    `SELECT
       cp.user_id,
       CASE
         WHEN $2::float8 IS NOT NULL AND COALESCE(cl.latitude, cg.latitude) IS NOT NULL
              AND COALESCE(cs.show_distance, true) = true
         THEN public.gb_rounded_distance_km(
           $2::float8,
           $3::float8,
           COALESCE(cl.latitude, cg.latitude),
           COALESCE(cl.longitude, cg.longitude)
         )::text
         ELSE NULL
       END AS distance_km,
       (cp.home_gym_id IS NOT NULL AND cp.home_gym_id = $5::uuid) AS same_gym,
       (cp.preferred_time::text = $6::text OR cp.preferred_time = 'flexible') AS same_time,
       (cp.experience_level::text = $7::text) AS same_level,
       (char_length(cp.bio) > 10) AS has_bio,
       (
         SELECT count(*)::text
         FROM public.user_interests ui1
         JOIN public.user_interests ui2 ON ui2.interest_id = ui1.interest_id AND ui2.user_id = cp.user_id
         WHERE ui1.user_id = $1
       ) AS shared_interests,
       GREATEST(1, (SELECT count(*) FROM public.user_interests WHERE user_id = $1))::text AS total_my_interests
     FROM public.user_profiles cp
     LEFT JOIN public.user_settings cs ON cs.user_id = cp.user_id
     LEFT JOIN public.user_locations cl ON cl.user_id = cp.user_id AND cl.expires_at > now()
     LEFT JOIN public.gyms cg ON cg.id = cp.home_gym_id
     WHERE cp.user_id <> $1
       AND cp.deleted_at IS NULL
       AND cp.account_status = 'active'
       AND cp.onboarding_state = 'complete'
       AND cp.visibility = 'discoverable'
       AND COALESCE(cs.discovery_visible, true) = true
       AND NOT public.is_blocked($1, cp.user_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.user_relationships rel
         WHERE rel.actor_id = $1
           AND rel.target_id = cp.user_id
           AND (
             rel.type IN ('connect', 'hide')
             OR (rel.type = 'pass' AND (rel.expires_at IS NULL OR rel.expires_at > now()))
           )
       )
       AND (
         $2::float8 IS NULL
         OR COALESCE(cl.latitude, cg.latitude) IS NULL
         OR public.gb_dwithin(
           $2::float8,
           $3::float8,
           COALESCE(cl.latitude, cg.latitude),
           COALESCE(cl.longitude, cg.longitude),
           $4::float8
         )
       )
       AND ($8::uuid IS NULL OR cp.home_gym_id = $8::uuid)
       AND ($9::text IS NULL OR cp.preferred_time::text = $9::text)
       AND ($10::text IS NULL OR $10::text = 'any' OR cp.gender_code = $10::text)
       AND (
         $11::uuid IS NULL
         OR EXISTS (
           SELECT 1 FROM public.user_interests uif
           WHERE uif.user_id = cp.user_id AND uif.interest_id = $11::uuid
         )
       )
       AND ($12::uuid IS NULL OR cp.user_id > $12::uuid)
     ORDER BY cp.user_id ASC
     LIMIT $13`,
    [
      userId,
      origin.lat,
      origin.lon,
      radiusM,
      origin.home_gym_id,
      origin.preferred_time,
      origin.experience_level,
      params.gym_id ?? null,
      params.preferred_time ?? null,
      params.gender ?? null,
      params.interest_id ?? null,
      cursorId,
      limit + 1,
    ]
  );

  // Compute compatibility score (07-DISCOVER-WORKOUTS.md: 40% interests, 25% time, 15% experience, 15% gym, 5% completeness)
  const scored = candidatesRes.rows.map((row) => {
    const interestRatio = Math.min(1, Number(row.shared_interests) / Number(row.total_my_interests));
    const score = Math.round(
      (0.4 * interestRatio +
        0.25 * (row.same_time ? 1 : 0.3) +
        0.15 * (row.same_level ? 1 : 0.5) +
        0.15 * (row.same_gym ? 1 : 0.3) +
        0.05 * (row.has_bio ? 1 : 0.4)) *
        100
    );
    return { ...row, compatibility_score: score };
  });

  if (!params.cursor) {
    scored.sort((a, b) => b.compatibility_score - a.compatibility_score || a.user_id.localeCompare(b.user_id));
  }

  const hasMore = scored.length > limit;
  const pageSlice = scored.slice(0, limit);

  const items = [];
  for (const c of pageSlice) {
    const profile = await hydrateProfileDTO(client, c.user_id, userId);
    items.push({
      ...profile,
      distance_km: c.distance_km !== null ? Number(c.distance_km) : profile.distance_km,
      compatibility_score: c.compatibility_score,
    });
  }

  const last = pageSlice[pageSlice.length - 1];
  const nextCursor = hasMore && last ? encodeKeysetCursor(last.compatibility_score, last.user_id) : null;

  return {
    data: items,
    page: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function discoverActionCommand(
  client: pg.PoolClient,
  actorId: string,
  targetId: string,
  idempotencyKey: string,
  body: { action: 'pass' | 'connect' | 'hide' }
) {
  await assertActiveAccount(client, actorId);
  if (actorId === targetId) {
    throw Problems.validation('Cannot perform discover action on yourself.');
  }

  if (!['pass', 'connect', 'hide'].includes(body.action)) {
    throw Problems.validation('Invalid discover action.', [
      { field: 'action', reason: 'must_be_pass_connect_or_hide' },
    ]);
  }

  const blk = await client.query<{ blocked: boolean }>(
    `SELECT public.is_blocked($1, $2) AS blocked`,
    [actorId, targetId]
  );
  if (blk.rows[0]?.blocked) {
    throw Problems.notFound('Profile');
  }

  const requestHash = computeRequestHash('POST', `/v1/discover/${targetId}/actions`, body);

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/discover/${targetId}/actions`,
    userId: actorId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const expiresAt =
        body.action === 'pass' ? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() : null;

      await client.query(
        `INSERT INTO public.user_relationships (actor_id, target_id, type, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (actor_id, target_id, type)
         DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [actorId, targetId, body.action, expiresAt]
      );

      let conversationId: string | null = null;
      if (body.action === 'connect') {
        const convResult = await getOrCreateDirectConversationCommand(
          client,
          actorId,
          idempotencyKey,
          targetId
        );
        conversationId = (convResult.body as { data: { id: string } }).data.id;

        await createNotificationAndOutbox(client, {
          recipientId: targetId,
          type: 'connection_created',
          actorId,
          resourceType: 'profile',
          resourceId: actorId,
          title: 'New connection request',
          body: 'An athlete connected with you on GymBuddy.',
          deepLink: `gymbuddy://profiles/${actorId}`,
          collapseId: `connect:${actorId}:${targetId}`,
          dedupeKey: `connect:${actorId}:${targetId}`,
        });
      }

      return {
        statusCode: 200,
        body: {
          data: {
            target_id: targetId,
            action: body.action,
            conversation_id: conversationId,
            cooldown_expires_at: expiresAt,
          },
        },
      };
    },
  });
}

function validateStartsAtAndTimezone(startsAtIso: string, timezone: string): Date {
  const dt = new Date(startsAtIso);
  if (Number.isNaN(dt.getTime())) {
    throw Problems.validation(
      'Invalid starts_at timestamp.',
      [{ field: 'starts_at', reason: 'invalid_rfc3339' }],
      'INVALID_LOCAL_TIME'
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(dt);
  } catch {
    throw Problems.validation(
      `Invalid IANA timezone "${timezone}".`,
      [{ field: 'timezone', reason: 'invalid_iana_timezone' }],
      'INVALID_LOCAL_TIME'
    );
  }
  if (dt.getTime() < Date.now() - 60_000) {
    throw Problems.validation(
      'Workout session cannot be scheduled in the past.',
      [{ field: 'starts_at', reason: 'in_past' }],
      'INVALID_LOCAL_TIME'
    );
  }
  return dt;
}

async function scheduleSessionReminderOutboxEvents(
  client: pg.PoolClient,
  sessionId: string,
  revision: number,
  userId: string,
  startsAt: Date
): Promise<void> {
  for (const offsetHours of [24, 2]) {
    const remindAt = new Date(startsAt.getTime() - offsetHours * 3600 * 1000);
    if (remindAt.getTime() > Date.now()) {
      const dedupeKey = `reminder:${sessionId}:rev${revision}:${userId}:${offsetHours}h`;
      await client.query(
        `INSERT INTO public.outbox_events (
           topic, aggregate_type, aggregate_id, dedupe_key, payload, available_at
         ) VALUES ('workout.reminder', 'workout_session', $1, $2, $3::jsonb, $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          sessionId,
          dedupeKey,
          JSON.stringify({
            session_id: sessionId,
            revision,
            user_id: userId,
            offset_hours: offsetHours,
            starts_at: startsAt.toISOString(),
          }),
          remindAt.toISOString(),
        ]
      );
    }
  }
}

export async function createWorkoutSessionCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  body: {
    title?: string;
    activity: string;
    gym_id?: string | null;
    coarse_location?: string;
    starts_at: string;
    timezone?: string;
    duration_minutes?: number;
    capacity?: number;
    notes?: string;
  }
) {
  await assertActiveAccount(client, userId);

  const timezone = body.timezone ?? 'Europe/Kyiv';
  const startsAt = validateStartsAtAndTimezone(body.starts_at, timezone);
  const capacity = body.capacity ?? 2;

  if (capacity < 2 || capacity > 20) {
    throw Problems.validation('capacity must be between 2 and 20.', [
      { field: 'capacity', reason: 'out_of_bounds' },
    ]);
  }

  const requestHash = computeRequestHash('POST', '/v1/workout-sessions', body);

  return executeIdempotentCommand(client, {
    scope: 'POST:/v1/workout-sessions',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const title = (body.title ?? body.activity).trim().slice(0, 120);
      const activity = body.activity.trim().slice(0, 80);

      const insRes = await client.query<{
        id: string;
        creator_id: string;
        title: string;
        activity: string;
        gym_id: string | null;
        coarse_location: string;
        starts_at: Date;
        timezone: string;
        duration_minutes: number;
        capacity: number;
        confirmed_count: number;
        status: string;
        notes: string;
        revision: number;
        version: string;
        created_at: Date;
      }>(
        `INSERT INTO public.workout_sessions (
           creator_id, title, activity, gym_id, coarse_location, starts_at, timezone,
           duration_minutes, capacity, confirmed_count, status, notes, revision, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'scheduled', $10, 1, 1)
         RETURNING id, creator_id, title, activity, gym_id, coarse_location, starts_at, timezone,
                   duration_minutes, capacity, confirmed_count, status::text, notes, revision, version::text, created_at`,
        [
          userId,
          title,
          activity,
          body.gym_id ?? null,
          (body.coarse_location ?? 'Kyiv').slice(0, 140),
          startsAt.toISOString(),
          timezone,
          body.duration_minutes ?? 60,
          capacity,
          (body.notes ?? '').slice(0, 1000),
        ]
      );

      const s = insRes.rows[0]!;

      await client.query(
        `INSERT INTO public.session_participants (session_id, user_id, role, status, acknowledged_revision)
         VALUES ($1, $2, 'host', 'confirmed', 1)`,
        [s.id, userId]
      );

      await scheduleSessionReminderOutboxEvents(client, s.id, 1, userId, startsAt);

      return {
        statusCode: 201,
        body: {
          data: {
            ...s,
            starts_at: s.starts_at.toISOString(),
            created_at: s.created_at.toISOString(),
            version: Number(s.version),
          },
        },
      };
    },
  });
}

export async function updateWorkoutSessionCommand(
  client: pg.PoolClient,
  userId: string,
  sessionId: string,
  idempotencyKey: string,
  body: {
    starts_at?: string;
    timezone?: string;
    gym_id?: string | null;
    notes?: string;
    status?: 'cancelled' | 'in_progress' | 'completed';
    reason?: string;
    version: number;
  }
) {
  await assertActiveAccount(client, userId);

  const requestHash = computeRequestHash('PATCH', `/v1/workout-sessions/${sessionId}`, body);

  return executeIdempotentCommand(client, {
    scope: `PATCH:/v1/workout-sessions/${sessionId}`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const sessRes = await client.query<{
        id: string;
        creator_id: string;
        starts_at: Date;
        timezone: string;
        gym_id: string | null;
        status: string;
        confirmed_count: number;
        revision: number;
        version: string;
      }>(
        `SELECT id, creator_id, starts_at, timezone, gym_id, status::text, confirmed_count, revision, version::text
         FROM public.workout_sessions
         WHERE id = $1
         FOR UPDATE`,
        [sessionId]
      );

      if (sessRes.rowCount === 0) throw Problems.notFound('Workout session');
      const s = sessRes.rows[0]!;
      if (s.creator_id !== userId) throw Problems.forbidden('Only session creator can update the session.');
      if (Number(s.version) !== body.version) throw Problems.versionConflict();

      if (s.status === 'completed' || s.status === 'cancelled') {
        throw Problems.conflict('SESSION_TERMINAL', 'Session is in terminal state', 'Completed or cancelled sessions cannot be rescheduled.');
      }

      if (body.status === 'cancelled') {
        await client.query(
          `UPDATE public.workout_sessions
           SET status = 'cancelled', cancelled_at = now(), version = version + 1
           WHERE id = $1`,
          [sessionId]
        );
        await client.query(
          `UPDATE public.workout_invitations
           SET status = 'revoked', responded_at = now(), version = version + 1
           WHERE session_id = $1 AND status IN ('pending', 'accepted')`,
          [sessionId]
        );
      } else {
        const nextTz = body.timezone ?? s.timezone;
        const nextStartsAt = body.starts_at
          ? validateStartsAtAndTimezone(body.starts_at, nextTz)
          : s.starts_at;
        const nextGymId = body.gym_id !== undefined ? body.gym_id : s.gym_id;

        const materialChange =
          nextStartsAt.getTime() !== s.starts_at.getTime() || nextGymId !== s.gym_id;

        const nextRevision = materialChange ? s.revision + 1 : s.revision;
        const nextStatus =
          body.status ??
          (materialChange && s.confirmed_count > 1 ? 'reschedule_pending' : s.status);

        if (materialChange) {
          await client.query(
            `INSERT INTO public.workout_session_revisions (
               session_id, revision, changed_by, old_starts_at, new_starts_at, old_gym_id, new_gym_id, reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              sessionId,
              nextRevision,
              userId,
              s.starts_at.toISOString(),
              nextStartsAt.toISOString(),
              s.gym_id,
              nextGymId,
              (body.reason ?? 'Rescheduled by host').slice(0, 500),
            ]
          );

          if (s.confirmed_count > 1) {
            await client.query(
              `UPDATE public.session_participants
               SET status = 'reconfirmation_required'
               WHERE session_id = $1 AND user_id <> $2 AND status = 'confirmed'`,
              [sessionId, userId]
            );
          }
        }

        await client.query(
          `UPDATE public.workout_sessions
           SET
             starts_at = $2,
             timezone = $3,
             gym_id = $4,
             notes = COALESCE($5, notes),
             status = $6::public.workout_session_status,
             revision = $7,
             version = version + 1
           WHERE id = $1`,
          [
            sessionId,
            nextStartsAt.toISOString(),
            nextTz,
            nextGymId,
            body.notes ?? null,
            nextStatus,
            nextRevision,
          ]
        );

        // Schedule deduplicated reminders for the new revision
        const partRes = await client.query<{ user_id: string }>(
          `SELECT user_id FROM public.session_participants WHERE session_id = $1 AND status IN ('confirmed', 'reconfirmation_required')`,
          [sessionId]
        );
        for (const p of partRes.rows) {
          await scheduleSessionReminderOutboxEvents(
            client,
            sessionId,
            nextRevision,
            p.user_id,
            nextStartsAt
          );
        }
      }

      const updated = await getWorkoutSessionQuery(client, userId, sessionId);
      return {
        statusCode: 200,
        body: updated,
      };
    },
  });
}

export async function getWorkoutSessionQuery(
  client: pg.PoolClient,
  userId: string,
  sessionId: string
) {
  await assertActiveAccount(client, userId);

  const canView = await client.query<{ ok: boolean }>(
    `SELECT public.can_view_workout_session($1, $2) AS ok`,
    [userId, sessionId]
  );
  if (!canView.rows[0]?.ok) {
    throw Problems.notFound('Workout session');
  }

  const res = await client.query<{
    id: string;
    creator_id: string;
    title: string;
    activity: string;
    gym_id: string | null;
    coarse_location: string;
    starts_at: Date;
    timezone: string;
    duration_minutes: number;
    capacity: number;
    confirmed_count: number;
    status: string;
    notes: string;
    revision: number;
    version: string;
    created_at: Date;
  }>(
    `SELECT id, creator_id, title, activity, gym_id, coarse_location, starts_at, timezone,
            duration_minutes, capacity, confirmed_count, status::text, notes, revision, version::text, created_at
     FROM public.workout_sessions WHERE id = $1`,
    [sessionId]
  );

  if (res.rowCount === 0) throw Problems.notFound('Workout session');
  const s = res.rows[0]!;

  const partRes = await client.query<{
    user_id: string;
    role: string;
    status: string;
    acknowledged_revision: number;
  }>(
    `SELECT user_id, role, status::text, acknowledged_revision
     FROM public.session_participants WHERE session_id = $1 ORDER BY joined_at ASC`,
    [sessionId]
  );

  return {
    data: {
      ...s,
      starts_at: s.starts_at.toISOString(),
      created_at: s.created_at.toISOString(),
      version: Number(s.version),
      participants: partRes.rows,
    },
  };
}

export async function createWorkoutInvitationCommand(
  client: pg.PoolClient,
  inviterId: string,
  sessionId: string,
  idempotencyKey: string,
  body: {
    invitee_id: string;
    message?: string;
    expires_at?: string;
  }
) {
  await assertActiveAccount(client, inviterId);
  if (inviterId === body.invitee_id) {
    throw Problems.validation('Cannot invite yourself to a workout session.');
  }

  const blk = await client.query<{ blocked: boolean }>(
    `SELECT public.is_blocked($1, $2) AS blocked`,
    [inviterId, body.invitee_id]
  );
  if (blk.rows[0]?.blocked) {
    throw Problems.relationshipBlocked();
  }

  const requestHash = computeRequestHash(
    'POST',
    `/v1/workout-sessions/${sessionId}/invitations`,
    body
  );

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/workout-sessions/${sessionId}/invitations`,
    userId: inviterId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const sessRes = await client.query<{
        id: string;
        creator_id: string;
        status: string;
        capacity: number;
        confirmed_count: number;
        starts_at: Date;
      }>(
        `SELECT id, creator_id, status::text, capacity, confirmed_count, starts_at
         FROM public.workout_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );

      if (sessRes.rowCount === 0) throw Problems.notFound('Workout session');
      const s = sessRes.rows[0]!;
      if (s.creator_id !== inviterId) {
        throw Problems.forbidden('Only session creator can send invitations.');
      }
      if (!['scheduled', 'reschedule_pending'].includes(s.status)) {
        throw Problems.conflict('SESSION_NOT_OPEN', 'Session not open for invitations', 'Session is not active.');
      }
      if (s.confirmed_count >= s.capacity) {
        throw Problems.conflict('SESSION_FULL', 'Session full', 'Workout session has reached capacity.');
      }

      const existingPending = await client.query<{ id: string }>(
        `SELECT id FROM public.workout_invitations
         WHERE session_id = $1 AND invitee_id = $2 AND status = 'pending'`,
        [sessionId, body.invitee_id]
      );
      if (existingPending.rowCount && existingPending.rowCount > 0) {
        throw Problems.conflict(
          'INVITATION_ALREADY_PENDING',
          'Invitation already pending',
          'An active invitation already exists for this user and session.'
        );
      }

      const defaultExpires = new Date(
        Math.min(s.starts_at.getTime(), Date.now() + 48 * 3600 * 1000)
      );
      const expiresAt = body.expires_at ? new Date(body.expires_at) : defaultExpires;

      const insRes = await client.query<{
        id: string;
        status: string;
        version: string;
        expires_at: Date;
        created_at: Date;
      }>(
        `INSERT INTO public.workout_invitations (
           session_id, inviter_id, invitee_id, status, message, expires_at
         ) VALUES ($1, $2, $3, 'pending', $4, $5)
         RETURNING id, status::text, version::text, expires_at, created_at`,
        [
          sessionId,
          inviterId,
          body.invitee_id,
          (body.message ?? '').slice(0, 500),
          expiresAt.toISOString(),
        ]
      );

      const inv = insRes.rows[0]!;

      await createNotificationAndOutbox(client, {
        recipientId: body.invitee_id,
        type: 'workout_invited',
        actorId: inviterId,
        resourceType: 'workout_invitation',
        resourceId: inv.id,
        title: 'Workout invitation',
        body: 'You received a workout session invitation.',
        deepLink: `gymbuddy://workout-invitations/${inv.id}`,
        collapseId: `workout_inv:${inv.id}`,
        dedupeKey: `workout_inv:${inv.id}`,
      });

      return {
        statusCode: 201,
        body: {
          data: {
            id: inv.id,
            session_id: sessionId,
            inviter_id: inviterId,
            invitee_id: body.invitee_id,
            status: inv.status,
            expires_at: inv.expires_at.toISOString(),
            version: Number(inv.version),
            created_at: inv.created_at.toISOString(),
          },
        },
      };
    },
  });
}

/**
 * 07-DISCOVER-WORKOUTS.md:
 * - Only invitee accepts/declines; inviter may revoke pending.
 * - Transition uses version and row lock (`SELECT ... FOR UPDATE` on both invitation AND session).
 * - Checks not expired (410 INVITATION_EXPIRED), not blocked (403 RELATIONSHIP_BLOCKED),
 *   and capacity (`confirmed_count < capacity` -> 409 SESSION_FULL).
 */
export async function transitionWorkoutInvitationCommand(
  client: pg.PoolClient,
  userId: string,
  invitationId: string,
  action: 'accept' | 'decline' | 'revoke',
  idempotencyKey: string,
  body: { version: number }
) {
  await assertActiveAccount(client, userId);

  const requestHash = computeRequestHash(
    'POST',
    `/v1/workout-invitations/${invitationId}/${action}`,
    body
  );

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/workout-invitations/${invitationId}/${action}`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      // Lock invitation row
      const invRes = await client.query<{
        id: string;
        session_id: string;
        inviter_id: string;
        invitee_id: string;
        status: string;
        expires_at: Date;
        version: string;
      }>(
        `SELECT id, session_id, inviter_id, invitee_id, status::text, expires_at, version::text
         FROM public.workout_invitations
         WHERE id = $1
         FOR UPDATE`,
        [invitationId]
      );

      if (invRes.rowCount === 0) throw Problems.notFound('Workout invitation');
      const inv = invRes.rows[0]!;

      // Authorization check
      if ((action === 'accept' || action === 'decline') && inv.invitee_id !== userId) {
        throw Problems.forbidden('Only the invitee can accept or decline this invitation.');
      }
      if (action === 'revoke' && inv.inviter_id !== userId) {
        throw Problems.forbidden('Only the inviter can revoke this invitation.');
      }

      // Check bilateral block
      const blk = await client.query<{ blocked: boolean }>(
        `SELECT public.is_blocked($1, $2) AS blocked`,
        [inv.inviter_id, inv.invitee_id]
      );
      if (blk.rows[0]?.blocked) {
        throw Problems.relationshipBlocked();
      }

      // Lock parent workout_session row to prevent race conditions on capacity or cancel
      const sessRes = await client.query<{
        id: string;
        status: string;
        capacity: number;
        confirmed_count: number;
        revision: number;
        starts_at: Date;
      }>(
        `SELECT id, status::text, capacity, confirmed_count, revision, starts_at
         FROM public.workout_sessions
         WHERE id = $1
         FOR UPDATE`,
        [inv.session_id]
      );

      if (sessRes.rowCount === 0) throw Problems.notFound('Workout session');
      const sess = sessRes.rows[0]!;

      const targetStatus =
        action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'revoked';

      // Idempotent duplicate transition check
      if (inv.status === targetStatus) {
        return {
          statusCode: 200,
          body: {
            data: {
              id: inv.id,
              session_id: inv.session_id,
              status: inv.status,
              version: Number(inv.version),
            },
          },
        };
      }

      if (inv.status !== 'pending') {
        throw Problems.conflict(
          'INVITATION_TERMINAL',
          'Invitation already finalized',
          `Cannot ${action} an invitation in "${inv.status}" state.`
        );
      }

      if (Number(inv.version) !== body.version) {
        throw Problems.versionConflict();
      }

      if (new Date(inv.expires_at) <= new Date()) {
        await client.query(
          `UPDATE public.workout_invitations SET status = 'expired', version = version + 1 WHERE id = $1`,
          [inv.id]
        );
        throw Problems.invitationExpired();
      }

      if (sess.status === 'cancelled' || sess.status === 'completed') {
        throw Problems.conflict(
          'INVITATION_TERMINAL',
          'Session is no longer active',
          `Workout session is ${sess.status}.`
        );
      }

      if (action === 'accept') {
        if (sess.confirmed_count >= sess.capacity) {
          throw Problems.conflict(
            'SESSION_FULL',
            'Workout session is full',
            'All available participant slots for this workout session have been claimed.'
          );
        }

        await client.query(
          `INSERT INTO public.session_participants (session_id, user_id, role, status, acknowledged_revision)
           VALUES ($1, $2, 'participant', 'confirmed', $3)
           ON CONFLICT (session_id, user_id)
           DO UPDATE SET status = 'confirmed', acknowledged_revision = EXCLUDED.acknowledged_revision`,
          [sess.id, inv.invitee_id, sess.revision]
        );

        await client.query(
          `UPDATE public.workout_sessions
           SET confirmed_count = confirmed_count + 1, version = version + 1
           WHERE id = $1`,
          [sess.id]
        );

        await scheduleSessionReminderOutboxEvents(
          client,
          sess.id,
          sess.revision,
          inv.invitee_id,
          sess.starts_at
        );
      }

      const updInv = await client.query<{ status: string; version: string }>(
        `UPDATE public.workout_invitations
         SET status = $2::public.invitation_status,
             responded_at = now(),
             version = version + 1
         WHERE id = $1
         RETURNING status::text, version::text`,
        [inv.id, targetStatus]
      );

      const notifyTarget = action === 'revoke' ? inv.invitee_id : inv.inviter_id;
      const notifyType =
        action === 'accept'
          ? 'workout_invitation_accepted'
          : action === 'decline'
          ? 'workout_invitation_declined'
          : 'workout_session_updated';

      await createNotificationAndOutbox(client, {
        recipientId: notifyTarget,
        type: notifyType,
        actorId: userId,
        resourceType: 'workout_session',
        resourceId: inv.session_id,
        title: `Workout invitation ${targetStatus}`,
        body: `Workout session invitation was ${targetStatus}.`,
        deepLink: `gymbuddy://workout-sessions/${inv.session_id}`,
        collapseId: `workout_inv:${inv.id}`,
        dedupeKey: `workout_inv_transition:${inv.id}:${targetStatus}`,
      });

      realtimeHub.publishToTopic(`user:${notifyTarget}`, {
        type: 'invitation.updated',
        aggregate_id: inv.id,
        data: {
          invitation_id: inv.id,
          session_id: inv.session_id,
          status: targetStatus,
        },
      });

      return {
        statusCode: 200,
        body: {
          data: {
            id: inv.id,
            session_id: inv.session_id,
            status: updInv.rows[0]!.status,
            version: Number(updInv.rows[0]!.version),
          },
        },
      };
    },
  });
}

export async function listMyWorkoutSessionsQuery(
  client: pg.PoolClient,
  userId: string,
  params: { state?: 'upcoming' | 'history' }
) {
  await assertActiveAccount(client, userId);
  const state = params.state ?? 'upcoming';

  // Per 01-CURRENT-APP-AUDIT.md & 07-DISCOVER-WORKOUTS.md:
  // Upcoming sessions ONLY include active confirmed/reschedule_pending sessions (never pending/declined invitations!)
  const res = await client.query<{
    id: string;
    creator_id: string;
    title: string;
    activity: string;
    gym_id: string | null;
    coarse_location: string;
    starts_at: Date;
    timezone: string;
    duration_minutes: number;
    capacity: number;
    confirmed_count: number;
    status: string;
    revision: number;
    version: string;
  }>(
    `SELECT
       ws.id, ws.creator_id, ws.title, ws.activity, ws.gym_id, ws.coarse_location,
       ws.starts_at, ws.timezone, ws.duration_minutes, ws.capacity, ws.confirmed_count,
       ws.status::text, ws.revision, ws.version::text
     FROM public.workout_sessions ws
     JOIN public.session_participants sp
       ON sp.session_id = ws.id AND sp.user_id = $1
     WHERE sp.status IN ('confirmed', 'reconfirmation_required', 'attended')
       AND NOT public.is_blocked($1, ws.creator_id)
       AND (
         ($2::text = 'upcoming' AND ws.status IN ('scheduled', 'reschedule_pending', 'in_progress') AND ws.starts_at >= (now() - INTERVAL '2 hours'))
         OR ($2::text = 'history' AND (ws.status IN ('completed', 'cancelled') OR ws.starts_at < (now() - INTERVAL '2 hours')))
       )
     ORDER BY ws.starts_at ASC, ws.id ASC`,
    [userId, state]
  );

  return {
    data: res.rows.map((s) => ({
      ...s,
      starts_at: s.starts_at.toISOString(),
      version: Number(s.version),
    })),
    page: { next_cursor: null, has_more: false },
  };
}
