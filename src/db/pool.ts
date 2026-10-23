import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

let activePool: pg.Pool | null = null;
let currentConnectionString: string = env.DATABASE_URL;

export function getPool(connectionString?: string): pg.Pool {
  const target = connectionString ?? currentConnectionString;
  if (!activePool || currentConnectionString !== target) {
    if (activePool) {
      void activePool.end().catch(() => {});
    }
    currentConnectionString = target;
    activePool = new Pool({
      connectionString: target,
      max: 25,
      idleTimeoutMillis: 30000,
    });
  }
  return activePool;
}

export async function closePool(): Promise<void> {
  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}

/**
 * Executes a callback inside a database transaction with PostgreSQL RLS claims set
 * (`SET LOCAL ROLE authenticated; set_config('request.jwt.claim.sub', userId, true)`).
 * Guarantees that every SQL statement inside `fn` is subject to Row Level Security!
 */
export async function withUserRlsContext<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  options?: { aal?: 'aal1' | 'aal2'; role?: 'authenticated' | 'anon' }
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dbRole = options?.role ?? 'authenticated';
    await client.query(`SET LOCAL ROLE ${dbRole}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [dbRole]);
    await client.query(`SELECT set_config('request.jwt.claim.aal', $1, true)`, [
      options?.aal ?? 'aal1',
    ]);
    const claimsJson = JSON.stringify({
      sub: userId,
      role: dbRole,
      aal: options?.aal ?? 'aal1',
    });
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claimsJson]);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Executes a privileged server/worker transaction using `service_role`.
 * Domain functions MUST still perform explicit authorization checks before mutating data.
 */
export async function withServiceTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  actorUserId?: string | null
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE service_role`);
    if (actorUserId) {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [actorUserId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
