import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

export async function runSeed(options?: {
  connectionString?: string;
  silent?: boolean;
}): Promise<void> {
  const connectionString =
    options?.connectionString ??
    process.env.DATABASE_DIRECT_URL ??
    process.env.DATABASE_URL ??
    'postgresql://localhost:5432/gymbuddy_dev';

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const seedPath = path.resolve(process.cwd(), 'supabase/seed.sql');
    const sql = await fs.readFile(seedPath, 'utf8');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    if (!options?.silent) {
      console.log('Seed data applied successfully.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
