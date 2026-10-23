import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { withServiceTransaction } from '../../db/pool.js';
import { verifySupabaseAccessToken } from '../../core/supabase-jwt.js';
import { observability } from '../../observability/logger.js';

export type DurableRealtimeEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'message.read'
  | 'conversation.updated'
  | 'notification.created'
  | 'invitation.updated'
  | 'session.updated'
  | 'media.ready';

export type EphemeralRealtimeEventType = 'typing.changed' | 'presence.changed';

export type RealtimeEventType = DurableRealtimeEventType | EphemeralRealtimeEventType;

export interface RealtimeEnvelope<T = Record<string, unknown>> {
  event_id: string;
  type: RealtimeEventType;
  occurred_at: string;
  aggregate_id: string;
  sequence?: number;
  data: T;
}

interface ConnectedSubscriber {
  id: string;
  userId: string;
  ws?: WebSocket;
  callback?: (envelope: RealtimeEnvelope) => void;
  topics: Set<string>;
}

class RealtimeHub {
  private subscribers = new Map<string, ConnectedSubscriber>();
  private typingLastSent = new Map<string, number>(); // key: `${convId}:${userId}`
  private presenceState = new Map<string, { lastSeenMs: number; optOut: boolean }>();

  public registerCallbackSubscriber(
    userId: string,
    callback: (envelope: RealtimeEnvelope) => void
  ): string {
    const subId = `sub_${crypto.randomUUID()}`;
    this.subscribers.set(subId, {
      id: subId,
      userId,
      callback,
      topics: new Set([`user:${userId}`]),
    });
    return subId;
  }

  public async registerWebSocketSubscriber(ws: WebSocket, token: string): Promise<string> {
    const claims = await verifySupabaseAccessToken(token);
    const subId = `ws_${crypto.randomUUID()}`;
    this.subscribers.set(subId, {
      id: subId,
      userId: claims.sub,
      ws,
      topics: new Set([`user:${claims.sub}`]),
    });
    this.touchPresence(claims.sub);
    return subId;
  }

  public removeSubscriber(subId: string): void {
    this.subscribers.delete(subId);
  }

  /**
   * Authorizes and subscribes a connected user to a private topic:
   * - `user:{user_id}` -> must match own `userId` and active account
   * - `conversation:{conversation_id}` -> must pass `is_conversation_member(userId, convId)`
   */
  public async subscribeTopic(subId: string, topic: string): Promise<boolean> {
    const sub = this.subscribers.get(subId);
    if (!sub) return false;

    if (topic.startsWith('user:')) {
      const targetUserId = topic.slice('user:'.length);
      if (targetUserId !== sub.userId) {
        return false;
      }
      const active = await withServiceTransaction(async (client) => {
        const res = await client.query<{ ok: boolean }>(
          'SELECT public.is_active_account($1) AS ok',
          [sub.userId]
        );
        return res.rows[0]?.ok === true;
      });
      if (!active) return false;
      sub.topics.add(topic);
      return true;
    }

    if (topic.startsWith('conversation:')) {
      const convId = topic.slice('conversation:'.length);
      const allowed = await withServiceTransaction(async (client) => {
        const res = await client.query<{ ok: boolean }>(
          'SELECT public.is_conversation_member($1, $2) AS ok',
          [sub.userId, convId]
        );
        return res.rows[0]?.ok === true;
      });
      if (!allowed) return false;
      sub.topics.add(topic);
      return true;
    }

    return false;
  }

  public revokeConversationSubscriptionsForPair(userA: string, userB: string, convId?: string): void {
    for (const sub of this.subscribers.values()) {
      if (sub.userId === userA || sub.userId === userB) {
        if (convId) {
          sub.topics.delete(`conversation:${convId}`);
        } else {
          for (const t of [...sub.topics]) {
            if (t.startsWith('conversation:')) {
              sub.topics.delete(t);
            }
          }
        }
      }
    }
  }

  public publishToTopic<T = Record<string, unknown>>(
    topic: string,
    params: {
      type: RealtimeEventType;
      aggregate_id: string;
      sequence?: number;
      data: T;
      event_id?: string;
    }
  ): RealtimeEnvelope<T> {
    const envelope: RealtimeEnvelope<T> = {
      event_id: params.event_id ?? `evt_${crypto.randomUUID().replace(/-/g, '')}`,
      type: params.type,
      occurred_at: new Date().toISOString(),
      aggregate_id: params.aggregate_id,
      ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
      data: params.data,
    };

    observability.increment('realtime_events_emitted_total');

    const serialized = JSON.stringify(envelope);
    for (const sub of this.subscribers.values()) {
      if (sub.topics.has(topic)) {
        if (sub.callback) {
          sub.callback(envelope as RealtimeEnvelope);
        }
        if (sub.ws && sub.ws.readyState === sub.ws.OPEN) {
          sub.ws.send(serialized);
        }
      }
    }

    return envelope;
  }

  /**
   * Ephemeral typing signal: throttled <= 1 per 2 seconds, expires after 5s on client.
   */
  public emitTyping(conversationId: string, userId: string, isTyping: boolean): boolean {
    const key = `${conversationId}:${userId}`;
    const now = Date.now();
    const last = this.typingLastSent.get(key) ?? 0;
    if (isTyping && now - last < 2000) {
      return false; // throttled
    }
    this.typingLastSent.set(key, now);
    this.publishToTopic(`conversation:${conversationId}`, {
      type: 'typing.changed',
      aggregate_id: conversationId,
      data: {
        conversation_id: conversationId,
        user_id: userId,
        is_typing: isTyping,
        expires_in_ms: 5000,
      },
    });
    return true;
  }

  public touchPresence(userId: string, optOut = false): void {
    this.presenceState.set(userId, { lastSeenMs: Date.now(), optOut });
  }

  public getCoarsePresence(userId: string): 'online' | 'recently_active' | 'offline' {
    for (const sub of this.subscribers.values()) {
      if (sub.userId === userId) {
        const p = this.presenceState.get(userId);
        if (p?.optOut) return 'offline';
        return 'online';
      }
    }
    const state = this.presenceState.get(userId);
    if (!state || state.optOut) return 'offline';
    const ageMs = Date.now() - state.lastSeenMs;
    if (ageMs <= 60_000) return 'online';
    if (ageMs <= 15 * 60_000) return 'recently_active';
    return 'offline';
  }

  public isUserConnectedInForeground(userId: string): boolean {
    for (const sub of this.subscribers.values()) {
      if (sub.userId === userId) return true;
    }
    return false;
  }
}

export const realtimeHub = new RealtimeHub();
