import crypto from 'node:crypto';
import { withServiceTransaction, getPool } from './db/pool.js';
import { AppProblem, Problems } from './core/problem.js';
import { verifySupabaseAccessToken, type SupabaseJwtClaims } from './core/supabase-jwt.js';
import { enforceRateLimit } from './core/rate-limit.js';
import { validateIdempotencyKeyHeader, executeIdempotentCommand, computeRequestHash } from './core/idempotency.js';
import { observability } from './observability/logger.js';
import {
  getBootstrap,
  hydrateProfileDTO,
  updateMyProfile,
  getPublicProfile,
  blockUserCommand,
  unblockUserCommand,
  createReportCommand,
  requestAccountDeletionCommand,
  cancelAccountDeletionCommand,
  assertActiveAccount,
} from './modules/identity/identity.service.js';
import {
  createUploadIntentCommand,
  completeUploadCommand,
  getAuthorizedMediaUrl,
} from './modules/media/media.service.js';
import {
  getStorageProvider,
  verifyLocalStorageToken,
} from './modules/media/storage-provider.js';
import {
  createPostCommand,
  hydratePostDTO,
  updatePostCommand,
  deletePostCommand,
  getFeedQuery,
  toggleLikePostCommand,
  toggleSavePostCommand,
  createCommentCommand,
  listCommentsQuery,
  deleteCommentCommand,
  searchQuery,
} from './modules/social/social.service.js';
import {
  getOrCreateDirectConversationCommand,
  listConversationsQuery,
  updateConversationMembershipCommand,
  sendMessageCommand,
  getMessagesQuery,
  updateReadStateCommand,
  assertConversationMemberAndUnblocked,
} from './modules/chat/chat.service.js';
import {
  updateMyLocationCommand,
  getDiscoverCandidatesQuery,
  discoverActionCommand,
  createWorkoutSessionCommand,
  getWorkoutSessionQuery,
  updateWorkoutSessionCommand,
  createWorkoutInvitationCommand,
  transitionWorkoutInvitationCommand,
  listMyWorkoutSessionsQuery,
} from './modules/workouts/workouts.service.js';
import {
  registerPushDeviceCommand,
  revokePushDeviceCommand,
  listNotifications,
  markNotificationReadCommand,
} from './modules/notifications/notifications.service.js';
import {
  listAdminReportsQuery,
  executeModerationActionCommand,
} from './modules/admin/admin.service.js';
import { realtimeHub } from './modules/realtime/realtime-hub.js';

export interface ApiRequest {
  method: string;
  url: string; // e.g. "/v1/me/bootstrap?limit=20"
  headers?: Record<string, string | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  ip?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

function getHeader(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

async function authenticateRequest(
  headers: Record<string, string | undefined> | undefined
): Promise<SupabaseJwtClaims> {
  const authHeader = getHeader(headers, 'authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw Problems.unauthorized('Missing Bearer authorization header.');
  }
  const token = authHeader.slice(7).trim();
  return verifySupabaseAccessToken(token);
}

export async function handleApiRequest(req: ApiRequest): Promise<ApiResponse> {
  const startMs = performance.now();
  const requestId =
    getHeader(req.headers, 'x-request-id') ?? `req_${crypto.randomUUID().replace(/-/g, '')}`;
  const method = req.method.toUpperCase();
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  let actorUserId: string | null = null;

  try {
    observability.increment('http_requests_total');

    // Enforce default 256 KB JSON payload cap (08-API-CONTRACT.md)
    if (
      req.body !== undefined &&
      req.body !== null &&
      !Buffer.isBuffer(req.body) &&
      !pathname.startsWith('/v1/storage/object/upload/')
    ) {
      const serializedLen = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
      if (serializedLen > 256 * 1024) {
        throw Problems.payloadTooLarge('Request body exceeds maximum 256 KB limit.');
      }
    }

    // -------------------------------------------------------------------------
    // Public Health Endpoints (No JWT required)
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/v1/health/live') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        body: { status: 'ok', build: '1.0.0', timestamp: new Date().toISOString() },
      };
    }

    if (method === 'GET' && pathname === '/v1/health/ready') {
      const pool = getPool();
      await pool.query('SELECT 1');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        body: {
          status: 'ready',
          dependencies: { database: 'up', storage: 'up' },
          metrics: observability.getLatencyPercentiles(),
        },
      };
    }

    // -------------------------------------------------------------------------
    // Signed Binary Storage Endpoints (Direct-to-Storage Upload & Download)
    // -------------------------------------------------------------------------
    const storageUploadMatch = pathname.match(/^\/v1\/storage\/object\/upload\/sign\/([^/]+)\/(.+)$/);
    if (method === 'PUT' && storageUploadMatch) {
      const bucket = decodeURIComponent(storageUploadMatch[1]!);
      const objectPath = storageUploadMatch[2]!.split('/').map(decodeURIComponent).join('/');
      const token = query.token ?? getHeader(req.headers, 'authorization')?.replace(/^Bearer\s+/i, '');
      if (!token) {
        throw Problems.unauthorized('Missing signed storage upload token.');
      }
      verifyLocalStorageToken(token, 'upload', bucket, objectPath);

      const binaryBuffer =
        req.rawBody ??
        (Buffer.isBuffer(req.body)
          ? req.body
          : typeof req.body === 'string'
          ? Buffer.from(req.body, 'binary')
          : Buffer.alloc(0));

      if (binaryBuffer.byteLength === 0) {
        throw Problems.validation('Uploaded binary payload cannot be empty.');
      }
      if (binaryBuffer.byteLength > 10_485_760) {
        throw Problems.payloadTooLarge('Uploaded object exceeds 10 MB maximum size.');
      }

      const contentType = getHeader(req.headers, 'content-type') ?? 'application/octet-stream';
      await getStorageProvider().putObjectBytes(bucket, objectPath, binaryBuffer, contentType);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        body: { Key: `${bucket}/${objectPath}`, byte_size: binaryBuffer.byteLength },
      };
    }

    const storageDownloadMatch = pathname.match(/^\/v1\/storage\/object\/sign\/([^/]+)\/(.+)$/);
    if (method === 'GET' && storageDownloadMatch) {
      const bucket = decodeURIComponent(storageDownloadMatch[1]!);
      const objectPath = storageDownloadMatch[2]!.split('/').map(decodeURIComponent).join('/');
      const token = query.token;
      if (!token) {
        throw Problems.unauthorized('Missing signed storage download token.');
      }
      verifyLocalStorageToken(token, 'download', bucket, objectPath);

      const bytes = await getStorageProvider().getObjectBytes(bucket, objectPath);
      const mimeType = objectPath.endsWith('.webp')
        ? 'image/webp'
        : objectPath.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';

      return {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'private, max-age=900',
          'X-Request-ID': requestId,
        },
        body: bytes,
      };
    }

    // -------------------------------------------------------------------------
    // Authenticated Endpoints (Require valid Supabase Auth Bearer JWT verified via JWKS)
    // -------------------------------------------------------------------------
    const claims = await authenticateRequest(req.headers);
    const userId = claims.sub;
    actorUserId = userId;
    const idemKey = getHeader(req.headers, 'idempotency-key');

    return await withServiceTransaction<ApiResponse>(async (client): Promise<ApiResponse> => {
      // 1. GET /v1/me/bootstrap
      if (method === 'GET' && pathname === '/v1/me/bootstrap') {
        await enforceRateLimit(client, userId, { scope: 'bootstrap', maxHits: 60, windowSeconds: 60 });
        const body = await getBootstrap(client, userId);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      // 2. GET / PATCH /v1/me/profile
      if (pathname === '/v1/me/profile') {
        if (method === 'GET') {
          await assertActiveAccount(client, userId);
          const profile = await hydrateProfileDTO(client, userId, userId);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: { data: profile },
          };
        }
        if (method === 'PATCH') {
          await enforceRateLimit(client, userId, { scope: 'me:profile', maxHits: 30, windowSeconds: 60 });
          const res = await updateMyProfile(
            client,
            userId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as Parameters<typeof updateMyProfile>[3]
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
      }

      // 3. GET / PATCH /v1/me/settings
      if (pathname === '/v1/me/settings') {
        await assertActiveAccount(client, userId);
        if (method === 'GET') {
          const sRes = await client.query(
            `SELECT * FROM public.user_settings WHERE user_id = $1`,
            [userId]
          );
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: { data: sRes.rows[0] ?? null },
          };
        }
        if (method === 'PATCH') {
          await enforceRateLimit(client, userId, { scope: 'me:settings', maxHits: 30, windowSeconds: 60 });
          const patch = (req.body ?? {}) as {
            discovery_radius_km?: number;
            discovery_visible?: boolean;
            show_age?: boolean;
            show_distance?: boolean;
            show_online_status?: boolean;
            push_enabled?: boolean;
            push_messages?: boolean;
            push_message_preview?: boolean;
            push_workouts?: boolean;
            push_social?: boolean;
            quiet_hours_start?: string | null;
            quiet_hours_end?: string | null;
            timezone?: string;
          };
          if (
            patch.discovery_radius_km !== undefined &&
            (patch.discovery_radius_km < 1 || patch.discovery_radius_km > 100)
          ) {
            throw Problems.validation('discovery_radius_km must be between 1 and 100.', [
              { field: 'discovery_radius_km', reason: 'out_of_bounds' },
            ]);
          }
          const uRes = await client.query(
            `UPDATE public.user_settings
             SET
               discovery_radius_km = COALESCE($2, discovery_radius_km),
               discovery_visible = COALESCE($3, discovery_visible),
               show_age = COALESCE($4, show_age),
               show_distance = COALESCE($5, show_distance),
               show_online_status = COALESCE($6, show_online_status),
               push_enabled = COALESCE($7, push_enabled),
               push_messages = COALESCE($8, push_messages),
               push_message_preview = COALESCE($9, push_message_preview),
               push_workouts = COALESCE($10, push_workouts),
               push_social = COALESCE($11, push_social),
               quiet_hours_start = CASE WHEN $12::boolean THEN $13::time ELSE quiet_hours_start END,
               quiet_hours_end = CASE WHEN $14::boolean THEN $15::time ELSE quiet_hours_end END,
               timezone = COALESCE($16, timezone),
               version = version + 1
             WHERE user_id = $1
             RETURNING *`,
            [
              userId,
              patch.discovery_radius_km ?? null,
              patch.discovery_visible ?? null,
              patch.show_age ?? null,
              patch.show_distance ?? null,
              patch.show_online_status ?? null,
              patch.push_enabled ?? null,
              patch.push_messages ?? null,
              patch.push_message_preview ?? null,
              patch.push_workouts ?? null,
              patch.push_social ?? null,
              patch.quiet_hours_start !== undefined,
              patch.quiet_hours_start ?? null,
              patch.quiet_hours_end !== undefined,
              patch.quiet_hours_end ?? null,
              patch.timezone ?? null,
            ]
          );
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: { data: uRes.rows[0] },
          };
        }
      }

      // 4. PUT /v1/me/location
      if (method === 'PUT' && pathname === '/v1/me/location') {
        const res = await updateMyLocationCommand(
          client,
          userId,
          (req.body ?? {}) as { latitude: number; longitude: number; accuracy_m?: number }
        );
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res,
        };
      }

      // 5. Media Upload Intents & Complete
      if (method === 'POST' && pathname === '/v1/me/photos/upload-intents') {
        await enforceRateLimit(client, userId, { scope: 'media:intent', maxHits: 20, windowSeconds: 86400 });
        const res = await createUploadIntentCommand(
          client,
          userId,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof createUploadIntentCommand>[3]
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const photoCompleteMatch = pathname.match(/^\/v1\/me\/photos\/([0-9a-f-]+)\/complete$/i);
      if (method === 'POST' && photoCompleteMatch) {
        const res = await completeUploadCommand(
          client,
          userId,
          photoCompleteMatch[1]!,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof completeUploadCommand>[4]
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const mediaUrlMatch = pathname.match(/^\/v1\/media\/([0-9a-f-]+)\/url$/i);
      if (method === 'GET' && mediaUrlMatch) {
        const variant = (query.variant as 'thumb_256' | 'medium_1024' | 'full_2048' | undefined) ?? 'medium_1024';
        const signed = await getAuthorizedMediaUrl(client, userId, mediaUrlMatch[1]!, variant);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: { data: signed },
        };
      }

      // 7. Public Profiles & Block/Unblock
      const profileMatch = pathname.match(/^\/v1\/profiles\/([0-9a-f-]+)$/i);
      if (method === 'GET' && profileMatch) {
        await enforceRateLimit(client, userId, { scope: 'profiles:read', maxHits: 120, windowSeconds: 60 });
        const body = await getPublicProfile(client, userId, profileMatch[1]!);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const blockMatch = pathname.match(/^\/v1\/profiles\/([0-9a-f-]+)\/block$/i);
      if (blockMatch) {
        const targetId = blockMatch[1]!;
        if (method === 'POST') {
          await enforceRateLimit(client, userId, { scope: 'profiles:block', maxHits: 60, windowSeconds: 86400 });
          const res = await blockUserCommand(
            client,
            userId,
            targetId,
            validateIdempotencyKeyHeader(idemKey),
            ((req.body ?? {}) as { reason?: string }).reason,
            requestId
          );
          return {
            status: res.statusCode,
            headers: { 'X-Request-ID': requestId },
            body: null,
          };
        }
        if (method === 'DELETE') {
          await unblockUserCommand(client, userId, targetId, requestId);
          return {
            status: 204,
            headers: { 'X-Request-ID': requestId },
            body: null,
          };
        }
      }

      // 8. Discover Candidates & Actions
      if (method === 'GET' && pathname === '/v1/discover') {
        await enforceRateLimit(client, userId, { scope: 'discover:read', maxHits: 60, windowSeconds: 60 });
        const radiusKm = query.radius_km ? Number(query.radius_km) : undefined;
        if (radiusKm !== undefined && (Number.isNaN(radiusKm) || radiusKm < 1 || radiusKm > 100)) {
          throw Problems.validation('radius_km must be between 1 and 100.', [
            { field: 'radius_km', reason: 'out_of_bounds' },
          ]);
        }
        const body = await getDiscoverCandidatesQuery(client, userId, {
          radius_km: radiusKm,
          gym_id: query.gym_id,
          preferred_time: query.preferred_time,
          gender: query.gender,
          interest_id: query.interest_id,
          cursor: query.cursor,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const discoverActionMatch = pathname.match(/^\/v1\/discover\/([0-9a-f-]+)\/actions$/i);
      if (method === 'POST' && discoverActionMatch) {
        await enforceRateLimit(client, userId, { scope: 'discover:action', maxHits: 120, windowSeconds: 86400 });
        const res = await discoverActionCommand(
          client,
          userId,
          discoverActionMatch[1]!,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as { action: 'pass' | 'connect' | 'hide' }
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      // 9. Feed & Posts & Interactions
      if (method === 'GET' && pathname === '/v1/feed') {
        await enforceRateLimit(client, userId, { scope: 'feed:read', maxHits: 120, windowSeconds: 60 });
        const body = await getFeedQuery(client, userId, {
          mode: (query.mode as 'for_you' | 'following') ?? 'for_you',
          type: query.type as 'text' | 'recipe' | 'workout' | undefined,
          cursor: query.cursor,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      if (method === 'POST' && pathname === '/v1/posts') {
        await enforceRateLimit(client, userId, { scope: 'posts:create', maxHits: 30, windowSeconds: 3600 });
        const res = await createPostCommand(
          client,
          userId,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof createPostCommand>[3]
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const postMatch = pathname.match(/^\/v1\/posts\/([0-9a-f-]+)$/i);
      if (postMatch) {
        const postId = postMatch[1]!;
        if (method === 'GET') {
          const canView = await client.query<{ ok: boolean }>(
            `SELECT public.can_view_post($1, $2) AS ok`,
            [userId, postId]
          );
          if (!canView.rows[0]?.ok) throw Problems.notFound('Post');
          const data = await hydratePostDTO(client, postId, userId);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: { data },
          };
        }
        if (method === 'PATCH') {
          const res = await updatePostCommand(
            client,
            userId,
            postId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as { body: string; visibility?: 'community' | 'connections' | 'private'; version: number }
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
        if (method === 'DELETE') {
          await deletePostCommand(client, userId, postId);
          return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
        }
      }

      const postLikeMatch = pathname.match(/^\/v1\/posts\/([0-9a-f-]+)\/like$/i);
      if (postLikeMatch && (method === 'PUT' || method === 'DELETE')) {
        await enforceRateLimit(client, userId, { scope: 'posts:like', maxHits: 300, windowSeconds: 3600 });
        const body = await toggleLikePostCommand(client, userId, postLikeMatch[1]!, method === 'PUT');
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const postSaveMatch = pathname.match(/^\/v1\/posts\/([0-9a-f-]+)\/save$/i);
      if (postSaveMatch && (method === 'PUT' || method === 'DELETE')) {
        await toggleSavePostCommand(client, userId, postSaveMatch[1]!, method === 'PUT');
        return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
      }

      const postCommentsMatch = pathname.match(/^\/v1\/posts\/([0-9a-f-]+)\/comments$/i);
      if (postCommentsMatch) {
        const postId = postCommentsMatch[1]!;
        if (method === 'GET') {
          const body = await listCommentsQuery(client, userId, postId, {
            cursor: query.cursor,
            limit: query.limit ? Number(query.limit) : undefined,
          });
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body,
          };
        }
        if (method === 'POST') {
          await enforceRateLimit(client, userId, { scope: 'comments:create', maxHits: 60, windowSeconds: 3600 });
          const res = await createCommentCommand(
            client,
            userId,
            postId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as { body: string; parent_id?: string | null }
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
      }

      const commentMatch = pathname.match(/^\/v1\/comments\/([0-9a-f-]+)$/i);
      if (commentMatch) {
        const commentId = commentMatch[1]!;
        if (method === 'DELETE') {
          await deleteCommentCommand(client, userId, commentId);
          return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
        }
        if (method === 'PATCH') {
          const body = (req.body ?? {}) as { body: string; version: number };
          const upd = await client.query<{ id: string; body: string; version: string }>(
            `UPDATE public.comments
             SET body = $3, version = version + 1
             WHERE id = $1 AND author_id = $2 AND version = $4 AND deleted_at IS NULL
             RETURNING id, body, version::text`,
            [commentId, userId, (body.body ?? '').trim(), body.version]
          );
          if (upd.rowCount === 0) throw Problems.versionConflict();
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: { data: { ...upd.rows[0], version: Number(upd.rows[0]!.version) } },
          };
        }
      }

      // 10. Search
      if (method === 'GET' && pathname === '/v1/search') {
        await enforceRateLimit(client, userId, { scope: 'search', maxHits: 30, windowSeconds: 60 });
        const body = await searchQuery(client, userId, {
          q: query.q,
          type: query.type as 'people' | 'posts' | 'recipes' | undefined,
          max_calories: query.max_calories ? Number(query.max_calories) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      // 11. Conversations & Chat Messages
      if (pathname === '/v1/conversations') {
        if (method === 'GET') {
          const body = await listConversationsQuery(client, userId, {
            archived: query.archived === 'true',
          });
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body,
          };
        }
        if (method === 'POST') {
          const body = (req.body ?? {}) as { participant_id: string };
          const res = await getOrCreateDirectConversationCommand(
            client,
            userId,
            validateIdempotencyKeyHeader(idemKey),
            body.participant_id
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
      }

      const convMemberMatch = pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/membership$/i);
      if (method === 'PATCH' && convMemberMatch) {
        const res = await updateConversationMembershipCommand(
          client,
          userId,
          convMemberMatch[1]!,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as { pinned?: boolean; archived?: boolean; clear_history?: boolean; version: number }
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const convMessagesMatch = pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/messages$/i);
      if (convMessagesMatch) {
        const convId = convMessagesMatch[1]!;
        if (method === 'GET') {
          await enforceRateLimit(client, userId, { scope: 'messages:read', maxHits: 240, windowSeconds: 60 });
          const body = await getMessagesQuery(client, userId, convId, {
            before_seq: query.before_seq ? Number(query.before_seq) : undefined,
            after_seq: query.after_seq !== undefined ? Number(query.after_seq) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
          });
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body,
          };
        }
        if (method === 'POST') {
          await enforceRateLimit(client, userId, { scope: 'messages:send', maxHits: 60, windowSeconds: 60 });
          const res = await sendMessageCommand(
            client,
            userId,
            convId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as Parameters<typeof sendMessageCommand>[4]
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
      }

      const convReadMatch = pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/read-state$/i);
      if (method === 'PUT' && convReadMatch) {
        await enforceRateLimit(client, userId, { scope: 'messages:read_state', maxHits: 120, windowSeconds: 60 });
        const body = (req.body ?? {}) as { last_read_seq: number };
        const res = await updateReadStateCommand(client, userId, convReadMatch[1]!, body.last_read_seq);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res,
        };
      }

      const convTypingMatch = pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/typing$/i);
      if (method === 'POST' && convTypingMatch) {
        await enforceRateLimit(client, userId, { scope: 'messages:typing', maxHits: 30, windowSeconds: 60 });
        await assertConversationMemberAndUnblocked(client, userId, convTypingMatch[1]!);
        const body = (req.body ?? {}) as { is_typing?: boolean };
        realtimeHub.emitTyping(convTypingMatch[1]!, userId, Boolean(body.is_typing));
        return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
      }

      // 12. Workout Sessions & Invitations
      if (method === 'POST' && pathname === '/v1/workout-sessions') {
        await enforceRateLimit(client, userId, { scope: 'workouts:create', maxHits: 20, windowSeconds: 86400 });
        const res = await createWorkoutSessionCommand(
          client,
          userId,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof createWorkoutSessionCommand>[3]
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const sessionMatch = pathname.match(/^\/v1\/workout-sessions\/([0-9a-f-]+)$/i);
      if (sessionMatch) {
        const sessionId = sessionMatch[1]!;
        if (method === 'GET') {
          const body = await getWorkoutSessionQuery(client, userId, sessionId);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body,
          };
        }
        if (method === 'PATCH') {
          const res = await updateWorkoutSessionCommand(
            client,
            userId,
            sessionId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as Parameters<typeof updateWorkoutSessionCommand>[4]
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
      }

      const sessionInviteMatch = pathname.match(/^\/v1\/workout-sessions\/([0-9a-f-]+)\/invitations$/i);
      if (method === 'POST' && sessionInviteMatch) {
        await enforceRateLimit(client, userId, { scope: 'workouts:invite', maxHits: 50, windowSeconds: 86400 });
        const res = await createWorkoutInvitationCommand(
          client,
          userId,
          sessionInviteMatch[1]!,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof createWorkoutInvitationCommand>[4]
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      const invTransitionMatch = pathname.match(
        /^\/v1\/workout-invitations\/([0-9a-f-]+)\/(accept|decline|revoke)$/i
      );
      if (method === 'POST' && invTransitionMatch) {
        const res = await transitionWorkoutInvitationCommand(
          client,
          userId,
          invTransitionMatch[1]!,
          invTransitionMatch[2]!.toLowerCase() as 'accept' | 'decline' | 'revoke',
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as { version: number }
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      if (method === 'GET' && pathname === '/v1/me/workout-sessions') {
        const body = await listMyWorkoutSessionsQuery(client, userId, {
          state: (query.state as 'upcoming' | 'history') ?? 'upcoming',
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      // 13. Notifications & Push Devices
      if (method === 'GET' && pathname === '/v1/notifications') {
        const body = await listNotifications(client, userId, {
          cursor: query.cursor,
          limit: query.limit ? Number(query.limit) : undefined,
          unreadOnly: query.unread_only === 'true',
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const notifReadMatch = pathname.match(/^\/v1\/notifications\/([0-9a-f-]+)\/read$/i);
      if (method === 'PUT' && notifReadMatch) {
        await markNotificationReadCommand(client, userId, notifReadMatch[1]!);
        return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
      }

      if (method === 'POST' && pathname === '/v1/push-devices') {
        await enforceRateLimit(client, userId, { scope: 'push:register', maxHits: 20, windowSeconds: 86400 });
        const body = await registerPushDeviceCommand(
          client,
          userId,
          (req.body ?? {}) as Parameters<typeof registerPushDeviceCommand>[2]
        );
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const pushDeleteMatch = pathname.match(/^\/v1\/push-devices\/([0-9a-f-]+)$/i);
      if (method === 'DELETE' && pushDeleteMatch) {
        await revokePushDeviceCommand(client, userId, pushDeleteMatch[1]!);
        return { status: 204, headers: { 'X-Request-ID': requestId }, body: null };
      }

      // 14. Reports
      if (method === 'POST' && pathname === '/v1/reports') {
        await enforceRateLimit(client, userId, { scope: 'reports:create', maxHits: 20, windowSeconds: 86400 });
        const res = await createReportCommand(
          client,
          userId,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof createReportCommand>[3],
          requestId
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      // 15. GDPR Data Export & Account Deletion
      if (method === 'POST' && pathname === '/v1/me/data-export') {
        await enforceRateLimit(client, userId, { scope: 'me:export', maxHits: 2, windowSeconds: 86400 });
        const reqHash = computeRequestHash('POST', '/v1/me/data-export', req.body);
        const res = await executeIdempotentCommand(client, {
          scope: 'POST:/v1/me/data-export',
          userId,
          idempotencyKey: validateIdempotencyKeyHeader(idemKey),
          requestHash: reqHash,
          execute: async () => {
            const existing = await client.query<{ id: string }>(
              `SELECT id FROM public.account_exports WHERE user_id = $1 AND status IN ('requested', 'processing')`,
              [userId]
            );
            if (existing.rowCount && existing.rowCount > 0) {
              throw Problems.conflict('EXPORT_ALREADY_PENDING', 'Export already pending', 'A data export job is already running.');
            }
            const ins = await client.query<{ id: string; status: string; requested_at: Date }>(
              `INSERT INTO public.account_exports (user_id, status) VALUES ($1, 'requested')
               RETURNING id, status::text, requested_at`,
              [userId]
            );
            return {
              statusCode: 202,
              body: {
                data: {
                  id: ins.rows[0]!.id,
                  status: ins.rows[0]!.status,
                  requested_at: ins.rows[0]!.requested_at.toISOString(),
                },
              },
            };
          },
        });
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      if (pathname === '/v1/me/account-deletion') {
        if (method === 'POST') {
          await enforceRateLimit(client, userId, { scope: 'me:delete', maxHits: 3, windowSeconds: 86400 });
          const res = await requestAccountDeletionCommand(
            client,
            userId,
            validateIdempotencyKeyHeader(idemKey),
            (req.body ?? {}) as { confirmation: string; reason?: string },
            requestId
          );
          return {
            status: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: res.body,
          };
        }
        if (method === 'DELETE') {
          const res = await cancelAccountDeletionCommand(
            client,
            userId,
            validateIdempotencyKeyHeader(idemKey),
            requestId
          );
          return {
            status: res.statusCode,
            headers: { 'X-Request-ID': requestId },
            body: null,
          };
        }
      }

      // 16. Admin & Moderation Endpoints
      if (method === 'GET' && pathname === '/v1/admin/reports') {
        const body = await listAdminReportsQuery(client, userId, {
          status: query.status,
          limit: query.limit ? Number(query.limit) : undefined,
          requestId,
        });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body,
        };
      }

      const adminActionMatch = pathname.match(/^\/v1\/admin\/cases\/([0-9a-f-]+)\/actions$/i);
      if (method === 'POST' && adminActionMatch) {
        const res = await executeModerationActionCommand(
          client,
          userId,
          adminActionMatch[1]!,
          validateIdempotencyKeyHeader(idemKey),
          (req.body ?? {}) as Parameters<typeof executeModerationActionCommand>[4],
          requestId
        );
        return {
          status: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: res.body,
        };
      }

      throw Problems.notFound('Endpoint', 'ENDPOINT_NOT_FOUND');
    });
  } catch (err) {
    const latencyMs = Number((performance.now() - startMs).toFixed(2));
    observability.recordLatency(latencyMs);

    if (err instanceof AppProblem) {
      observability.increment('http_errors_4xx_total');
      observability.log('warn', err.title, {
        request_id: requestId,
        user_id: actorUserId,
        route: pathname,
        method,
        status: err.status,
        latency_ms: latencyMs,
        context: { code: err.code },
      });
      return {
        status: err.status,
        headers: {
          'Content-Type': 'application/problem+json',
          'X-Request-ID': requestId,
          ...(err.headers ?? {}),
        },
        body: err.toJSON(requestId),
      };
    }

    observability.increment('http_errors_5xx_total');
    observability.log('error', (err as Error).message ?? 'Internal server error', {
      request_id: requestId,
      user_id: actorUserId,
      route: pathname,
      method,
      status: 500,
      latency_ms: latencyMs,
    });

    const internalProblem = new AppProblem({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      title: 'Internal server error',
      detail: 'An unexpected error occurred.',
    });
    return {
      status: 500,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Request-ID': requestId,
      },
      body: internalProblem.toJSON(requestId),
    };
  }
}
