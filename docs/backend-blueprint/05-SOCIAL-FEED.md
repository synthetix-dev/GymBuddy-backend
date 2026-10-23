# Social feed

## Content model and commands

`posts` is the aggregate root with subtype `text|recipe|workout`. Recipe ingredients/steps and workout metadata are written in the same transaction. States: `draft → processing_media → published → hidden|deleted`; a failed upload stays draft and is retryable. Edit increments version; delete soft-deletes public view and schedules media cleanup after retention.

Commands: create draft, request/finalize media, publish, edit, delete, like/unlike, save/unsave, comment/reply/edit/delete, hide/unhide, report. Server validates text length, subtype invariants, media ownership/readiness, audience, account state and block relationship.

## MVP feed algorithm

Fan-out on read, keyset paginated. Build eligible set first: published, visible profile/audience, not blocked/hidden, moderation allowed. Score:

```text
score = 0.55 * recency_decay(36h)
      + 0.20 * relationship_weight
      + 0.15 * interest_overlap
      + 0.05 * nearby_coarse_bonus
      + 0.05 * capped_engagement_log
```

Mix constraints prevent domination: max 2 consecutive same author, reserve 20% discovery posts, cap stale posts, deterministic daily/user salt. Return `feed_reason`, never exact location. “Following” feed can sort strictly `(published_at,id)`.

Cursor encodes score snapshot/time/id, signed server-side. First MVP may use chronological feed plus interest filter; above score is next increment without ML.

## Interactions

- `post_likes`/`saved_posts` unique keys make toggles idempotent.
- Comments max nesting depth 2; 1,000 chars; deleted parent keeps tombstone while replies exist.
- Counters are cached server values, never client-authoritative; reconcile job detects drift.
- A block immediately removes both users' content from feeds/search and prevents interaction.
- Repost is deferred; if added, store reference and snapshot rules, not duplicate content.

## Search

PostgreSQL generated `tsvector` + GIN for post/recipe text; trigram for people/recipe title. Query length/rate limits, language configuration, visibility predicates applied before response. Numeric calorie filter is typed (`max_calories`), not overloaded text as in current `FeedView.swift`.

## Pagination and errors

`GET /v1/feed?mode=for_you&limit=20&cursor=` returns `items,next_cursor,has_more`. Missing/deleted item while paging is skipped. Stale cursor beyond retention → `410 CURSOR_EXPIRED`; client refreshes. `409 VERSION_CONFLICT` returns latest representation. Media processing returns post with variant state/placeholder.

## Recommendation evolution

1. Chronological + block/privacy.
2. Rules score and explicit interests.
3. Event warehouse, offline evaluation, diversity controls.
4. Candidate generation/ranking model only after measurable objective and safety/fairness review. Never infer sensitive traits or reward harassment; support “why shown” and reset preferences.

## Tests and scale

Unit: eligibility/score/diversity. Integration: RLS across private/block/suspended. Contract: cursor and mutations. Concurrency: duplicate likes, edit/delete race. Load: feed SQL `EXPLAIN ANALYZE`, p95 <300 ms at target dataset. Scale by indexes/materialized counters/partition old events before adding search infrastructure.
