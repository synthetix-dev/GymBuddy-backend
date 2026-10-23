# GymBuddy backend blueprint — executive summary

**Статус:** технічне проєктування, production-код не створювався.  
**Дата перевірки репозиторію та цін:** 2026-10-23.  
**Джерело істини аудиту:** поточний каталог `/Users/dmitro/Downloads/GymBuddy`.

## Вердикт

Для MVP обрати **Supabase Pro у регіоні ЄС**: PostgreSQL + PostGIS, Supabase Auth, Storage, Realtime і Row Level Security (RLS). Клієнт читає безпечні представлення та виконує прості CRUD-операції через офіційний Swift SDK; критичні команди (`send-message`, `accept-invitation`, `create-upload`, `delete-account`, `report-content`) проходять через короткі Edge Functions/RPC із транзакціями, rate limiting та аудитом. APNs викликається лише серверною функцією/worker. Це модульний моноліт, а не мікросервіси.

Причини: продукт реляційний (користувачі, блокування, взаємні зв'язки, коментарі, учасники сесій), вимагає транзакцій, геопошуку й детальної авторизації. PostgreSQL/PostGIS природніше за document DB; Supabase зменшує час і ціну MVP, але залишає переносиму PostgreSQL-схему.

**Альтернатива:** NestJS modular monolith + PostgreSQL/PostGIS + S3-compatible storage + WebSocket gateway + Redis/worker. Переходити до неї, коли Edge Functions/RLS суттєво ускладнюють доменні транзакції, потрібні довгі jobs/власний протокол realtime, або з'являється вимога до повного vendor-neutral hosting.

## Що реально є зараз

Застосунок — офлайн-прототип SwiftUI без API, auth, геолокації, push чи зовнішніх пакетів. `AppDataStore` зберігає hardcoded users/posts/chats у пам'яті; процес перезапускається — дані зникають. Персистентні лише onboarding і три налаштування через `@AppStorage`. Деталі та докази: [01-CURRENT-APP-AUDIT.md](01-CURRENT-APP-AUDIT.md).

## Межі MVP

У перший публічний реліз входять: Apple sign-in; профіль; безпечний приблизний discover; пости трьох типів; likes/comments/saves; 1:1 chat із idempotent delivery/read; workout invitations/sessions; media; APNs; block/report; мінімальна moderation console; GDPR delete/export; observability, backups і restore drill.

Не входять: ML-рекомендації, групові чати, E2EE, stories, платежі, live location, мікросервіси, Kubernetes, Elasticsearch. Повнотекстовий пошук MVP робить PostgreSQL; Redis вводиться лише за виміряною потребою.

## Ціна й компоненти

Supabase Pro стартує від **$25/міс**, включає 100k MAU, 8 GB database disk, 100 GB storage, 250 GB egress, 5M realtime messages і 500 peak realtime connections; overage та compute залежать від навантаження. Джерела: [Supabase pricing](https://supabase.com/pricing), [billing quotas](https://supabase.com/docs/guides/platform/billing-on-supabase), [Realtime limits](https://supabase.com/docs/guides/realtime/limits). Реалістичний production-бюджет з error tracking/email/monitoring: приблизно **$35–70** для 100–1k MAU, **$80–250** для 10k MAU, **$350–1,500+** для 100k MAU; це planning range, не quote. Розрахунок і припущення: [15-SCALING-COSTS.md](15-SCALING-COSTS.md).

## Відповіді на 10 фінальних питань

1. **Backend:** Supabase + тонкий command layer на Edge Functions/RPC.
2. **База:** PostgreSQL із PostGIS; SQL migrations у репозиторії.
3. **Готові сервіси:** auth, DB hosting, object storage/CDN, realtime transport. Самостійно: доменні правила, RLS, ranking, moderation workflow, APNs orchestration.
4. **Окремий сервер:** не потрібен постійно для MVP; потрібен серверний trusted execution layer. Виділений NestJS — еволюційний крок.
5. **Chat:** durable message у PostgreSQL у транзакції, Realtime як сигнал доставки, REST/keyset pagination як recovery, APNs для background.
6. **Фото:** private Supabase Storage buckets, signed URLs, thumbnails, metadata в DB.
7. **Nearby:** PostGIS `geography(Point,4326)`, серверний radius query; клієнту повертати rounded distance/area, ніколи точні координати інших людей.
8. **Вартість:** див. діапазони вище; медіа-egress і realtime fan-out — головна невизначеність.
9. **До релізу:** P0 auth/authorization, privacy/block/report, chat correctness, data deletion, backups, monitoring, rate limits і тестовий release gate.
10. **Послідовність:** Foundation → Identity/Privacy → Media → Social → Chat/Push → Discover/Workouts → Production readiness.

## Карта комплекту

Документи `01`–`17` деталізують систему. Додаткові артефакти: `openapi.yaml`, `ENVIRONMENT.md`, `ACCESS-MATRIX.md`, `SCREEN-API-MATRIX.md`, `BACKEND-TASKS.md`.
