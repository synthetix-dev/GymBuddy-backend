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
    invitation_id?: string;
    version?: number;
  };

  if (!body.invitation_id || typeof body.version !== 'number') {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'invitation_id and version are required.',
      requestId: ctx.requestId,
    });
  }

  const { data, error } = await ctx.adminClient.rpc('accept_workout_invitation_rpc', {
    p_actor_id: ctx.userId,
    p_invitation_id: body.invitation_id,
    p_expected_version: body.version,
  });

  if (error) {
    const status = error.code === '40001' ? 409 : error.code === '42501' ? 403 : 422;
    return problemResponse({
      status,
      code: status === 409 ? 'VERSION_CONFLICT' : 'INVITATION_TRANSITION_FAILED',
      title: 'Unable to accept workout invitation',
      detail: error.message,
      requestId: ctx.requestId,
    });
  }

  return jsonResponse(200, { data }, ctx.requestId);
});
