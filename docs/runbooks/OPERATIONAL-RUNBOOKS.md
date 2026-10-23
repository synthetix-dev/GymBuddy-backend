# GymBuddy Production Operational Runbooks (`13-DEVOPS-INFRASTRUCTURE.md`)

## 1. Compromised Key Rotation Runbook
1. Generate a new 256-bit secret for `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, or new Apple APNs `.p8` key.
2. Deploy overlapping verification window (`verifyAccessToken(token, [newSecret, oldSecret])`).
3. If `SUPABASE_SERVICE_ROLE_KEY` or `APNS_PRIVATE_KEY` was exposed:
   - Immediately rotate key in Supabase / Apple Developer Portal.
   - Run `pnpm drill:rotate-keys` to verify zero-downtime token transition.
   - Audit `public.audit_logs` for anomalous administrative or service actions during exposure window.

## 2. Backup Restore & GDPR Tombstone Suppression Runbook
1. Provision isolated target database (`gymbuddy_restore_target`).
2. Restore physical/logical snapshot into target database.
3. **CRITICAL:** Before opening traffic, execute `SELECT public.suppress_restored_deleted_accounts_rpc();` (automated in `pnpm drill:restore`).
4. Verify that all subjects recorded in `public.deleted_subject_tombstones` have `account_status = 'deleted'` and zero rows in `public.user_locations` and `public.push_devices`.
5. Run smoke test (`GET /v1/health/ready`) and switch traffic.

## 3. Database Saturation / High CPU (>70% p95)
1. Inspect slow queries via `pg_stat_statements`.
2. Verify all list queries use keyset indexes (`posts_feed_keyset_idx`, `messages_conv_seq_desc_idx`, `user_locations_coords_expires_idx`).
3. Ensure PgBouncer transaction pooling is active on `DATABASE_URL`.

## 4. Abusive Traffic / Scraping Spike
1. Check `rate_limit_hits_total` metric and `public.rate_limit_buckets`.
2. Tighten per-route limits or block offending accounts via `POST /v1/admin/cases/{id}/actions` (`temporary_suspend` / `interaction_limit`).
