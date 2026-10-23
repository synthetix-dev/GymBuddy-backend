import type pg from 'pg';
import { env, hashWithPepper } from '../config/env.js';
import { observability } from '../observability/logger.js';
import { Problems } from './problem.js';

export interface RateLimitRule {
  scope: string;
  maxHits: number;
  windowSeconds: number;
}

export async function enforceRateLimit(
  client: pg.PoolClient,
  subject: string,
  rule: RateLimitRule
): Promise<void> {
  const windowMs = rule.windowSeconds * 1000;
  const now = Date.now();
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const expiresAt = new Date(windowStartMs + windowMs);

  const hashedSubject = hashWithPepper(`${rule.scope}:${subject}`, env.RATE_LIMIT_PEPPER);
  const bucketKey = `${rule.scope}:${hashedSubject}:${windowStartMs}`;

  const res = await client.query<{ hit_count: number }>(
    `INSERT INTO public.rate_limit_buckets (bucket_key, window_start, hit_count, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_key)
     DO UPDATE SET hit_count = public.rate_limit_buckets.hit_count + 1
     RETURNING hit_count`,
    [bucketKey, windowStart.toISOString(), expiresAt.toISOString()]
  );

  const hits = res.rows[0]?.hit_count ?? 1;
  if (hits > rule.maxHits) {
    observability.increment('rate_limit_hits_total');
    const retryAfterSec = Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000));
    throw Problems.rateLimited(retryAfterSec);
  }
}
