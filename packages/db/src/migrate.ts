import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createPool } from './index.js';

const appTables = new Set([
  'app_metadata', 'categories', 'projects', 'project_boundary_overrides',
  'assets', 'asset_versions', 'scan_runs', 'scan_errors',
  'users', 'sessions', 'print_requests', 'print_request_files',
  'print_request_history', 'request_queue_state',
]);

export async function runMigrations(connectionString: string, migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))) {
  const pool = createPool(connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(294853117)');
      try {
        const namespaces = await client.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace
           WHERE nspname NOT IN ('public', 'information_schema', 'drizzle')
             AND nspname NOT LIKE 'pg_%'`,
        );
        const tables = await client.query<{ schemaname: string; tablename: string }>(
          `SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname IN ('public', 'drizzle')`,
        );
        if (namespaces.rows.length || tables.rows.some(({ schemaname, tablename }) =>
          schemaname === 'public' ? !appTables.has(tablename) : tablename !== '__drizzle_migrations')) {
          throw new Error('Migrations require a dedicated Print Pantry database without unrelated schemas or tables');
        }
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
