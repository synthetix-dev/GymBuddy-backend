import type pg from 'pg';
import { env } from '../../config/env.js';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';
import { encodeKeysetCursor, decodeKeysetCursor } from '../../core/cursor.js';
import { assertActiveAccount, hydrateProfileDTO } from '../identity/identity.service.js';
import { createNotificationAndOutbox } from '../notifications/notifications.service.js';

export interface CreatePostInput {
  type: 'text' | 'recipe' | 'workout';
  body: string;
  visibility?: 'community' | 'connections' | 'private';
  attachment_ids?: string[];
  recipe?: {
    title: string;
    subtitle?: string;
    difficulty?: 'easy' | 'medium' | 'hard';
    calories: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    prep_minutes?: number;
    servings?: number;
    ingredients?: Array<{ text: string; quantity?: number; unit?: string }>;
    steps?: Array<{ instruction: string }>;
  };
  workout?: {
    activity: string;
    duration_minutes: number;
    calories_burned?: number;
    gym_id?: string | null;
  };
}

export async function hydratePostDTO(
  client: pg.PoolClient,
  postId: string,
  viewerId: string,
  feedReason?: string
) {
  const res = await client.query<{
    id: string;
    author_id: string;
    type: 'text' | 'recipe' | 'workout';
    status: string;
    body: string;
    visibility: string;
    likes_count: string;
    comments_count: string;
    saves_count: string;
    published_at: Date;
    created_at: Date;
    updated_at: Date;
    version: string;
    is_liked: boolean;
    is_saved: boolean;
  }>(
    `SELECT
       p.id,
       p.author_id,
       p.type::text AS type,
       p.status::text AS status,
       p.body,
       p.visibility::text AS visibility,
       p.likes_count::text,
       p.comments_count::text,
       p.saves_count::text,
       p.published_at,
       p.created_at,
       p.updated_at,
       p.version::text,
       EXISTS (SELECT 1 FROM public.post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $2) AS is_liked,
       EXISTS (SELECT 1 FROM public.saved_posts sp WHERE sp.post_id = p.id AND sp.user_id = $2) AS is_saved
     FROM public.posts p
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [postId, viewerId]
  );

  if (res.rowCount === 0) {
    throw Problems.notFound('Post');
  }

  const p = res.rows[0]!;
  const author = await hydrateProfileDTO(client, p.author_id, viewerId);

  const mediaRes = await client.query<{
    media_object_id: string;
    position: number;
    alt_text: string;
  }>(
    `SELECT media_object_id, position, alt_text
     FROM public.post_media
     WHERE post_id = $1
     ORDER BY position ASC`,
    [postId]
  );

  let recipeData: Record<string, unknown> | null = null;
  if (p.type === 'recipe') {
    const recRes = await client.query(
      `SELECT title, subtitle, difficulty::text, calories, protein_g, carbs_g, fat_g, prep_minutes, servings
       FROM public.recipes WHERE post_id = $1`,
      [postId]
    );
    if (recRes.rowCount && recRes.rowCount > 0) {
      const ingRes = await client.query(
        `SELECT position, text, quantity, unit FROM public.recipe_ingredients
         WHERE recipe_post_id = $1 ORDER BY position ASC`,
        [postId]
      );
      const stepRes = await client.query(
        `SELECT position, instruction FROM public.recipe_steps
         WHERE recipe_post_id = $1 ORDER BY position ASC`,
        [postId]
      );
      recipeData = {
        ...recRes.rows[0],
        ingredients: ingRes.rows,
        steps: stepRes.rows,
      };
    }
  }

  let workoutData: Record<string, unknown> | null = null;
  if (p.type === 'workout') {
    const wkRes = await client.query(
      `SELECT wu.activity, wu.duration_minutes, wu.calories_burned, wu.gym_id, g.name AS gym_name
       FROM public.workout_updates wu
       LEFT JOIN public.gyms g ON g.id = wu.gym_id
       WHERE wu.post_id = $1`,
      [postId]
    );
    workoutData = wkRes.rows[0] ?? null;
  }

  return {
    id: p.id,
    type: p.type,
    status: p.status,
    author,
    body: p.body,
    visibility: p.visibility,
    likes_count: Number(p.likes_count),
    comments_count: Number(p.comments_count),
    saves_count: Number(p.saves_count),
    is_liked: p.is_liked,
    is_saved: p.is_saved,
    media: mediaRes.rows.map((m) => ({
      media_object_id: m.media_object_id,
      position: m.position,
      alt_text: m.alt_text,
      url: `${env.GYMBUDDY_API_BASE_URL}/media/${m.media_object_id}/url`,
    })),
    ...(recipeData ? { recipe: recipeData } : {}),
    ...(workoutData ? { workout: workoutData } : {}),
    ...(feedReason ? { feed_reason: feedReason } : {}),
    published_at: p.published_at.toISOString(),
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
    version: Number(p.version),
  };
}

export async function createPostCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  input: CreatePostInput
) {
  await assertActiveAccount(client, userId);

  if (!['text', 'recipe', 'workout'].includes(input.type)) {
    throw Problems.validation('Invalid post type.', [{ field: 'type', reason: 'invalid_enum' }]);
  }
  if (typeof input.body !== 'string' || input.body.length > 5000) {
    throw Problems.validation('Post body must not exceed 5000 characters.', [
      { field: 'body', reason: 'invalid_length' },
    ]);
  }
  if (input.attachment_ids && input.attachment_ids.length > 4) {
    throw Problems.validation('Maximum 4 image attachments allowed per post.', [
      { field: 'attachment_ids', reason: 'max_4' },
    ]);
  }

  if (input.type === 'recipe') {
    if (!input.recipe || !input.recipe.title || input.recipe.title.trim().length === 0) {
      throw Problems.validation('Recipe posts require recipe.title.', [
        { field: 'recipe.title', reason: 'required' },
      ]);
    }
    if (
      typeof input.recipe.calories !== 'number' ||
      input.recipe.calories < 0 ||
      input.recipe.calories > 10000
    ) {
      throw Problems.validation('recipe.calories must be between 0 and 10000.', [
        { field: 'recipe.calories', reason: 'out_of_bounds' },
      ]);
    }
  }

  if (input.type === 'workout') {
    if (!input.workout || !input.workout.activity || input.workout.activity.trim().length === 0) {
      throw Problems.validation('Workout posts require workout.activity.', [
        { field: 'workout.activity', reason: 'required' },
      ]);
    }
    if (
      typeof input.workout.duration_minutes !== 'number' ||
      input.workout.duration_minutes < 1 ||
      input.workout.duration_minutes > 720
    ) {
      throw Problems.validation('workout.duration_minutes must be between 1 and 720.', [
        { field: 'workout.duration_minutes', reason: 'out_of_bounds' },
      ]);
    }
  }

  const requestHash = computeRequestHash('POST', '/v1/posts', input);

  return executeIdempotentCommand(client, {
    scope: 'POST:/v1/posts',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      // Validate media attachments ownership and readiness
      if (input.attachment_ids && input.attachment_ids.length > 0) {
        const mediaCheck = await client.query<{ id: string; owner_id: string; status: string }>(
          `SELECT id, owner_id, status::text
           FROM public.media_objects
           WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [input.attachment_ids]
        );
        if (mediaCheck.rowCount !== input.attachment_ids.length) {
          throw Problems.validation('One or more attachment_ids do not exist.', [
            { field: 'attachment_ids', reason: 'not_found' },
          ]);
        }
        for (const m of mediaCheck.rows) {
          if (m.owner_id !== userId) {
            throw Problems.forbidden('Cannot attach media owned by another user.');
          }
          if (m.status !== 'ready') {
            throw Problems.validation('Media object is not ready for publishing.', [
              { field: 'attachment_ids', reason: 'media_not_ready' },
            ]);
          }
        }
      }

      const postRes = await client.query<{ id: string }>(
        `INSERT INTO public.posts (author_id, type, status, body, visibility, published_at)
         VALUES ($1, $2, 'published', $3, $4, now())
         RETURNING id`,
        [userId, input.type, input.body.trim(), input.visibility ?? 'community']
      );

      const postId = postRes.rows[0]!.id;

      if (input.attachment_ids && input.attachment_ids.length > 0) {
        for (let i = 0; i < input.attachment_ids.length; i++) {
          await client.query(
            `INSERT INTO public.post_media (post_id, media_object_id, position)
             VALUES ($1, $2, $3)`,
            [postId, input.attachment_ids[i], i]
          );
        }
      }

      if (input.type === 'recipe' && input.recipe) {
        const r = input.recipe;
        await client.query(
          `INSERT INTO public.recipes (
             post_id, title, subtitle, difficulty, calories, protein_g, carbs_g, fat_g, prep_minutes, servings
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            postId,
            r.title.trim(),
            (r.subtitle ?? '').trim(),
            r.difficulty ?? 'medium',
            r.calories,
            r.protein_g ?? 0,
            r.carbs_g ?? 0,
            r.fat_g ?? 0,
            r.prep_minutes ?? 15,
            r.servings ?? 1,
          ]
        );

        const ingredients = r.ingredients ?? [];
        for (let i = 0; i < ingredients.length; i++) {
          const ing = ingredients[i]!;
          await client.query(
            `INSERT INTO public.recipe_ingredients (recipe_post_id, position, text, quantity, unit)
             VALUES ($1, $2, $3, $4, $5)`,
            [postId, i, ing.text.trim(), ing.quantity ?? null, ing.unit ?? null]
          );
        }

        const steps = r.steps ?? [];
        for (let i = 0; i < steps.length; i++) {
          const st = steps[i]!;
          await client.query(
            `INSERT INTO public.recipe_steps (recipe_post_id, position, instruction)
             VALUES ($1, $2, $3)`,
            [postId, i, st.instruction.trim()]
          );
        }
      }

      if (input.type === 'workout' && input.workout) {
        const w = input.workout;
        await client.query(
          `INSERT INTO public.workout_updates (post_id, activity, duration_minutes, calories_burned, gym_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [postId, w.activity.trim(), w.duration_minutes, w.calories_burned ?? null, w.gym_id ?? null]
        );
      }

      const hydrated = await hydratePostDTO(client, postId, userId);
      return {
        statusCode: 201,
        body: { data: hydrated },
      };
    },
  });
}

export async function updatePostCommand(
  client: pg.PoolClient,
  userId: string,
  postId: string,
  idempotencyKey: string,
  body: { body: string; visibility?: 'community' | 'connections' | 'private'; version: number }
) {
  await assertActiveAccount(client, userId);

  const requestHash = computeRequestHash('PATCH', `/v1/posts/${postId}`, body);
  return executeIdempotentCommand(client, {
    scope: `PATCH:/v1/posts/${postId}`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const checkRes = await client.query<{ author_id: string; version: string }>(
        `SELECT author_id, version::text FROM public.posts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [postId]
      );
      if (checkRes.rowCount === 0) throw Problems.notFound('Post');
      if (checkRes.rows[0]!.author_id !== userId) throw Problems.forbidden();
      if (Number(checkRes.rows[0]!.version) !== body.version) {
        throw Problems.versionConflict();
      }

      await client.query(
        `UPDATE public.posts
         SET body = $2,
             visibility = COALESCE($3::public.post_visibility, visibility),
             version = version + 1
         WHERE id = $1`,
        [postId, body.body.trim(), body.visibility ?? null]
      );

      const updated = await hydratePostDTO(client, postId, userId);
      return { statusCode: 200, body: { data: updated } };
    },
  });
}

export async function deletePostCommand(
  client: pg.PoolClient,
  userId: string,
  postId: string
): Promise<void> {
  await assertActiveAccount(client, userId);
  const res = await client.query<{ author_id: string }>(
    `SELECT author_id FROM public.posts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [postId]
  );
  if (res.rowCount === 0) throw Problems.notFound('Post');
  if (res.rows[0]!.author_id !== userId) throw Problems.forbidden();

  await client.query(
    `UPDATE public.posts SET status = 'deleted', deleted_at = now(), version = version + 1 WHERE id = $1`,
    [postId]
  );
}

/**
 * Implements 05-SOCIAL-FEED.md ranking and diversity constraints:
 * score = 0.55 * recency_decay(36h)
 *       + 0.20 * relationship_weight
 *       + 0.15 * interest_overlap
 *       + 0.05 * nearby_coarse_bonus
 *       + 0.05 * capped_engagement_log
 * Diversity: max 2 consecutive posts from same author.
 */
export async function getFeedQuery(
  client: pg.PoolClient,
  userId: string,
  params: {
    mode?: 'for_you' | 'following';
    type?: 'text' | 'recipe' | 'workout';
    cursor?: string;
    limit?: number;
  }
) {
  await assertActiveAccount(client, userId);
  const mode = params.mode ?? 'for_you';
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  let cursorPublishedAt: string | null = null;
  let cursorId: string | null = null;
  if (params.cursor) {
    const decoded = decodeKeysetCursor(params.cursor);
    cursorPublishedAt = String(decoded.sort_value);
    cursorId = decoded.id;
  }

  const eligibleRes = await client.query<{
    id: string;
    author_id: string;
    published_at: Date;
    likes_count: string;
    comments_count: string;
    saves_count: string;
    is_connected: boolean;
    interest_overlap_ratio: number;
    same_coarse_area: boolean;
  }>(
    `SELECT
       p.id,
       p.author_id,
       p.published_at,
       p.likes_count::text,
       p.comments_count::text,
       p.saves_count::text,
       public.are_connected($1, p.author_id) AS is_connected,
       COALESCE(
         (
           SELECT count(*)::float
           FROM public.user_interests ui1
           JOIN public.user_interests ui2 ON ui2.interest_id = ui1.interest_id AND ui2.user_id = p.author_id
           WHERE ui1.user_id = $1
         ) / GREATEST(1, (SELECT count(*) FROM public.user_interests WHERE user_id = $1)),
         0.0
       ) AS interest_overlap_ratio,
       COALESCE(
         (
           SELECT ul1.coarse_geohash = ul2.coarse_geohash
           FROM public.user_locations ul1
           JOIN public.user_locations ul2 ON ul2.user_id = p.author_id AND ul2.expires_at > now()
           WHERE ul1.user_id = $1 AND ul1.expires_at > now()
         ),
         false
       ) AS same_coarse_area
     FROM public.posts p
     WHERE p.deleted_at IS NULL
       AND p.status = 'published'
       AND public.can_view_post($1, p.id)
       AND ($2::public.post_type IS NULL OR p.type = $2::public.post_type)
       AND ($3::boolean = false OR p.author_id = $1 OR public.are_connected($1, p.author_id))
       AND (
         $4::timestamptz IS NULL
         OR (p.published_at, p.id) < ($4::timestamptz, $5::uuid)
       )
     ORDER BY p.published_at DESC, p.id DESC
     LIMIT $6`,
    [
      userId,
      params.type ?? null,
      mode === 'following',
      cursorPublishedAt,
      cursorId,
      Math.min(200, (limit + 1) * 2),
    ]
  );

  let ranked = eligibleRes.rows.map((r) => {
    const ageHours = Math.max(0, (Date.now() - r.published_at.getTime()) / (1000 * 3600));
    const recencyDecay = Math.exp(-ageHours / 36.0);
    const relationshipWeight = r.author_id === userId || r.is_connected ? 1.0 : 0.25;
    const interestOverlap = Math.min(1.0, r.interest_overlap_ratio);
    const nearbyBonus = r.same_coarse_area ? 1.0 : 0.0;
    const engagementRaw =
      Number(r.likes_count) + Number(r.comments_count) * 2 + Number(r.saves_count) * 2;
    const cappedEngagementLog = Math.min(1.0, Math.log10(1 + engagementRaw) / 3.0);

    const score =
      0.55 * recencyDecay +
      0.20 * relationshipWeight +
      0.15 * interestOverlap +
      0.05 * nearbyBonus +
      0.05 * cappedEngagementLog;

    const feedReason = r.is_connected
      ? 'connection'
      : interestOverlap > 0
      ? 'shared_interests'
      : r.same_coarse_area
      ? 'nearby_community'
      : 'community_highlight';

    return {
      ...r,
      score,
      feedReason,
    };
  });

  if (mode === 'for_you' && !params.cursor) {
    ranked.sort((a, b) => b.score - a.score || b.published_at.getTime() - a.published_at.getTime());

    // Enforce mix constraint: max 2 consecutive posts by the same author
    const diversified: typeof ranked = [];
    const deferred: typeof ranked = [];
    for (const item of ranked) {
      const len = diversified.length;
      if (
        len >= 2 &&
        diversified[len - 1]!.author_id === item.author_id &&
        diversified[len - 2]!.author_id === item.author_id
      ) {
        deferred.push(item);
      } else {
        diversified.push(item);
      }
    }
    ranked = [...diversified, ...deferred];
  }

  const hasMore = ranked.length > limit;
  const pageItems = ranked.slice(0, limit);
  const hydratedItems = [];
  for (const item of pageItems) {
    hydratedItems.push(await hydratePostDTO(client, item.id, userId, item.feedReason));
  }

  const last = pageItems[pageItems.length - 1];
  const nextCursor =
    hasMore && last ? encodeKeysetCursor(last.published_at.toISOString(), last.id) : null;

  return {
    data: hydratedItems,
    page: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function toggleLikePostCommand(
  client: pg.PoolClient,
  userId: string,
  postId: string,
  like: boolean
) {
  await assertActiveAccount(client, userId);

  const canView = await client.query<{ ok: boolean; author_id: string }>(
    `SELECT public.can_view_post($1, p.id) AS ok, p.author_id
     FROM public.posts p WHERE p.id = $2 AND p.deleted_at IS NULL`,
    [userId, postId]
  );

  if (canView.rowCount === 0 || !canView.rows[0]!.ok) {
    throw Problems.notFound('Post');
  }

  const authorId = canView.rows[0]!.author_id;

  if (like) {
    const ins = await client.query(
      `INSERT INTO public.post_likes (post_id, user_id)
       VALUES ($1, $2) ON CONFLICT (post_id, user_id) DO NOTHING RETURNING post_id`,
      [postId, userId]
    );
    if (ins.rowCount && ins.rowCount > 0 && authorId !== userId) {
      await createNotificationAndOutbox(client, {
        recipientId: authorId,
        type: 'post_liked',
        actorId: userId,
        resourceType: 'post',
        resourceId: postId,
        title: 'New like on your post',
        body: 'Someone liked your post.',
        deepLink: `gymbuddy://posts/${postId}`,
        collapseId: `post_like:${postId}`,
        dedupeKey: `like:${postId}:${userId}`,
      });
    }
  } else {
    await client.query(`DELETE FROM public.post_likes WHERE post_id = $1 AND user_id = $2`, [
      postId,
      userId,
    ]);
  }

  const countRes = await client.query<{ likes_count: string }>(
    `SELECT likes_count::text FROM public.posts WHERE id = $1`,
    [postId]
  );

  return {
    data: {
      post_id: postId,
      is_liked: like,
      likes_count: Number(countRes.rows[0]?.likes_count ?? 0),
    },
  };
}

export async function toggleSavePostCommand(
  client: pg.PoolClient,
  userId: string,
  postId: string,
  save: boolean
): Promise<void> {
  await assertActiveAccount(client, userId);
  const canView = await client.query<{ ok: boolean }>(
    `SELECT public.can_view_post($1, $2) AS ok`,
    [userId, postId]
  );
  if (!canView.rows[0]?.ok) {
    throw Problems.notFound('Post');
  }

  if (save) {
    await client.query(
      `INSERT INTO public.saved_posts (user_id, post_id)
       VALUES ($1, $2) ON CONFLICT (user_id, post_id) DO NOTHING`,
      [userId, postId]
    );
  } else {
    await client.query(`DELETE FROM public.saved_posts WHERE user_id = $1 AND post_id = $2`, [
      userId,
      postId,
    ]);
  }
}

export async function createCommentCommand(
  client: pg.PoolClient,
  userId: string,
  postId: string,
  idempotencyKey: string,
  body: { body: string; parent_id?: string | null }
) {
  await assertActiveAccount(client, userId);

  const canView = await client.query<{ ok: boolean; author_id: string }>(
    `SELECT public.can_view_post($1, p.id) AS ok, p.author_id
     FROM public.posts p WHERE p.id = $2 AND p.deleted_at IS NULL`,
    [userId, postId]
  );
  if (canView.rowCount === 0 || !canView.rows[0]!.ok) {
    throw Problems.notFound('Post');
  }

  const text = (body.body ?? '').trim();
  if (text.length < 1 || text.length > 1000) {
    throw Problems.validation('Comment body must be between 1 and 1000 characters.', [
      { field: 'body', reason: 'invalid_length' },
    ]);
  }

  const requestHash = computeRequestHash('POST', `/v1/posts/${postId}/comments`, body);

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/posts/${postId}/comments`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      let depth = 1;
      let parentAuthorId: string | null = null;

      if (body.parent_id) {
        const parentRes = await client.query<{
          post_id: string;
          depth: number;
          author_id: string;
          deleted_at: Date | null;
        }>(
          `SELECT post_id, depth, author_id, deleted_at
           FROM public.comments WHERE id = $1`,
          [body.parent_id]
        );
        if (parentRes.rowCount === 0 || parentRes.rows[0]!.post_id !== postId) {
          throw Problems.validation('Parent comment not found on this post.', [
            { field: 'parent_id', reason: 'not_found' },
          ]);
        }
        if (parentRes.rows[0]!.depth >= 2) {
          throw Problems.validation('Maximum comment nesting depth is 2.', [
            { field: 'parent_id', reason: 'max_depth_exceeded' },
          ]);
        }
        depth = 2;
        parentAuthorId = parentRes.rows[0]!.author_id;
      }

      const insRes = await client.query<{
        id: string;
        post_id: string;
        author_id: string;
        parent_id: string | null;
        depth: number;
        body: string;
        version: string;
        created_at: Date;
      }>(
        `INSERT INTO public.comments (post_id, author_id, parent_id, depth, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, post_id, author_id, parent_id, depth, body, version::text, created_at`,
        [postId, userId, body.parent_id ?? null, depth, text]
      );

      const c = insRes.rows[0]!;
      const postAuthorId = canView.rows[0]!.author_id;

      if (parentAuthorId && parentAuthorId !== userId) {
        await createNotificationAndOutbox(client, {
          recipientId: parentAuthorId,
          type: 'comment_replied',
          actorId: userId,
          resourceType: 'comment',
          resourceId: c.id,
          title: 'New reply to your comment',
          body: 'Someone replied to your comment.',
          deepLink: `gymbuddy://posts/${postId}?comment=${c.id}`,
          collapseId: `comment_reply:${c.id}`,
          dedupeKey: `comment_reply:${c.id}`,
        });
      } else if (postAuthorId !== userId) {
        await createNotificationAndOutbox(client, {
          recipientId: postAuthorId,
          type: 'post_commented',
          actorId: userId,
          resourceType: 'post',
          resourceId: postId,
          title: 'New comment on your post',
          body: 'Someone commented on your post.',
          deepLink: `gymbuddy://posts/${postId}?comment=${c.id}`,
          collapseId: `post_comment:${postId}`,
          dedupeKey: `post_comment:${c.id}`,
        });
      }

      return {
        statusCode: 201,
        body: {
          data: {
            id: c.id,
            post_id: c.post_id,
            author_id: c.author_id,
            parent_id: c.parent_id,
            depth: c.depth,
            body: c.body,
            version: Number(c.version),
            created_at: c.created_at.toISOString(),
          },
        },
      };
    },
  });
}

export async function listCommentsQuery(
  client: pg.PoolClient,
  userId: string,
  postId: string,
  params: { cursor?: string; limit?: number }
) {
  await assertActiveAccount(client, userId);
  const canView = await client.query<{ ok: boolean }>(
    `SELECT public.can_view_post($1, $2) AS ok`,
    [userId, postId]
  );
  if (!canView.rows[0]?.ok) {
    throw Problems.notFound('Post');
  }

  // Return comments including tombstone parents that still have active child replies (05-SOCIAL-FEED.md)
  const res = await client.query<{
    id: string;
    post_id: string;
    author_id: string;
    parent_id: string | null;
    depth: number;
    body: string;
    status: string;
    deleted_at: Date | null;
    has_replies: boolean;
    version: string;
    created_at: Date;
  }>(
    `SELECT
       c.id,
       c.post_id,
       c.author_id,
       c.parent_id,
       c.depth,
       c.body,
       c.status,
       c.deleted_at,
       EXISTS (
         SELECT 1 FROM public.comments child
         WHERE child.parent_id = c.id AND child.deleted_at IS NULL
       ) AS has_replies,
       c.version::text,
       c.created_at
     FROM public.comments c
     WHERE c.post_id = $1
       AND NOT public.is_blocked($2, c.author_id)
       AND (
         c.deleted_at IS NULL
         OR EXISTS (
           SELECT 1 FROM public.comments child
           WHERE child.parent_id = c.id AND child.deleted_at IS NULL
         )
       )
     ORDER BY c.created_at ASC, c.id ASC`,
    [postId, userId]
  );

  return {
    data: res.rows.map((c) => ({
      id: c.id,
      post_id: c.post_id,
      author_id: c.deleted_at ? null : c.author_id,
      parent_id: c.parent_id,
      depth: c.depth,
      body: c.deleted_at ? '[Comment deleted]' : c.body,
      is_tombstone: c.deleted_at !== null,
      version: Number(c.version),
      created_at: c.created_at.toISOString(),
    })),
    page: {
      next_cursor: null,
      has_more: false,
    },
  };
}

export async function deleteCommentCommand(
  client: pg.PoolClient,
  userId: string,
  commentId: string
): Promise<void> {
  await assertActiveAccount(client, userId);
  const res = await client.query<{ author_id: string }>(
    `SELECT author_id FROM public.comments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [commentId]
  );
  if (res.rowCount === 0) throw Problems.notFound('Comment');
  if (res.rows[0]!.author_id !== userId) throw Problems.forbidden();

  await client.query(
    `UPDATE public.comments
     SET status = 'deleted', deleted_at = now(), version = version + 1
     WHERE id = $1`,
    [commentId]
  );
}

export async function searchQuery(
  client: pg.PoolClient,
  userId: string,
  params: {
    q?: string;
    type?: 'people' | 'posts' | 'recipes';
    max_calories?: number;
    limit?: number;
  }
) {
  await assertActiveAccount(client, userId);
  const q = (params.q ?? '').trim();
  const searchType = params.type ?? 'posts';
  const limit = Math.min(50, Math.max(1, params.limit ?? 20));

  if (q.length > 100) {
    throw Problems.validation('Search query cannot exceed 100 characters.');
  }
  if (searchType !== 'recipes' && q.length < 2) {
    throw Problems.validation('Search query must be at least 2 characters long.', [
      { field: 'q', reason: 'too_short' },
    ]);
  }

  if (searchType === 'people') {
    const res = await client.query<{ user_id: string }>(
      `SELECT up.user_id
       FROM public.user_profiles up
       WHERE up.deleted_at IS NULL
         AND up.account_status = 'active'
         AND public.can_view_profile($1, up.user_id)
         AND (up.display_name ILIKE ('%' || $2 || '%') OR similarity(up.display_name, $2) > 0.2)
       ORDER BY similarity(up.display_name, $2) DESC, up.user_id ASC
       LIMIT $3`,
      [userId, q, limit]
    );
    const profiles = [];
    for (const r of res.rows) {
      profiles.push(await hydrateProfileDTO(client, r.user_id, userId));
    }
    return { data: profiles, page: { next_cursor: null, has_more: false } };
  }

  if (searchType === 'recipes') {
    const res = await client.query<{ post_id: string }>(
      `SELECT r.post_id
       FROM public.recipes r
       JOIN public.posts p ON p.id = r.post_id
       WHERE p.deleted_at IS NULL
         AND p.status = 'published'
         AND public.can_view_post($1, p.id)
         AND ($2::text = '' OR r.search_tsv @@ plainto_tsquery('english', $2) OR r.title ILIKE ('%' || $2 || '%'))
         AND ($3::int IS NULL OR r.calories <= $3::int)
       ORDER BY p.published_at DESC, p.id DESC
       LIMIT $4`,
      [userId, q, params.max_calories ?? null, limit]
    );
    const posts = [];
    for (const row of res.rows) {
      posts.push(await hydratePostDTO(client, row.post_id, userId));
    }
    return { data: posts, page: { next_cursor: null, has_more: false } };
  }

  // Default: posts search via tsvector + ILIKE fallback
  const res = await client.query<{ id: string }>(
    `SELECT p.id
     FROM public.posts p
     WHERE p.deleted_at IS NULL
       AND p.status = 'published'
       AND public.can_view_post($1, p.id)
       AND (p.search_tsv @@ plainto_tsquery('english', $2) OR p.body ILIKE ('%' || $2 || '%'))
     ORDER BY p.published_at DESC, p.id DESC
     LIMIT $3`,
    [userId, q, limit]
  );

  const posts = [];
  for (const row of res.rows) {
    posts.push(await hydratePostDTO(client, row.id, userId));
  }
  return { data: posts, page: { next_cursor: null, has_more: false } };
}
