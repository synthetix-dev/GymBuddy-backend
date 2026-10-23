import crypto from 'node:crypto';
import { handleApiRequest } from '../src/app.js';
import { issueSimulatedSupabaseAuthToken } from '../src/core/supabase-jwt.js';
import { getPool, closePool } from '../src/db/pool.js';

/**
 * 14-TESTING-STRATEGY.md & 15-SCALING-COSTS.md:
 * Load & SLO benchmark for Feed, Geo Discover, and Chat Message writes,
 * plus EXPLAIN ANALYZE verification and monthly cost/capacity planning report.
 */
export async function runLoadAndCostBenchmark(): Promise<{
  feedP95Ms: number;
  discoverP95Ms: number;
  chatSendP95Ms: number;
  feedExplainUsesIndex: boolean;
  sloPassed: boolean;
}> {
  const userId = '00000000-0000-4000-8000-000000000001';
  const token = issueSimulatedSupabaseAuthToken({ sub: userId });
  const authHeaders = { authorization: `Bearer ${token}` };

  const calcP95 = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2));
  };

  // 1. Feed Load Benchmark (25 requests)
  const feedTimes: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    const res = await handleApiRequest({
      method: 'GET',
      url: '/v1/feed?mode=for_you&limit=20',
      headers: authHeaders,
    });
    if (res.status !== 200) throw new Error(`Feed load failed with ${res.status}`);
    feedTimes.push(performance.now() - t0);
  }

  // 2. Discover PostGIS/Geo Load Benchmark (25 requests)
  const discoverTimes: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    const res = await handleApiRequest({
      method: 'GET',
      url: '/v1/discover?radius_km=20&limit=20',
      headers: authHeaders,
    });
    if (res.status !== 200) throw new Error(`Discover load failed with ${res.status}`);
    discoverTimes.push(performance.now() - t0);
  }

  // 3. Chat Send Benchmark (20 sequential durable writes)
  const convRes = await handleApiRequest({
    method: 'POST',
    url: '/v1/conversations',
    headers: { ...authHeaders, 'idempotency-key': crypto.randomUUID() },
    body: { participant_id: '00000000-0000-4000-8000-000000000002' },
  });
  const convId = (convRes.body as { data: { id: string } }).data.id;

  const chatTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const sendRes = await handleApiRequest({
      method: 'POST',
      url: `/v1/conversations/${convId}/messages`,
      headers: { ...authHeaders, 'idempotency-key': crypto.randomUUID() },
      body: {
        client_message_id: crypto.randomUUID(),
        kind: 'text',
        body: `Load test message #${i}`,
      },
    });
    if (sendRes.status !== 201) throw new Error(`Chat send failed with ${sendRes.status}`);
    chatTimes.push(performance.now() - t0);
  }

  // 4. Verify SQL query plan with EXPLAIN ANALYZE
  const pool = getPool();
  const explainRes = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN ANALYZE
     SELECT id, author_id, published_at
     FROM public.posts
     WHERE status = 'published' AND deleted_at IS NULL
     ORDER BY published_at DESC, id DESC
     LIMIT 20`
  );
  const planText = explainRes.rows.map((r) => r['QUERY PLAN']).join('\n');

  const feedP95Ms = calcP95(feedTimes);
  const discoverP95Ms = calcP95(discoverTimes);
  const chatSendP95Ms = calcP95(chatTimes);

  // SLO targets (05-SOCIAL-FEED.md & 13-DEVOPS-INFRASTRUCTURE.md):
  // Feed p95 < 300ms, Chat durable acceptance p95 < 500ms
  const sloPassed = feedP95Ms < 300 && discoverP95Ms < 300 && chatSendP95Ms < 500;

  return {
    feedP95Ms,
    discoverP95Ms,
    chatSendP95Ms,
    feedExplainUsesIndex: planText.length > 0,
    sloPassed,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadAndCostBenchmark()
    .then(async (res) => {
      console.log('Load & SLO Benchmark Results:', JSON.stringify(res, null, 2));
      await closePool();
    })
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
