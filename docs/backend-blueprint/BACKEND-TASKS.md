# Agent-ready backend tasks

Each task must include migration/API/authorization/observability/tests/docs; no task is done with only a happy-path handler.

## Foundation

- **BE-F01:** Create `supabase/` layout, local seed, deterministic commands and ADR-001. Verify clean machine startup.
- **BE-F02:** Install extensions/types/core tables from `03`; migration up from empty and prior snapshot.
- **BE-F03:** Implement problem+json, request IDs, auth context, idempotency store and rate-limit interface.
- **BE-F04:** CI for SQL/Edge/OpenAPI/RLS/secret scan; staging deploy and smoke.
- **BE-F05:** Structured redacted logs, Sentry, metrics dashboards and alerts.

## Identity/privacy

- **BE-I01:** Apple Auth configuration, bootstrap trigger/transaction, active-account guard.
- **BE-I02:** Profile/settings/interests endpoints with version conflict and public projection.
- **BE-I03:** Session list/revoke and Keychain-facing contract.
- **BE-I04:** Block/unblock transaction and global `is_blocked/can_view` predicates.
- **BE-I05:** Report intake/dedupe/evidence snapshot.
- **BE-I06:** Export/delete state machines, job, restore-suppression record and audit.

## Media/social

- **BE-M01:** Upload-intent/finalize with quotas, ownership and private paths.
- **BE-M02:** Validator/EXIF stripper/variants/quarantine/orphan GC.
- **BE-S01:** Atomic discriminated post aggregates and lifecycle.
- **BE-S02:** Feed eligibility/keyset/ranking query with explain/load fixture.
- **BE-S03:** Likes/saves/comments unique/transaction/counter reconcile.
- **BE-S04:** PostgreSQL FTS/trigram search with visibility filtering.

## Communication/fitness

- **BE-C01:** Direct conversation canonicalization, members and per-user archive/pin/hide.
- **BE-C02:** Send-message RPC with client ID/server sequence/outbox.
- **BE-C03:** Message pagination/read cursor/delete/edit and private attachments.
- **BE-C04:** Authorized realtime topics, envelope, reconnect/catch-up contract.
- **BE-C05:** Notification/device/outbox/APNs worker/preferences/badge reconcile.
- **BE-W01:** Location consent/update/expiry and safe PostGIS discover query.
- **BE-W02:** Discover actions/cooldowns/connection/message-request rule.
- **BE-W03:** Session/invitation transitions, capacity locks, revisions and reminders.

## Admin/production

- **BE-A01:** Admin identities/RBAC/MFA gate and audited access middleware.
- **BE-A02:** Report queue/cases/actions/appeals and system announcements.
- **BE-P01:** Full RLS negative matrix and OWASP API/security corpus.
- **BE-P02:** Load profiles for feed/geo/chat/realtime and budget dashboard.
- **BE-P03:** Backup restore, key rotation and incident tabletop.
- **BE-P04:** Generate Swift client DTOs; staging contract/E2E suite; release report.

For every task, acceptance references the module rules in documents `02`–`14`; unresolved product choices in `17` must become explicit ADRs, never implicit code decisions.
