# Risks, assumptions and open decisions

## Top risks

| Risk | Impact | Mitigation / owner decision |
|---|---|---|
| Safety of real-world meetings | severe | adult-only, coarse location, venue guidance, block/report/moderation before launch |
| RLS complexity/service-role bypass | data breach | default deny, negative matrix, minimal trusted functions, review |
| Realtime limits/cost fan-out | degraded chat/cost | user-scoped channels, no durable presence, catch-up API, capacity alarms |
| Media egress/abuse | cost/security | quotas, variants/CDN, scanning, lifecycle |
| BaaS lock-in | migration cost | portable SQL/domain contract, adapters, avoid provider objects in UI |
| Offline conflict/data loss | trust | durable outbox/idempotency/server reconciliation |
| Moderation capacity | user harm | limited launch cohort, SLAs, admin workflow/metrics |
| No existing tests/build proof | regressions | add test targets and Xcode 26 CI before integration |
| iOS 26-only market | reach | product decision; assess deployment target before backend launch |

## Assumptions requiring confirmation

1. Launch is 18+ and EU-first; exact jurisdiction/legal entity unknown.
2. Connections permit direct chat after connect; mutual approval/message request policy unresolved.
3. Posts default community-visible; profile can be hidden from Discover.
4. One-to-one chat only for MVP; no E2EE requirement.
5. Workout sessions start 1:1 but schema supports capacity >2.
6. Public profile shows age, gym and rounded distance; verify privacy UX.
7. Email/password is optional; Apple-only may affect non-Apple admin/support flows.
8. Seven-day deletion cooling period and retention schedule require counsel approval.
9. Supabase EU region availability/terms/DPA must be selected during provisioning.

## Product decisions before implementation

- Mutual match versus unilateral connection/message request.
- Allowed gender/identity vocabulary and discover filter fairness.
- Minimum age and age verification level.
- Profile/post visibility model and whether blocked users see tombstones.
- Message deletion semantics and reportable evidence window.
- Location freshness/rounding and manual gym verification.
- Session reschedule acknowledgment/cancellation rules.
- Moderation policy, SLA, appeals and emergency disclosure process.
- Analytics provider/consent and whether product telemetry is necessary at launch.
- RPO/RTO budget and when to buy PITR.

## Decisions that do not block foundation

Ranking weights, reposts, group chat, advanced presence, ML, video, waitlists and external search can be deferred behind stable contracts.
