import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDatabase, createPool } from './index.js';

export async function runMigrations(connectionString: string, migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))) {
  const pool = createPool(connectionString);
  try {
    await migrate(createDatabase(pool), { migrationsFolder });
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
