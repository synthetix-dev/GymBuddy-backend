# SwiftUI integration

## Target layers

```text
App composition
  → Feature ViewModels (@MainActor, observable)
    → Domain UseCases / Repository protocols
      → Remote API + Realtime + Media + Push adapters
      → Local cache/outbox (SwiftData/SQLite)
```

Components:

- `APIClient` actor: URLSession, Codable, auth interceptor, request ID, retry/cancellation, problem decoding.
- `AuthManager` actor: Apple flow and auth provider calls.
- `SessionManager` actor: single-flight refresh, account status, bootstrap routing.
- `SecureTokenStorage`: Keychain only; protocol enables tests.
- Feature repositories: `Profile`, `Feed`, `Conversation`, `Discover`, `Workout`, `Notification`.
- Separate DTO/domain/view data; server timestamps/IDs never modeled as display strings.
- `MediaUploader`: intent → background upload → complete; progress/checksum.
- `RealtimeClient` actor: one socket, typed events, rejoin/catch-up.
- `PushNotificationManager`: permission, token registration, deep links; push does not mutate canonical data.
- Cache/outbox: explicit stale metadata and optimistic client IDs.

## State/error policy

Each feature has `idle/loading/content(empty)/refreshing/error(staleContent?)`. Map 401 to serialized refresh; 403 account/block to actionable domain state; 409 refresh/reconcile; 422 field errors; 429 respect `Retry-After`; 5xx/network exponential backoff with full jitter for idempotent requests only. Never retry non-idempotent mutation without key. Accessibility and offline banners are view concerns.

## Incremental migration

1. Add protocols and move current `AppDataStore` fixtures behind `MockRepositories`; views unchanged.
2. Add session/bootstrap route while all content remains mock.
3. Replace profile/settings/media slice.
4. Replace feed read, then like/save/comment/create.
5. Replace conversations/history/send, then realtime/read/push/offline.
6. Replace discover/location and workout flows.
7. Remove fixture construction only after parity tests and feature-flag rollout.

`AppDataStore` may temporarily become a facade, but domain mutations leave it. Do not inject Supabase client directly into views.

## Screen-to-API overview

Exact matrix is in [SCREEN-API-MATRIX.md](SCREEN-API-MATRIX.md). Principal file changes:

| Existing files | Change |
|---|---|
| `GymBuddyApp.swift`, `MainAppView.swift` | dependency container, auth/onboarding route, deep links, lifecycle reconnect |
| `Domain/Models.swift` | split server DTO/domain/display; Instant/timezone/distance types |
| `Domain/AppDataStore.swift` | phase out fixtures/business mutations; facade or per-feature VMs |
| `Onboarding/*` | real registration/profile/permission steps and resumable server state |
| `Discovery/*` | repository pagination, permission/manual location, server filters/actions |
| `Feed/*` | cursor pages, drafts/upload progress/comments, optimistic interactions |
| `Chat/*` | cached inbox/history, outbox/status/read/realtime, real attachment upload |
| `Profile/*` | remote profile/settings, server counts/sessions, account/session management |
| project config | packages, entitlements, privacy strings, environments, universal links/APNs |

## Offline behaviors

- Profile/feed/history: show last cache with “updated” time; sensitive cache encrypted/file-protected.
- Like/save/read: queue coalescible operation.
- Post/message/session: persist draft/outbox with stable key; show progress/failure.
- Discover: cached cards may display but connect requires server; never calculate exact remote distance from cached coordinates.
- Account/block/deletion: require network and explicit confirmed result.

## Tests

Repository contract tests run against mock and staging; URLProtocol transport tests; Keychain/reinstall cases; view-model deterministic clocks; event duplication/gap; offline outbox process death; deep-link authorization; schema snapshot generated from OpenAPI.
