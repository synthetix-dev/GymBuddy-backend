import { authenticateEdgeRequest, jsonResponse, problemResponse } from '../_shared/edge-adapter.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return problemResponse({
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      title: 'Method not allowed',
      detail: 'Only POST is supported.',
      requestId: req.headers.get('x-request-id') ?? 'req_edge',
    });
  }

  const ctx = await authenticateEdgeRequest(req);
  if (ctx instanceof Response) return ctx;

  const body = (await req.json().catch(() => ({}))) as {
    conversation_id?: string;
    client_message_id?: string;
    body?: string;
    kind?: 'text' | 'image' | 'workout_invitation' | 'system';
    workout_invitation_id?: string | null;
  };

  if (!body.conversation_id || !body.client_message_id || !body.body) {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'conversation_id, client_message_id, and body are required.',
      requestId: ctx.requestId,
    });
  }

  const { data, error } = await ctx.adminClient.rpc('send_message_rpc', {
    p_sender_id: ctx.userId,
    p_conversation_id: body.conversation_id,
    p_client_message_id: body.client_message_id,
    p_body: body.body,
    p_kind: body.kind ?? 'text',
    p_workout_invitation_id: body.workout_invitation_id ?? null,
  });

  if (error) {
    const status = error.code === '42501' ? 403 : 422;
    return problemResponse({
      status,
      code: status === 403 ? 'FORBIDDEN' : 'MESSAGE_REJECTED',
      title: 'Unable to send message',
      detail: error.message,
      requestId: ctx.requestId,
    });
  }

  const deduplicated = Boolean((data as { deduplicated?: boolean })?.deduplicated);
  return jsonResponse(deduplicated ? 200 : 201, { data }, ctx.requestId);
});
