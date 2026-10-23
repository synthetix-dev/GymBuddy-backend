# Admin and moderation

## Minimal panel

Separate web application and domain; staff identity with MFA; no shared accounts. Features: user/account status, report queue/case, public post/comment/media preview, workout-session metadata, system announcements, metrics and append-only audit. Search requires reason and is audited.

## Roles

| Role | Allowed | Explicitly denied by default |
|---|---|---|
| Support | account status, user-visible troubleshooting metadata | message content, exact location, sanctions |
| Moderator | assigned reports, reported public content/evidence snapshot, warn/hide/suspend within policy | free browsing private chats/location |
| Safety lead | escalated cases, time-bound access approval, permanent suspension | infrastructure/secrets |
| Ops | service health/jobs, pseudonymous identifiers | content/PII |
| Auditor | read audit/action history | mutate users/content |
| Super admin | role management/emergency actions with dual control | routine case work |

Private-message evidence is included only when a user explicitly reports selected messages; otherwise encrypted/private content is inaccessible. Emergency access requires ticket, purpose, time-bound grant and immutable audit/notification to auditor.

## Workflow

`new → triaged → investigating → actioned|dismissed → appealed → closed`. Deduplicate related reports but retain reporters. Action requires policy reason; high-impact suspension/erasure uses two-person approval. Actions: no_action, warn, content_hide, interaction_limit, temporary/permanent suspend, restore. Never hard-delete evidence before retention ends.

Admin endpoints enforce role + case assignment + object scope and append `audit_logs` with before/after hashes, request ID and actor. Audit export is restricted; logs redact message/location/token data.

## Metrics

Queue age p50/p95, reports/DAU, repeat offender rate, action/appeal reversal, SLA breaches, false-positive sampling; system metrics are aggregate and never expose private text.
