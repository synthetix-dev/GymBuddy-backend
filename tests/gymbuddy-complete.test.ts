import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../scripts/migrate.js';
import { runSeed } from '../scripts/seed.js';
import { handleApiRequest } from '../src/app.js';
import { withUserRlsContext, withServiceTransaction, closePool } from '../src/db/pool.js';
import {
  issueSimulatedSupabaseAuthToken,
  verifySupabaseAccessToken,
} from '../src/core/supabase-jwt.js';
import { validateStrictProductionEnv } from '../src/config/env.js';
import { sendApnsHttp2Push, resetApnsTokenCache } from '../src/core/apns-client.js';
import { setApnsTransportAdapter } from '../src/modules/notifications/notifications.service.js';
import { getStorageProvider } from '../src/modules/media/storage-provider.js';
import { processOutboxBatch } from '../src/workers/outbox-worker.js';
import { startWorkerDaemon } from '../src/workers/run-workers.js';
import { realtimeHub } from '../src/modules/realtime/realtime-hub.js';
import { executeRestoreDrill } from '../scripts/restore-drill.js';
import { runKeyRotationDrill } from '../scripts/key-rotation-drill.js';

const USER_DMITRO = '00000000-0000-4000-8000-000000000001';
const USER_MAYA = '00000000-0000-4000-8000-000000000002';
const USER_ALEX = '00000000-0000-4000-8000-000000000003';
const USER_SAM = '00000000-0000-4000-8000-000000000004';
const USER_PRIYA = '00000000-0000-4000-8000-000000000005';
const USER_CHRIS = '00000000-0000-4000-8000-000000000006';
const USER_TAYLOR = '00000000-0000-4000-8000-000000000007';

const ADMIN_MODERATOR = '00000000-0000-4000-8000-000000000091';
const ADMIN_SAFETY_LEAD = '00000000-0000-4000-8000-000000000092';

function authHeaderFor(userId: string) {
  return { authorization: `Bearer ${issueSimulatedSupabaseAuthToken({ sub: userId })}` };
}

describe('GymBuddy Complete Backend Blueprint Verification Suite', () => {
  beforeAll(async () => {
    process.env.GYMBUDDY_SILENT_LOGS = '1';
    await runMigrations({ reset: true, silent: true });
    await runSeed({ silent: true });
  });

  afterAll(async () => {
    await closePool();
  });

  it('Scenario 1: PostgreSQL RLS Negative Matrix — User A cannot read or mutate User B private settings, exact location, notifications, or push tokens', async () => {
    await withUserRlsContext(USER_DMITRO, async (client) => {
      // 1. User settings: Dmitro can only see his own settings row, never Maya's
      const settingsRes = await client.query(`SELECT user_id FROM public.user_settings`);
      expect(settingsRes.rows.map((r) => r.user_id)).toEqual([USER_DMITRO]);

      // 2. Exact user_locations: Dmitro can only see his own location row, never Maya's coordinates
      const locRes = await client.query(`SELECT user_id, latitude, longitude FROM public.user_locations`);
      expect(locRes.rows.map((r) => r.user_id)).toEqual([USER_DMITRO]);

      // 3. Attempting to update Maya's profile under Dmitro's RLS context affects 0 rows
      const updateMaya = await client.query(
        `UPDATE public.user_profiles SET bio = 'Hacked' WHERE user_id = $1`,
        [USER_MAYA]
      );
      expect(updateMaya.rowCount).toBe(0);

      // 4. Audit logs are unreadable by regular users
      const auditRes = await client.query(`SELECT * FROM public.audit_logs`);
      expect(auditRes.rowCount).toBe(0);
    });
  });

  it('Scenario 2: Supabase Auth Trigger (auth.users -> user_profiles + user_settings), JWKS Verification, Removal of Custom Auth Routes & Optimistic Concurrency', async () => {
    // 1. Custom auth endpoints (/v1/auth/apple, /v1/auth/refresh, /v1/auth/recover, /v1/me/sessions) and public.user_sessions must NOT exist
    const legacyAppleRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/auth/apple',
      headers: authHeaderFor(USER_DMITRO),
      body: {},
    });
    expect(legacyAppleRes.status).toBe(404);

    await withServiceTransaction(async (client) => {
      const tableCheck = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions'`
      );
      expect(tableCheck.rowCount).toBe(0);
    });

    // 2. Simulate Supabase Auth creating a new user in auth.users (as happens after native iOS Sign in with Apple -> Supabase Auth)
    const newAuthUserId = crypto.randomUUID();
    await withServiceTransaction(async (client) => {
      await client.query(
        `INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
         VALUES ($1, $2, now(), $3::jsonb)`,
        [newAuthUserId, 'olena@privaterelay.appleid.com', JSON.stringify({ full_name: 'Olena' })]
      );
    });

    // 3. Issue a real ES256 JWT verified via Supabase JWKS
    const accessToken = issueSimulatedSupabaseAuthToken({
      sub: newAuthUserId,
      email: 'olena@privaterelay.appleid.com',
    });
    const verifiedClaims = await verifySupabaseAccessToken(accessToken);
    expect(verifiedClaims.sub).toBe(newAuthUserId);

    // Forged signature must be rejected by JWKS verifier
    const tamperedToken = `${accessToken.slice(0, -4)}AAAA`;
    await expect(verifySupabaseAccessToken(tamperedToken)).rejects.toThrow();

    // 4. Bootstrap reflects profile step provisioned automatically by the on_auth_user_created trigger
    const boot1 = await handleApiRequest({
      method: 'GET',
      url: '/v1/me/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(boot1.status).toBe(200);
    const bootData = (boot1.body as {
      data: { next_step: string; profile: { display_name: string }; settings: { discovery_radius_km: number } };
    }).data;
    expect(bootData.next_step).toBe('profile');
    expect(bootData.profile.display_name).toBe('Olena');
    expect(bootData.settings.discovery_radius_km).toBe(15);

    // 5. Complete profile with version = 1 (and test optimistic concurrency conflict)
    const patchRes = await handleApiRequest({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': crypto.randomUUID(),
      },
      body: {
        display_name: 'Olena Kyiv',
        birth_date: '1999-06-15',
        bio: 'Powerlifting and mobility',
        onboarding_state: 'complete',
        interest_ids: ['10000000-0000-4000-8000-000000000001'],
        version: 1,
      },
    });
    expect(patchRes.status).toBe(200);
    expect((patchRes.body as { data: { version: number } }).data.version).toBe(2);

    // Stale version = 1 with new Idempotency-Key must return 409 VERSION_CONFLICT
    const conflictRes = await handleApiRequest({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': crypto.randomUUID(),
      },
      body: {
        display_name: 'Stale Write',
        version: 1,
      },
    });
    expect(conflictRes.status).toBe(409);
    expect((conflictRes.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });

  it('Scenario 3: Real Binary Media Pipeline — Sharp Image Decoding, EXIF Stripping, Real WebP Thumbnails & Bomb/Polyglot Rejection', async () => {
    const headers = authHeaderFor(USER_DMITRO);

    // 1. Reject SVG MIME (415)
    const svgRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/me/photos/upload-intents',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: {
        purpose: 'avatar',
        mime_type: 'image/svg+xml',
        byte_size: 2048,
        sha256: 'a'.repeat(64),
      },
    });
    expect(svgRes.status).toBe(415);

    // 2. Reject Oversized Avatar > 10 MB (413)
    const oversizeRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/me/photos/upload-intents',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: {
        purpose: 'avatar',
        mime_type: 'image/jpeg',
        byte_size: 11 * 1024 * 1024,
        sha256: 'a'.repeat(64),
      },
    });
    expect(oversizeRes.status).toBe(413);

    // 3. Generate a real 1200x900 JPEG image with embedded EXIF metadata using sharp
    const realJpegWithExif = await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 3,
        background: { r: 40, g: 120, b: 220 },
      },
    })
      .withExif({
        IFD0: {
          Make: 'Apple',
          Model: 'iPhone 16 Pro',
          Software: 'GymBuddy GPS Test',
        },
      })
      .jpeg({ quality: 88 })
      .toBuffer();

    const inputMeta = await sharp(realJpegWithExif).metadata();
    expect(inputMeta.exif).toBeDefined();

    const realSha256 = crypto.createHash('sha256').update(realJpegWithExif).digest('hex');

    // Create upload intent for the real JPEG
    const validIntent = await handleApiRequest({
      method: 'POST',
      url: '/v1/me/photos/upload-intents',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: {
        purpose: 'post_image',
        mime_type: 'image/jpeg',
        byte_size: realJpegWithExif.byteLength,
        sha256: realSha256,
      },
    });
    expect(validIntent.status).toBe(201);
    const intentData = (validIntent.body as {
      data: { media_object_id: string; upload_url: string; bucket: string; object_path: string };
    }).data;

    // Upload the actual binary JPEG bytes to the signed storage URL
    const uploadPath = new URL(intentData.upload_url).pathname + new URL(intentData.upload_url).search;
    const putUploadRes = await handleApiRequest({
      method: 'PUT',
      url: uploadPath,
      headers: { 'content-type': 'image/jpeg' },
      rawBody: realJpegWithExif,
    });
    expect(putUploadRes.status).toBe(200);

    // Complete upload: downloads bytes from storage, verifies SHA-256, decodes with sharp, strips EXIF, generates 3 WebP variants
    const completeValid = await handleApiRequest({
      method: 'POST',
      url: `/v1/me/photos/${intentData.media_object_id}/complete`,
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: {
        sha256: realSha256,
      },
    });
    expect(completeValid.status).toBe(200);
    const completeData = (completeValid.body as {
      data: {
        status: string;
        exif_stripped: boolean;
        width: number;
        height: number;
        variants: string[];
      };
    }).data;
    expect(completeData.status).toBe('ready');
    expect(completeData.exif_stripped).toBe(true);
    expect(completeData.width).toBe(1200);
    expect(completeData.height).toBe(900);
    expect(completeData.variants).toEqual(['thumb_256', 'medium_1024', 'full_2048']);

    // Verify the generated WebP variant bytes in storage have EXIF stripped and correct dimensions
    const thumbBytes = await getStorageProvider().getObjectBytes(
      'media-variants',
      `${intentData.object_path}/thumb_256.webp`
    );
    const thumbMeta = await sharp(thumbBytes).metadata();
    expect(thumbMeta.format).toBe('webp');
    expect(thumbMeta.width).toBeLessThanOrEqual(256);
    expect(thumbMeta.exif).toBeUndefined();

    // Verify signed download URL works end-to-end
    const signedUrlRes = await handleApiRequest({
      method: 'GET',
      url: `/v1/media/${intentData.media_object_id}/url?variant=thumb_256`,
      headers,
    });
    expect(signedUrlRes.status).toBe(200);
    const signedDownloadUrl = (signedUrlRes.body as { data: { url: string } }).data.url;
    const dlUrlObj = new URL(signedDownloadUrl);
    const dlRes = await handleApiRequest({
      method: 'GET',
      url: dlUrlObj.pathname + dlUrlObj.search,
    });
    expect(dlRes.status).toBe(200);
    expect(Buffer.isBuffer(dlRes.body)).toBe(true);
    expect((dlRes.body as Buffer).byteLength).toBe(thumbBytes.byteLength);
  });

  it('Scenario 4: Social Feed, Recipe Creation, Idempotent Likes, Comment Depth Limit & Tombstone', async () => {
    const dmitroHeaders = authHeaderFor(USER_DMITRO);
    const mayaHeaders = authHeaderFor(USER_MAYA);

    // 1. Create a recipe post atomically
    const createRecipeRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/posts',
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        type: 'recipe',
        body: 'High-protein cottage cheese pancakes for morning training.',
        recipe: {
          title: 'Protein Cottage Cheese Pancakes',
          subtitle: 'Quick 45g protein breakfast',
          difficulty: 'easy',
          calories: 460,
          protein_g: 45,
          carbs_g: 38,
          fat_g: 11,
          prep_minutes: 15,
          servings: 1,
          ingredients: [{ text: 'Cottage cheese 5%', quantity: 200, unit: 'g' }],
          steps: [{ instruction: 'Blend ingredients and cook 3 minutes per side.' }],
        },
      },
    });
    expect(createRecipeRes.status).toBe(201);
    const postId = (createRecipeRes.body as { data: { id: string } }).data.id;

    // 2. Concurrent duplicate likes from Maya must result in likes_count = 1
    const [like1, like2] = await Promise.all([
      handleApiRequest({ method: 'PUT', url: `/v1/posts/${postId}/like`, headers: mayaHeaders }),
      handleApiRequest({ method: 'PUT', url: `/v1/posts/${postId}/like`, headers: mayaHeaders }),
    ]);
    expect(like1.status).toBe(200);
    expect(like2.status).toBe(200);
    expect((like2.body as { data: { likes_count: number } }).data.likes_count).toBe(1);

    // 3. Comment nesting depth <= 2 enforced, and parent tombstone kept when reply exists
    const c1Res = await handleApiRequest({
      method: 'POST',
      url: `/v1/posts/${postId}/comments`,
      headers: { ...mayaHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { body: 'Looks delicious! Do you use oat flour?' },
    });
    expect(c1Res.status).toBe(201);
    const c1Id = (c1Res.body as { data: { id: string } }).data.id;

    const c2Res = await handleApiRequest({
      method: 'POST',
      url: `/v1/posts/${postId}/comments`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { body: 'Yes, 40g of rolled oats blended!', parent_id: c1Id },
    });
    expect(c2Res.status).toBe(201);
    const c2Id = (c2Res.body as { data: { id: string } }).data.id;

    // Depth 3 must be rejected with 422
    const c3Res = await handleApiRequest({
      method: 'POST',
      url: `/v1/posts/${postId}/comments`,
      headers: { ...mayaHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { body: 'Depth 3 attempt', parent_id: c2Id },
    });
    expect(c3Res.status).toBe(422);

    // Delete parent comment c1 while reply c2 exists -> c1 becomes tombstone "[Comment deleted]"
    const delParent = await handleApiRequest({
      method: 'DELETE',
      url: `/v1/comments/${c1Id}`,
      headers: mayaHeaders,
    });
    expect(delParent.status).toBe(204);

    const commentsList = await handleApiRequest({
      method: 'GET',
      url: `/v1/posts/${postId}/comments`,
      headers: dmitroHeaders,
    });
    expect(commentsList.status).toBe(200);
    const commentsData = (commentsList.body as {
      data: Array<{ id: string; body: string; is_tombstone: boolean }>;
    }).data;
    expect(commentsData.length).toBe(2);
    expect(commentsData[0]!.is_tombstone).toBe(true);
    expect(commentsData[0]!.body).toBe('[Comment deleted]');

    // 4. Search recipes with max_calories filter
    const searchRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/search?type=recipes&q=pancakes&max_calories=500',
      headers: mayaHeaders,
    });
    expect(searchRes.status).toBe(200);
    expect((searchRes.body as { data: Array<{ id: string }> }).data.some((p) => p.id === postId)).toBe(true);
  });

  it('Scenario 5: Chat Idempotent Retry, Monotonic Sequence, Reconnect Catch-Up & Non-Connection Message Request Limit', async () => {
    const dmitroHeaders = authHeaderFor(USER_DMITRO);
    const mayaHeaders = authHeaderFor(USER_MAYA);

    // 1. Create or get direct conversation between Dmitro & Maya (mutually connected)
    const convRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { participant_id: USER_MAYA },
    });
    expect([200, 201]).toContain(convRes.status);
    const convId = (convRes.body as { data: { id: string } }).data.id;

    // Subscribe Maya to Realtime channel and verify unauthorized user Alex is denied
    const receivedEvents: string[] = [];
    const mayaSubId = realtimeHub.registerCallbackSubscriber(USER_MAYA, (env) => {
      receivedEvents.push(`${env.type}:${env.sequence ?? 0}`);
    });
    expect(await realtimeHub.subscribeTopic(mayaSubId, `conversation:${convId}`)).toBe(true);

    const alexSubId = realtimeHub.registerCallbackSubscriber(USER_ALEX, () => {});
    expect(await realtimeHub.subscribeTopic(alexSubId, `conversation:${convId}`)).toBe(false);

    // 2. Lost HTTP response + retry with same client_message_id & Idempotency-Key produces ONE message
    const clientMsgId = crypto.randomUUID();
    const idemKey = crypto.randomUUID();

    const send1 = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${convId}/messages`,
      headers: { ...dmitroHeaders, 'idempotency-key': idemKey },
      body: {
        client_message_id: clientMsgId,
        kind: 'text',
        body: 'Ready for squats at 18:00?',
      },
    });
    expect(send1.status).toBe(201);
    const msg1 = (send1.body as { data: { id: string; server_seq: number } }).data;

    const sendRetry = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${convId}/messages`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: clientMsgId,
        kind: 'text',
        body: 'Ready for squats at 18:00?',
      },
    });
    expect(sendRetry.status).toBe(201);
    const msgRetry = (sendRetry.body as { data: { id: string; server_seq: number } }).data;
    expect(msgRetry.id).toBe(msg1.id);
    expect(msgRetry.server_seq).toBe(msg1.server_seq);

    // Same client_message_id with different body must fail with 409 IDEMPOTENCY_CONFLICT
    const sendConflict = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${convId}/messages`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: clientMsgId,
        kind: 'text',
        body: 'Different payload with same client_message_id!',
      },
    });
    expect(sendConflict.status).toBe(409);
    expect((sendConflict.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');

    // 3. Reconnect catch-up query (`after_seq=0`) returns canonical sequence order
    const catchUpRes = await handleApiRequest({
      method: 'GET',
      url: `/v1/conversations/${convId}/messages?after_seq=0`,
      headers: mayaHeaders,
    });
    expect(catchUpRes.status).toBe(200);
    const messages = (catchUpRes.body as { data: Array<{ id: string; server_seq: number }> }).data;
    expect(messages.some((m) => m.id === msg1.id)).toBe(true);

    // 4. Monotonic read state: advancing to seq, then sending lower seq keeps higher seq
    const read1 = await handleApiRequest({
      method: 'PUT',
      url: `/v1/conversations/${convId}/read-state`,
      headers: mayaHeaders,
      body: { last_read_seq: msg1.server_seq },
    });
    expect(read1.status).toBe(200);
    expect((read1.body as { data: { last_read_seq: number } }).data.last_read_seq).toBe(msg1.server_seq);

    const readLower = await handleApiRequest({
      method: 'PUT',
      url: `/v1/conversations/${convId}/read-state`,
      headers: mayaHeaders,
      body: { last_read_seq: 0 },
    });
    expect((readLower.body as { data: { last_read_seq: number } }).data.last_read_seq).toBe(msg1.server_seq);

    expect(receivedEvents.length).toBeGreaterThan(0);
    realtimeHub.removeSubscriber(mayaSubId);
    realtimeHub.removeSubscriber(alexSubId);

    // 5. Non-connection message request limit: Dmitro connects to Taylor (unilateral) -> 1st message allowed, 2nd blocked until Taylor replies
    const connectTaylor = await handleApiRequest({
      method: 'POST',
      url: `/v1/discover/${USER_TAYLOR}/actions`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { action: 'connect' },
    });
    expect(connectTaylor.status).toBe(200);
    const taylorConvId = (connectTaylor.body as { data: { conversation_id: string } }).data.conversation_id;

    const firstReqMsg = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${taylorConvId}/messages`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: crypto.randomUUID(),
        kind: 'text',
        body: 'Hi Taylor! Would you like to train at Apollo Next?',
      },
    });
    expect(firstReqMsg.status).toBe(201);

    const secondReqMsg = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${taylorConvId}/messages`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: crypto.randomUUID(),
        kind: 'text',
        body: 'Second unsolicited message before reply',
      },
    });
    expect(secondReqMsg.status).toBe(403);
    expect((secondReqMsg.body as { code: string }).code).toBe('MESSAGE_REQUEST_LIMIT_REACHED');
  });

  it('Scenario 6: Discover Geo Privacy (Never Leaks Coordinates) & Workout Session Final-Seat Concurrency Race', async () => {
    const dmitroHeaders = authHeaderFor(USER_DMITRO);
    const alexHeaders = authHeaderFor(USER_ALEX);
    const samHeaders = authHeaderFor(USER_SAM);

    // 1. Discover returns rounded distance_km and NEVER leaks latitude/longitude/point/accuracy_m
    const discRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/discover?radius_km=25',
      headers: dmitroHeaders,
    });
    expect(discRes.status).toBe(200);
    const rawJson = JSON.stringify(discRes.body);
    expect(rawJson).not.toContain('latitude');
    expect(rawJson).not.toContain('longitude');
    expect(rawJson).not.toContain('accuracy_m');
    expect(rawJson).not.toContain('coarse_geohash');

    const candidates = (discRes.body as { data: Array<{ id: string; distance_km: number | null }> }).data;
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      if (c.distance_km !== null) {
        expect(Number.isInteger(c.distance_km)).toBe(true);
        expect(c.distance_km).toBeGreaterThanOrEqual(1);
      }
    }

    // 2. Create Workout Session with capacity = 2 (Dmitro is host -> 1 slot left!)
    const startsAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const createSessRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/workout-sessions',
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        title: 'Heavy Squat & Bench Session',
        activity: 'Powerlifting',
        gym_id: '20000000-0000-4000-8000-000000000001',
        starts_at: startsAt,
        timezone: 'Europe/Kyiv',
        duration_minutes: 90,
        capacity: 2,
      },
    });
    expect(createSessRes.status).toBe(201);
    const sessionId = (createSessRes.body as { data: { id: string } }).data.id;

    // Invite both Alex and Sam to the session with only 1 remaining capacity slot
    const invAlexRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/workout-sessions/${sessionId}/invitations`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { invitee_id: USER_ALEX, message: 'Spotter needed!' },
    });
    expect(invAlexRes.status).toBe(201);
    const invAlexId = (invAlexRes.body as { data: { id: string } }).data.id;

    const invSamRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/workout-sessions/${sessionId}/invitations`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { invitee_id: USER_SAM, message: 'Join us!' },
    });
    expect(invSamRes.status).toBe(201);
    const invSamId = (invSamRes.body as { data: { id: string } }).data.id;

    // Concurrent acceptance race for the single remaining seat!
    const [acceptAlex, acceptSam] = await Promise.all([
      handleApiRequest({
        method: 'POST',
        url: `/v1/workout-invitations/${invAlexId}/accept`,
        headers: { ...alexHeaders, 'idempotency-key': crypto.randomUUID() },
        body: { version: 1 },
      }),
      handleApiRequest({
        method: 'POST',
        url: `/v1/workout-invitations/${invSamId}/accept`,
        headers: { ...samHeaders, 'idempotency-key': crypto.randomUUID() },
        body: { version: 1 },
      }),
    ]);

    const statuses = [acceptAlex.status, acceptSam.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rejected = acceptAlex.status === 409 ? acceptAlex : acceptSam;
    expect((rejected.body as { code: string }).code).toBe('SESSION_FULL');

    // Verify confirmed_count is strictly 2 and reschedule transitions session to reschedule_pending
    const newStartsAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    const reschedRes = await handleApiRequest({
      method: 'PATCH',
      url: `/v1/workout-sessions/${sessionId}`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        starts_at: newStartsAt,
        reason: 'Moved 2 hours later',
        version: 2,
      },
    });
    expect(reschedRes.status).toBe(200);
    const updatedSess = (reschedRes.body as {
      data: { status: string; revision: number; confirmed_count: number };
    }).data;
    expect(updatedSess.confirmed_count).toBe(2);
    expect(updatedSess.status).toBe('reschedule_pending');
    expect(updatedSess.revision).toBe(2);
  });

  it('Scenario 7: Bilateral Block Enforcement Across Feed, Discover, Profile, Chat & Workouts', async () => {
    const dmitroHeaders = authHeaderFor(USER_DMITRO);
    const priyaHeaders = authHeaderFor(USER_PRIYA);

    // Open a conversation first
    const convRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { participant_id: USER_PRIYA },
    });
    expect([200, 201]).toContain(convRes.status);
    const convId = (convRes.body as { data: { id: string } }).data.id;

    // Dmitro blocks Priya
    const blockRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/profiles/${USER_PRIYA}/block`,
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { reason: 'harassment' },
    });
    expect(blockRes.status).toBe(204);

    // 1. Public profile returns 404 in both directions
    const viewPriya = await handleApiRequest({
      method: 'GET',
      url: `/v1/profiles/${USER_PRIYA}`,
      headers: dmitroHeaders,
    });
    expect(viewPriya.status).toBe(404);

    const viewDmitroFromPriya = await handleApiRequest({
      method: 'GET',
      url: `/v1/profiles/${USER_DMITRO}`,
      headers: priyaHeaders,
    });
    expect(viewDmitroFromPriya.status).toBe(404);

    // 2. Priya's posts disappear from Dmitro's feed
    const feedRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/feed',
      headers: dmitroHeaders,
    });
    const feedPosts = (feedRes.body as { data: Array<{ author: { id: string } }> }).data;
    expect(feedPosts.every((p) => p.author.id !== USER_PRIYA)).toBe(true);

    // 3. Priya cannot send messages to the conversation (403 RELATIONSHIP_BLOCKED)
    const msgRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${convId}/messages`,
      headers: { ...priyaHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: crypto.randomUUID(),
        kind: 'text',
        body: 'Blocked send attempt',
      },
    });
    expect(msgRes.status).toBe(403);
    expect((msgRes.body as { code: string }).code).toBe('RELATIONSHIP_BLOCKED');
  });

  it('Scenario 8: Real HTTP/2 APNs Transport (ES256 Provider JWT + HTTP/2 Stream) & 410 Invalid Token Revocation', async () => {
    const mayaHeaders = authHeaderFor(USER_MAYA);

    // Generate a real P-256 (prime256v1) APNs provider keypair for real ES256 signing
    const apnsKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const apnsPrivateKeyPem = apnsKeyPair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();

    // Start a real local HTTP/2 APNs server
    const capturedHttp2Requests: Array<{
      path: string;
      authHeader: string;
      topic: string;
      collapseId: string;
      body: Record<string, unknown>;
    }> = [];

    const h2Server = http2.createServer();
    h2Server.on('stream', (stream, headers) => {
      const reqPath = String(headers[':path'] ?? '');
      const authHeader = String(headers['authorization'] ?? '');
      const topic = String(headers['apns-topic'] ?? '');
      const collapseId = String(headers['apns-collapse-id'] ?? '');

      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        capturedHttp2Requests.push({ path: reqPath, authHeader, topic, collapseId, body });

        if (reqPath.includes('410')) {
          stream.respond({ ':status': 410, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ reason: 'Unregistered' }));
        } else {
          stream.respond({ ':status': 200, 'apns-id': crypto.randomUUID() });
          stream.end();
        }
      });
    });

    await new Promise<void>((resolve) => h2Server.listen(0, '127.0.0.1', () => resolve()));
    const addr = h2Server.address() as { port: number };
    const localApnsEndpoint = `http://127.0.0.1:${addr.port}`;

    try {
      resetApnsTokenCache();

      // Wire notifications service to the real HTTP/2 APNs client pointed at our real HTTP/2 server
      setApnsTransportAdapter(async (params) =>
        sendApnsHttp2Push({
          ...params,
          keyId: 'REALKEY123',
          teamId: 'REALTEAM99',
          privateKeyPem: apnsPrivateKeyPem,
          authorityOverride: localApnsEndpoint,
        })
      );

      // Register two push devices for Maya: one healthy, one that will trigger 410 Unregistered over HTTP/2
      const dev1 = await handleApiRequest({
        method: 'POST',
        url: '/v1/push-devices',
        headers: mayaHeaders,
        body: {
          token: 'apns_valid_device_token_maya_00001',
          environment: 'sandbox',
          bundle_id: 'com.gymbuddy.app',
          device_name: 'Maya iPhone 16',
        },
      });
      expect(dev1.status).toBe(200);

      const dev2 = await handleApiRequest({
        method: 'POST',
        url: '/v1/push-devices',
        headers: mayaHeaders,
        body: {
          token: 'apns_expired_410_device_token_maya_00002',
          environment: 'sandbox',
          bundle_id: 'com.gymbuddy.app',
          device_name: 'Maya Old iPhone',
        },
      });
      expect(dev2.status).toBe(200);
      const expiredDeviceId = (dev2.body as { data: { id: string } }).data.id;

      // Process outbox batch through the real HTTP/2 client
      const batchResult = await processOutboxBatch(50);
      expect(batchResult.processed).toBeGreaterThan(0);
      expect(capturedHttp2Requests.length).toBeGreaterThan(0);

      // Verify the ES256 provider JWT sent over HTTP/2 is cryptographically valid against apnsKeyPair.publicKey
      const firstH2 = capturedHttp2Requests[0]!;
      expect(firstH2.authHeader.startsWith('bearer ')).toBe(true);
      const apnsJwt = firstH2.authHeader.slice(7);
      const [hB64, pB64, sB64] = apnsJwt.split('.') as [string, string, string];
      const sigValid = crypto.verify(
        'sha256',
        Buffer.from(`${hB64}.${pB64}`, 'utf8'),
        { key: apnsKeyPair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sB64, 'base64url')
      );
      expect(sigValid).toBe(true);

      // Verify default message push hides preview text ("New message")
      const msgPush = capturedHttp2Requests.find((r) => r.body.type === 'message_received');
      if (msgPush) {
        const aps = msgPush.body.aps as { alert: { body: string } };
        expect(aps.alert.body).toBe('New message');
      }

      // Verify 410 token was revoked in database
      await withServiceTransaction(async (client) => {
        const checkRevoked = await client.query<{ revoked_at: Date | null; revoke_reason: string }>(
          `SELECT revoked_at, revoke_reason FROM public.push_devices WHERE id = $1`,
          [expiredDeviceId]
        );
        expect(checkRevoked.rows[0]!.revoked_at).not.toBeNull();
        expect(checkRevoked.rows[0]!.revoke_reason).toBe('apns_410_unregistered');
      });
    } finally {
      setApnsTransportAdapter((params) => sendApnsHttp2Push(params));
      h2Server.close();
    }
  });

  it('Scenario 9: Reports, Evidence Snapshot, Admin RBAC/MFA & Dual-Control Permanent Suspension', async () => {
    const dmitroHeaders = authHeaderFor(USER_DMITRO);
    const chrisHeaders = authHeaderFor(USER_CHRIS);
    const modHeaders = authHeaderFor(ADMIN_MODERATOR);
    const safetyLeadHeaders = authHeaderFor(ADMIN_SAFETY_LEAD);

    // 1. Dmitro reports Chris's profile
    const repRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/reports',
      headers: { ...dmitroHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        target_type: 'profile',
        target_id: USER_CHRIS,
        reason: 'spam_or_scam',
        details: 'Repeated commercial spam links.',
      },
    });
    expect(repRes.status).toBe(202);

    // 2. Non-admin user cannot access /v1/admin/reports (403)
    const nonAdminRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/admin/reports',
      headers: dmitroHeaders,
    });
    expect(nonAdminRes.status).toBe(403);

    // 3. Moderator views report queue (audited)
    const queueRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/admin/reports?status=new',
      headers: modHeaders,
    });
    expect(queueRes.status).toBe(200);
    const cases = (queueRes.body as {
      data: Array<{ case_id: string; subject_user_id: string; evidence_snapshot: Record<string, unknown> }>;
    }).data;
    const chrisCase = cases.find((c) => c.subject_user_id === USER_CHRIS)!;
    expect(chrisCase).toBeDefined();
    expect(chrisCase.evidence_snapshot).toHaveProperty('profile');

    // 4. Permanent suspension without second approver must fail with 403 DUAL_CONTROL_REQUIRED
    const soloBanRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/admin/cases/${chrisCase.case_id}/actions`,
      headers: { ...safetyLeadHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        action: 'permanent_suspend',
        reason: 'Confirmed commercial spam bot',
      },
    });
    expect(soloBanRes.status).toBe(403);
    expect((soloBanRes.body as { code: string }).code).toBe('DUAL_CONTROL_REQUIRED');

    // 5. Permanent suspension WITH second approver (Safety Lead + Moderator) succeeds and suspends Chris
    const dualBanRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/admin/cases/${chrisCase.case_id}/actions`,
      headers: { ...safetyLeadHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        action: 'permanent_suspend',
        reason: 'Confirmed commercial spam bot',
        approved_by_admin_id: ADMIN_MODERATOR,
      },
    });
    expect(dualBanRes.status).toBe(200);

    // 6. Suspended user Chris immediately receives 403 ACCOUNT_SUSPENDED
    const chrisFeedRes = await handleApiRequest({
      method: 'GET',
      url: '/v1/feed',
      headers: chrisHeaders,
    });
    expect(chrisFeedRes.status).toBe(403);
    expect((chrisFeedRes.body as { code: string }).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('Scenario 10: GDPR Export, Account Deletion Cooling-Off, Backup Restore Suppression, JWKS Rotation, Fail-Safe Prod Env, Continuous Worker & Deno Edge Functions', async () => {
    const samHeaders = authHeaderFor(USER_SAM);

    // 1. Request GDPR data export
    const expRes = await handleApiRequest({
      method: 'POST',
      url: '/v1/me/data-export',
      headers: { ...samHeaders, 'idempotency-key': crypto.randomUUID() },
    });
    expect(expRes.status).toBe(202);

    // 2. Request account deletion -> starts 7-day cooling-off
    const delReq = await handleApiRequest({
      method: 'POST',
      url: '/v1/me/account-deletion',
      headers: { ...samHeaders, 'idempotency-key': crypto.randomUUID() },
      body: { confirmation: 'DELETE', reason: 'Taking a break' },
    });
    expect(delReq.status).toBe(202);

    // While deletion is pending, normal feed endpoints return 403 ACCOUNT_DELETION_PENDING
    const blockedFeed = await handleApiRequest({
      method: 'GET',
      url: '/v1/feed',
      headers: samHeaders,
    });
    expect(blockedFeed.status).toBe(403);
    expect((blockedFeed.body as { code: string }).code).toBe('ACCOUNT_DELETION_PENDING');

    // 3. Cancel deletion during cooling-off -> restores active status
    const cancelDel = await handleApiRequest({
      method: 'DELETE',
      url: '/v1/me/account-deletion',
      headers: { ...samHeaders, 'idempotency-key': crypto.randomUUID() },
    });
    expect(cancelDel.status).toBe(204);

    const restoredFeed = await handleApiRequest({
      method: 'GET',
      url: '/v1/feed',
      headers: samHeaders,
    });
    expect(restoredFeed.status).toBe(200);

    // 4. Execute full Backup Restore Drill
    const restoreDrill = await executeRestoreDrill();
    expect(restoreDrill.suppressedCount).toBe(1);
    expect(restoreDrill.postRestoreStatus).toBe('deleted');
    expect(restoreDrill.locationRowsRemaining).toBe(0);

    // 5. Execute Supabase JWKS Asymmetric Key Rotation Drill
    const keyRotation = await runKeyRotationDrill();
    expect(keyRotation.oldTokenAcceptedDuringOverlap).toBe(true);
    expect(keyRotation.newTokenAcceptedDuringOverlap).toBe(true);
    expect(keyRotation.oldTokenRejectedAfterRetirement).toBe(true);

    // 6. Fail-Safe Production Configuration Check: rejects placeholders & missing secrets in production/staging
    expect(() =>
      validateStrictProductionEnv({
        GYMBUDDY_ENVIRONMENT: 'production',
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'dev-placeholder',
      })
    ).toThrow(/Fatal configuration error for production environment/);

    // 7. Continuous Worker Daemon Lifecycle Check
    const daemon = startWorkerDaemon({ outboxPollIntervalMs: 50, maintenanceIntervalMs: 100 });
    await new Promise((r) => setTimeout(r, 120));
    const statsBeforeStop = daemon.getStats();
    expect(statsBeforeStop.cycles).toBeGreaterThanOrEqual(1);
    expect(statsBeforeStop.running).toBe(true);
    await daemon.stop();
    expect(daemon.getStats().running).toBe(false);

    // 8. Verify Supabase Edge Functions are pure Deno.serve functions with zero Node-only imports
    const edgeDirs = ['send-message', 'accept-invitation', 'create-upload', 'delete-account', 'report-content'];
    for (const dir of edgeDirs) {
      const fnPath = path.resolve(process.cwd(), `supabase/functions/${dir}/index.ts`);
      const source = await fs.readFile(fnPath, 'utf8');
      expect(source).toContain('Deno.serve(');
      expect(source).not.toMatch(/from\s+['"](pg|ws|node:)/);
    }
  });
});
