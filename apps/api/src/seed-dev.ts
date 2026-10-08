import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '@print-pantry/db';
import { hashPassword } from './auth.js';

const localHosts = new Set(['db', 'localhost', '127.0.0.1']);

export function isLocalDevelopmentDatabase(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return ['postgres:', 'postgresql:'].includes(url.protocol) &&
      localHosts.has(url.hostname) && url.pathname === '/print_pantry_dev';
  } catch {
    return false;
  }
}

async function seedDevelopmentAccount(): Promise<void> {
  if (process.env.DEV_SEED_USER !== 'true') {
    console.info('Local development account seeding is disabled.');
    return;
  }

  const connectionString = process.env.DATABASE_URL ?? '';
  if (!isLocalDevelopmentDatabase(connectionString)) {
    throw new Error('Refusing to seed a user outside the local print_pantry_dev database');
  }

  const pool = createPool(connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('print_pantry_account_provision'))");
        const existing = await client.query('SELECT id FROM users LIMIT 1');
        if (existing.rows.length) {
          await client.query('COMMIT');
          console.info('Skipping local development account seed because users already exist.');
          return;
        }

        const passwordHash = await hashPassword('print-pantry-dev');
        await client.query(
          'INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
          [randomUUID(), 'admin', passwordHash, 'operator'],
        );
        await client.query('COMMIT');
        console.info('Seeded local development portal account: admin / print-pantry-dev');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedDevelopmentAccount().catch((error: unknown) => {
    console.error('Local development account seeding failed:', error);
    process.exitCode = 1;
  });
}
