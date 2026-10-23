import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

async function ensureDatabaseExists(targetUrl: string): Promise<void> {
  const parsed = new URL(targetUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName || !/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Invalid database name in URL: ${targetUrl}`);
  }

  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/postgres';

  const adminClient = new Client({ connectionString: adminUrl.toString() });
  await adminClient.connect();
  try {
    const existsRes = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName]
    );
    if (existsRes.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } finally {
    await adminClient.end();
  }
}

/**
 * In managed Supabase, the `auth` schema, `auth.users`, `auth.uid()`, and roles
 * (`anon`, `authenticated`, `service_role`) are pre-provisioned by the Supabase platform
 * and MUST NOT be defined inside `supabase/migrations/*.sql`.
 * When running local tests against standalone PostgreSQL, this bootstrapper ensures
 * those platform primitives exist before applying `supabase/migrations/*.sql`.
 */
async function ensureSupabasePlatformPrimitivesForLocalPostgres(client: pg.Client): Promise<void> {
  const checkAuthUsers = await client.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  `);
  if (checkAuthUsers.rowCount && checkAuthUsers.rowCount > 0) {
    return;
  }

  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
      END IF;
    END
    $$;

    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext UNIQUE,
      encrypted_password text,
      email_confirmed_at timestamptz,
      last_sign_in_at timestamptz,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $fn$
      SELECT NULLIF(
        COALESCE(
          current_setting('request.jwt.claim.sub', true),
          (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        ),
        ''
      )::uuid;
    $fn$;

    CREATE OR REPLACE FUNCTION auth.role()
    RETURNS text
    LANGUAGE sql
    STABLE
    AS $fn$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.role', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        current_user
      );
    $fn$;

    CREATE OR REPLACE FUNCTION auth.jwt()
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    AS $fn$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
        jsonb_build_object(
          'sub', current_setting('request.jwt.claim.sub', true),
          'role', current_setting('request.jwt.claim.role', true),
          'aal', current_setting('request.jwt.claim.aal', true)
        )
      );
    $fn$;

    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT SELECT ON auth.users TO authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role;
  `);
}

export async function runMigrations(options?: {
  connectionString?: string;
  reset?: boolean;
  silent?: boolean;
}): Promise<{ applied: string[] }> {
  const connectionString =
    options?.connectionString ??
    process.env.DATABASE_DIRECT_URL ??
    process.env.DATABASE_URL ??
    'postgresql://localhost:5432/gymbuddy_dev';

  await ensureDatabaseExists(connectionString);

  const client = new Client({ connectionString });
  await client.connect();

  const applied: string[] = [];

  try {
    if (options?.reset) {
      await client.query(`
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
        DROP SCHEMA IF EXISTS auth CASCADE;
      `);
      if (!options?.silent) {
        console.log('Reset schemas public and auth.');
      }
    }

    await ensureSupabasePlatformPrimitivesForLocalPostgres(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public._schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM public._schema_migrations WHERE version = $1',
        [file]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public._schema_migrations (version) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        applied.push(file);
        if (!options?.silent) {
          console.log(`Applied migration: ${file}`);
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    // Ensure _schema_migrations also has RLS enabled so every public table is protected
    await client.query(`
      ALTER TABLE public._schema_migrations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public._schema_migrations FORCE ROW LEVEL SECURITY;
    `);
  } finally {
    await client.end();
  }

  return { applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reset = process.argv.includes('--reset');
  runMigrations({ reset })
    .then(({ applied }) => {
      console.log(`Migration complete. Applied ${applied.length} migration(s).`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
