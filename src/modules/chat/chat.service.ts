import type pg from 'pg';
import { env } from '../../config/env.js';
import { Problems } from '../../core/problem.js';
import { executeIdempotentCommand, computeRequestHash } from '../../core/idempotency.js';
import { assertActiveAccount, hydrateProfileDTO } from '../identity/identity.service.js';
import { createNotificationAndOutbox } from '../notifications/notifications.service.js';
import { realtimeHub } from '../realtime/realtime-hub.js';

export async function assertConversationMemberAndUnblocked(
  client: pg.PoolClient,
  userId: string,
  conversationId: string
): Promise<{ peerUserId: string; lastSeq: number; hiddenBeforeSeq: number }> {
  await assertActiveAccount(client, userId);

  const memRes = await client.query<{
    user_id: string;
    hidden_before_seq: string;
  }>(
    `SELECT user_id, hidden_before_seq::text
     FROM public.conversation_members
     WHERE conversation_id = $1`,
    [conversationId]
  );

  if (memRes.rowCount === 0) {
    throw Problems.notFound('Conversation');
  }

  const myRow = memRes.rows.find((r) => r.user_id === userId);
  if (!myRow) {
    throw Problems.forbidden('You are not a member of this conversation.');
  }

  const peerRow = memRes.rows.find((r) => r.user_id !== userId);
  const peerUserId = peerRow?.user_id ?? userId;

  const blkRes = await client.query<{ blocked: boolean }>(
    `SELECT public.is_blocked($1, $2) AS blocked`,
    [userId, peerUserId]
  );

  if (blkRes.rows[0]?.blocked) {
    throw Problems.relationshipBlocked('Conversation is unavailable due to block restrictions.');
  }

  const convRes = await client.query<{ last_seq: string; status: string }>(
    `SELECT last_seq::text, status::text FROM public.conversations WHERE id = $1`,
    [conversationId]
  );
  if (convRes.rowCount === 0 || convRes.rows[0]!.status === 'blocked') {
    throw Problems.relationshipBlocked('Conversation is blocked.');
  }

  return {
    peerUserId,
    lastSeq: Number(convRes.rows[0]!.last_seq),
    hiddenBeforeSeq: Number(myRow.hidden_before_seq),
  };
}

export async function getOrCreateDirectConversationCommand(
  client: pg.PoolClient,
  userId: string,
  idempotencyKey: string,
  participantId: string
) {
  await assertActiveAccount(client, userId);
  if (userId === participantId) {
    throw Problems.validation('Cannot create a direct conversation with yourself.', [
      { field: 'participant_id', reason: 'self_conversation' },
    ]);
  }

  await assertActiveAccount(client, participantId);

  const blkRes = await client.query<{ blocked: boolean }>(
    `SELECT public.is_blocked($1, $2) AS blocked`,
    [userId, participantId]
  );
  if (blkRes.rows[0]?.blocked) {
    throw Problems.relationshipBlocked();
  }

  const requestHash = computeRequestHash('POST', '/v1/conversations', {
    participant_id: participantId,
  });

  return executeIdempotentCommand(client, {
    scope: 'POST:/v1/conversations',
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const keyRes = await client.query<{ key: string }>(
        `SELECT public.compute_direct_key($1, $2) AS key`,
        [userId, participantId]
      );
      const directKey = keyRes.rows[0]!.key;

      const existing = await client.query<{ id: string; status: string; last_seq: string }>(
        `SELECT id, status::text, last_seq::text
         FROM public.conversations
         WHERE direct_key = $1
         FOR UPDATE`,
        [directKey]
      );

      let conversationId: string;
      let created = false;

      if (existing.rowCount && existing.rowCount > 0) {
        if (existing.rows[0]!.status === 'blocked') {
          throw Problems.relationshipBlocked();
        }
        conversationId = existing.rows[0]!.id;
      } else {
        created = true;
        const ins = await client.query<{ id: string }>(
          `INSERT INTO public.conversations (type, direct_key, initiator_id, status)
           VALUES ('direct', $1, $2, 'active')
           RETURNING id`,
          [directKey, userId]
        );
        conversationId = ins.rows[0]!.id;

        for (const memberId of [userId, participantId]) {
          await client.query(
            `INSERT INTO public.conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT DO NOTHING`,
            [conversationId, memberId]
          );
          await client.query(
            `INSERT INTO public.message_read_states (conversation_id, user_id, last_read_seq)
             VALUES ($1, $2, 0)
             ON CONFLICT DO NOTHING`,
            [conversationId, memberId]
          );
        }
      }

      const peerProfile = await hydrateProfileDTO(client, participantId, userId);

      return {
        statusCode: created ? 201 : 200,
        body: {
          data: {
            id: conversationId,
            type: 'direct',
            participant: peerProfile,
            last_seq: existing.rows[0] ? Number(existing.rows[0].last_seq) : 0,
            unread_count: 0,
          },
        },
      };
    },
  });
}

export async function listConversationsQuery(
  client: pg.PoolClient,
  userId: string,
  params: { archived?: boolean }
) {
  await assertActiveAccount(client, userId);

  const res = await client.query<{
    id: string;
    last_seq: string;
    last_message_at: Date | null;
    created_at: Date;
    archived_at: Date | null;
    pinned_at: Date | null;
    hidden_before_seq: string;
    member_version: string;
    peer_user_id: string;
    last_read_seq: string;
  }>(
    `SELECT
       c.id,
       c.last_seq::text,
       c.last_message_at,
       c.created_at,
       cm.archived_at,
       cm.pinned_at,
       cm.hidden_before_seq::text,
       cm.version::text AS member_version,
       peer.user_id AS peer_user_id,
       COALESCE(mrs.last_read_seq, 0)::text AS last_read_seq
     FROM public.conversations c
     JOIN public.conversation_members cm
       ON cm.conversation_id = c.id AND cm.user_id = $1
     JOIN public.conversation_members peer
       ON peer.conversation_id = c.id AND peer.user_id <> $1
     LEFT JOIN public.message_read_states mrs
       ON mrs.conversation_id = c.id AND mrs.user_id = $1
     WHERE c.status <> 'blocked'
       AND NOT public.is_blocked($1, peer.user_id)
       AND (
         ($2::boolean = true AND cm.archived_at IS NOT NULL)
         OR ($2::boolean = false AND cm.archived_at IS NULL)
       )
     ORDER BY cm.pinned_at DESC NULLS LAST, c.last_message_at DESC NULLS LAST, c.created_at DESC`,
    [userId, Boolean(params.archived)]
  );

  const items = [];
  for (const row of res.rows) {
    const peerProfile = await hydrateProfileDTO(client, row.peer_user_id, userId);
    const effectiveFloor = Math.max(Number(row.last_read_seq), Number(row.hidden_before_seq));
    const unreadCount = Math.max(0, Number(row.last_seq) - effectiveFloor);

    items.push({
      id: row.id,
      type: 'direct',
      participant: {
        ...peerProfile,
        presence: realtimeHub.getCoarsePresence(row.peer_user_id),
      },
      last_seq: Number(row.last_seq),
      last_read_seq: Number(row.last_read_seq),
      unread_count: unreadCount,
      is_pinned: row.pinned_at !== null,
      is_archived: row.archived_at !== null,
      membership_version: Number(row.member_version),
      last_message_at: row.last_message_at ? row.last_message_at.toISOString() : null,
    });
  }

  return {
    data: items,
    page: { next_cursor: null, has_more: false },
  };
}

export async function updateConversationMembershipCommand(
  client: pg.PoolClient,
  userId: string,
  conversationId: string,
  idempotencyKey: string,
  body: {
    pinned?: boolean;
    archived?: boolean;
    clear_history?: boolean;
    version: number;
  }
) {
  const { lastSeq } = await assertConversationMemberAndUnblocked(client, userId, conversationId);

  const requestHash = computeRequestHash(
    'PATCH',
    `/v1/conversations/${conversationId}/membership`,
    body
  );

  return executeIdempotentCommand(client, {
    scope: `PATCH:/v1/conversations/${conversationId}/membership`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const updRes = await client.query<{
        pinned_at: Date | null;
        archived_at: Date | null;
        hidden_before_seq: string;
        version: string;
      }>(
        `UPDATE public.conversation_members
         SET
           pinned_at = CASE
             WHEN $4::boolean IS NULL THEN pinned_at
             WHEN $4::boolean = true THEN COALESCE(pinned_at, now())
             ELSE NULL
           END,
           archived_at = CASE
             WHEN $5::boolean IS NULL THEN archived_at
             WHEN $5::boolean = true THEN COALESCE(archived_at, now())
             ELSE NULL
           END,
           hidden_before_seq = CASE
             WHEN $6::boolean = true THEN GREATEST(hidden_before_seq, $7::bigint)
             ELSE hidden_before_seq
           END,
           version = version + 1
         WHERE conversation_id = $1 AND user_id = $2 AND version = $3
         RETURNING pinned_at, archived_at, hidden_before_seq::text, version::text`,
        [
          conversationId,
          userId,
          body.version,
          body.pinned ?? null,
          body.archived ?? null,
          Boolean(body.clear_history),
          lastSeq,
        ]
      );

      if (updRes.rowCount === 0) {
        throw Problems.versionConflict();
      }

      const m = updRes.rows[0]!;
      return {
        statusCode: 200,
        body: {
          data: {
            conversation_id: conversationId,
            is_pinned: m.pinned_at !== null,
            is_archived: m.archived_at !== null,
            hidden_before_seq: Number(m.hidden_before_seq),
            version: Number(m.version),
          },
        },
      };
    },
  });
}

export async function sendMessageCommand(
  client: pg.PoolClient,
  userId: string,
  conversationId: string,
  idempotencyKey: string,
  body: {
    client_message_id: string;
    kind: 'text' | 'image' | 'workout_invitation';
    body?: string;
    attachment_ids?: string[];
    workout_invitation_id?: string;
  }
) {
  await assertActiveAccount(client, userId);

  if (!body.client_message_id || !/^[0-9a-f-]{36}$/i.test(body.client_message_id)) {
    throw Problems.validation('Valid UUID client_message_id is required.', [
      { field: 'client_message_id', reason: 'required_uuid' },
    ]);
  }

  const text = (body.body ?? '').trim();
  const attachments = body.attachment_ids ?? [];

  if (text.length > 4000) {
    throw Problems.validation('Message body cannot exceed 4000 characters.', [
      { field: 'body', reason: 'max_4000' },
    ]);
  }
  if (body.kind === 'text' && text.length === 0 && attachments.length === 0) {
    throw Problems.validation('Text message requires non-empty body or attachment.', [
      { field: 'body', reason: 'empty_message' },
    ]);
  }
  if (body.kind === 'image' && attachments.length === 0) {
    throw Problems.validation('Image message requires at least one ready attachment_id.', [
      { field: 'attachment_ids', reason: 'required' },
    ]);
  }
  if (attachments.length > 4) {
    throw Problems.validation('Maximum 4 attachments per message.', [
      { field: 'attachment_ids', reason: 'max_4' },
    ]);
  }

  // Lock conversation row FIRST to serialize sequence assignment & block checks
  const convLockRes = await client.query<{
    id: string;
    last_seq: string;
    status: string;
  }>(
    `SELECT id, last_seq::text, status::text
     FROM public.conversations
     WHERE id = $1
     FOR UPDATE`,
    [conversationId]
  );

  if (convLockRes.rowCount === 0) {
    throw Problems.notFound('Conversation');
  }

  const { peerUserId } = await assertConversationMemberAndUnblocked(
    client,
    userId,
    conversationId
  );

  // Check if client_message_id was already recorded in this conversation by this sender
  const existingMsgRes = await client.query<{
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    server_seq: string;
    kind: string;
    body: string;
    created_at: Date;
  }>(
    `SELECT id, conversation_id, sender_id, client_message_id, server_seq::text, kind::text, body, created_at
     FROM public.messages
     WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
    [conversationId, userId, body.client_message_id]
  );

  if (existingMsgRes.rowCount && existingMsgRes.rowCount > 0) {
    const existingMsg = existingMsgRes.rows[0]!;
    if (existingMsg.kind !== body.kind || existingMsg.body !== text) {
      throw Problems.idempotencyConflict(
        'client_message_id was already sent with a different message payload.'
      );
    }
    return {
      statusCode: 201,
      replayed: true,
      body: {
        data: {
          id: existingMsg.id,
          conversation_id: existingMsg.conversation_id,
          sender_id: existingMsg.sender_id,
          client_message_id: existingMsg.client_message_id,
          server_seq: Number(existingMsg.server_seq),
          kind: existingMsg.kind,
          body: existingMsg.body,
          attachment_ids: attachments,
          created_at: existingMsg.created_at.toISOString(),
        },
      },
    };
  }

  // Enforce non-connection message-request policy (06-CHAT-REALTIME.md & ADR-002):
  // If peer has not connected back and has not sent any messages in this conversation yet,
  // initiator may send at most 1 message until accepted/replied.
  const mutualCheck = await client.query<{ peer_connected: boolean; peer_replied: boolean; my_sent_count: string }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM public.user_relationships r
         WHERE r.actor_id = $2 AND r.target_id = $1 AND r.type IN ('connect', 'follow')
       ) AS peer_connected,
       EXISTS (
         SELECT 1 FROM public.messages m
         WHERE m.conversation_id = $3 AND m.sender_id = $2
       ) AS peer_replied,
       (
         SELECT count(*)::text FROM public.messages m
         WHERE m.conversation_id = $3 AND m.sender_id = $1
       ) AS my_sent_count`,
    [userId, peerUserId, conversationId]
  );

  const mc = mutualCheck.rows[0]!;
  if (!mc.peer_connected && !mc.peer_replied && Number(mc.my_sent_count) >= 1) {
    throw Problems.forbidden(
      'You can send at most one message request until the recipient replies or connects.',
      'MESSAGE_REQUEST_LIMIT_REACHED'
    );
  }

  // Validate attachments ownership and status = 'ready'
  if (attachments.length > 0) {
    const mediaRes = await client.query<{ id: string; owner_id: string; status: string }>(
      `SELECT id, owner_id, status::text
       FROM public.media_objects
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [attachments]
    );
    if (mediaRes.rowCount !== attachments.length) {
      throw Problems.validation('One or more message attachments do not exist.', [
        { field: 'attachment_ids', reason: 'not_found' },
      ]);
    }
    for (const m of mediaRes.rows) {
      if (m.owner_id !== userId) {
        throw Problems.forbidden('Cannot attach media owned by another user.');
      }
      if (m.status !== 'ready') {
        throw Problems.validation('Attachment media is not in ready state.', [
          { field: 'attachment_ids', reason: 'media_not_ready' },
        ]);
      }
    }
  }

  const requestHash = computeRequestHash(
    'POST',
    `/v1/conversations/${conversationId}/messages`,
    body
  );

  return executeIdempotentCommand(client, {
    scope: `POST:/v1/conversations/${conversationId}/messages`,
    userId,
    idempotencyKey,
    requestHash,
    execute: async () => {
      const nextSeq = Number(convLockRes.rows[0]!.last_seq) + 1;

      const insRes = await client.query<{
        id: string;
        created_at: Date;
      }>(
        `INSERT INTO public.messages (
           conversation_id, sender_id, client_message_id, kind, body, workout_invitation_id, server_seq, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent')
         RETURNING id, created_at`,
        [
          conversationId,
          userId,
          body.client_message_id,
          body.kind,
          text,
          body.workout_invitation_id ?? null,
          nextSeq,
        ]
      );

      const msgId = insRes.rows[0]!.id;
      const createdAt = insRes.rows[0]!.created_at;

      for (let i = 0; i < attachments.length; i++) {
        await client.query(
          `INSERT INTO public.message_attachments (message_id, media_object_id, position)
           VALUES ($1, $2, $3)`,
          [msgId, attachments[i], i]
        );
      }

      await client.query(
        `UPDATE public.conversations
         SET last_seq = $2, last_message_at = $3
         WHERE id = $1`,
        [conversationId, nextSeq, createdAt]
      );

      // Sender has implicitly read up to nextSeq
      await client.query(
        `INSERT INTO public.message_read_states (conversation_id, user_id, last_read_seq, last_delivered_seq)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET
           last_read_seq = GREATEST(public.message_read_states.last_read_seq, EXCLUDED.last_read_seq),
           last_delivered_seq = GREATEST(public.message_read_states.last_delivered_seq, EXCLUDED.last_delivered_seq)`,
        [conversationId, userId, nextSeq]
      );

      // Create notification + APNs outbox event for recipient
      await createNotificationAndOutbox(client, {
        recipientId: peerUserId,
        type: 'message_received',
        actorId: userId,
        resourceType: 'conversation',
        resourceId: conversationId,
        title: 'New message',
        body: 'New message',
        previewBody: text.length > 0 ? text.slice(0, 120) : 'Sent an attachment',
        deepLink: `gymbuddy://conversations/${conversationId}`,
        collapseId: `conv:${conversationId}`,
        dedupeKey: `msg:${msgId}`,
      });

      // Emit realtime signals on authorized channels
      realtimeHub.publishToTopic(`conversation:${conversationId}`, {
        type: 'message.created',
        aggregate_id: conversationId,
        sequence: nextSeq,
        data: {
          message_id: msgId,
          conversation_id: conversationId,
          sender_id: userId,
          client_message_id: body.client_message_id,
          server_seq: nextSeq,
          kind: body.kind,
        },
      });

      realtimeHub.publishToTopic(`user:${peerUserId}`, {
        type: 'conversation.updated',
        aggregate_id: conversationId,
        sequence: nextSeq,
        data: {
          conversation_id: conversationId,
          last_seq: nextSeq,
          message_id: msgId,
        },
      });

      return {
        statusCode: 201,
        body: {
          data: {
            id: msgId,
            conversation_id: conversationId,
            sender_id: userId,
            client_message_id: body.client_message_id,
            server_seq: nextSeq,
            kind: body.kind,
            body: text,
            attachment_ids: attachments,
            created_at: createdAt.toISOString(),
          },
        },
      };
    },
  });
}

export async function getMessagesQuery(
  client: pg.PoolClient,
  userId: string,
  conversationId: string,
  params: { before_seq?: number; after_seq?: number; limit?: number }
) {
  const { hiddenBeforeSeq } = await assertConversationMemberAndUnblocked(
    client,
    userId,
    conversationId
  );

  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const floorSeq = Math.max(hiddenBeforeSeq, params.after_seq ?? 0);

  let rows;
  if (params.after_seq !== undefined) {
    // Reconnect catch-up: ascending from after_seq
    const res = await client.query<{
      id: string;
      conversation_id: string;
      sender_id: string;
      client_message_id: string;
      server_seq: string;
      kind: string;
      body: string;
      status: string;
      workout_invitation_id: string | null;
      created_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT
         id, conversation_id, sender_id, client_message_id, server_seq::text,
         kind::text, body, status::text, workout_invitation_id, created_at, edited_at, deleted_at
       FROM public.messages
       WHERE conversation_id = $1 AND server_seq > $2
       ORDER BY server_seq ASC
       LIMIT $3`,
      [conversationId, floorSeq, limit + 1]
    );
    rows = res.rows;
  } else {
    // History pagination backwards from before_seq
    const res = await client.query<{
      id: string;
      conversation_id: string;
      sender_id: string;
      client_message_id: string;
      server_seq: string;
      kind: string;
      body: string;
      status: string;
      workout_invitation_id: string | null;
      created_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT
         id, conversation_id, sender_id, client_message_id, server_seq::text,
         kind::text, body, status::text, workout_invitation_id, created_at, edited_at, deleted_at
       FROM public.messages
       WHERE conversation_id = $1
         AND server_seq > $2
         AND ($3::bigint IS NULL OR server_seq < $3::bigint)
       ORDER BY server_seq DESC
       LIMIT $4`,
      [conversationId, hiddenBeforeSeq, params.before_seq ?? null, limit + 1]
    );
    rows = res.rows;
  }

  const hasMore = rows.length > limit;
  const pageItems = rows.slice(0, limit);

  const hydrated = [];
  for (const m of pageItems) {
    const attRes = await client.query<{ media_object_id: string; position: number }>(
      `SELECT media_object_id, position FROM public.message_attachments
       WHERE message_id = $1 ORDER BY position ASC`,
      [m.id]
    );
    hydrated.push({
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      client_message_id: m.client_message_id,
      server_seq: Number(m.server_seq),
      kind: m.kind,
      body: m.deleted_at ? '' : m.body,
      status: m.deleted_at ? 'deleted' : m.status,
      workout_invitation_id: m.workout_invitation_id,
      attachments: attRes.rows.map((a) => ({
        media_object_id: a.media_object_id,
        position: a.position,
        url: `${env.GYMBUDDY_API_BASE_URL}/media/${a.media_object_id}/url`,
      })),
      created_at: m.created_at.toISOString(),
      edited_at: m.edited_at ? m.edited_at.toISOString() : null,
      deleted_at: m.deleted_at ? m.deleted_at.toISOString() : null,
    });
  }

  const last = hydrated[hydrated.length - 1];
  return {
    data: hydrated,
    page: {
      next_cursor: hasMore && last ? String(last.server_seq) : null,
      has_more: hasMore,
    },
  };
}

export async function updateReadStateCommand(
  client: pg.PoolClient,
  userId: string,
  conversationId: string,
  lastReadSeq: number
) {
  const { lastSeq } = await assertConversationMemberAndUnblocked(client, userId, conversationId);

  if (typeof lastReadSeq !== 'number' || lastReadSeq < 0) {
    throw Problems.validation('last_read_seq must be a non-negative integer.', [
      { field: 'last_read_seq', reason: 'invalid' },
    ]);
  }

  const boundedSeq = Math.min(lastReadSeq, lastSeq);

  const res = await client.query<{ last_read_seq: string; read_at: Date }>(
    `INSERT INTO public.message_read_states (conversation_id, user_id, last_read_seq, last_delivered_seq, read_at)
     VALUES ($1, $2, $3, $3, now())
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET
       last_read_seq = GREATEST(public.message_read_states.last_read_seq, EXCLUDED.last_read_seq),
       last_delivered_seq = GREATEST(public.message_read_states.last_delivered_seq, EXCLUDED.last_delivered_seq),
       read_at = CASE
         WHEN EXCLUDED.last_read_seq > public.message_read_states.last_read_seq THEN now()
         ELSE public.message_read_states.read_at
       END
     RETURNING last_read_seq::text, read_at`,
    [conversationId, userId, boundedSeq]
  );

  const canonicalSeq = Number(res.rows[0]!.last_read_seq);

  realtimeHub.publishToTopic(`conversation:${conversationId}`, {
    type: 'message.read',
    aggregate_id: conversationId,
    sequence: canonicalSeq,
    data: {
      conversation_id: conversationId,
      user_id: userId,
      last_read_seq: canonicalSeq,
      read_at: res.rows[0]!.read_at.toISOString(),
    },
  });

  return {
    data: {
      conversation_id: conversationId,
      user_id: userId,
      last_read_seq: canonicalSeq,
      read_at: res.rows[0]!.read_at.toISOString(),
    },
  };
}
