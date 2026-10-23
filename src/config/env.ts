import crypto from 'node:crypto';

export interface AppEnv {
  PORT: number;
  GYMBUDDY_ENVIRONMENT: 'dev' | 'staging' | 'production' | 'test';
  GYMBUDDY_API_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DATABASE_URL: string;
  DATABASE_DIRECT_URL: string;
  PUBLIC_APP_URL: string;
  APPLE_APP_SITE_ASSOCIATION_TEAM_ID: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_BUNDLE_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_ENVIRONMENT: 'sandbox' | 'production';
  EMAIL_PROVIDER_API_KEY: string;
  EMAIL_FROM: string;
  SENTRY_DSN_IOS: string;
  SENTRY_DSN_SERVER: string;
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
  RATE_LIMIT_PEPPER: string;
  IP_HASH_PEPPER: string;
  TOKEN_ENCRYPTION_KEY: string;
  MEDIA_SIGNING_SECRET: string;
  MEDIA_MAX_AVATAR_BYTES: number;
  MEDIA_MAX_POST_IMAGE_BYTES: number;
  MEDIA_MAX_CHAT_IMAGE_BYTES: number;
  MEDIA_MAX_PIXELS: number;
  MEDIA_DAILY_QUOTA_BYTES: number;
  OUTBOX_WORKER_ID: string;
  JOB_LEASE_SECONDS: number;
  ADMIN_APP_URL: string;
  ADMIN_ALLOWED_EMAIL_DOMAINS: string[];
}

const INSECURE_PLACEHOLDER_PATTERNS = [
  /^dev-/i,
  /dev_placeholder/i,
  /pub-dev-key/i,
  /service-role-dev-key/i,
  /^0123456789abcdef/i,
  /placeholder/i,
];

function isInsecurePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return INSECURE_PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

export function validateStrictProductionEnv(raw: Partial<Record<string, string>>): void {
  const envName = raw.GYMBUDDY_ENVIRONMENT ?? 'dev';
  if (!['dev', 'staging', 'production', 'test'].includes(envName)) {
    throw new Error(
      `Invalid GYMBUDDY_ENVIRONMENT="${envName}". Expected dev, staging, production, or test.`
    );
  }

  if (envName !== 'production' && envName !== 'staging') {
    return;
  }

  const requiredSecrets: Array<{ key: string; minLength?: number; mustBeHex64?: boolean; mustBePemKey?: boolean }> = [
    { key: 'GYMBUDDY_API_BASE_URL', minLength: 10 },
    { key: 'SUPABASE_URL', minLength: 10 },
    { key: 'SUPABASE_PUBLISHABLE_KEY', minLength: 20 },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', minLength: 24 },
    { key: 'DATABASE_URL', minLength: 16 },
    { key: 'APNS_KEY_ID', minLength: 5 },
    { key: 'APNS_TEAM_ID', minLength: 5 },
    { key: 'APNS_BUNDLE_ID', minLength: 5 },
    { key: 'APNS_PRIVATE_KEY', mustBePemKey: true },
    { key: 'RATE_LIMIT_PEPPER', minLength: 24 },
    { key: 'IP_HASH_PEPPER', minLength: 24 },
    { key: 'TOKEN_ENCRYPTION_KEY', mustBeHex64: true },
    { key: 'MEDIA_SIGNING_SECRET', minLength: 32 },
  ];

  const violations: string[] = [];

  for (const req of requiredSecrets) {
    const val = raw[req.key]?.trim() ?? '';
    if (!val) {
      violations.push(`${req.key} is missing`);
      continue;
    }
    if (isInsecurePlaceholder(val)) {
      violations.push(`${req.key} uses an insecure development placeholder`);
      continue;
    }
    if (req.minLength && val.length < req.minLength) {
      violations.push(`${req.key} must be at least ${req.minLength} characters`);
    }
    if (req.mustBeHex64 && !/^[a-fA-F0-9]{64}$/.test(val)) {
      violations.push(`${req.key} must be a 64-character hex string (256-bit key)`);
    }
    if (req.mustBePemKey && !val.includes('BEGIN PRIVATE KEY')) {
      violations.push(`${req.key} must be a valid PKCS#8 PEM private key`);
    }
  }

  if (envName === 'production' && raw.APNS_ENVIRONMENT !== 'production') {
    violations.push('APNS_ENVIRONMENT must be "production" when GYMBUDDY_ENVIRONMENT="production"');
  }

  if (
    (raw.SUPABASE_URL && raw.SUPABASE_URL.includes('localhost')) ||
    (raw.GYMBUDDY_API_BASE_URL && raw.GYMBUDDY_API_BASE_URL.includes('localhost'))
  ) {
    violations.push('SUPABASE_URL and GYMBUDDY_API_BASE_URL cannot point to localhost in staging/production');
  }

  if (violations.length > 0) {
    throw new Error(
      `Fatal configuration error for ${envName} environment:\n- ${violations.join('\n- ')}`
    );
  }
}

export function loadEnv(overrides?: Partial<Record<string, string>>): AppEnv {
  const raw = { ...process.env, ...overrides };
  validateStrictProductionEnv(raw);

  const envName = (raw.GYMBUDDY_ENVIRONMENT ?? 'dev') as AppEnv['GYMBUDDY_ENVIRONMENT'];
  const allowDevFallbacks = envName === 'dev' || envName === 'test';

  const requireOrDev = (key: string, devDefault: string): string => {
    const val = raw[key];
    if (val !== undefined && val !== '') return val;
    if (allowDevFallbacks) return devDefault;
    throw new Error(`Missing required environment variable: ${key}`);
  };

  return {
    PORT: Number(raw.PORT ?? 3000),
    GYMBUDDY_ENVIRONMENT: envName,
    GYMBUDDY_API_BASE_URL: requireOrDev('GYMBUDDY_API_BASE_URL', 'http://localhost:3000/v1'),
    SUPABASE_URL: requireOrDev('SUPABASE_URL', 'http://localhost:3000'),
    SUPABASE_PUBLISHABLE_KEY: requireOrDev('SUPABASE_PUBLISHABLE_KEY', 'pub-dev-key'),
    SUPABASE_SERVICE_ROLE_KEY: requireOrDev('SUPABASE_SERVICE_ROLE_KEY', 'service-role-dev-key'),
    DATABASE_URL: requireOrDev('DATABASE_URL', 'postgresql://localhost:5432/gymbuddy_dev'),
    DATABASE_DIRECT_URL:
      raw.DATABASE_DIRECT_URL ??
      raw.DATABASE_URL ??
      (allowDevFallbacks ? 'postgresql://localhost:5432/gymbuddy_dev' : ''),
    PUBLIC_APP_URL: raw.PUBLIC_APP_URL ?? 'https://gymbuddy.app',
    APPLE_APP_SITE_ASSOCIATION_TEAM_ID:
      raw.APPLE_APP_SITE_ASSOCIATION_TEAM_ID ?? 'TEAMID1234.com.gymbuddy.app',
    APNS_KEY_ID: requireOrDev('APNS_KEY_ID', 'APNSKEY123'),
    APNS_TEAM_ID: requireOrDev('APNS_TEAM_ID', 'TEAMID1234'),
    APNS_BUNDLE_ID: requireOrDev('APNS_BUNDLE_ID', 'com.gymbuddy.app'),
    APNS_PRIVATE_KEY: requireOrDev(
      'APNS_PRIVATE_KEY',
      '-----BEGIN PRIVATE KEY-----\nDEV\n-----END PRIVATE KEY-----'
    ),
    APNS_ENVIRONMENT: (raw.APNS_ENVIRONMENT as 'sandbox' | 'production') ?? 'sandbox',
    EMAIL_PROVIDER_API_KEY: raw.EMAIL_PROVIDER_API_KEY ?? '',
    EMAIL_FROM: raw.EMAIL_FROM ?? 'no-reply@gymbuddy.app',
    SENTRY_DSN_IOS: raw.SENTRY_DSN_IOS ?? '',
    SENTRY_DSN_SERVER: raw.SENTRY_DSN_SERVER ?? '',
    OTEL_EXPORTER_OTLP_ENDPOINT: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
    RATE_LIMIT_PEPPER: requireOrDev('RATE_LIMIT_PEPPER', 'dev-rate-limit-pepper-secret-01'),
    IP_HASH_PEPPER: requireOrDev('IP_HASH_PEPPER', 'dev-ip-hash-pepper-secret-01'),
    TOKEN_ENCRYPTION_KEY: requireOrDev(
      'TOKEN_ENCRYPTION_KEY',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ),
    MEDIA_SIGNING_SECRET: requireOrDev('MEDIA_SIGNING_SECRET', 'dev-media-signing-secret-key-01'),
    MEDIA_MAX_AVATAR_BYTES: Number(raw.MEDIA_MAX_AVATAR_BYTES ?? 10 * 1024 * 1024),
    MEDIA_MAX_POST_IMAGE_BYTES: Number(raw.MEDIA_MAX_POST_IMAGE_BYTES ?? 15 * 1024 * 1024),
    MEDIA_MAX_CHAT_IMAGE_BYTES: Number(raw.MEDIA_MAX_CHAT_IMAGE_BYTES ?? 15 * 1024 * 1024),
    MEDIA_MAX_PIXELS: Number(raw.MEDIA_MAX_PIXELS ?? 12_000_000),
    MEDIA_DAILY_QUOTA_BYTES: Number(raw.MEDIA_DAILY_QUOTA_BYTES ?? 100 * 1024 * 1024),
    OUTBOX_WORKER_ID: raw.OUTBOX_WORKER_ID ?? `worker-${crypto.randomUUID().slice(0, 8)}`,
    JOB_LEASE_SECONDS: Number(raw.JOB_LEASE_SECONDS ?? 60),
    ADMIN_APP_URL: raw.ADMIN_APP_URL ?? 'https://admin.gymbuddy.app',
    ADMIN_ALLOWED_EMAIL_DOMAINS: (raw.ADMIN_ALLOWED_EMAIL_DOMAINS ?? 'gymbuddy.app')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export const env = loadEnv();

export function hashWithPepper(value: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(value).digest('hex');
}

export function encryptSensitiveToken(plainText: string): string {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSensitiveToken(cipherText: string): string {
  const [ivHex, tagHex, dataHex] = cipherText.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Malformed encrypted token');
  }
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY.slice(0, 64), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
