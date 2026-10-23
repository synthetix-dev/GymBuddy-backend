# Аудит поточного iOS-застосунку

## Метод і межі

Перевірено всі 29 Swift-файлів, `project.pbxproj`, assets, `README.md` і `VALIDATION.md`. Репозиторій не містить `.git`, тестового target або backend-каталогу. Висновки нижче стосуються лише наявних файлів; заплановані серверні можливості явно позначені.

## Структура

| Зона | Наявне |
|---|---|
| App | `GymBuddyApp.swift`: composition root і onboarding flag; `MainAppView.swift`: 4 tabs; `AppTab.swift`, `BottomTabBar.swift`, preview states |
| Domain | `Models.swift`: 10 value/entity types; `AppDataStore.swift`: єдиний mutable in-memory store, fixtures і всі mutations |
| Features | Onboarding (5 screens), Discovery (3), Feed (4), Chat (3), Profile (4) |
| DesignSystem | colors, typography, spacing, buttons, cards, local photo rendering, JPEG resize |
| Project | Swift 6, iOS 26.0, generated Info.plist, bundle `com.example.GymBuddy`, no package dependencies/capabilities |

## Моделі й стан

`Models.swift` визначає `User`, `WorkoutSession`, `Message`, `Conversation`, `FeedPost`, `RecipeMetadata`, `WorkoutPostMetadata` та enums. Це UI-oriented моделі: nested author/participant, display strings (`timeAgo`, `dateString`, `timeString`), локальний `Data`, client-owned counters. Вони не `Codable`, крім кількох enums; немає DTO/versioning/server timestamps.

`AppDataStore.swift` створює 8 hardcoded users (Dmitro, Maya, Alex, Sam, Priya, Chris, Taylor, Jordan), 5 posts, 5 conversations і 1 invitation. Він же фільтрує discovery, створює chat, mutate likes/saves, публікує posts, archive/pin/delete chat, send messages і schedule/update workout. UUID генеруються при кожному запуску, тому зв'язки нестабільні між процесами.

Персистентність:

- `GymBuddyApp.swift`: `hasCompletedGymBuddyOnboardingV1` через `@AppStorage`.
- `ProfileSettingsView.swift`: `gymBuddyNotifications`, `gymBuddyDiscoveryVisible`, `gymBuddyDistance` через `@AppStorage`.
- Усі інші дані — RAM. Немає SwiftData/Core Data/files/cache/Keychain/CloudKit.

## Повна функціональна матриця

| Функціонал | Поточна реалізація (доказ) | Потрібно на backend | P |
|---|---|---|---|
| Onboarding | 6-page local flow; обидві CTA завершують його (`Features/Onboarding/*`, `GymBuddyApp.swift`) | server `onboarding_state`, profile completeness; auth routing | P0 |
| Registration/sign-in | UI відсутній; “Sign in” лише завершує onboarding (`OnboardingFinalView.swift`) | Apple OAuth, optional email, sessions, recovery | P0 |
| Current profile | hardcoded Dmitro; local edit/avatar (`AppDataStore.swift`, `ProfileSettingsView.swift`) | profile CRUD, validation, media ownership, optimistic version | P0 |
| Public profile | derived from nested local User (`PublicProfileView.swift`) | privacy-safe projection, posts, connection state | P0 |
| Interests/level/time | arrays/enums in `User`; local selectors | normalized interests and profile preferences | P0 |
| Settings | 3 `@AppStorage` values; local help/QR/share/logout (`ProfileSettingsView.swift`) | synced settings, privacy, notifications, account sessions | P0 |
| Profile posts/stats | computed from arrays (`ProfileView.swift`) | paginated posts and server counters | P1 |
| Discover cards | cyclic fixture deck (`DiscoveryView.swift`) | candidates, exclusions, cursor, impressions/actions | P0 |
| Discover filters | gender/gym/time only, local (`DiscoveryFilterSheet.swift`) | radius, interests, time, age/privacy validation | P0 |
| Geolocation | hardcoded distance and “Kyiv” (`Models.swift`, `ProfileView.swift`) | consent, PostGIS, coarse output, TTL location | P0 |
| Connect/pass | connect creates/reopens local chat; pass only advances (`AppDataStore.swift`) | idempotent actions, optional mutual connection policy | P0 |
| Feed | local list/search and 5 fixtures (`FeedView.swift`) | cursor feed, visibility/block filters, ranking | P0 |
| Text/workout posts | local creation (`CreatePostView.swift`) | draft/publish/edit/delete, moderation | P0 |
| Recipes | metadata + detail/checklist (`Models.swift`, `RecipeDetailView.swift`) | normalized recipe data and transactions | P1 |
| Photo posts | PhotosPicker + local JPEG `Data` (`CreatePostView.swift`, `ImageDataProcessor.swift`) | upload intent, scanning/processing/storage | P0 |
| Likes/saves | boolean/counter mutation in array (`AppDataStore.swift`) | unique joins, atomic counts | P0 |
| Comments/replies | count displayed; no comment UI/data | comment tree, pagination, moderation | P0 |
| Feed search | in-memory substring or max kcal (`FeedView.swift`) | FTS/trigram, typed filters | P1 |
| Chat inbox | local search/pin/archive/delete (`ChatView.swift`) | membership, per-user state, unread/cursors | P0 |
| 1:1 messages | local text append (`AppDataStore.swift`) | idempotent send, ordering, read/delivery, realtime | P0 |
| Chat attachment | chosen/previewed, but send drops the photo (`ChatView.swift:414-485`) | private object + attachment message | P0 |
| Presence/typing | fixture `isOnline`; no typing | ephemeral realtime presence/typing | P1 |
| Unread | hardcoded badge “2” only for Maya (`ChatView.swift`) | read cursor and unread aggregation | P0 |
| Chat archive/pin/delete | local sets/removal (`AppDataStore.swift`) | per-member conversation state/soft hide | P1 |
| Block | deletes local conversation only (`AppDataStore.swift`) | durable symmetric exclusion + transactional enforcement | P0 |
| Report | alert says local/offline (`ChatView.swift`) | report intake, evidence snapshot, moderation queue | P0 |
| Workout scheduling | fixed gym list, date/time picker, local invite (`ScheduleSessionView.swift`) | venue/timezone/status/capacity/invitation transactions | P0 |
| Invitation response | pending/accepted/declined local mutation (`MessageBubbleView.swift`, store) | state machine, authorization, concurrency | P0 |
| Upcoming sessions | flattens every local scheduled workout, including pending/declined (`ProfileView.swift`) | filtered server query and lifecycle | P1 |
| Push | absent | device registry, outbox, APNs sender/preferences | P0 |
| Media CDN | local xcassets and memory data | private/public policy, CDN, cleanup | P0 |
| Moderation/admin | absent | roles, queues, actions, audit | P0 |
| Offline/retry | process-only state; cosmetic screen phases | cache, outbox, idempotency/reconciliation | P0 |
| Error/loading states | generic previewable `ScreenStateContainer`, not tied to I/O (`Layout.swift`) | typed network errors and per-feature state | P1 |
| Analytics/monitoring | absent | product events, Sentry/OTel/logs | P1 |
| Sharing/QR | plain text and code alert (`ProfileShareSheet.swift`, settings) | canonical deep link / safe public identifier | P1 |

## Екрани

Top-level: onboarding splash, 4 story slides, final CTA; Discover + filter; Feed + search + composer + recipe detail; Chat inbox + conversation + archive + scheduler; Profile + settings + editor + saved/liked + public profile. Точне API mapping: [SCREEN-API-MATRIX.md](SCREEN-API-MATRIX.md).

## Архітектурні ризики

1. UI, fixtures, business rules і persistence змішані в одному store; неможливо незалежно тестувати transport/domain.
2. Client-owned counters/status дозволили б tampering у реальній системі.
3. Nested `User`/`WorkoutSession` snapshots створюють divergence.
4. Date/time і distance — display strings/`Int`, а не UTC instant/timezone/decimal.
5. Block не є safety control; report не відправляється; attachment silently discarded.
6. Onboarding completion помилково дорівнює authenticated state; logout replay-ить onboarding.
7. Немає test target, entitlements, privacy usage strings, environments або secrets strategy.
8. `com.example.GymBuddy` і дві різні development teams потребують release cleanup.

## Безпечна заміна mock без big-bang rewrite

Ввести protocols/repositories паралельно з `AppDataStore`, зберегти наявні views; адаптер `Mock*Repository` спочатку повертає fixtures. По одному vertical slice замінювати на remote implementation: session → profile → feed → interactions → chat → discover/workouts. UI-моделі лишаються domain types, API DTO мапляться окремо. Деталі: [09-IOS-INTEGRATION.md](09-IOS-INTEGRATION.md).
