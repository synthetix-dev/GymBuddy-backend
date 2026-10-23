# API and realtime contract

## Standards

Base `/v1`; HTTPS only; bearer JWT; JSON snake_case; UUID strings; RFC 3339 UTC timestamps; `application/problem+json`. List responses use `{data, page:{next_cursor,has_more}}`. Mutating POST commands require `Idempotency-Key`; updates require `If-Match` or `version`. Correlation header `X-Request-ID`. Full machine-readable seed: [openapi.yaml](openapi.yaml).

Error example:

```json
{"type":"https://api.gymbuddy.app/problems/version-conflict","title":"Version conflict","status":409,"code":"VERSION_CONFLICT","detail":"Resource changed; refresh and retry.","request_id":"req_01...","errors":[{"field":"version","reason":"stale"}]}
```

## Endpoint inventory

All `auth: user` endpoints require active account. `O/M/V/A` authorization is defined in [ACCESS-MATRIX.md](ACCESS-MATRIX.md). Default body 256 KB, pagination limit 20/default/100 max.

| Method/path | Purpose / auth | Input / response | Errors / rate / idem |
|---|---|---|---|
| `GET /health/live|ready` | ops, public | status/build/dependency readiness (no secrets) | 200/503; 60/min |
| `GET /me/bootstrap` | session bootstrap, O | profile/settings/next_step/feature config | 401/403; 60/min |
| `GET/PATCH /me/profile` | own profile | patch + version → profile | 422/409; 30/min; update idem |
| `GET/PATCH /me/settings` | synced settings | privacy/push/discovery | 422; 30/min |
| `POST /me/photos/upload-intents` | upload slot | mime,size,sha256,purpose → signed URL/object | 413/415/429; 20/day; yes |
| `POST /me/photos/{id}/complete` | finalize | upload checksum → processing media | 409/422; yes |
| `GET /profiles/{id}` | public profile, V | projection + relation | 403/404 (hide existence); 120/min |
| `POST /profiles/{id}/block` | safety | reason optional → 204 | 404; 60/day; yes |
| `DELETE /profiles/{id}/block` | unblock | 204 | 404; yes |
| `GET /discover` | candidates | radius/interests/time/gym/cursor | 422; 60/min |
| `POST /discover/{id}/actions` | pass/connect/hide | action → state/conversation optional | 409/422; 120/day; yes |
| `GET /feed` | for_you/following | mode,type,cursor,limit | 410 cursor; 120/min |
| `POST /posts` | create/publish post | discriminated post DTO | 413/422; 30/hour; yes |
| `GET/PATCH/DELETE /posts/{id}` | read/edit/delete | version for mutation | 403/404/409; yes mutation |
| `PUT/DELETE /posts/{id}/like` | like/unlike | interaction state/count | 404; 300/hour; naturally idem |
| `PUT/DELETE /posts/{id}/save` | save | 204 | 404; idem |
| `GET/POST /posts/{id}/comments` | list/create | cursor; body,parent_id | 422/429; 60/hour; create idem |
| `PATCH/DELETE /comments/{id}` | edit/delete own | body,version | 403/409; idem |
| `GET /search` | people/posts/recipes | q,type,filters,cursor | 422/429; 30/min |
| `GET/POST /conversations` | list/create direct | cursor; participant_id | 403/409; create idem |
| `PATCH /conversations/{id}/membership` | pin/archive/hide | fields + version | 403/409; idem |
| `GET /conversations/{id}/messages` | history/catch-up, M | before_seq/after_seq/limit | 403/404; 240/min |
| `POST /conversations/{id}/messages` | send, M | client_message_id,kind,body,attachments | 403/409/422/429; 60/min; required |
| `PUT /conversations/{id}/read-state` | monotonic read | last_read_seq | 403/422; 120/min; idem |
| `POST /conversations/{id}/typing` | ephemeral | is_typing | 403/429; 30/min |
| `POST /workout-sessions` | create | activity,starts_at,timezone,capacity,gym | 422/409; 20/day; required |
| `GET/PATCH /workout-sessions/{id}` | participant view/update creator | version/revision | 403/409/422; idem |
| `POST /workout-sessions/{id}/invitations` | invite | invitee_id,expires_at | 403/409; 50/day; required |
| `POST /workout-invitations/{id}/accept|decline|revoke` | transition | version | 403/409/410; required |
| `GET /me/workout-sessions` | upcoming/history | state,cursor | 120/min |
| `GET /notifications` | inbox | cursor/unread_only | 120/min |
| `PUT /notifications/{id}/read` | mark read | 204 | 404; idem |
| `POST/DELETE /push-devices/{id?}` | register/revoke | token,environment,bundle | 422; 20/day; idem |
| `POST /reports` | report target | target_type/id,reason,details | 409/422; 20/day; required |
| `POST /me/data-export` | async export | 202 job | 409/429; 2/day; required |
| `POST /me/account-deletion` | reauth delete request | confirmation/reauth proof | 401/409; 3/day; required |
| `DELETE /me/account-deletion` | cancel pending | 204 | 409; required |
| `GET /admin/reports` | queue, A | filters/cursor | 403; audited |
| `POST /admin/cases/{id}/actions` | moderation action, A | action/reason/duration | 403/409; required + audited |

## Examples

```http
POST /v1/conversations/8b.../messages
Authorization: Bearer <access-token>
Idempotency-Key: 62f8...
Content-Type: application/json

{"client_message_id":"4ac...","kind":"text","body":"Thursday at 18:00 works!","attachment_ids":[]}
```

```json
{"data":{"id":"99a...","conversation_id":"8b...","client_message_id":"4ac...","server_seq":91,"kind":"text","body":"Thursday at 18:00 works!","created_at":"2026-10-23T16:31:04Z"}}
```

## Realtime events

Private topics: `user:{user_id}` (conversation/notification summary) and `conversation:{id}` (messages, reads, typing). Subscription JWT must match user/member; server never accepts client-supplied arbitrary user id as authorization.

Envelope:

```json
{"event_id":"evt_01...","type":"message.created","occurred_at":"2026-10-23T16:31:04Z","aggregate_id":"8b...","sequence":91,"data":{"message_id":"99a..."}}
```

Durable types: `message.created|updated|deleted`, `message.read`, `conversation.updated`, `notification.created`, `invitation.updated`, `session.updated`, `media.ready`. Ephemeral: `typing.changed`, `presence.changed`; not replayed. Event is a hint: fetch resource/catch-up, dedupe `event_id`, ignore older aggregate version.
