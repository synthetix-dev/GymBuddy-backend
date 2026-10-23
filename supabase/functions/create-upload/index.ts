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
    purpose?: 'avatar' | 'profile_photo' | 'post_image' | 'message_attachment';
    mime_type?: 'image/jpeg' | 'image/png' | 'image/heic' | 'image/webp';
    byte_size?: number;
    sha256?: string;
  };

  const allowedMimes = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'];
  if (
    !body.purpose ||
    !body.mime_type ||
    !allowedMimes.includes(body.mime_type) ||
    typeof body.byte_size !== 'number' ||
    body.byte_size <= 0 ||
    body.byte_size > 10_485_760 ||
    !body.sha256 ||
    !/^[a-f0-9]{64}$/i.test(body.sha256)
  ) {
    return problemResponse({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Invalid upload intent parameters',
      detail: 'Valid purpose, mime_type, byte_size (<= 10 MB), and 64-char hex sha256 are required.',
      requestId: ctx.requestId,
    });
  }

  const bucket =
    body.purpose === 'avatar' || body.purpose === 'profile_photo'
      ? 'profile-originals'
      : body.purpose === 'post_image'
      ? 'post-originals'
      : 'message-attachments';

  const mediaId = crypto.randomUUID();
  const ext = body.mime_type.split('/')[1];
  const objectPath = `${ctx.userId}/${mediaId}/original.${ext}`;

  const { data: signedUpload, error: signErr } = await ctx.adminClient.storage
    .from(bucket)
    .createSignedUploadUrl(objectPath);

  if (signErr || !signedUpload) {
    return problemResponse({
      status: 502,
      code: 'STORAGE_SIGN_FAILED',
      title: 'Unable to create Supabase Storage signed upload URL',
      detail: signErr?.message ?? 'Storage error',
      requestId: ctx.requestId,
    });
  }

  const { error: dbErr } = await ctx.adminClient.from('media_objects').insert({
    id: mediaId,
    owner_id: ctx.userId,
    purpose: body.purpose,
    bucket,
    object_path: objectPath,
    declared_mime: body.mime_type,
    byte_size: body.byte_size,
    sha256_hex: body.sha256.toLowerCase(),
    status: 'upload_pending',
    visibility: 'private',
  });

  if (dbErr) {
    return problemResponse({
      status: 422,
      code: 'MEDIA_INSERT_FAILED',
      title: 'Unable to register upload intent',
      detail: dbErr.message,
      requestId: ctx.requestId,
    });
  }

  return jsonResponse(
    201,
    {
      data: {
        media_object_id: mediaId,
        bucket,
        object_path: objectPath,
        upload_url: signedUpload.signedUrl,
        upload_token: signedUpload.token,
        expires_in_seconds: 900,
      },
    },
    ctx.requestId
  );
});
