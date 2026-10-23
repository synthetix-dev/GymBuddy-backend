import { processOutboxBatch, runLifecycleMaintenanceJobs } from './outbox-worker.js';
import { closePool } from '../db/pool.js';
import { observability } from '../observability/logger.js';

export interface WorkerDaemonOptions {
  outboxPollIntervalMs?: number;
  maintenanceIntervalMs?: number;
  batchSize?: number;
}

export interface WorkerDaemonHandle {
  stop: () => Promise<void>;
  getStats: () => {
    cycles: number;
    totalProcessed: number;
    maintenanceRuns: number;
    running: boolean;
  };
}

/**
 * Starts a continuous background worker daemon that polls `outbox_events` with
 * `FOR UPDATE SKIP LOCKED` and executes lifecycle maintenance jobs on a schedule,
 * supporting graceful shutdown on SIGINT / SIGTERM.
 */
export function startWorkerDaemon(options?: WorkerDaemonOptions): WorkerDaemonHandle {
  const outboxPollIntervalMs = options?.outboxPollIntervalMs ?? 1500;
  const maintenanceIntervalMs = options?.maintenanceIntervalMs ?? 60_000;
  const batchSize = options?.batchSize ?? 50;

  let running = true;
  let cycles = 0;
  let totalProcessed = 0;
  let maintenanceRuns = 0;
  let lastMaintenanceMs = 0;
  let timer: NodeJS.Timeout | null = null;
  let currentTickPromise: Promise<void> | null = null;

  const tick = async () => {
    if (!running) return;
    try {
      const outbox = await processOutboxBatch(batchSize);
      cycles++;
      totalProcessed += outbox.processed;

      const nowMs = Date.now();
      if (nowMs - lastMaintenanceMs >= maintenanceIntervalMs) {
        await runLifecycleMaintenanceJobs();
        maintenanceRuns++;
        lastMaintenanceMs = nowMs;
      }

      if (!running) return;
      // If we claimed a full batch, poll again immediately (10ms) to drain queue; otherwise sleep outboxPollIntervalMs
      const nextDelay = outbox.claimed >= batchSize ? 10 : outboxPollIntervalMs;
      timer = setTimeout(() => {
        currentTickPromise = tick();
      }, nextDelay);
    } catch (err) {
      observability.log('error', `Worker daemon tick error: ${(err as Error).message}`);
      if (running) {
        timer = setTimeout(() => {
          currentTickPromise = tick();
        }, outboxPollIntervalMs * 2);
      }
    }
  };

  currentTickPromise = tick();

  return {
    stop: async () => {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentTickPromise) {
        await currentTickPromise.catch(() => undefined);
      }
    },
    getStats: () => ({
      cycles,
      totalProcessed,
      maintenanceRuns,
      running,
    }),
  };
}

async function main() {
  const runOnce = process.argv.includes('--once');
  if (runOnce) {
    const outbox = await processOutboxBatch(50);
    const maintenance = await runLifecycleMaintenanceJobs();
    console.log(JSON.stringify({ outbox, maintenance }, null, 2));
    await closePool();
    return;
  }

  observability.log('info', 'Starting continuous GymBuddy worker daemon...');
  const daemon = startWorkerDaemon();

  const shutdown = async (signal: string) => {
    observability.log('info', `Received ${signal}; stopping worker daemon gracefully...`);
    await daemon.stop();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
