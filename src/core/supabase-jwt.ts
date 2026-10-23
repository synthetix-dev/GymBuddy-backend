import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { Problems } from './problem.js';

export interface SupabaseJwtClaims {
  sub: string;
  role: 'authenticated' | 'anon' | 'service_role';
  session_id?: string;
  aal?: 'aal1' | 'aal2';
  email?: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface SupabaseJwk extends crypto.JsonWebKey {
  kid: string;
  kty: 'EC' | 'RSA';
  alg?: 'ES256' | 'RS256';
  use?: string;
}

export type SupabaseJwksFetcher = (jwksUrl: string) => Promise<{ keys: SupabaseJwk[] }>;

// Deterministic local ES256 keypair ONLY for local dev/test JWKS simulation when not hitting remote Supabase Cloud
const devEcKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const devPublicJwk: SupabaseJwk = {
  ...(devEcKeyPair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey),
  kid: 'supabase-local-es256-kid-1',
  kty: 'EC',
  alg: 'ES256',
  use: 'sig',
};

const defaultJwksFetcher: SupabaseJwksFetcher = async (jwksUrl: string) => {
  if (
    (env.GYMBUDDY_ENVIRONMENT === 'dev' || env.GYMBUDDY_ENVIRONMENT === 'test') &&
    jwksUrl.includes('localhost')
  ) {
    return { keys: [devPublicJwk] };
  }

  const res = await fetch(jwksUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Supabase JWKS (${res.status}) from ${jwksUrl}`);
  }
  return (await res.json()) as { keys: SupabaseJwk[] };
};

let activeJwksFetcher: SupabaseJwksFetcher = defaultJwksFetcher;
let cachedKeys: Map<string, crypto.KeyObject> = new Map();
let cacheExpiresAtMs = 0;

export function setSupabaseJwksFetcher(fetcher: SupabaseJwksFetcher | null): void {
  activeJwksFetcher = fetcher ?? defaultJwksFetcher;
  cachedKeys.clear();
  cacheExpiresAtMs = 0;
}

async function getSupabasePublicKey(kid: string): Promise<crypto.KeyObject> {
  const now = Date.now();
  const cached = cachedKeys.get(kid);
  if (cached && now < cacheExpiresAtMs) {
    return cached;
  }

  const jwksUrl = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
  const jwks = await activeJwksFetcher(jwksUrl);
  const nextMap = new Map<string, crypto.KeyObject>();

  for (const jwk of jwks.keys ?? []) {
    if (jwk.kid && (jwk.kty === 'EC' || jwk.kty === 'RSA')) {
      nextMap.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
  }

  cachedKeys = nextMap;
  cacheExpiresAtMs = now + 10 * 60 * 1000; // 10 min JWKS cache TTL

  const found = cachedKeys.get(kid);
  if (!found) {
    throw Problems.unauthorized(`Unknown Supabase JWKS key id (kid="${kid}").`);
  }
  return found;
}

/**
 * Verifies a Supabase Auth access token (JWT) against the project's asymmetric JWKS
 * (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).
 * Supports ES256 (P-256) and RS256 (RSA-2048). Never uses a local symmetric JWT_SECRET.
 */
export async function verifySupabaseAccessToken(token: string): Promise<SupabaseJwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Problems.unauthorized('Malformed Bearer JWT token.');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string; typ?: string };
  let claims: SupabaseJwtClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw Problems.unauthorized('Invalid JWT encoding.');
  }

  if ((header.alg !== 'ES256' && header.alg !== 'RS256') || !header.kid) {
    throw Problems.unauthorized('Supabase JWT must use asymmetric ES256 or RS256 with a kid header.');
  }

  const publicKey = await getSupabasePublicKey(header.kid);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signatureBytes = Buffer.from(signatureB64, 'base64url');

  const isValid =
    header.alg === 'ES256'
      ? crypto.verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signatureBytes)
      : crypto.verify('RSA-SHA256', signingInput, publicKey, signatureBytes);

  if (!isValid) {
    throw Problems.unauthorized('Invalid Supabase JWT signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
    throw Problems.unauthorized('Supabase access token has expired.');
  }

  const expectedIssuer = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
  if (claims.iss !== expectedIssuer) {
    throw Problems.unauthorized(`Invalid JWT issuer "${claims.iss}". Expected "${expectedIssuer}".`);
  }

  if (claims.aud !== 'authenticated') {
    throw Problems.unauthorized('Invalid JWT audience.');
  }

  if (!claims.sub) {
    throw Problems.unauthorized('Missing subject claim in JWT.');
  }

  return claims;
}

/**
 * Test/Simulator helper ONLY: Signs a Supabase-compatible ES256 JWT with the simulated
 * Supabase Auth private key (used in automated tests and local CLI drills to simulate tokens
 * issued by Supabase Auth after native iOS Sign in with Apple).
 */
export function issueSimulatedSupabaseAuthToken(
  params: {
    sub: string;
    email?: string;
    role?: 'authenticated' | 'anon' | 'service_role';
    session_id?: string;
    aal?: 'aal1' | 'aal2';
    expiresInSeconds?: number;
  },
  customKey?: { privateKey: crypto.KeyObject; kid: string }
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const kid = customKey?.kid ?? 'supabase-local-es256-kid-1';
  const privKey = customKey?.privateKey ?? devEcKeyPair.privateKey;

  const headerB64 = Buffer.from(
    JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }),
    'utf8'
  ).toString('base64url');

  const payload: SupabaseJwtClaims = {
    sub: params.sub,
    role: params.role ?? 'authenticated',
    session_id: params.session_id ?? crypto.randomUUID(),
    aal: params.aal ?? 'aal1',
    email: params.email,
    iss: `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`,
    aud: 'authenticated',
    iat: nowSec,
    exp: nowSec + (params.expiresInSeconds ?? 900),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signatureB64 = crypto
    .sign('sha256', signingInput, { key: privKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
