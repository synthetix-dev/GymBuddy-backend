# Testing strategy

## Layers

| Layer | Scope |
|---|---|
| Unit | ranking, state machines, validation, privacy projections, retry policies |
| DB/integration | migrations, constraints, transactions, RLS with distinct JWTs, PostGIS |
| Contract | OpenAPI request/response/error compatibility; generated Swift DTO compile |
| Auth | Apple nonce/PKCE, refresh rotation/revoke, suspended/deleted, enumeration/rate |
| Realtime | authorized subscriptions, duplicate/out-of-order/gap/rejoin, token refresh |
| Concurrency | like dedupe, send retry, final session seat, accept/cancel/reschedule races |
| Media/security | MIME corpus, bombs, EXIF, signed URL expiry, quotas, OWASP API cases |
| E2E | onboarding through discover/feed/chat/workout/block/report/delete |
| Offline | airplane mode, process kill, outbox, reinstall/Keychain, conflict reconcile |
| Push | sandbox device, multi-device, 410 token, dedupe/collapse/deep link/privacy |
| Load | feed/search/PostGIS/message write/realtime connection and fan-out |
| DR | backup restore, migration forward fix, compromised-key rotation |

## Critical production scenarios

1. User A cannot read/mutate B's private profile/settings/location, chats, media or device tokens.
2. Block takes effect across feed/discover/chat/realtime/workouts under concurrent send.
3. Lost send response + retry produces exactly one message and stable order.
4. Offline queue survives process death and reconciles duplicate realtime/HTTP results.
5. Two users cannot accept the final session capacity slot.
6. Account deletion revokes sessions, removes/anonymizes dependent data and survives restored backup suppression.
7. Malicious/oversize file never becomes `ready` or publicly addressable.
8. APNs payload hides content by default and invalid token is revoked.
9. Migration applies to production-like snapshot with zero incompatible API window.
10. Restore meets declared RPO/RTO; team can execute runbook.

## Gates

P0 tests 100% pass; no critical/high unresolved security defects; RLS negative matrix complete; p95 within SLO at 2× forecast peak; migration/restore rehearsed; TestFlight on supported devices; accessibility/localization/permission denial paths verified.
