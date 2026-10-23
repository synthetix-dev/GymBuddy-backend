import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { Problems } from './problem.js';

export interface CursorPayload {
  sort_value: string | number;
  id: string;
  issued_at: number;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours retention for active cursors

export function encodeKeysetCursor(sortValue: string | number, id: string, issuedAt = Date.now()): string {
  const payload: CursorPayload = {
    sort_value: sortValue,
    id,
    issued_at: issuedAt,
  };
  const dataB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', env.MEDIA_SIGNING_SECRET)
    .update(dataB64)
    .digest('base64url');
  return `${dataB64}.${sig}`;
}

export function decodeKeysetCursor(cursor: string): CursorPayload {
  const parts = cursor.split('.');
  if (parts.length !== 2) {
    throw Problems.cursorExpired('Malformed pagination cursor.');
  }
  const [dataB64, sig] = parts as [string, string];
  const expectedSig = crypto
    .createHmac('sha256', env.MEDIA_SIGNING_SECRET)
    .update(dataB64)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Problems.cursorExpired('Invalid cursor signature.');
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw Problems.cursorExpired('Corrupted cursor payload.');
  }

  if (!payload.id || payload.sort_value === undefined || !payload.issued_at) {
    throw Problems.cursorExpired('Incomplete cursor payload.');
  }

  if (Date.now() - payload.issued_at > CURSOR_TTL_MS) {
    throw Problems.cursorExpired('Pagination cursor is older than retention window (24h).');
  }

  return payload;
}
