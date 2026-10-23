# Security, privacy and threat model

## Trust boundaries and assets

Untrusted: iOS device, network, user content, upload metadata, realtime client. Trusted: Auth issuer, versioned server functions, PostgreSQL/RLS, workers and secret store. High-value assets: identities/tokens, exact location, private messages/media, reports, APNs tokens and admin actions.

## Threat matrix

| Threat | Control | Verification |
|---|---|---|
| IDOR/BOLA | derive actor from JWT; resource-level RLS; opaque IDs not sufficient | cross-user integration matrix |
| private message leak | membership predicate on message/list/media URL/realtime topic | former/blocked/nonmember tests |
| photo access | private buckets, signed short URL after DB authorization | expired/shared URL tests |
| exact location leak | exact point O/S only; views expose bucket; strip EXIF | response/log snapshot scan |
| spam/harassment | connection/message-request limits, blocks, rate/device/IP signals, reports | abuse simulations |
| account takeover | Apple nonce/PKCE, refresh rotation, Keychain, session revoke, neutral recovery | replay/reuse tests |
| scraping | pagination caps, per-account/IP/device rate, anomaly alerts, no bulk IDs | load/bot tests |
| forged invitation | server membership/actor/state checks, signed JWT, transaction | role/race tests |
| replay/duplicate | idempotency key + request hash; unique constraints | lost-response retry |
| race conditions | row locks/version predicates/unique partial constraints | concurrent test suite |
| malicious upload | signed narrow path, magic-byte decode, size/pixel limits, quarantine | corpus/fuzz tests |
| excessive disclosure | response DTO allowlists, log redaction, admin case scope | schema/privacy review |
| service-role compromise | vault, no client embed, rotation, egress/log alert, minimal worker | secret scanning/rotation drill |

## Authorization invariants

Block is bilateral for discovery, profiles (product-dependent minimal tombstone), feed interactions, chat sends/subscriptions, session invitations and media URL issuance. Admin role never bypasses private messages by default. Service role is isolated to workers/functions and each function repeats domain authorization before privileged DB access. Full matrix: [ACCESS-MATRIX.md](ACCESS-MATRIX.md).

## RLS and validation

Enable RLS on every exposed schema table; default-deny; only expose curated views/functions. Validate type/length/range/state server-side. `SECURITY DEFINER` functions set safe `search_path` and revoke public execute. Service keys never used by mobile. Rate limits at gateway plus durable abuse counters for sensitive actions.

## Privacy/GDPR

Data inventory and purpose per field; consent/legitimate-basis record; EU region and DPA review; privacy notice; access/export/correction/erasure; retention schedule; processor list; breach runbook. Location is optional and purpose-limited. Do not collect health metrics beyond product need; if fitness/health data later enters scope, conduct DPIA and review special-category rules. Legal counsel must approve policy.

Suggested retention: raw exact location replaced and expires ≤30d; presence/typing not stored; auth/audit security logs 90–365d pseudonymized; reports/cases per legal policy; deleted content 30d recovery unless safety/legal hold; export URL 7d. Backups expire by rotation and are not surgically edited; deleted identifiers are suppressed if restore occurs.

## Real-world meeting safety

Adult-only initial release; coarse location; no live sharing; public venue recommendation; report/block accessible from profile/chat/session; reminders not to share home address; emergency disclaimer; repeated-abuse correlation with guarded access; moderator escalation. Never tell a reported user who reported/blocked them.

## Security release gate

Threat model reviewed; RLS negative tests complete; dependency/secret/SAST scans clean; upload fuzz corpus; auth replay/rate tests; admin MFA; restore and key-rotation drills; privacy export/erasure verified; external penetration test before meaningful public scale.
