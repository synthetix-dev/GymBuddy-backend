import crypto from 'node:crypto';
import type pg from 'pg';
import { env } from '../../config/env.js';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';
import { realtimeHub } from '../realtime/realtime-hub.js';

export interface ProfileDTO {
  id: string;
  public_code: string;
  display_name: string;
  bio: string;
  gender_code: string;
  age_years: number | null;
  experience_level: string;
  preferred_time: string;
  home_gym_id: string | null;
  home_gym_name: string | null;
  city_label: string;
  visibility: string;
  onboarding_state?: string;
  interests: Array<{ id: string; slug: string; label: string; proficiency: string }>;
  photos: Array<{ id: string; media_object_id: string; position: number; is_avatar: boolean; url: string }>;
  distance_km: number | null;
  version: number;
}

export async function assertActiveAccount(
  client: pg.PoolClient,
  userId: string,
  options?: { allowDeletionPending?: boolean; allowProfileSetup?: boolean }
): Promise<{
  account_status: 'active' | 'suspended' | 'deletion_pending' | 'deleted';
  onboarding_state: 'profile_required' | 'permissions_required' | 'complete';
}> {
  const res = await client.query<{
    account_status: 'active' | 'suspended' | 'deletion_pending' | 'deleted';
    onboarding_state: 'profile_required' | 'permissions_required' | 'complete';
    suspended_until: Date | null;
    deleted_at: Date | null;
  }>(
    `SELECT account_status, onboarding_state, suspended_until, deleted_at
     FROM public.user_profiles
     WHERE user_id = $1`,
    [userId]
  );

  if (res.rowCount === 0) {
    throw Problems.unauthorized('Account profile does not exist.');
  }

  const row = res.rows[0]!;
  if (row.account_status === 'deleted' || row.deleted_at !== null) {
    throw Problems.unauthorized('Account is no longer active.');
  }
  if (row.account_status === 'suspended') {
    if (row.suspended_until && row.suspended_until <= new Date()) {
      await client.query(
        `UPDATE public.user_profiles SET account_status = 'active', suspended_until = NULL WHERE user_id = $1`,
        [userId]
      );
      row.account_status = 'active';
    } else {
      throw Problems.accountSuspended();
    }
  }
  if (row.account_status === 'deletion_pending' && !options?.allowDeletionPending) {
    throw Problems.accountDeletionPending();
  }

  return {
    account_status: row.account_status,
    onboarding_state: row.onboarding_state,
  };
}

export async function hydrateProfileDTO(
  client: pg.PoolClient,
  targetUserId: string,
  viewerUserId: string
): Promise<ProfileDTO> {
  const profRes = await client.query<{
    id: string;
    public_code: string;
    display_name: string;
    bio: string;
    gender_code: string;
    age_years: number | null;
    experience_level: string;
    preferred_time: string;
    home_gym_id: string | null;
    home_gym_name: string | null;
    city_label: string;
    visibility: string;
    version: string;
  }>(
    `SELECT
       up.user_id AS id,
       up.public_code,
       up.display_name,
       up.bio,
       up.gender_code,
       CASE
         WHEN up.user_id = $2 OR COALESCE(us.show_age, true) = true
         THEN EXTRACT(YEAR FROM age(CURRENT_DATE, up.birth_date))::int
         ELSE NULL
       END AS age_years,
       up.experience_level::text,
       up.preferred_time::text,
       up.home_gym_id,
       g.name AS home_gym_name,
       up.city_label,
       up.visibility::text,
       up.version::text
     FROM public.user_profiles up
     LEFT JOIN public.user_settings us ON us.user_id = up.user_id
     LEFT JOIN public.gyms g ON g.id = up.home_gym_id
     WHERE up.user_id = $1 AND up.deleted_at IS NULL`,
    [targetUserId, viewerUserId]
  );

  if (profRes.rowCount === 0) {
    throw Problems.notFound('Profile', 'PROFILE_NOT_FOUND');
  }

  const p = profRes.rows[0]!;

  // Interests
  const intRes = await client.query<{
    id: string;
    slug: string;
    label: string;
    proficiency: string;
  }>(
    `SELECT i.id, i.slug, i.label, ui.proficiency::text
     FROM public.user_interests ui
     JOIN public.interests i ON i.id = ui.interest_id
     WHERE ui.user_id = $1
     ORDER BY i.label ASC`,
    [targetUserId]
  );

  // Photos
  const photoRes = await client.query<{
    id: string;
    media_object_id: string;
    position: number;
    is_avatar: boolean;
    object_path: string;
  }>(
    `SELECT up.id, up.media_object_id, up.position, up.is_avatar, mo.object_path
     FROM public.user_photos up
     JOIN public.media_objects mo ON mo.id = up.media_object_id
     WHERE up.user_id = $1 AND up.deleted_at IS NULL AND up.status = 'ready'
     ORDER BY up.is_avatar DESC, up.position ASC`,
    [targetUserId]
  );

  // Coarse rounded distance if viewer != target and both have valid locations
  let distanceKm: number | null = null;
  if (viewerUserId !== targetUserId) {
    const distRes = await client.query<{ distance_km: string | null }>(
      `SELECT
         CASE
           WHEN COALESCE(us.show_distance, true) = false THEN NULL
           ELSE public.gb_rounded_distance_km(vl.latitude, vl.longitude, tl.latitude, tl.longitude)
         END AS distance_km
       FROM public.user_profiles tp
       LEFT JOIN public.user_settings us ON us.user_id = tp.user_id
       LEFT JOIN public.user_locations vl ON vl.user_id = $1 AND vl.expires_at > now()
       LEFT JOIN public.user_locations tl ON tl.user_id = $2 AND tl.expires_at > now()
       WHERE tp.user_id = $2`,
      [viewerUserId, targetUserId]
    );
    const rawDist = distRes.rows[0]?.distance_km;
    distanceKm = rawDist !== null && rawDist !== undefined ? Number(rawDist) : null;
  }

  return {
    id: p.id,
    public_code: p.public_code,
    display_name: p.display_name,
    bio: p.bio,
    gender_code: p.gender_code,
    age_years: p.age_years,
    experience_level: p.experience_level,
    preferred_time: p.preferred_time,
    home_gym_id: p.home_gym_id,
    home_gym_name: p.home_gym_name,
    city_label: p.city_label,
    visibility: p.visibility,
    interests: intRes.rows,
    photos: photoRes.rows.map((ph) => ({
      id: ph.id,
      media_object_id: ph.media_object_id,
      position: ph.position,
      is_avatar: ph.is_avatar,
      url: `${env.GYMBUDDY_API_BASE_URL}/media/${ph.media_object_id}/url`,
    })),
    distance_km: distanceKm,
    version: Number(p.version),
  };
}

export async function getBootstrap(client: pg.PoolClient, userId: string) {
  const statusInfo = await assertActiveAccount(client, userId, {
    allowDeletionPending: true,
    allowProfileSetup: true,
  });

  const profile = await hydrateProfileDTO(client, userId, userId);
  const settingsRes = await client.query(
    `SELECT
       discovery_radius_km, discovery_visible, discover_gender_filter,
       discover_min_age, discover_max_age, show_age, show_distance, show_online_status,
       push_enabled, push_messages, push_message_preview, push_workouts, push_social,
       quiet_hours_start, quiet_hours_end, locale, timezone, analytics_opt_in, version::int AS version
     FROM public.user_settings
     WHERE user_id = $1`,
    [userId]
  );

  const unreadNotifRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );

  const nextStep: 'profile' | 'permissions' | 'discover' =
    statusInfo.onboarding_state === 'complete'
      ? 'discover'
      : statusInfo.onboarding_state === 'permissions_required'
      ? 'permissions'
      : 'profile';

  return {
    data: {
      next_step: nextStep,
      account_status: statusInfo.account_status,
      profile,
      settings: settingsRes.rows[0] ?? null,
      unread_notifications_count: Number(unreadNotifRes.rows[0]?.count ?? 0),
      feature_config: {
        max_post_images: 4,
        max_message_chars: 4000,
        location_optional: true,
        min_age_years: 18,
      },
    },
  };
}

export async function updateMyProfile(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  body: {
    display_name?: string;
    birth_date?: string;
    gender_code?: string;
    bio?: string;
    experience_level?: string;
    preferred_time?: string;
    home_gym_id?: string | null;
    city_label?: string;
    visibility?: string;
    onboarding_state?: 'profile_required' | 'permissions_required' | 'complete';
    interest_ids?: string[];
    version: number;
  }
) {
  await assertActiveAccount(client, userId);

  if (typeof body.version !== 'number' || body.version < 1) {
    throw Problems.validation('Valid version is required for optimistic concurrency.', [
      { field: 'version', reason: 'invalid' },
    ]);
  }

  if (body.display_name !== undefined) {
    const trimmed = body.display_name.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw Problems.validation('display_name must be between 1 and 80 characters.', [
        { field: 'display_name', reason: 'length_out_of_bounds' },
      ]);
    }
  }

  if (body.birth_date !== undefined) {
    const bd = new Date(body.birth_date);
    const eighteenYearsAgo = new Date();
    eighteenYearsAgo.setUTCFullYear(eighteenYearsAgo.getUTCFullYear() - 18);
    if (Number.isNaN(bd.getTime()) || bd > eighteenYearsAgo) {
      throw Problems.validation('Users must be at least 18 years old.', [
        { field: 'birth_date', reason: 'underage_or_invalid' },
      ]);
    }
  }

  const requestHash = computeRequestHash('PATCH', '/v1/me/profile', body);

  return executeIdempotentCommand(client, {
    scope: 'PATCH:/v1/me/profile',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const updateRes = await client.query(
        `UPDATE public.user_profiles
         SET
           display_name = COALESCE($3, display_name),
           birth_date = COALESCE($4::date, birth_date),
           gender_code = COALESCE($5, gender_code),
           bio = COALESCE($6, bio),
           experience_level = COALESCE($7::public.experience_level, experience_level),
           preferred_time = COALESCE($8::public.preferred_workout_time, preferred_time),
           home_gym_id = CASE WHEN $9::boolean THEN $10::uuid ELSE home_gym_id END,
           city_label = COALESCE($11, city_label),
           visibility = COALESCE($12::public.profile_visibility, visibility),
           onboarding_state = COALESCE($13::public.onboarding_state, onboarding_state),
           version = version + 1
         WHERE user_id = $1 AND version = $2
         RETURNING version`,
        [
          userId,
          body.version,
          body.display_name?.trim() ?? null,
          body.birth_date ?? null,
          body.gender_code ?? null,
          body.bio ?? null,
          body.experience_level ?? null,
          body.preferred_time ?? null,
          body.home_gym_id !== undefined,
          body.home_gym_id ?? null,
          body.city_label ?? null,
          body.visibility ?? null,
          body.onboarding_state ?? null,
        ]
      );

      if (updateRes.rowCount === 0) {
        throw Problems.versionConflict();
      }

      if (Array.isArray(body.interest_ids)) {
        await client.query(`DELETE FROM public.user_interests WHERE user_id = $1`, [userId]);
        for (const interestId of body.interest_ids) {
          await client.query(
            `INSERT INTO public.user_interests (user_id, interest_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, interestId]
          );
        }
      }

      const updatedProfile = await hydrateProfileDTO(client, userId, userId);
      return {
        statusCode: 200,
        body: { data: updatedProfile },
      };
    },
  });
}

export async function getPublicProfile(
  client: pg.PoolClient,
  viewerUserId: string,
  targetUserId: string
) {
  await assertActiveAccount(client, viewerUserId);

  const visibleRes = await client.query<{ ok: boolean }>(
    `SELECT public.can_view_profile($1, $2) AS ok`,
    [viewerUserId, targetUserId]
  );

  if (!visibleRes.rows[0]?.ok) {
    // Return 404 to hide existence when blocked or hidden (08-API-CONTRACT.md)
    throw Problems.notFound('Profile', 'PROFILE_NOT_FOUND');
  }

  const profile = await hydrateProfileDTO(client, targetUserId, viewerUserId);
  const relRes = await client.query<{ type: string }>(
    `SELECT type::text FROM public.user_relationships WHERE actor_id = $1 AND target_id = $2`,
    [viewerUserId, targetUserId]
  );

  return {
    data: {
      ...profile,
      relationship: relRes.rows.map((r) => r.type),
    },
  };
}

export async function blockUserCommand(
  client: pg.PoolClient,
  blockerId: string,
  blockedId: string,
  idempotencyKey: string,
  reasonCode: string | undefined,
  requestId: string
) {
  await assertActiveAccount(client, blockerId);
  if (blockerId === blockedId) {
    throw Problems.validation('Cannot block yourself.', [{ field: 'id', reason: 'self_block' }]);
  }

  const requestHash = computeRequestHash('POST', `/v1/profiles/${blockedId}/block`, {
    reason_code: reasonCode ?? 'user_initiated',
  });

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/profiles/${blockedId}/block`,
    userId: blockerId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      await client.query(`SELECT public.execute_block_user_rpc($1, $2, $3, $4)`, [
        blockerId,
        blockedId,
        reasonCode ?? 'user_initiated',
        requestId,
      ]);
      realtimeHub.revokeConversationSubscriptionsForPair(blockerId, blockedId);
      return {
        statusCode: 204,
        body: null,
      };
    },
  });
}

export async function unblockUserCommand(
  client: pg.PoolClient,
  blockerId: string,
  blockedId: string,
  requestId: string
) {
  await assertActiveAccount(client, blockerId);
  await client.query(
    `DELETE FROM public.blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
    [blockerId, blockedId]
  );
  await client.query(
    `INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
     VALUES ('user', $1, 'user.unblocked', 'user_profile', $2, $3)`,
    [blockerId, blockedId, requestId]
  );
}

export async function createReportCommand(
  client: pg.PoolClient,
  reporterId: string,
  idempotencyKey: string,
  body: {
    target_type: 'profile' | 'post' | 'comment' | 'message' | 'workout_session';
    target_id: string;
    reason: string;
    details?: string;
  },
  requestId: string
) {
  await assertActiveAccount(client, reporterId);

  const requestHash = computeRequestHash('POST', '/v1/reports', body);
  return executeIdempotentCommand<{
    data: { id: string; status: string; deduplicated?: boolean; created_at?: string };
  }>(client, {
    scope: 'POST:/v1/reports',
    userId: reporterId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      // Capture immutable evidence snapshot of the target resource
      let evidenceSnapshot: Record<string, unknown> = {
        captured_at: new Date().toISOString(),
        target_type: body.target_type,
        target_id: body.target_id,
      };
      let reportedUserId: string | null = null;

      if (body.target_type === 'profile') {
        const res = await client.query(
          `SELECT user_id, public_code, display_name, bio FROM public.user_profiles WHERE user_id = $1`,
          [body.target_id]
        );
        if (res.rowCount === 0) throw Problems.notFound('Profile');
        reportedUserId = res.rows[0].user_id;
        evidenceSnapshot = { ...evidenceSnapshot, profile: res.rows[0] };
      } else if (body.target_type === 'post') {
        const res = await client.query(
          `SELECT id, author_id, type, body, created_at FROM public.posts WHERE id = $1`,
          [body.target_id]
        );
        if (res.rowCount === 0) throw Problems.notFound('Post');
        reportedUserId = res.rows[0].author_id;
        evidenceSnapshot = { ...evidenceSnapshot, post: res.rows[0] };
      } else if (body.target_type === 'comment') {
        const res = await client.query(
          `SELECT id, post_id, author_id, body, created_at FROM public.comments WHERE id = $1`,
          [body.target_id]
        );
        if (res.rowCount === 0) throw Problems.notFound('Comment');
        reportedUserId = res.rows[0].author_id;
        evidenceSnapshot = { ...evidenceSnapshot, comment: res.rows[0] };
      } else if (body.target_type === 'message') {
        const res = await client.query(
          `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.server_seq, m.created_at
           FROM public.messages m
           JOIN public.conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
           WHERE m.id = $1`,
          [body.target_id, reporterId]
        );
        if (res.rowCount === 0) throw Problems.notFound('Message');
        const msg = res.rows[0]!;
        reportedUserId = msg.sender_id;
        // Include up to 5 context messages around the reported message for moderation review
        const contextMsgs = await client.query(
          `SELECT id, sender_id, body, server_seq, created_at
           FROM public.messages
           WHERE conversation_id = $1 AND server_seq BETWEEN ($2 - 2) AND ($2 + 2)
           ORDER BY server_seq ASC`,
          [msg.conversation_id, msg.server_seq]
        );
        evidenceSnapshot = {
          ...evidenceSnapshot,
          message: msg,
          conversation_context: contextMsgs.rows,
        };
      } else if (body.target_type === 'workout_session') {
        const res = await client.query(
          `SELECT id, creator_id, title, activity, notes, starts_at FROM public.workout_sessions WHERE id = $1`,
          [body.target_id]
        );
        if (res.rowCount === 0) throw Problems.notFound('Workout session');
        reportedUserId = res.rows[0].creator_id;
        evidenceSnapshot = { ...evidenceSnapshot, workout_session: res.rows[0] };
      }

      if (reportedUserId === reporterId) {
        throw Problems.validation('Cannot report your own content.');
      }

      // Check active duplicate report from same reporter on same target
      const dupRes = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.reports
         WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3
           AND status IN ('new', 'triaged', 'investigating')`,
        [reporterId, body.target_type, body.target_id]
      );

      if (dupRes.rowCount && dupRes.rowCount > 0) {
        return {
          statusCode: 202,
          body: {
            data: {
              id: dupRes.rows[0]!.id,
              status: dupRes.rows[0]!.status,
              deduplicated: true,
            },
          },
        };
      }

      const repRes = await client.query<{ id: string; status: string; created_at: Date }>(
        `INSERT INTO public.reports (
           reporter_id, target_type, target_id, reported_user_id, reason, details, evidence_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id, status::text, created_at`,
        [
          reporterId,
          body.target_type,
          body.target_id,
          reportedUserId,
          body.reason.trim(),
          (body.details ?? '').trim(),
          JSON.stringify(evidenceSnapshot),
        ]
      );

      const report = repRes.rows[0]!;

      await client.query(
        `INSERT INTO public.moderation_cases (
           report_id, target_type, target_id, subject_user_id, status, severity
         ) VALUES ($1, $2, $3, $4, 'new', 'medium')`,
        [report.id, body.target_type, body.target_id, reportedUserId]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
         VALUES ('user', $1, 'report.created', $2, $3, $4)`,
        [reporterId, body.target_type, body.target_id, requestId]
      );

      return {
        statusCode: 202,
        body: {
          data: {
            id: report.id,
            status: report.status,
            created_at: report.created_at.toISOString(),
          },
        },
      };
    },
  });
}

export async function requestAccountDeletionCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  body: { confirmation: string; reason?: string },
  requestId: string
) {
  if (body.confirmation !== 'DELETE') {
    throw Problems.validation('Confirmation string must be "DELETE".', [
      { field: 'confirmation', reason: 'must_equal_DELETE' },
    ]);
  }

  const requestHash = computeRequestHash('POST', '/v1/me/account-deletion', body);
  return executeIdempotentCommand(client, {
    scope: 'POST:/v1/me/account-deletion',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const existing = await client.query<{ id: string; status: string; due_at: Date }>(
        `SELECT id, status::text, due_at FROM public.account_deletions
         WHERE user_id = $1 AND status IN ('requested', 'cooling_off', 'processing')`,
        [userId]
      );

      if (existing.rowCount && existing.rowCount > 0) {
        throw Problems.conflict(
          'DELETION_ALREADY_PENDING',
          'Account deletion already pending',
          'An account deletion request is already in progress.'
        );
      }

      const insRes = await client.query<{ id: string; status: string; due_at: Date }>(
        `INSERT INTO public.account_deletions (user_id, status, reason, reauth_verified, due_at)
         VALUES ($1, 'cooling_off', $2, true, now() + INTERVAL '7 days')
         RETURNING id, status::text, due_at`,
        [userId, (body.reason ?? '').slice(0, 500)]
      );

      await client.query(
        `UPDATE public.user_profiles
         SET account_status = 'deletion_pending', version = version + 1
         WHERE user_id = $1`,
        [userId]
      );

      // Revoke all APNs device tokens
      await client.query(
        `UPDATE public.push_devices
         SET revoked_at = now(), revoke_reason = 'account_deletion_requested'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
         VALUES ('user', $1::uuid, 'account.deletion_requested', 'user_profile', ($1::uuid)::text, $2)`,
        [userId, requestId]
      );

      return {
        statusCode: 202,
        body: {
          data: {
            id: insRes.rows[0]!.id,
            status: insRes.rows[0]!.status,
            due_at: insRes.rows[0]!.due_at.toISOString(),
          },
        },
      };
    },
  });
}

export async function cancelAccountDeletionCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  requestId: string
) {
  const requestHash = computeRequestHash('DELETE', '/v1/me/account-deletion', {});
  return executeIdempotentCommand(client, {
    scope: 'DELETE:/v1/me/account-deletion',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const updRes = await client.query(
        `UPDATE public.account_deletions
         SET status = 'cancelled', cancelled_at = now()
         WHERE user_id = $1 AND status IN ('requested', 'cooling_off')
         RETURNING id`,
        [userId]
      );

      if (updRes.rowCount === 0) {
        throw Problems.conflict(
          'NO_CANCELLABLE_DELETION',
          'No active cooling-off deletion request',
          'There is no pending account deletion in the cooling-off period.'
        );
      }

      await client.query(
        `UPDATE public.user_profiles
         SET account_status = 'active', version = version + 1
         WHERE user_id = $1`,
        [userId]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
         VALUES ('user', $1::uuid, 'account.deletion_cancelled', 'user_profile', ($1::uuid)::text, $2)`,
        [userId, requestId]
      );

      return {
        statusCode: 204,
        body: null,
      };
    },
  });
}

export async function executeFinalAccountErasure(
  client: pg.PoolClient,
  userId: string,
  requestId: string
): Promise<void> {
  const userHash = crypto.createHash('sha256').update(userId).digest('hex');

  // Purge private data in dependency order
  await client.query(`DELETE FROM public.user_locations WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM public.push_devices WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM public.notifications WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM public.saved_posts WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM public.hidden_posts WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM public.user_interests WHERE user_id = $1`, [userId]);
  await client.query(
    `DELETE FROM public.user_relationships WHERE actor_id = $1 OR target_id = $1`,
    [userId]
  );
  await client.query(`DELETE FROM public.user_photos WHERE user_id = $1`, [userId]);
  await client.query(
    `UPDATE public.media_objects SET status = 'deleted', deleted_at = now() WHERE owner_id = $1`,
    [userId]
  );

  // Soft-delete posts and anonymize messages
  await client.query(
    `UPDATE public.posts SET status = 'deleted', body = '', deleted_at = now() WHERE author_id = $1`,
    [userId]
  );
  await client.query(
    `UPDATE public.messages SET status = 'deleted', body = '', deleted_at = now() WHERE sender_id = $1`,
    [userId]
  );

  // Anonymize public.user_profiles record (auth.users deletion is handled via Supabase Auth Admin API)
  await client.query(
    `UPDATE public.user_profiles
     SET
       display_name = 'Deleted User',
       bio = '',
       gender_code = 'prefer_not_to_say',
       home_gym_id = NULL,
       visibility = 'hidden',
       account_status = 'deleted',
       deleted_at = now(),
       version = version + 1
     WHERE user_id = $1`,
    [userId]
  );

  await client.query(
    `UPDATE public.account_deletions
     SET status = 'completed', completed_at = now()
     WHERE user_id = $1 AND status <> 'completed'`,
    [userId]
  );

  await client.query(
    `INSERT INTO public.audit_logs (actor_type, actor_id, action, resource_type, resource_id, request_id)
     VALUES ('worker', NULL, 'account.erasure_completed', 'user_profile_hash', $1, $2)`,
    [userHash, requestId]
  );
}
