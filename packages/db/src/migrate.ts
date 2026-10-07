import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createPool } from './index.js';

export async function runMigrations(connectionString: string, migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))) {
  const pool = createPool(connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(294853117)');
      try {
        await migrate(drizzle(client), { migrationsFolder });
      } finally {
        await client.query('SELECT pg_advisory_unlock(294853117)');
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations(process.env.DATABASE_URL ?? '').catch((error: unknown) => {
    console.error('Database migration failed:', error);
    process.exitCode = 1;
  });
}
