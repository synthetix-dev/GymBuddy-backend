import crypto from 'node:crypto';
import type pg from 'pg';
import sharp from 'sharp';
import { env } from '../../config/env.js';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';
import { assertActiveAccount } from '../identity/identity.service.js';
import { realtimeHub } from '../realtime/realtime-hub.js';
import { getStorageProvider } from './storage-provider.js';

export type MediaPurpose = 'avatar' | 'profile_photo' | 'post_image' | 'message_attachment';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic']);

function getBucketForPurpose(purpose: MediaPurpose): string {
  switch (purpose) {
    case 'avatar':
    case 'profile_photo':
      return 'profile-originals';
    case 'post_image':
      return 'post-originals';
    case 'message_attachment':
      return 'message-attachments';
  }
}

function getMaxBytesForPurpose(purpose: MediaPurpose): number {
  switch (purpose) {
    case 'avatar':
    case 'profile_photo':
      return env.MEDIA_MAX_AVATAR_BYTES; // 10 MB
    case 'post_image':
      return env.MEDIA_MAX_POST_IMAGE_BYTES; // 15 MB
    case 'message_attachment':
      return env.MEDIA_MAX_CHAT_IMAGE_BYTES; // 15 MB
  }
}

/**
 * Sniffs binary magic bytes of a file buffer and checks for polyglot/script payloads.
 */
export function sniffBufferMagicBytes(fileBuffer: Buffer): {
  sniffedMime?: 'image/jpeg' | 'image/png' | 'image/heic';
  rejectionReason?: string;
} {
  if (fileBuffer.byteLength < 12) {
    return { rejectionReason: 'FILE_TOO_SMALL_OR_CORRUPTED' };
  }

  // Scan first 512 bytes and last 512 bytes for embedded script/SVG/HTML/PHP polyglots
  const headText = fileBuffer.subarray(0, Math.min(512, fileBuffer.byteLength)).toString('utf8').toLowerCase();
  const tailText = fileBuffer
    .subarray(Math.max(0, fileBuffer.byteLength - 512))
    .toString('utf8')
    .toLowerCase();
  const combined = `${headText}\n${tailText}`;

  if (
    combined.includes('<svg') ||
    combined.includes('<script') ||
    combined.includes('<html') ||
    combined.includes('<?php')
  ) {
    return { rejectionReason: 'POLYGLOT_OR_SCRIPT_DETECTED' };
  }

  // JPEG: FF D8 FF
  if (fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff) {
    return { sniffedMime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    fileBuffer[0] === 0x89 &&
    fileBuffer[1] === 0x50 &&
    fileBuffer[2] === 0x4e &&
    fileBuffer[3] === 0x47 &&
    fileBuffer[4] === 0x0d &&
    fileBuffer[5] === 0x0a &&
    fileBuffer[6] === 0x1a &&
    fileBuffer[7] === 0x0a
  ) {
    return { sniffedMime: 'image/png' };
  }

  // ISO BMFF / HEIC: bytes 4..11 contain 'ftypheic', 'ftypheix', 'ftypmif1', 'ftypmsf1'
  const boxHeader = fileBuffer.subarray(4, 12).toString('ascii');
  if (
    boxHeader === 'ftypheic' ||
    boxHeader === 'ftypheix' ||
    boxHeader === 'ftypmif1' ||
    boxHeader === 'ftypmsf1'
  ) {
    return { sniffedMime: 'image/heic' };
  }

  return { rejectionReason: 'UNRECOGNIZED_MAGIC_BYTES' };
}

export async function createUploadIntentCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  body: {
    purpose: MediaPurpose;
    mime_type: string;
    byte_size: number;
    sha256: string;
  }
) {
  await assertActiveAccount(client, userId);

  if (!['avatar', 'profile_photo', 'post_image', 'message_attachment'].includes(body.purpose)) {
    throw Problems.validation('Invalid media upload purpose.', [
      { field: 'purpose', reason: 'invalid_enum' },
    ]);
  }

  if (!ALLOWED_MIMES.has(body.mime_type)) {
    throw Problems.unsupportedMedia(
      `MIME type "${body.mime_type}" is not allowed. Supported: image/jpeg, image/png, image/heic.`
    );
  }

  const maxBytes = getMaxBytesForPurpose(body.purpose);
  if (typeof body.byte_size !== 'number' || body.byte_size <= 0) {
    throw Problems.validation('byte_size must be a positive integer.', [
      { field: 'byte_size', reason: 'invalid' },
    ]);
  }
  if (body.byte_size > maxBytes) {
    throw Problems.payloadTooLarge(
      `File size ${body.byte_size} bytes exceeds limit of ${maxBytes} bytes for ${body.purpose}.`
    );
  }

  if (!/^[a-f0-9]{64}$/i.test(body.sha256)) {
    throw Problems.validation('sha256 must be a 64-character hex string.', [
      { field: 'sha256', reason: 'invalid_sha256' },
    ]);
  }

  // Enforce daily per-user byte quota
  const quotaRes = await client.query<{ used_bytes: string }>(
    `SELECT COALESCE(SUM(byte_size), 0)::text AS used_bytes
     FROM public.media_objects
     WHERE owner_id = $1 AND created_at >= (now() - INTERVAL '24 hours')`,
    [userId]
  );
  const usedBytes = Number(quotaRes.rows[0]?.used_bytes ?? 0);
  if (usedBytes + body.byte_size > env.MEDIA_DAILY_QUOTA_BYTES) {
    throw Problems.rateLimited(3600, 'Daily media upload byte quota exceeded.');
  }

  const requestHash = computeRequestHash('POST', '/v1/me/photos/upload-intents', body);

  return executeIdempotentCommand(client, {
    scope: 'POST:/v1/me/photos/upload-intents',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const mediaId = crypto.randomUUID();
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const bucket = getBucketForPurpose(body.purpose);
      // Server-generated path: never uses client filename
      const objectPath = `${userId}/${yyyy}/${mm}/${mediaId}`;
      const visibility =
        body.purpose === 'message_attachment'
          ? 'conversation'
          : body.purpose === 'post_image'
          ? 'authenticated'
          : 'private';

      await client.query(
        `INSERT INTO public.media_objects (
           id, owner_id, purpose, bucket, object_path, declared_mime, byte_size, sha256_hex, status, visibility
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'upload_pending', $9)`,
        [
          mediaId,
          userId,
          body.purpose,
          bucket,
          objectPath,
          body.mime_type,
          body.byte_size,
          body.sha256.toLowerCase(),
          visibility,
        ]
      );

      const storage = getStorageProvider();
      const signed = await storage.createSignedUploadUrl({
        bucket,
        objectPath,
        maxBytes: body.byte_size,
        expiresInSeconds: 600,
      });

      return {
        statusCode: 201,
        body: {
          data: {
            media_object_id: mediaId,
            bucket,
            object_path: objectPath,
            upload_url: signed.url,
            upload_token: signed.token,
            expires_at: signed.expires_at,
            max_bytes: body.byte_size,
          },
        },
      };
    },
  });
}

/**
 * Downloads the real uploaded binary object from Storage, verifies SHA-256 checksum and byte size,
 * sniffs magic bytes, decodes image with `sharp` (with decompression bomb guard `limitInputPixels`),
 * strips all EXIF/GPS metadata, and generates & uploads 3 real WebP variants (`thumb_256`, `medium_1024`, `full_2048`).
 */
export async function completeUploadCommand(
  client: pg.PoolClient,
  userId: string,
  mediaObjectId: string,
  idempotencyKey: string,
  body: {
    set_as_avatar?: boolean;
  }
) {
  await assertActiveAccount(client, userId);

  const requestHash = computeRequestHash('POST', `/v1/me/photos/${mediaObjectId}/complete`, body);

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/me/photos/${mediaObjectId}/complete`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const objRes = await client.query<{
        id: string;
        owner_id: string;
        purpose: MediaPurpose;
        bucket: string;
        object_path: string;
        declared_mime: string;
        byte_size: number;
        sha256_hex: string;
        status: string;
      }>(
        `SELECT id, owner_id, purpose, bucket, object_path, declared_mime, byte_size, sha256_hex, status::text
         FROM public.media_objects
         WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [mediaObjectId]
      );

      if (objRes.rowCount === 0) {
        throw Problems.notFound('Media object');
      }

      const media = objRes.rows[0]!;
      if (media.owner_id !== userId) {
        throw Problems.forbidden('You do not own this media object.');
      }

      const storage = getStorageProvider();
      const fileBuffer = await storage.getObjectBytes(media.bucket, media.object_path);

      // 1. Verify actual uploaded byte size matches declared intent
      if (fileBuffer.byteLength !== media.byte_size) {
        await storage.deleteObject(media.bucket, media.object_path);
        await client.query(
          `UPDATE public.media_objects SET status = 'rejected', rejection_reason = 'BYTE_SIZE_MISMATCH' WHERE id = $1`,
          [mediaObjectId]
        );
        throw Problems.validation(
          `Uploaded byte size (${fileBuffer.byteLength}) does not match declared byte_size (${media.byte_size}).`,
          [{ field: 'byte_size', reason: 'size_mismatch' }],
          'MEDIA_VALIDATION_FAILED'
        );
      }

      // 2. Verify actual SHA-256 checksum over uploaded bytes
      const actualSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (actualSha256 !== media.sha256_hex) {
        await storage.deleteObject(media.bucket, media.object_path);
        await client.query(
          `UPDATE public.media_objects SET status = 'rejected', rejection_reason = 'SHA256_CHECKSUM_MISMATCH' WHERE id = $1`,
          [mediaObjectId]
        );
        throw Problems.validation(
          'Uploaded file SHA-256 checksum does not match declared intent.',
          [{ field: 'sha256', reason: 'checksum_mismatch' }],
          'MEDIA_VALIDATION_FAILED'
        );
      }

      // 3. Magic byte & polyglot check on real buffer
      const magic = sniffBufferMagicBytes(fileBuffer);
      if (!magic.sniffedMime || magic.rejectionReason) {
        await storage.deleteObject(media.bucket, media.object_path);
        await client.query(
          `UPDATE public.media_objects
           SET status = 'quarantined', rejection_reason = $2
           WHERE id = $1`,
          [mediaObjectId, magic.rejectionReason ?? 'UNRECOGNIZED_MAGIC_BYTES']
        );
        throw Problems.validation(
          `Media validation failed: ${magic.rejectionReason}`,
          [{ field: 'file', reason: magic.rejectionReason ?? 'invalid' }],
          'MEDIA_VALIDATION_FAILED'
        );
      }

      if (magic.sniffedMime !== media.declared_mime) {
        await storage.deleteObject(media.bucket, media.object_path);
        await client.query(
          `UPDATE public.media_objects
           SET status = 'quarantined',
               sniffed_mime = $2,
               rejection_reason = $3
           WHERE id = $1`,
          [
            mediaObjectId,
            magic.sniffedMime,
            `MIME_MISMATCH_DECLARED_${media.declared_mime}_SNIFFED_${magic.sniffedMime}`,
          ]
        );
        throw Problems.validation(
          `Declared MIME (${media.declared_mime}) does not match actual file header (${magic.sniffedMime}).`,
          [{ field: 'mime_type', reason: 'mime_mismatch' }],
          'MEDIA_VALIDATION_FAILED'
        );
      }

      // 4. Decode image with sharp & enforce decompression bomb pixel limit (<= 12 MP)
      let width = 0;
      let height = 0;
      try {
        const meta = await sharp(fileBuffer, {
          limitInputPixels: env.MEDIA_MAX_PIXELS,
          failOn: 'error',
        }).metadata();

        width = meta.width ?? 0;
        height = meta.height ?? 0;

        if (width <= 0 || height <= 0 || width * height > env.MEDIA_MAX_PIXELS) {
          throw new Error('DECOMPRESSION_BOMB_EXCEEDS_MAX_PIXELS');
        }
      } catch (err) {
        await storage.deleteObject(media.bucket, media.object_path);
        const reason = (err as Error).message.includes('pixel limit') ||
          (err as Error).message.includes('DECOMPRESSION_BOMB')
          ? 'DECOMPRESSION_BOMB_EXCEEDS_MAX_PIXELS'
          : 'IMAGE_DECODE_FAILED';
        await client.query(
          `UPDATE public.media_objects
           SET status = 'quarantined',
               sniffed_mime = $2,
               rejection_reason = $3
           WHERE id = $1`,
          [mediaObjectId, magic.sniffedMime, reason]
        );
        throw Problems.validation(
          `Media decoding failed: ${reason}`,
          [{ field: 'file', reason }],
          'MEDIA_VALIDATION_FAILED'
        );
      }

      // 5. Re-encode original without EXIF/GPS metadata & overwrite original in Storage so no GPS remains at rest
      const strippedOriginalBuffer = await sharp(fileBuffer, {
        limitInputPixels: env.MEDIA_MAX_PIXELS,
      })
        .rotate() // auto-orient from EXIF orientation before stripping EXIF
        .jpeg({ quality: 90 })
        .toBuffer();
      await storage.putObjectBytes(
        media.bucket,
        media.object_path,
        strippedOriginalBuffer,
        'image/jpeg'
      );

      // 6. Generate 3 real resized WebP variants (thumb_256, medium_1024, full_2048) with EXIF stripped
      const variantSpecs: Array<{
        name: 'thumb_256' | 'medium_1024' | 'full_2048';
        maxDim: number;
        fit: 'cover' | 'inside';
        quality: number;
      }> = [
        { name: 'thumb_256', maxDim: 256, fit: 'cover', quality: 80 },
        { name: 'medium_1024', maxDim: 1024, fit: 'inside', quality: 82 },
        { name: 'full_2048', maxDim: 2048, fit: 'inside', quality: 85 },
      ];

      const createdVariants: string[] = [];

      for (const spec of variantSpecs) {
        const rendered = await sharp(fileBuffer, {
          limitInputPixels: env.MEDIA_MAX_PIXELS,
        })
          .rotate()
          .resize(spec.maxDim, spec.maxDim, {
            fit: spec.fit,
            withoutEnlargement: spec.fit === 'inside',
          })
          .webp({ quality: spec.quality })
          .toBuffer({ resolveWithObject: true });

        const variantPath = `${media.object_path}/${spec.name}.webp`;
        const contentHash = crypto
          .createHash('sha256')
          .update(rendered.data)
          .digest('hex');

        await storage.putObjectBytes(
          'media-variants',
          variantPath,
          rendered.data,
          'image/webp'
        );

        await client.query(
          `INSERT INTO public.media_variants (
             media_object_id, variant_name, bucket, object_path, mime_type, byte_size, width, height, content_hash
           ) VALUES ($1, $2, 'media-variants', $3, 'image/webp', $4, $5, $6, $7)
           ON CONFLICT (media_object_id, variant_name)
           DO UPDATE SET
             byte_size = EXCLUDED.byte_size,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             content_hash = EXCLUDED.content_hash`,
          [
            mediaObjectId,
            spec.name,
            variantPath,
            rendered.info.size,
            rendered.info.width,
            rendered.info.height,
            contentHash,
          ]
        );

        createdVariants.push(spec.name);
      }

      await client.query(
        `UPDATE public.media_objects
         SET status = 'ready',
             sniffed_mime = $2,
             width = $3,
             height = $4,
             exif_stripped = true
         WHERE id = $1`,
        [mediaObjectId, magic.sniffedMime, width, height]
      );

      // If avatar or profile_photo, attach to user_photos
      if (media.purpose === 'avatar' || media.purpose === 'profile_photo') {
        const isAvatar = media.purpose === 'avatar' || body.set_as_avatar === true;
        if (isAvatar) {
          await client.query(
            `UPDATE public.user_photos SET is_avatar = false WHERE user_id = $1 AND is_avatar = true AND deleted_at IS NULL`,
            [userId]
          );
        }
        await client.query(
          `INSERT INTO public.user_photos (user_id, media_object_id, position, is_avatar, status)
           VALUES ($1, $2, 0, $3, 'ready')
           ON CONFLICT DO NOTHING`,
          [userId, mediaObjectId, isAvatar]
        );
      }

      realtimeHub.publishToTopic(`user:${userId}`, {
        type: 'media.ready',
        aggregate_id: mediaObjectId,
        data: {
          media_object_id: mediaObjectId,
          status: 'ready',
          exif_stripped: true,
        },
      });

      return {
        statusCode: 200,
        body: {
          data: {
            id: mediaObjectId,
            status: 'ready',
            width,
            height,
            exif_stripped: true,
            variants: createdVariants,
          },
        },
      };
    },
  });
}

/**
 * Issues a short-lived signed download URL ONLY after verifying database-level authorization
 * (owner, visible profile photo, visible post attachment, or active unblocked conversation member).
 */
export async function getAuthorizedMediaUrl(
  client: pg.PoolClient,
  viewerId: string,
  mediaObjectId: string,
  variant: 'thumb_256' | 'medium_1024' | 'full_2048' = 'medium_1024'
): Promise<{ url: string; expires_at: string; variant: string }> {
  await assertActiveAccount(client, viewerId);

  const res = await client.query<{
    id: string;
    owner_id: string;
    bucket: string;
    object_path: string;
    status: string;
    authorized: boolean;
  }>(
    `SELECT
       mo.id,
       mo.owner_id,
       mo.bucket,
       mo.object_path,
       mo.status::text,
       (
         mo.owner_id = $2
         OR EXISTS (
           SELECT 1 FROM public.user_photos up
           WHERE up.media_object_id = mo.id
             AND up.deleted_at IS NULL
             AND public.can_view_profile($2, up.user_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.post_media pm
           WHERE pm.media_object_id = mo.id
             AND public.can_view_post($2, pm.post_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.message_attachments ma
           JOIN public.messages m ON m.id = ma.message_id
           WHERE ma.media_object_id = mo.id
             AND public.is_conversation_member($2, m.conversation_id)
         )
       ) AS authorized
     FROM public.media_objects mo
     WHERE mo.id = $1 AND mo.deleted_at IS NULL`,
    [mediaObjectId, viewerId]
  );

  if (res.rowCount === 0 || !res.rows[0]!.authorized || res.rows[0]!.status !== 'ready') {
    throw Problems.notFound('Media');
  }

  const mo = res.rows[0]!;
  const storage = getStorageProvider();
  const signed = await storage.createSignedDownloadUrl({
    bucket: 'media-variants',
    objectPath: `${mo.object_path}/${variant}.webp`,
    expiresInSeconds: 300, // 5 minutes per 06-CHAT-REALTIME.md & 10-MEDIA-NOTIFICATIONS.md
  });

  return {
    url: signed.url,
    expires_at: signed.expires_at,
    variant,
  };
}

export async function cleanupOrphanMediaObjects(client: pg.PoolClient): Promise<number> {
  const res = await client.query<{ bucket: string; object_path: string }>(
    `UPDATE public.media_objects
     SET status = 'deleted', deleted_at = now()
     WHERE status = 'upload_pending'
       AND deleted_at IS NULL
       AND created_at < (now() - INTERVAL '24 hours')
     RETURNING bucket, object_path`
  );
  const storage = getStorageProvider();
  for (const row of res.rows) {
    await storage.deleteObject(row.bucket, row.object_path);
  }
  return res.rowCount ?? 0;
}
