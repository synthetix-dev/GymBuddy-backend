# Environment variables (names only)

Never commit values. Client-visible publishable values are explicitly separated from server secrets.

| Scope | Variable | Purpose |
|---|---|---|
| iOS config | `GYMBUDDY_API_BASE_URL` | `/v1` base per environment |
| iOS config | `SUPABASE_URL` | project URL |
| iOS config | `SUPABASE_PUBLISHABLE_KEY` | publishable/anon key, not service role |
| iOS config | `GYMBUDDY_ENVIRONMENT` | dev/staging/production |
| iOS config | `SENTRY_DSN_IOS` | public telemetry DSN with PII disabled |
| server | `SUPABASE_URL` | project URL |
| server | `SUPABASE_SERVICE_ROLE_KEY` | privileged server only |
| server | `DATABASE_URL` | pooled runtime connection |
| migration | `DATABASE_DIRECT_URL` | direct migration connection |
| server | `JWT_ISSUER`, `JWT_AUDIENCE` | token validation |
| APNs | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | provider identity |
| APNs | `APNS_PRIVATE_KEY` | secret signing key |
| APNs | `APNS_ENVIRONMENT` | sandbox/production |
| email | `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM` | transactional email |
| observability | `SENTRY_DSN_SERVER`, `OTEL_EXPORTER_OTLP_ENDPOINT` | errors/traces |
| abuse | `RATE_LIMIT_PEPPER`, `IP_HASH_PEPPER` | pseudonymous limiting/audit |
| media | `MEDIA_SIGNING_SECRET`, `MEDIA_MAX_*` | URL signing/limits |
| jobs | `OUTBOX_WORKER_ID`, `JOB_LEASE_SECONDS` | worker claims |
| app links | `PUBLIC_APP_URL`, `APPLE_APP_SITE_ASSOCIATION_TEAM_ID` | deep links |
| admin | `ADMIN_APP_URL`, `ADMIN_ALLOWED_EMAIL_DOMAINS` | admin policy hint; RBAC still DB-based |

Validate presence/format on startup; never log values. Rotate with overlap where supported.
