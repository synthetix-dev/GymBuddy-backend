import crypto from 'node:crypto';
import type pg from 'pg';
import { encryptSensitiveToken, decryptSensitiveToken } from '../../config/env.js';
import { Problems } from '../../core/problem.js';
import { encodeKeysetCursor, decodeKeysetCursor } from '../../core/cursor.js';
import { assertActiveAccount } from '../identity/identity.service.js';
import { observability } from '../../observability/logger.js';
import { realtimeHub } from '../realtime/realtime-hub.js';
import { sendApnsHttp2Push } from '../../core/apns-client.js';

export interface ApnsDispatchResult {
  deviceId: string;
  status: 'sent' | 'revoked_410' | 'throttled_429' | 'skipped_quiet_hours' | 'skipped_foreground';
  collapseId: string;
  payload: Record<string, unknown>;
}

// Default APNs transport is the real HTTP/2 Apple Push Notification service client (`sendApnsHttp2Push`).
// Tests may inject a custom HTTP/2 authority or test adapter via `setApnsTransportAdapter`.
export type ApnsTransportAdapter = (params: {
  deviceToken: string;
  environment: 'sandbox' | 'production';
  bundleId: string;
  collapseId: string;
  payload: Record<string, unknown>;
}) => Promise<{ statusCode: 200 | 400 | 403 | 410 | 429 | 500; reason?: string }>;

let currentApnsAdapter: ApnsTransportAdapter = (params) => sendApnsHttp2Push(params);

export function setApnsTransportAdapter(adapter: ApnsTransportAdapter): void {
  currentApnsAdapter = adapter;
}

export function resetDefaultApnsTransportAdapter(): void {
  currentApnsAdapter = (params) => sendApnsHttp2Push(params);
}

export async function registerPushDeviceCommand(
  client: pg.PoolClient,
  userId: string,
  body: {
    token: string;
    environment: 'sandbox' | 'production';
    bundle_id: string;
    device_name?: string;
  }
) {
  await assertActiveAccount(client, userId);

  const cleanToken = body.token.trim();
  if (cleanToken.length < 16 || cleanToken.length > 512) {
    throw Problems.validation('Invalid APNs device token.', [{ field: 'token', reason: 'invalid' }]);
  }

  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');
  const encryptedToken = encryptSensitiveToken(cleanToken);

  const res = await client.query<{
    id: string;
    environment: string;
    bundle_id: string;
    device_name: string;
    last_seen_at: Date;
  }>(
    `INSERT INTO public.push_devices (
       user_id, token_hash, encrypted_token, environment, bundle_id, device_name, last_seen_at, revoked_at, revoke_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, NULL)
     ON CONFLICT (environment, bundle_id, token_hash)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       encrypted_token = EXCLUDED.encrypted_token,
       device_name = EXCLUDED.device_name,
       last_seen_at = now(),
       revoked_at = NULL,
       revoke_reason = NULL
     RETURNING id, environment::text, bundle_id, device_name, last_seen_at`,
    [
      userId,
      tokenHash,
      encryptedToken,
      body.environment,
      body.bundle_id,
      (body.device_name ?? 'iPhone').slice(0, 120),
    ]
  );

  return {
    data: {
      id: res.rows[0]!.id,
      environment: res.rows[0]!.environment,
      bundle_id: res.rows[0]!.bundle_id,
      device_name: res.rows[0]!.device_name,
      token_suffix: tokenHash.slice(-8),
      last_seen_at: res.rows[0]!.last_seen_at.toISOString(),
    },
  };
}

export async function revokePushDeviceCommand(
  client: pg.PoolClient,
  userId: string,
  deviceId: string
): Promise<void> {
  await assertActiveAccount(client, userId);
  const res = await client.query(
    `UPDATE public.push_devices
     SET revoked_at = now(), revoke_reason = 'user_revoked'
     WHERE id = $1 AND user_id = $2`,
    [deviceId, userId]
  );
  if (res.rowCount === 0) {
    throw Problems.notFound('Push device');
  }
}

export async function listNotifications(
  client: pg.PoolClient,
  userId: string,
  params: { cursor?: string; limit?: number; unreadOnly?: boolean }
) {
  await assertActiveAccount(client, userId);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (params.cursor) {
    const decoded = decodeKeysetCursor(params.cursor);
    cursorCreatedAt = String(decoded.sort_value);
    cursorId = decoded.id;
  }

  const res = await client.query<{
    id: string;
    type: string;
    actor_id: string | null;
    resource_type: string;
    resource_id: string | null;
    title: string;
    body: string;
    payload: Record<string, unknown>;
    read_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, type::text, actor_id, resource_type, resource_id, title, body, payload, read_at, created_at
     FROM public.notifications
     WHERE user_id = $1
       AND ($2::boolean = false OR read_at IS NULL)
       AND (
         $3::timestamptz IS NULL
         OR (created_at, id) < ($3::timestamptz, $4::uuid)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $5`,
    [userId, Boolean(params.unreadOnly), cursorCreatedAt, cursorId, limit + 1]
  );

  const hasMore = res.rows.length > limit;
  const items = res.rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeKeysetCursor(last.created_at.toISOString(), last.id) : null;

  return {
    data: items.map((n) => ({
      id: n.id,
      type: n.type,
      actor_id: n.actor_id,
      resource_type: n.resource_type,
      resource_id: n.resource_id,
      title: n.title,
      body: n.body,
      payload: n.payload,
      read_at: n.read_at ? n.read_at.toISOString() : null,
      created_at: n.created_at.toISOString(),
    })),
    page: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function markNotificationReadCommand(
  client: pg.PoolClient,
  userId: string,
  notificationId: string
): Promise<void> {
  await assertActiveAccount(client, userId);
  const res = await client.query(
    `UPDATE public.notifications
     SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND user_id = $2`,
    [notificationId, userId]
  );
  if (res.rowCount === 0) {
    throw Problems.notFound('Notification');
  }
}

export function isWithinQuietHours(
  now: Date,
  timezone: string,
  quietStart: string | null,
  quietEnd: string | null
): boolean {
  if (!quietStart || !quietEnd) return false;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const currentHm = formatter.format(now); // "HH:MM"
    const startHm = quietStart.slice(0, 5);
    const endHm = quietEnd.slice(0, 5);
    if (startHm <= endHm) {
      return currentHm >= startHm && currentHm < endHm;
    }
    // Crosses midnight (e.g., 22:00 to 07:00)
    return currentHm >= startHm || currentHm < endHm;
  } catch {
    return false;
  }
}

/**
 * Creates an in-app notification + enqueues an outbox_events row in the same transaction.
 */
export async function createNotificationAndOutbox(
  client: pg.PoolClient,
  params: {
    recipientId: string;
    type:
      | 'message_received'
      | 'post_liked'
      | 'post_commented'
      | 'comment_replied'
      | 'connection_created'
      | 'workout_invited'
      | 'workout_invitation_accepted'
      | 'workout_invitation_declined'
      | 'workout_session_updated'
      | 'workout_session_cancelled'
      | 'workout_reminder'
      | 'moderation_notice'
      | 'system_announcement';
    actorId?: string | null;
    resourceType: string;
    resourceId?: string | null;
    title: string;
    body: string;
    deepLink: string;
    collapseId: string;
    dedupeKey: string;
    previewBody?: string;
  }
): Promise<void> {
  // Check block first (safety notices bypass block check)
  if (params.actorId) {
    const blk = await client.query<{ blocked: boolean }>(
      `SELECT public.is_blocked($1, $2) AS blocked`,
      [params.recipientId, params.actorId]
    );
    if (blk.rows[0]?.blocked) {
      return;
    }
  }

  const notifRes = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO public.notifications (
       user_id, type, actor_id, resource_type, resource_id, title, body, payload, dedupe_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING
     RETURNING id, created_at`,
    [
      params.recipientId,
      params.type,
      params.actorId ?? null,
      params.resourceType,
      params.resourceId ?? null,
      params.title,
      params.body,
      JSON.stringify({ deep_link: params.deepLink }),
      params.dedupeKey,
    ]
  );

  if (notifRes.rowCount === 0) {
    return; // Deduplicated
  }

  const notif = notifRes.rows[0]!;

  realtimeHub.publishToTopic(`user:${params.recipientId}`, {
    type: 'notification.created',
    aggregate_id: notif.id,
    data: {
      notification_id: notif.id,
      type: params.type,
      resource_type: params.resourceType,
      resource_id: params.resourceId ?? null,
    },
  });

  await client.query(
    `INSERT INTO public.outbox_events (
       topic, aggregate_type, aggregate_id, dedupe_key, payload
     ) VALUES ('apns.send', 'notification', $1, $2, $3::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      notif.id,
      `apns:${params.recipientId}:${params.dedupeKey}`,
      JSON.stringify({
        notification_id: notif.id,
        recipient_id: params.recipientId,
        type: params.type,
        title: params.title,
        default_body: params.body,
        preview_body: params.previewBody ?? params.body,
        deep_link: params.deepLink,
        collapse_id: params.collapseId,
      }),
    ]
  );
}

/**
 * Worker handler that processes an `apns.send` outbox event:
 * - Respects recipient push preferences, preview privacy ("New message" by default), and quiet hours
 * - Computes canonical badge count from unread notifications
 * - Revokes invalid tokens on APNs 410 response
 */
export async function processApnsOutboxPayload(
  client: pg.PoolClient,
  payload: {
    notification_id: string;
    recipient_id: string;
    type: string;
    title: string;
    default_body: string;
    preview_body?: string;
    deep_link: string;
    collapse_id: string;
  },
  now = new Date()
): Promise<ApnsDispatchResult[]> {
  const settingsRes = await client.query<{
    push_enabled: boolean;
    push_messages: boolean;
    push_message_preview: boolean;
    push_workouts: boolean;
    push_social: boolean;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
  }>(
    `SELECT
       push_enabled, push_messages, push_message_preview, push_workouts, push_social,
       quiet_hours_start::text, quiet_hours_end::text, timezone
     FROM public.user_settings
     WHERE user_id = $1`,
    [payload.recipient_id]
  );

  if (settingsRes.rowCount === 0) return [];
  const prefs = settingsRes.rows[0]!;

  const isSafetyOrSystem =
    payload.type === 'moderation_notice' || payload.type === 'system_announcement';

  if (!isSafetyOrSystem && !prefs.push_enabled) {
    return [];
  }

  if (payload.type === 'message_received' && !prefs.push_messages) return [];
  if (payload.type.startsWith('workout_') && !prefs.push_workouts) return [];
  if (
    ['post_liked', 'post_commented', 'comment_replied', 'connection_created'].includes(payload.type) &&
    !prefs.push_social
  ) {
    return [];
  }

  // Quiet hours suppression for non-safety notifications
  if (
    !isSafetyOrSystem &&
    isWithinQuietHours(now, prefs.timezone, prefs.quiet_hours_start, prefs.quiet_hours_end)
  ) {
    return [
      {
        deviceId: 'quiet_hours',
        status: 'skipped_quiet_hours',
        collapseId: payload.collapse_id,
        payload: {},
      },
    ];
  }

  // Choose foreground realtime vs APNs for chat messages
  if (
    payload.type === 'message_received' &&
    realtimeHub.isUserConnectedInForeground(payload.recipient_id)
  ) {
    return [
      {
        deviceId: 'foreground_realtime',
        status: 'skipped_foreground',
        collapseId: payload.collapse_id,
        payload: {},
      },
    ];
  }

  // Derive accurate badge count from unread notifications
  const unreadRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.notifications WHERE user_id = $1 AND read_at IS NULL`,
    [payload.recipient_id]
  );
  const badgeCount = Number(unreadRes.rows[0]?.count ?? 1);

  // Privacy-first lock screen body: "New message" by default unless push_message_preview is explicitly enabled
  const alertBody =
    payload.type === 'message_received'
      ? prefs.push_message_preview
        ? payload.preview_body ?? 'New message'
        : 'New message'
      : payload.default_body;

  const apnsPayload = {
    aps: {
      alert: {
        title: payload.title,
        body: alertBody,
      },
      badge: badgeCount,
      sound: 'default',
      'mutable-content': 1,
    },
    deep_link: payload.deep_link,
    notification_id: payload.notification_id,
    type: payload.type,
  };

  const devicesRes = await client.query<{
    id: string;
    encrypted_token: string;
    environment: 'sandbox' | 'production';
    bundle_id: string;
  }>(
    `SELECT id, encrypted_token, environment::text AS environment, bundle_id
     FROM public.push_devices
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [payload.recipient_id]
  );

  const results: ApnsDispatchResult[] = [];

  for (const dev of devicesRes.rows) {
    const rawToken = decryptSensitiveToken(dev.encrypted_token);
    const resp = await currentApnsAdapter({
      deviceToken: rawToken,
      environment: dev.environment,
      bundleId: dev.bundle_id,
      collapseId: payload.collapse_id,
      payload: apnsPayload,
    });

    if (resp.statusCode === 200) {
      observability.increment('apns_sent_total');
      results.push({
        deviceId: dev.id,
        status: 'sent',
        collapseId: payload.collapse_id,
        payload: apnsPayload,
      });
    } else if (resp.statusCode === 410) {
      observability.increment('apns_revoked_tokens_total');
      await client.query(
        `UPDATE public.push_devices
         SET revoked_at = now(), revoke_reason = 'apns_410_unregistered'
         WHERE id = $1`,
        [dev.id]
      );
      results.push({
        deviceId: dev.id,
        status: 'revoked_410',
        collapseId: payload.collapse_id,
        payload: apnsPayload,
      });
    } else if (resp.statusCode === 429 || resp.statusCode === 500) {
      throw new Error(`APNs transient error ${resp.statusCode}: ${resp.reason ?? 'retryable'}`);
    }
  }

  return results;
}
