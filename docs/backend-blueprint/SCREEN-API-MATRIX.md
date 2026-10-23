# iOS screen ↔ API matrix

| Screen / file | Reads | Writes/events | UI states / offline |
|---|---|---|---|
| app route `GymBuddyApp.swift` | `GET /me/bootstrap` | refresh/logout | splash, unauth, profile-required, active, suspended; cached route never overrides server |
| onboarding `Features/Onboarding/*` | bootstrap/feature config | auth provider, profile setup, settings | resume step; permission denied alternatives |
| Discover `DiscoveryView.swift` | `GET /discover` | `POST /discover/{id}/actions` | loading/cards/empty/rate/error; cache view-only offline |
| filters `DiscoveryFilterSheet.swift` | profile settings, gyms/search | `PATCH /me/settings` optional | locally editable; server validation/revert |
| Feed `FeedView.swift` | `GET /feed`, `/search` | none | skeleton/content/empty/stale/error; cached pages |
| card `FeedPostCard.swift` | included post | like/save endpoints | optimistic coalesced; rollback permanent error |
| composer `CreatePostView.swift` | own profile/config | upload intent/complete, `POST /posts` | draft/upload/publish/retry; durable offline draft |
| recipe `RecipeDetailView.swift` | `GET /posts/{id}` | save/like | cached content; unavailable tombstone |
| public profile `PublicProfileView.swift` | `/profiles/{id}`, author posts | connect/block/report | privacy/blocked/not-found distinct local UX |
| Chat inbox `ChatView.swift` | `/conversations` | membership patch | cached inbox + reconnect badge |
| conversation `ChatView.swift` | messages before/after cursor | send/read/typing + realtime | outbox states, gap catch-up, block termination |
| scheduler `ScheduleSessionView.swift` | gyms/profile | create session/invitation | timezone/validation/full/conflict |
| Profile `ProfileView.swift` | own profile/posts/sessions | composer routes | cached own data; server counts |
| Settings `ProfileSettingsView.swift` | profile/settings/session devices | patches, export/delete/logout | per-field errors; destructive actions network-only |
| Saved/Liked | feed filtered endpoints or `/me/saved|liked` | toggles | cached/stale/empty |

All existing files keep presentation responsibilities; new ViewModels/repositories own calls and state.
