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
    target_type?: 'profile' | 'post' | 'comment' | 'message' | 'workout_session';
    target_id?: string;
    reason?: string;
    details?: string;
  };

  if (!body.target_type || !body.target_id || !body.reason) {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'target_type, target_id, and reason are required.',
      requestId: ctx.requestId,
    });
  }

  const { data: repRow, error } = await ctx.adminClient
    .from('reports')
    .insert({
      reporter_id: ctx.userId,
      target_type: body.target_type,
      target_id: body.target_id,
      reason: body.reason.trim(),
      details: (body.details ?? '').trim(),
      status: 'new',
      evidence_snapshot: {
        captured_at: new Date().toISOString(),
        target_type: body.target_type,
        target_id: body.target_id,
      },
    })
    .select('id, status, created_at')
    .single();

  if (error || !repRow) {
    return problemResponse({
      status: 422,
      code: 'REPORT_FAILED',
      title: 'Unable to submit report',
      detail: error?.message ?? 'Report error',
      requestId: ctx.requestId,
    });
  }

  await ctx.adminClient.from('moderation_cases').insert({
    report_id: repRow.id,
    target_type: body.target_type,
    target_id: body.target_id,
    status: 'new',
    severity: 'medium',
  });

  return jsonResponse(202, { data: repRow }, ctx.requestId);
});
