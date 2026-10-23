# GymBuddy Production Backend (`/v1`)

Повна реалізація бекенду **GymBuddy** згідно з комплектом архітектурної документації `docs/backend-blueprint/` (`00-EXECUTIVE-SUMMARY.md` – `17-RISKS-OPEN-QUESTIONS.md`, `ACCESS-MATRIX.md`, `BACKEND-TASKS.md`, `ENVIRONMENT.md`, `SCREEN-API-MATRIX.md`, `openapi.yaml`).

## Архітектура та стек

- **База даних:** PostgreSQL 17 (`pgcrypto`, `citext`, `pg_trgm`, `postgis` + портативні геодезичні функції `gb_distance_m`, `gb_dwithin`, `gb_rounded_distance_km`, `gb_coarse_geohash`).
- **Авторизація (Defense-in-Depth):**
  - 48 таблиць у схемі `public`, на кожній увімкнено та примусово активовано Row Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`).
  - `SECURITY DEFINER` предикати з фіксованим `search_path`: `is_active_account`, `is_blocked` (двосторонній симетричний блок), `are_connected`, `can_view_profile`, `can_view_post`, `is_conversation_member`, `can_view_workout_session`, `has_admin_role`.
- **Командний шар та консистентність:**
  - Усі мутації вимагають `Idempotency-Key` (UUID) зі збереженням SHA-256 хешу запиту в `idempotency_keys` (`409 IDEMPOTENCY_CONFLICT` при спробі використати той самий ключ з іншим тілом).
  - Оптимістичне блокування через поле `version` (`409 VERSION_CONFLICT` при застарілій версії).
  - Повідомлення чату використовують монотонний серверний лічильник `server_seq` під `SELECT ... FOR UPDATE` на діалозі та дедуплікацію за `(conversation_id, sender_id, client_message_id)`.
  - Прийняття запрошень на тренування (`accept-invitation`) блокує рядок сесії (`SELECT ... FOR UPDATE`) і гарантує відсутність переповнення місткості (`409 SESSION_FULL`).
- **Побічні ефекти (Transactional Outbox):**
  - Таблиця `outbox_events` із конкурентним вибором `FOR UPDATE SKIP LOCKED`, орендою воркера (`leased_until`), експоненційним backoff та dead-lettering.
  - APNs пуш-воркер приховує текст повідомлень на заблокованому екрані за замовчуванням (`"New message"`), враховує тихі години (`quiet_hours`) у часовому поясі користувача та автоматично відкликає токени при відповіді `410 Unregistered`.

## Структура репозиторію

- `supabase/config.toml` — конфігурація Supabase проєкту, Auth (Sign in with Apple), приватних бакетів Storage (`profile-originals`, `post-originals`, `message-attachments`, `media-variants`).
- `supabase/migrations/` — 5 послідовних SQL-міграцій (`20261023000100` .. `20261023000500`) та `supabase/seed.sql`.
- `supabase/functions/` — адаптери Supabase Edge Functions (`send-message`, `accept-invitation`, `create-upload`, `delete-account`, `report-content`).
- `src/` — модульний моноліт на TypeScript:
  - `src/config/env.ts` — конфігурація середовища, шифрування токенів AES-256-GCM та криптографічні peppers.
  - `src/observability/logger.ts` — структуроване JSON-логування з автоматичним редагуванням PII/секретів та метриками латентності (p50/p95/p99).
  - `src/core/` — `problem+json` помилки, JWT-підпис/ротація, ідемпотентність, sliding-window rate limiter, HMAC-підписані keyset-курсори.
  - `src/modules/identity/` — Apple Sign-In, `/v1/me/bootstrap`, профілі, налаштування, сесії, двостороннє блокування, скарги з `evidence_snapshot`, GDPR-експорт і видалення акаунта з 7-денним cooling-off та `deleted_subject_tombstones`.
  - `src/modules/media/` — двофазне завантаження медіа, перевірка magic bytes, захист від decompression bombs (>12 MP) і поліглотів, очищення EXIF/GPS, генерація 3 варіантів, підписані URL.
  - `src/modules/social/` — пости (`text`, `recipe`, `workout`), формула ранжування стрічки `/v1/feed` з обмеженням домінування автора, ідемпотентні лайки/збереження, коментарі глибиною до 2 з tombstones, FTS + trigram пошук.
  - `src/modules/chat/` — канонічні 1:1 діалоги (`direct_key`), ідемпотентна відправка, ліміт 1 message-request для не-конектів, catch-up (`after_seq`), монотонний `last_read_seq`.
  - `src/modules/workouts/` — геопошук `/v1/discover` (повертає лише заокруглені км), скінченні автомати сесій та запрошень, перенесення часу з `reschedule_pending`, нагадування за 24 год і 2 год.
  - `src/modules/admin/` — RBAC (`support`, `moderator`, `safety_lead`, `ops`, `auditor`, `super_admin`), MFA-гейт, двоосібне погодження (`dual control`) для перманентного бану, незмінний `audit_logs`.
- `openapi/openapi.yaml` — повна специфікація OpenAPI 3.1.0.
- `sdk/swift/GymBuddyBackendSDK/` — згенерований Swift 6 клієнтський пакет для інтеграції в iOS-застосунок.
- `docs/adr/` та `docs/runbooks/` — архітектурні рішення (ADR-001, ADR-002) та операційні інструкції.

## Швидкий старт та команди перевірки

```bash
# 1. Застосувати всі SQL-міграції з нуля та заповнити тестовими даними
pnpm db:reset

# 2. Запустити перевірку типів TypeScript та валідацію OpenAPI 3.1
pnpm typecheck
pnpm openapi:validate

# 3. Згенерувати та скомпілювати Swift 6 SDK для iOS
pnpm sdk:generate
cd sdk/swift/GymBuddyBackendSDK && swift build && cd ../../..

# 4. Запустити повний набір інтеграційних, безпекових (RLS) та конкурентних тестів
pnpm test

# 5. Виконати операційні навчання (Backup Restore Drill, Key Rotation Drill, Load Test)
pnpm drill:restore
pnpm drill:rotate-keys
pnpm load:test
```
