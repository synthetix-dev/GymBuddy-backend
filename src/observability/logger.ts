import { env, hashWithPepper } from '../config/env.js';

const REDACTED_KEYS = new Set([
  'authorization',
  'password',
  'encrypted_password',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'device_token',
  'encrypted_token',
  'apns_private_key',
  'supabase_service_role_key',
  'jwt_secret',
  'latitude',
  'longitude',
  'point',
  'birth_date',
  'body',
]);

export function redactPII(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactPII(item));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactPII(v);
      }
    }
    return out;
  }
  return input;
}

export function pseudonymizeActor(userId?: string | null): string | null {
  if (!userId) return null;
  return `usr_${hashWithPepper(userId, env.IP_HASH_PEPPER).slice(0, 16)}`;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  request_id?: string;
  actor_pseudonym?: string | null;
  route?: string;
  method?: string;
  status?: number;
  latency_ms?: number;
  release: string;
  message: string;
  context?: Record<string, unknown>;
}

class ObservabilityRegistry {
  private requestLatencies: number[] = [];
  public counters: Record<string, number> = {
    http_requests_total: 0,
    http_errors_5xx_total: 0,
    http_errors_4xx_total: 0,
    rate_limit_hits_total: 0,
    outbox_processed_total: 0,
    outbox_dead_letter_total: 0,
    apns_sent_total: 0,
    apns_revoked_tokens_total: 0,
    realtime_events_emitted_total: 0,
  };
  public logsBuffer: LogEntry[] = [];
  private silent = process.env.GYMBUDDY_SILENT_LOGS === '1';

  public increment(metric: string, delta = 1): void {
    this.counters[metric] = (this.counters[metric] ?? 0) + delta;
  }

  public recordLatency(ms: number): void {
    this.requestLatencies.push(ms);
    if (this.requestLatencies.length > 5000) {
      this.requestLatencies.shift();
    }
  }

  public getLatencyPercentiles(): { p50: number; p95: number; p99: number } {
    if (this.requestLatencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.requestLatencies].sort((a, b) => a - b);
    const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return {
      p50: Number(pick(0.5).toFixed(2)),
      p95: Number(pick(0.95).toFixed(2)),
      p99: Number(pick(0.99).toFixed(2)),
    };
  }

  public log(
    level: LogEntry['level'],
    message: string,
    meta?: {
      request_id?: string;
      user_id?: string | null;
      route?: string;
      method?: string;
      status?: number;
      latency_ms?: number;
      context?: Record<string, unknown>;
    }
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      request_id: meta?.request_id,
      actor_pseudonym: pseudonymizeActor(meta?.user_id),
      route: meta?.route,
      method: meta?.method,
      status: meta?.status,
      latency_ms: meta?.latency_ms,
      release: 'gymbuddy-backend@1.0.0',
      message,
      context: meta?.context ? (redactPII(meta.context) as Record<string, unknown>) : undefined,
    };

    this.logsBuffer.push(entry);
    if (this.logsBuffer.length > 1000) {
      this.logsBuffer.shift();
    }

    if (!this.silent && env.GYMBUDDY_ENVIRONMENT !== 'test') {
      process.stdout.write(JSON.stringify(entry) + '\n');
    }
  }
}

export const observability = new ObservabilityRegistry();
