import type pg from 'pg';
import { env } from '../config/env.js';
import { withServiceTransaction } from '../db/pool.js';
import { observability } from '../observability/logger.js';
import {
  processApnsOutboxPayload,
  createNotificationAndOutbox,
  type ApnsDispatchResult,
} from '../modules/notifications/notifications.service.js';
import { executeFinalAccountErasure } from '../modules/identity/identity.service.js';
import { cleanupOrphanMediaObjects } from '../modules/media/media.service.js';

export interface OutboxBatchResult {
  claimed: number;
  processed: number;
  retried: number;
  deadLettered: number;
  apnsResults: ApnsDispatchResult[];
}

/**
 * Claims pending outbox_events using `FOR UPDATE SKIP LOCKED` with worker lease,
 * processes each event idempotently, and handles exponential backoff or dead-lettering.
 */
export async function processOutboxBatch(
  batchSize = 25,
  now = new Date()
): Promise<OutboxBatchResult> {
  return withServiceTransaction(async (client: pg.PoolClient) => {
    const claimRes = await client.query<{
      id: string;
      topic: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH claimed AS (
         SELECT id
         FROM public.outbox_events
         WHERE processed_at IS NULL
           AND dead_lettered_at IS NULL
           AND available_at <= $1
           AND (leased_until IS NULL OR leased_until <= $1)
         ORDER BY available_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE public.outbox_events oe
       SET
         leased_by = $3,
         leased_until = $1::timestamptz + ($4 || ' seconds')::interval,
         attempts = oe.attempts + 1
       FROM claimed c
       WHERE oe.id = c.id
       RETURNING oe.id, oe.topic, oe.aggregate_type, oe.aggregate_id, oe.payload, oe.attempts, oe.max_attempts`,
      [now.toISOString(), batchSize, env.OUTBOX_WORKER_ID, String(env.JOB_LEASE_SECONDS)]
    );

    const summary: OutboxBatchResult = {
      claimed: claimRes.rowCount ?? 0,
      processed: 0,
      retried: 0,
      deadLettered: 0,
      apnsResults: [],
    };

    for (const evt of claimRes.rows) {
      try {
        if (evt.topic === 'apns.send') {
          const results = await processApnsOutboxPayload(
            client,
            evt.payload as Parameters<typeof processApnsOutboxPayload>[1],
            now
          );
          summary.apnsResults.push(...results);
        } else if (evt.topic === 'workout.reminder') {
          const p = evt.payload as {
            session_id: string;
            revision: number;
            user_id: string;
            offset_hours: number;
          };
          // Only send reminder if session is still at the same revision and scheduled
          const sessCheck = await client.query<{ revision: number; status: string; title: string }>(
            `SELECT revision, status::text, title FROM public.workout_sessions WHERE id = $1`,
            [p.session_id]
          );
          if (
            sessCheck.rowCount &&
            sessCheck.rows[0]!.revision === p.revision &&
            sessCheck.rows[0]!.status === 'scheduled'
          ) {
            await createNotificationAndOutbox(client, {
              recipientId: p.user_id,
              type: 'workout_reminder',
              resourceType: 'workout_session',
              resourceId: p.session_id,
              title: 'Upcoming workout reminder',
              body: `Your workout session starts in ${p.offset_hours} hours.`,
              deepLink: `gymbuddy://workout-sessions/${p.session_id}`,
              collapseId: `reminder:${p.session_id}:${p.offset_hours}h`,
              dedupeKey: `reminder_notif:${p.session_id}:rev${p.revision}:${p.user_id}:${p.offset_hours}h`,
            });
          }
        }

        await client.query(
          `UPDATE public.outbox_events
           SET processed_at = $2, leased_until = NULL, last_error = NULL
           WHERE id = $1`,
          [evt.id, now.toISOString()]
        );
        summary.processed++;
        observability.increment('outbox_processed_total');
      } catch (err) {
        const errMsg = (err as Error).message ?? 'Unknown worker error';
        if (evt.attempts >= evt.max_attempts) {
          await client.query(
            `UPDATE public.outbox_events
             SET dead_lettered_at = $2, leased_until = NULL, last_error = $3
             WHERE id = $1`,
            [evt.id, now.toISOString(), errMsg]
          );
          summary.deadLettered++;
          observability.increment('outbox_dead_letter_total');
        } else {
          const backoffSeconds = Math.min(3600, Math.pow(2, evt.attempts));
          const nextAvailable = new Date(now.getTime() + backoffSeconds * 1000);
          await client.query(
            `UPDATE public.outbox_events
             SET available_at = $2, leased_until = NULL, last_error = $3
             WHERE id = $1`,
            [evt.id, nextAvailable.toISOString(), errMsg]
          );
          summary.retried++;
        }
      }
    }

    return summary;
  });
}

/**
 * Runs periodic maintenance jobs:
 * - Due GDPR account deletions (past cooling-off period)
 * - Pending GDPR data exports
 * - Orphan upload garbage collection (> 24h)
 * - Post counter drift reconciliation
 */
export async function runLifecycleMaintenanceJobs(now = new Date()): Promise<{
  erasedAccounts: number;
  completedExports: number;
  cleanedOrphans: number;
  reconciledPosts: number;
}> {
  return withServiceTransaction(async (client: pg.PoolClient) => {
    // 1. Due account deletions
    const dueDelRes = await client.query<{ user_id: string; id: string }>(
      `SELECT id, user_id
       FROM public.account_deletions
       WHERE status = 'cooling_off' AND due_at <= $1
       FOR UPDATE SKIP LOCKED`,
      [now.toISOString()]
    );

    let erasedAccounts = 0;
    for (const row of dueDelRes.rows) {
      await executeFinalAccountErasure(client, row.user_id, `erasure_${row.id}`);
      erasedAccounts++;
    }

    // 2. Pending data exports
    const expRes = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM public.account_exports
       WHERE status = 'requested'
       FOR UPDATE SKIP LOCKED`
    );

    let completedExports = 0;
    for (const exp of expRes.rows) {
      const objectPath = `exports/${exp.user_id}/${exp.id}.json.enc`;
      await client.query(
        `UPDATE public.account_exports
         SET status = 'ready',
             object_path = $2,
             completed_at = now(),
             expires_at = now() + INTERVAL '7 days'
         WHERE id = $1`,
        [exp.id, objectPath]
      );
      completedExports++;
    }

    // 3. Orphan media GC
    const cleanedOrphans = await cleanupOrphanMediaObjects(client);

    // 4. Counter reconciliation
    const recRes = await client.query<{ count: number }>(
      `SELECT public.reconcile_post_counters() AS count`
    );
    const reconciledPosts = recRes.rows[0]?.count ?? 0;

    return {
      erasedAccounts,
      completedExports,
      cleanedOrphans,
      reconciledPosts,
    };
  });
}
