import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { Problems } from '../../core/problem.js';

export interface SignedStorageUrl {
  url: string;
  token: string;
  expires_at: string;
}

export interface StorageProvider {
  createSignedUploadUrl(params: {
    bucket: string;
    objectPath: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl>;

  createSignedDownloadUrl(params: {
    bucket: string;
    objectPath: string;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl>;

  putObjectBytes(bucket: string, objectPath: string, data: Buffer, mimeType: string): Promise<void>;
  getObjectBytes(bucket: string, objectPath: string): Promise<Buffer>;
  deleteObject(bucket: string, objectPath: string): Promise<void>;
}

const LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), 'uploads');

function safeLocalPath(bucket: string, objectPath: string): string {
  const normalizedBucket = bucket.replace(/[^a-zA-Z0-9_-]/g, '');
  const normalizedObj = path.posix
    .normalize(objectPath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');
  const resolved = path.resolve(LOCAL_STORAGE_ROOT, normalizedBucket, normalizedObj);
  if (!resolved.startsWith(LOCAL_STORAGE_ROOT)) {
    throw Problems.forbidden('Invalid storage object path.');
  }
  return resolved;
}

export function signLocalStorageToken(params: {
  purpose: 'upload' | 'download';
  bucket: string;
  objectPath: string;
  maxBytes?: number;
  exp: number;
}): string {
  const payload = JSON.stringify({
    p: params.purpose,
    b: params.bucket,
    o: params.objectPath,
    m: params.maxBytes ?? 0,
    e: params.exp,
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', env.MEDIA_SIGNING_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyLocalStorageToken(
  token: string,
  expectedPurpose: 'upload' | 'download',
  expectedBucket: string,
  expectedObjectPath: string
): { maxBytes: number; exp: number } {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw Problems.unauthorized('Malformed storage signed token.');
  }
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = crypto
    .createHmac('sha256', env.MEDIA_SIGNING_SECRET)
    .update(payloadB64)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Problems.unauthorized('Invalid storage signed token signature.');
  }

  const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    p: string;
    b: string;
    o: string;
    m: number;
    e: number;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  if (parsed.e <= nowSec) {
    throw Problems.unauthorized('Storage signed URL has expired.');
  }
  if (
    parsed.p !== expectedPurpose ||
    parsed.b !== expectedBucket ||
    parsed.o !== expectedObjectPath
  ) {
    throw Problems.forbidden('Storage token scope mismatch.');
  }

  return { maxBytes: parsed.m, exp: parsed.e };
}

/**
 * Supabase Storage REST API Provider:
 * Calls real Supabase Storage endpoints (`/storage/v1/object/upload/sign/...`, `/storage/v1/object/sign/...`)
 * using `SUPABASE_SERVICE_ROLE_KEY`.
 */
export class SupabaseRestStorageProvider implements StorageProvider {
  constructor(
    private readonly baseUrl = env.SUPABASE_URL.replace(/\/+$/, ''),
    private readonly serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  ) {}

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  public async createSignedUploadUrl(params: {
    bucket: string;
    objectPath: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl> {
    const endpoint = `${this.baseUrl}/storage/v1/object/upload/sign/${params.bucket}/${params.objectPath}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: params.expiresInSeconds }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase Storage createSignedUploadUrl failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { url?: string; signedURL?: string; token?: string };
    const relativeUrl = data.url ?? data.signedURL ?? '';
    const fullUrl = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${this.baseUrl}/storage/v1${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
    const token =
      data.token ?? new URL(fullUrl).searchParams.get('token') ?? '';

    return {
      url: fullUrl,
      token,
      expires_at: new Date(Date.now() + params.expiresInSeconds * 1000).toISOString(),
    };
  }

  public async createSignedDownloadUrl(params: {
    bucket: string;
    objectPath: string;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl> {
    const endpoint = `${this.baseUrl}/storage/v1/object/sign/${params.bucket}/${params.objectPath}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: params.expiresInSeconds }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase Storage createSignedUrl failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const relativeUrl = data.signedURL ?? data.signedUrl ?? '';
    const fullUrl = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${this.baseUrl}/storage/v1${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
    const token = new URL(fullUrl).searchParams.get('token') ?? '';

    return {
      url: fullUrl,
      token,
      expires_at: new Date(Date.now() + params.expiresInSeconds * 1000).toISOString(),
    };
  }

  public async putObjectBytes(
    bucket: string,
    objectPath: string,
    data: Buffer,
    mimeType: string
  ): Promise<void> {
    const endpoint = `${this.baseUrl}/storage/v1/object/${bucket}/${objectPath}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.authHeaders({
        'Content-Type': mimeType,
        'x-upsert': 'true',
      }),
      body: new Uint8Array(data),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase Storage putObjectBytes failed (${res.status}): ${text}`);
    }
  }

  public async getObjectBytes(bucket: string, objectPath: string): Promise<Buffer> {
    const endpoint = `${this.baseUrl}/storage/v1/object/authenticated/${bucket}/${objectPath}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw Problems.notFound('Uploaded storage object');
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  public async deleteObject(bucket: string, objectPath: string): Promise<void> {
    const endpoint = `${this.baseUrl}/storage/v1/object/${bucket}/${objectPath}`;
    await fetch(endpoint, {
      method: 'DELETE',
      headers: this.authHeaders(),
    }).catch(() => {});
  }
}

/**
 * Local Disk Storage Provider (Used in local dev/test and compatible with `/v1/storage/object/...` HTTP routes)
 */
export class LocalDiskStorageProvider implements StorageProvider {
  public async createSignedUploadUrl(params: {
    bucket: string;
    objectPath: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl> {
    const exp = Math.floor(Date.now() / 1000) + params.expiresInSeconds;
    const token = signLocalStorageToken({
      purpose: 'upload',
      bucket: params.bucket,
      objectPath: params.objectPath,
      maxBytes: params.maxBytes,
      exp,
    });
    return {
      url: `${env.GYMBUDDY_API_BASE_URL}/storage/object/upload/sign/${params.bucket}/${params.objectPath}?token=${token}`,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
    };
  }

  public async createSignedDownloadUrl(params: {
    bucket: string;
    objectPath: string;
    expiresInSeconds: number;
  }): Promise<SignedStorageUrl> {
    const exp = Math.floor(Date.now() / 1000) + params.expiresInSeconds;
    const token = signLocalStorageToken({
      purpose: 'download',
      bucket: params.bucket,
      objectPath: params.objectPath,
      exp,
    });
    return {
      url: `${env.GYMBUDDY_API_BASE_URL}/storage/object/sign/${params.bucket}/${params.objectPath}?token=${token}`,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
    };
  }

  public async putObjectBytes(
    bucket: string,
    objectPath: string,
    data: Buffer,
    _mimeType: string
  ): Promise<void> {
    const targetFile = safeLocalPath(bucket, objectPath);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, data);
  }

  public async getObjectBytes(bucket: string, objectPath: string): Promise<Buffer> {
    const targetFile = safeLocalPath(bucket, objectPath);
    try {
      return await fs.readFile(targetFile);
    } catch {
      throw Problems.validation(
        'Uploaded file bytes not found in storage bucket. Upload file to upload_url before calling complete.',
        [{ field: 'file', reason: 'object_not_uploaded' }],
        'MEDIA_NOT_UPLOADED'
      );
    }
  }

  public async deleteObject(bucket: string, objectPath: string): Promise<void> {
    const targetFile = safeLocalPath(bucket, objectPath);
    await fs.unlink(targetFile).catch(() => {});
  }
}

let activeStorageProvider: StorageProvider =
  env.GYMBUDDY_ENVIRONMENT === 'production' || env.GYMBUDDY_ENVIRONMENT === 'staging'
    ? new SupabaseRestStorageProvider()
    : new LocalDiskStorageProvider();

export function getStorageProvider(): StorageProvider {
  return activeStorageProvider;
}

export function setStorageProvider(provider: StorageProvider): void {
  activeStorageProvider = provider;
}
