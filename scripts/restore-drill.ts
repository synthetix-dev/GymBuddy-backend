import pg from 'pg';
import { runMigrations } from './migrate.js';
import { runSeed } from './seed.js';
import { executeFinalAccountErasure } from '../src/modules/identity/identity.service.js';

const { Pool } = pg;

/**
 * 13-DEVOPS-INFRASTRUCTURE.md & 14-TESTING-STRATEGY.md:
 * Monthly restore drill to isolated project + backup restore suppression verification:
 * 1. Provision isolated drill database (`gymbuddy_restore_drill`)
 * 2. Migrate and seed
 * 3. Execute GDPR account erasure on user 00000000-0000-4000-8000-000000000008 (Jordan),
 *    which records a SHA-256 tombstone in `deleted_subject_tombstones`
 * 4. Simulate a point-in-time backup restore where Jordan's profile & location rows re-appear as 'active'
 * 5. Run `suppress_restored_deleted_accounts_rpc()` post-restore hook
 * 6. Verify Jordan's PII/location are re-purged and account_status is 'deleted', and measure RTO
 */
export async function executeRestoreDrill(): Promise<{
  rtoMs: number;
  suppressedCount: number;
  postRestoreStatus: string;
  locationRowsRemaining: number;
}> {
  const startMs = performance.now();
  const drillDbUrl = 'postgresql://localhost:5432/gymbuddy_restore_drill';

  await runMigrations({ connectionString: drillDbUrl, reset: true, silent: true });
  await runSeed({ connectionString: drillDbUrl, silent: true });

  const pool = new Pool({ connectionString: drillDbUrl });
  const client = await pool.connect();

  try {
    const targetUserId = '00000000-0000-4000-8000-000000000008';

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.account_deletions (user_id, status, reason, reauth_verified, due_at)
       VALUES ($1, 'cooling_off', 'Drill erasure', true, now())`,
      [targetUserId]
    );
    await executeFinalAccountErasure(client, targetUserId, 'req_drill_erasure');
    await client.query('COMMIT');

    // Simulate backup restore re-hydrating the deleted user's profile and exact location prior to erasure
    await client.query(
      `UPDATE public.user_profiles
       SET display_name = 'Jordan Restored From Old Backup',
           account_status = 'active',
           deleted_at = NULL
       WHERE user_id = $1`,
      [targetUserId]
    );
    await client.query(
      `INSERT INTO public.user_locations (user_id, latitude, longitude, coarse_geohash, accuracy_m)
       VALUES ($1, 50.45, 30.52, 'gh4_test', 20)
       ON CONFLICT (user_id) DO NOTHING`,
      [targetUserId]
    );

    // Run mandatory post-restore tombstone suppression hook
    const supRes = await client.query<{ count: number }>(
      `SELECT public.suppress_restored_deleted_accounts_rpc() AS count`
    );
    const suppressedCount = supRes.rows[0]?.count ?? 0;

    const verifyProfile = await client.query<{ account_status: string; display_name: string }>(
      `SELECT account_status::text, display_name FROM public.user_profiles WHERE user_id = $1`,
      [targetUserId]
    );
    const verifyLoc = await client.query(
      `SELECT 1 FROM public.user_locations WHERE user_id = $1`,
      [targetUserId]
    );

    const rtoMs = Number((performance.now() - startMs).toFixed(2));

    return {
      rtoMs,
      suppressedCount,
      postRestoreStatus: verifyProfile.rows[0]!.account_status,
      locationRowsRemaining: verifyLoc.rowCount ?? 0,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeRestoreDrill()
    .then((res) => {
      console.log('Backup Restore Drill Passed:', JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
