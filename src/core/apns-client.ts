import crypto from 'node:crypto';
import http2 from 'node:http2';
import { env } from '../config/env.js';

export interface ApnsRequestParams {
  deviceToken: string;
  environment: 'sandbox' | 'production';
  bundleId: string;
  collapseId: string;
  payload: Record<string, unknown>;
  authorityOverride?: string;
  caCertPem?: string;
  keyId?: string;
  teamId?: string;
  privateKeyPem?: string;
}

export interface ApnsResponse {
  statusCode: 200 | 400 | 403 | 410 | 429 | 500;
  reason?: string;
  apnsId?: string;
}

let cachedProviderJwt: string | null = null;
let cachedProviderJwtIssuedAt = 0;
let cachedKeyFingerprint = '';

/**
 * Generates an ES256 (P-256 / prime256v1) APNs Provider Authentication Token per RFC 7515 / Apple Spec.
 * Caches token for 50 minutes (Apple requires tokens to be refreshed no more than once every 20 mins and < 60 mins).
 */
export function signApnsProviderToken(params?: {
  keyId?: string;
  teamId?: string;
  privateKeyPem?: string;
  nowSeconds?: number;
}): string {
  const keyId = params?.keyId ?? env.APNS_KEY_ID;
  const teamId = params?.teamId ?? env.APNS_TEAM_ID;
  const privateKeyPem = (params?.privateKeyPem ?? env.APNS_PRIVATE_KEY).replace(/\\n/g, '\n');
  const nowSec = params?.nowSeconds ?? Math.floor(Date.now() / 1000);

  const fingerprint = `${keyId}:${teamId}:${privateKeyPem.slice(-32)}`;
  if (
    cachedProviderJwt &&
    cachedKeyFingerprint === fingerprint &&
    nowSec - cachedProviderJwtIssuedAt < 50 * 60
  ) {
    return cachedProviderJwt;
  }

  const headerB64 = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId }),
    'utf8'
  ).toString('base64url');
  const claimsB64 = Buffer.from(
    JSON.stringify({ iss: teamId, iat: nowSec }),
    'utf8'
  ).toString('base64url');

  const signingInput = `${headerB64}.${claimsB64}`;
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  // JWS ES256 requires raw 64-byte (r || s) IEEE P1363 encoding, not ASN.1 DER
  const signature = crypto
    .sign('SHA256', Buffer.from(signingInput, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');

  cachedProviderJwt = `${signingInput}.${signature}`;
  cachedProviderJwtIssuedAt = nowSec;
  cachedKeyFingerprint = fingerprint;

  return cachedProviderJwt;
}

export function resetApnsTokenCache(): void {
  cachedProviderJwt = null;
  cachedProviderJwtIssuedAt = 0;
  cachedKeyFingerprint = '';
}

/**
 * Sends a push notification over a real HTTP/2 connection to Apple APNs
 * (`https://api.push.apple.com:443` or `https://api.sandbox.push.apple.com:443`).
 */
export async function sendApnsHttp2Push(params: ApnsRequestParams): Promise<ApnsResponse> {
  const authority =
    params.authorityOverride ??
    (params.environment === 'production'
      ? 'https://api.push.apple.com:443'
      : 'https://api.sandbox.push.apple.com:443');

  const providerJwt = signApnsProviderToken({
    keyId: params.keyId,
    teamId: params.teamId,
    privateKeyPem: params.privateKeyPem,
  });
  const bodyBuffer = Buffer.from(JSON.stringify(params.payload), 'utf8');

  return new Promise<ApnsResponse>((resolve, reject) => {
    const client = http2.connect(
      authority,
      params.caCertPem ? { ca: params.caCertPem } : undefined
    );

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('APNs HTTP/2 request timed out after 10000ms'));
    }, 10_000);

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    const reqHeaders: http2.OutgoingHttpHeaders = {
      [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${params.deviceToken}`,
      authorization: `bearer ${providerJwt}`,
      'apns-topic': params.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': params.collapseId,
      'content-type': 'application/json',
      'content-length': String(bodyBuffer.byteLength),
    };

    const req = client.request(reqHeaders);

    let statusCode = 500;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];

    req.on('response', (headers) => {
      const rawStatus = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 500);
      if ([200, 400, 403, 410, 429, 500].includes(rawStatus)) {
        statusCode = rawStatus as ApnsResponse['statusCode'];
      } else if (rawStatus >= 400 && rawStatus < 500) {
        statusCode = 400;
      } else {
        statusCode = 500;
      }
      const rawId = headers['apns-id'];
      if (typeof rawId === 'string') {
        apnsId = rawId;
      }
    });

    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      clearTimeout(timeout);
      client.close();
      let reason: string | undefined;
      if (chunks.length > 0) {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            reason?: string;
          };
          reason = parsed.reason;
        } catch {
          // Non-JSON response body
        }
      }
      resolve({
        statusCode: statusCode as ApnsResponse['statusCode'],
        reason,
        apnsId,
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    req.end(bodyBuffer);
  });
}
