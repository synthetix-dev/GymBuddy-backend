# ADR-002: Product Decisions — Resolver for Open Questions (`17-RISKS-OPEN-QUESTIONS.md`)

- **Status:** Accepted
- **Date:** 2026-10-23
- **Refs:** `04-AUTHENTICATION.md`, `06-CHAT-REALTIME.md`, `07-DISCOVER-WORKOUTS.md`, `11-SECURITY-PRIVACY.md`, `12-ADMIN-MODERATION.md`, `17-RISKS-OPEN-QUESTIONS.md`

## Context
Document `17-RISKS-OPEN-QUESTIONS.md` and `BACKEND-TASKS.md` require all open product decisions to be codified as explicit ADRs rather than implicit code assumptions.

## Explicit Decisions

### 1. Connection & Messaging Policy (Unilateral Request vs Mutual Match)
- **Decision:** Pressing `connect` in Discover creates a `connect` relationship (`user_relationships`) and opens or returns the canonical 1:1 conversation (`direct_key`).
- **Anti-Spam Safeguard:** Until the recipient either replies or also connects (`mutual` state), the initiator may send **at most 1 initial message** (`MESSAGE_REQUEST_LIMIT_REACHED` `403` on a second message before recipient reply/connect).

### 2. Gender & Identity Vocabulary and Discover Filter Fairness
- **Decision:** `gender_code` supports inclusive, extensible values (`male`, `female`, `non_binary`, `other`, `prefer_not_to_say`). Discover filtering by gender is optional (`any` by default) and only matches users who opted into `discoverable` visibility.

### 3. Minimum Age & Verification
- **Decision:** Strict **18+ adult-only** policy (`birth_date <= current_date - interval '18 years'` enforced at both API validation and PostgreSQL `CHECK` constraint levels). Public profiles expose computed age in years only if `show_age = true` in `user_settings`, never raw `birth_date`.

### 4. Profile/Post Visibility & Block Tombstones
- **Decision:**
  - Bilateral blocking (`blocked_users`) hides both users from each other across Discover, Feed, Search, Public Profiles (returns `404 PROFILE_NOT_FOUND` to avoid leaking block status), and Chat.
  - Comment trees where a parent comment was deleted retain a neutral tombstone (`[Comment deleted]`) only while active child replies exist.

### 5. Message Deletion Semantics & Reportable Evidence Window
- **Decision:**
  - User message deletion sets `deleted_at` and replaces client-visible `body` with empty string (`status = 'deleted'`), while retaining an immutable audit/moderation snapshot for 30 days in case of safety reports.
  - Filing a report (`POST /v1/reports`) captures an immutable `evidence_snapshot` JSONB of the target resource (plus up to 5 surrounding messages in the same conversation when reporting a message) at the exact time of reporting.

### 6. Location Freshness, Rounding & Manual Gym Fallback
- **Decision:**
  - Coordinates are stored in `user_locations` with a **30-day TTL** (`expires_at = captured_at + interval '30 days'`).
  - API responses **never** return exact latitude/longitude or geohash of other users. Distance is rounded to the nearest integer kilometer (`GREATEST(1, ROUND(distance_m / 1000.0))`), and when location permission is denied, Discover falls back to the user's selected `home_gym_id` centroid.

### 7. Workout Session Reschedule & Cancellation Rules
- **Decision:**
  - Changing `starts_at` or `gym_id` on a `scheduled` session with accepted participants increments `revision`, records a row in `workout_session_revisions`, transitions the session to `reschedule_pending`, and sets existing non-creator participants to `reconfirmation_required`.
  - Once all accepted participants re-confirm, status returns to `scheduled`.
  - Blocking any participant in a 1:1 session immediately transitions the session to `cancelled` and revokes active invitations with a generic notification.

### 8. Moderation SLA, Dual Control & Emergency Access
- **Decision:**
  - Reports enter `new` state with a 24h P0 triage SLA.
  - Permanent account suspension (`permanent_suspend`) requires `safety_lead` or `super_admin` role with a mandatory second approver (`approved_by_admin_id != admin_id`) or emergency grant.
  - Private chat messages are unreadable by moderators unless captured in a report's `evidence_snapshot` or unlocked by a time-bound `admin_emergency_grants` record with ticket reference.

### 9. GDPR Deletion Cooling-Off & Backup Restore Suppression
- **Decision:**
  - Account deletion (`POST /v1/me/account-deletion`) immediately revokes all other active sessions, sets `account_status = 'deletion_pending'`, and starts a **7-day cooling-off period** (`due_at = now() + interval '7 days'`).
  - During the cooling-off window, the user can cancel (`DELETE /v1/me/account-deletion`).
  - Once `due_at` passes, the erasure worker purges private data, anonymizes shared references, and writes a permanent SHA-256 hash into `deleted_subject_tombstones` so that any future database backup restore drill automatically re-purges erased users before opening traffic.
