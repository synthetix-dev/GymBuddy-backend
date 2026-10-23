# Media and notifications

## Media pipeline

Buckets: `profile-originals` private, `post-originals` private, `message-attachments` private, `media-variants` signed/CDN according to visibility. Object path is server-generated (`owner/yyyy/mm/object_uuid`), never raw filename.

1. Client preprocesses HEIC/JPEG to sensible dimensions but server trusts none of it.
2. Request upload intent with declared MIME, byte size, SHA-256 and purpose.
3. Server enforces quota/type/ownership and returns short-lived signed upload constrained to path/size.
4. Client uploads, calls complete.
5. Worker sniffs magic bytes, decodes safely, strips metadata/EXIF GPS, rejects polyglots/decompression bombs, optionally malware/moderation scans, creates WebP/JPEG thumbnails.
6. Only `ready` variants may attach/publish; failed object quarantined/deleted.

MVP limits: avatars 10 MB/12 MP; post images 15 MB each, max 4; chat image 15 MB. Allow JPEG/PNG/HEIC input, normalized variants; no video/GIF/SVG. Signed download URL 5–15 min. Cache immutable variants by content hash; authorization precedes URL issuance. Orphan upload GC after 24h; deleted-content media after retention; account deletion walks owned objects and shared-reference rules.

Cost controls: per-user daily/monthly bytes, max dimensions, variants limited to 3 sizes, CDN cache, lifecycle metrics and budget alerts. Supabase Pro includes 100 GB storage and 250 GB cached/uncached allowances described on [pricing](https://supabase.com/pricing); overage must be monitored.

## APNs architecture

APNs token-based provider auth from trusted worker. Apple notes one APNs key can work across apps/environments and must be revocable: [Apple token setup](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens). Provider uses HTTP/2; never send from iOS client.

Event transaction inserts notification + outbox. Worker evaluates recipient preferences/quiet rules, collapses duplicates, chooses foreground realtime vs APNs, sends, records provider response. Invalid/unregistered token is revoked. Retry transient 429/5xx with bounded backoff; permanent 4xx dead-letter. `apns-collapse-id` for replaceable updates, deterministic dedupe key, mutable badge derived from unread count.

| Type | Default payload/privacy | Deep link |
|---|---|---|
| message | “New message” by default; preview only opt-in | conversation id |
| comment/reply | actor + generic interaction | post/comment |
| like | batched summary | post |
| workout invitation/accepted/cancelled | generic session info, no exact private location on lock screen | invitation/session |
| reminder | date/time; venue subject to preference | session |
| system/moderation | minimal sensitive detail | notification/support |

Silent push is only a refresh hint and is throttled by iOS; never rely on it for correctness. Multiple devices each have token record; login/register upserts, logout revokes that device, account delete revokes all. Token stored encrypted; logs contain hash suffix only.

## Notification preferences

Per category and channel (`in_app`, `push`), preview privacy, quiet hours/timezone. Safety/account notifications cannot all be disabled but remain minimal. Permission denial means in-app inbox works. Badge is reconciled during bootstrap and notification read, not incremented blindly.

## Tests

MIME mismatch, oversized/decompression bomb, EXIF removal, signed URL expiry/member revocation, orphan cleanup, duplicate outbox, multiple devices, invalid token, APNs 429/410, collapse behavior, timezone quiet hours, notification deep link to inaccessible/deleted resource.
