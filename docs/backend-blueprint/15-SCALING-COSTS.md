# Scaling and cost model

**Pricing checked:** 2026-10-23. USD before tax; ranges are planning estimates. Official baseline: [Supabase pricing](https://supabase.com/pricing), [billing quotas](https://supabase.com/docs/guides/platform/billing-on-supabase), [Realtime billing/limits](https://supabase.com/docs/guides/realtime/limits). Pro: $25, 100k MAU, 8 GB DB, 100 GB storage, 250 GB egress, 5M realtime messages, 500 peak connections; overage includes $0.00325/MAU, $0.125/GB DB, ~$0.021/GB storage, $0.09 uncached/$0.03 cached egress, $2.50/M realtime messages, $10/1k peak connections. Compute upgrades, PITR, transforms and third parties add cost.

## Assumptions

“Active users” below means MAU; DAU 20%; peak concurrent 2% MAU; each DAU: 20 feed views, 8 messages, 3 media views; image variant average 250 KB; new media 8 MB/MAU/month before variants; 30-day month. APNs itself has no per-message line item, but worker traffic does. Retention/storage and cache hit materially change results.

| MAU | DAU / peak | Messages/mo | New originals/mo | Architecture/capacity | Estimated monthly total |
|---:|---:|---:|---:|---|---:|
| 100 | 20 / 2 | 4.8k | 0.8 GB | Free for dev; Pro for public production | $35–60 |
| 1,000 | 200 / 20 | 48k | 8 GB | Pro Micro, within included realtime/storage | $40–70 |
| 10,000 | 2k / 200 | 480k | 80 GB | Pro; likely Small compute; CDN/cache discipline | $80–250 |
| 100,000 | 20k / 2k | 4.8M | 800 GB | larger compute, peak connection overage, lifecycle/external worker | $350–1,500+ |

The 100k range can exceed 5M realtime events because one message creates sender/recipient/read events; 2k peak connections exceed default 500. Support must raise configured limits/no-spend-cap, and compute must be load-tested. Media egress (not raw storage) is usually largest uncertainty; at 100k, use measured CDN hit ratio and perhaps move public variants to cheaper object/CDN while retaining metadata/API.

## Scale triggers

- DB CPU >70% sustained or query p95 breach: fix SQL/indexes, pool, then resize/read replica.
- 70% connection/message cap: consolidate channels, reduce presence, request higher limit.
- storage/egress budget >70%: aggressive variants/cache/lifecycle and per-user quotas.
- outbox age >60s: scale worker/concurrency; partition queue.
- feed query degrades: materialized candidates/counters; do not add Elasticsearch until PostgreSQL search is measured insufficient.
- 100k+ MAU or complex jobs: evaluate NestJS/Redis/queue based on telemetry, not user count alone.

Budgets should include 20–30% uncertainty, tax, Apple developer membership, support labor and observability vendor. Set provider spend cap/alerts, noting a cap may throttle features rather than preserve availability.
