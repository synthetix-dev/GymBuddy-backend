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
    confirmation?: string;
    reason?: string;
  };

  if (body.confirmation !== 'DELETE') {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'Confirmation string must equal "DELETE".',
      requestId: ctx.requestId,
    });
  }

  const dueAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const { data: delRow, error: insErr } = await ctx.adminClient
    .from('account_deletions')
    .insert({
      user_id: ctx.userId,
      status: 'cooling_off',
      reason: (body.reason ?? '').slice(0, 500),
      reauth_verified: true,
      due_at: dueAt,
    })
    .select('id, status, due_at')
    .single();

  if (insErr || !delRow) {
    return problemResponse({
      status: 409,
      code: 'DELETION_ALREADY_PENDING',
      title: 'Account deletion already pending',
      detail: insErr?.message ?? 'An active deletion request already exists.',
      requestId: ctx.requestId,
    });
  }

  await ctx.adminClient
    .from('user_profiles')
    .update({ account_status: 'deletion_pending' })
    .eq('user_id', ctx.userId);

  return jsonResponse(202, { data: delRow }, ctx.requestId);
});
