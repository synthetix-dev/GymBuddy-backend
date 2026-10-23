import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface EdgeAuthContext {
  userId: string;
  requestId: string;
  idempotencyKey: string;
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
}

export function problemResponse(params: {
  status: number;
  code: string;
  title: string;
  detail: string;
  requestId: string;
}): Response {
  return new Response(
    JSON.stringify({
      type: `https://api.gymbuddy.app/problems/${params.code.toLowerCase().replace(/_/g, '-')}`,
      title: params.title,
      status: params.status,
      detail: params.detail,
      code: params.code,
      request_id: params.requestId,
    }),
    {
      status: params.status,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Request-ID': params.requestId,
      },
    }
  );
}

export function jsonResponse(status: number, body: unknown, requestId: string): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      'X-Request-ID': requestId,
    },
  });
}

export async function authenticateEdgeRequest(req: Request): Promise<EdgeAuthContext | Response> {
  const requestId = req.headers.get('x-request-id') ?? `req_${crypto.randomUUID().replace(/-/g, '')}`;
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return problemResponse({
      status: 401,
      code: 'UNAUTHORIZED',
      title: 'Authentication required',
      detail: 'Missing Bearer authorization header.',
      requestId,
    });
  }

  const idempotencyKey = req.headers.get('idempotency-key') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'Valid UUID Idempotency-Key header is required.',
      requestId,
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return problemResponse({
      status: 500,
      code: 'EDGE_CONFIG_MISSING',
      title: 'Edge runtime configuration missing',
      detail: 'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set.',
      requestId,
    });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return problemResponse({
      status: 401,
      code: 'UNAUTHORIZED',
      title: 'Invalid Supabase session',
      detail: userErr?.message ?? 'Unable to verify user JWT with Supabase Auth.',
      requestId,
    });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    userId: userData.user.id,
    requestId,
    idempotencyKey,
    userClient,
    adminClient,
  };
}
