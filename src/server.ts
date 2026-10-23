import http from 'node:http';
import { WebSocketServer } from 'ws';
import { env } from './config/env.js';
import { handleApiRequest } from './app.js';
import { realtimeHub } from './modules/realtime/realtime-hub.js';
import { observability } from './observability/logger.js';

export function createHttpServer() {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBuffer = Buffer.concat(chunks);
    const reqUrl = req.url ?? '/';
    const isBinaryUpload = reqUrl.startsWith('/v1/storage/object/upload/sign/');

    let parsedBody: unknown = undefined;
    if (!isBinaryUpload && rawBuffer.byteLength > 0) {
      const rawText = rawBuffer.toString('utf8');
      if (rawText.trim().length > 0) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/problem+json' });
          res.end(
            JSON.stringify({
              type: 'https://api.gymbuddy.app/problems/invalid-json',
              title: 'Invalid JSON payload',
              status: 400,
              code: 'INVALID_JSON',
              request_id: (req.headers['x-request-id'] as string) ?? 'req_invalid_json',
            })
          );
          return;
        }
      }
    }

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : v;
    }

    const response = await handleApiRequest({
      method: req.method ?? 'GET',
      url: reqUrl,
      headers,
      body: parsedBody,
      rawBody: isBinaryUpload ? rawBuffer : undefined,
      ip: req.socket.remoteAddress,
    });

    res.writeHead(response.status, response.headers);
    if (response.body === null || response.status === 204) {
      res.end();
    } else if (Buffer.isBuffer(response.body)) {
      res.end(response.body);
    } else {
      res.end(JSON.stringify(response.body));
    }
  });

  // Attach Realtime WebSocket Gateway on /v1/realtime
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/v1/realtime', 'http://localhost');
    const token =
      url.searchParams.get('token') ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '');

    let subId: string;
    try {
      subId = await realtimeHub.registerWebSocketSubscriber(ws, token);
    } catch {
      ws.close(4401, 'Unauthorized');
      return;
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8')) as {
          action: 'subscribe' | 'ping';
          topic?: string;
        };
        if (msg.action === 'subscribe' && msg.topic) {
          const ok = await realtimeHub.subscribeTopic(subId, msg.topic);
          ws.send(
            JSON.stringify({
              type: ok ? 'subscription.ack' : 'subscription.denied',
              topic: msg.topic,
            })
          );
        } else if (msg.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch {
        // Ignore malformed frame
      }
    });

    ws.on('close', () => {
      realtimeHub.removeSubscriber(subId);
    });
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createHttpServer();
  server.listen(env.PORT, () => {
    observability.log('info', `GymBuddy Backend listening on port ${env.PORT}`, {
      context: { environment: env.GYMBUDDY_ENVIRONMENT },
    });
  });
}
