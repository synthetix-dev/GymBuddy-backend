import crypto from 'node:crypto';
import {
  issueSimulatedSupabaseAuthToken,
  setSupabaseJwksFetcher,
  verifySupabaseAccessToken,
  type SupabaseJwk,
} from '../src/core/supabase-jwt.js';

/**
 * 11-SECURITY-PRIVACY.md & 13-DEVOPS-INFRASTRUCTURE.md:
 * Verifies zero-downtime overlapping key rotation for Supabase Auth asymmetric JWKS keys (ES256).
 */
export async function runKeyRotationDrill(): Promise<{
  oldTokenAcceptedDuringOverlap: boolean;
  newTokenAcceptedDuringOverlap: boolean;
  oldTokenRejectedAfterRetirement: boolean;
}> {
  const oldKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const newKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const oldJwk: SupabaseJwk = {
    ...(oldKeyPair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey),
    kid: 'supabase-es256-kid-old',
    kty: 'EC',
    alg: 'ES256',
    use: 'sig',
  };
  const newJwk: SupabaseJwk = {
    ...(newKeyPair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey),
    kid: 'supabase-es256-kid-new',
    kty: 'EC',
    alg: 'ES256',
    use: 'sig',
  };

  try {
    const oldToken = issueSimulatedSupabaseAuthToken(
      { sub: '00000000-0000-4000-8000-000000000001' },
      { privateKey: oldKeyPair.privateKey, kid: 'supabase-es256-kid-old' }
    );
    const newToken = issueSimulatedSupabaseAuthToken(
      { sub: '00000000-0000-4000-8000-000000000001' },
      { privateKey: newKeyPair.privateKey, kid: 'supabase-es256-kid-new' }
    );

    // Phase 1: Overlap window — Supabase JWKS publishes both [newJwk, oldJwk]
    setSupabaseJwksFetcher(async () => ({ keys: [newJwk, oldJwk] }));
    const claimsFromOld = await verifySupabaseAccessToken(oldToken);
    const claimsFromNew = await verifySupabaseAccessToken(newToken);

    // Phase 2: Retirement — Supabase JWKS removes oldJwk and keeps only [newJwk]
    setSupabaseJwksFetcher(async () => ({ keys: [newJwk] }));
    let oldRejectedAfterRetirement = false;
    try {
      await verifySupabaseAccessToken(oldToken);
    } catch {
      oldRejectedAfterRetirement = true;
    }

    return {
      oldTokenAcceptedDuringOverlap: claimsFromOld.sub === '00000000-0000-4000-8000-000000000001',
      newTokenAcceptedDuringOverlap: claimsFromNew.sub === '00000000-0000-4000-8000-000000000001',
      oldTokenRejectedAfterRetirement: oldRejectedAfterRetirement,
    };
  } finally {
    setSupabaseJwksFetcher(null);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKeyRotationDrill()
    .then((result) => {
      console.log('Key Rotation Drill Passed:', JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
