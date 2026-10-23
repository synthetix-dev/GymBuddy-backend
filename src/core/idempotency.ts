import crypto from 'node:crypto';
import type pg from 'pg';
import { Problems } from './problem.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateIdempotencyKeyHeader(rawKey: string | undefined): string {
  if (!rawKey || !UUID_REGEX.test(rawKey.trim())) {
    throw Problems.validation(
      'Mutating command requires a valid UUID Idempotency-Key header.',
      [{ field: 'Idempotency-Key', reason: 'required_uuid' }]
    );
  }
  return rawKey.trim().toLowerCase();
}

export function computeRequestHash(method: string, path: string, body: unknown): string {
  const canonical = JSON.stringify({
    m: method.toUpperCase(),
    p: path,
    b: body ?? null,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export interface IdempotentResult<T = unknown> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

/**
 * Executes an idempotent command scoped to `(scope, userId, idempotencyKey)`.
 * - If the key was already completed with the exact same request hash, returns the stored response.
 * - If the key was used with a different request hash, throws `409 IDEMPOTENCY_CONFLICT`.
 */
export async function executeIdempotentCommand<T>(
  client: pg.PoolClient,
  params: {
    scope: string;
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    execute: () => Promise<{ statusCode: number; body: T }>;
  }
): Promise<IdempotentResult<T>> {
  const key = validateIdempotencyKeyHeader(params.idempotencyKey);

  // Acquire row lock or insert in_progress record
  const existingRes = await client.query<{
    request_hash: string;
    status: string;
    response_code: number | null;
    response_body: T | null;
    expires_at: Date;
  }>(
    `SELECT request_hash, status, response_code, response_body, expires_at
     FROM public.idempotency_keys
     WHERE scope = $1 AND user_id = $2 AND key = $3
     FOR UPDATE`,
    [params.scope, params.userId, key]
  );

  if (existingRes.rowCount && existingRes.rowCount > 0) {
    const existing = existingRes.rows[0]!;
    if (existing.request_hash !== params.requestHash) {
      throw Problems.idempotencyConflict();
    }
    if (existing.status === 'completed' && existing.response_code && existing.response_body !== null) {
      return {
        statusCode: existing.response_code,
        body: existing.response_body,
        replayed: true,
      };
    }
  } else {
    await client.query(
      `INSERT INTO public.idempotency_keys (scope, user_id, key, request_hash, status)
       VALUES ($1, $2, $3, $4, 'in_progress')`,
      [params.scope, params.userId, key, params.requestHash]
    );
  }

  const result = await params.execute();

  await client.query(
    `UPDATE public.idempotency_keys
     SET status = 'completed',
         response_code = $4,
         response_body = $5::jsonb
     WHERE scope = $1 AND user_id = $2 AND key = $3`,
    [params.scope, params.userId, key, result.statusCode, JSON.stringify(result.body)]
  );

  return {
    statusCode: result.statusCode,
    body: result.body,
    replayed: false,
  };
}
