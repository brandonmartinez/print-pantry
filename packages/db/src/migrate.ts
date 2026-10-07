import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
import { createPool } from './index.js';

const appTables = new Set([
  'app_metadata', 'categories', 'projects', 'project_boundary_overrides',
  'assets', 'asset_versions', 'scan_runs', 'scan_errors',
  'users', 'sessions', 'print_requests', 'print_request_files',
  'print_request_history', 'request_queue_state',
]);

export async function runMigrations(connectionString: string, migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))) {
  const firstMigration = readMigrationFiles({ migrationsFolder })[0];
  if (!firstMigration) throw new Error('No Print Pantry migration files were found');
  const pool = createPool(connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(294853117)');
      try {
        const namespaces = await client.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace
           WHERE nspname NOT IN ('public', 'information_schema')
             AND nspname !~ '^pg_'`,
        );
        const tables = await client.query<{ schemaname: string; tablename: string }>(
          `SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname IN ('public', 'drizzle')`,
        );
        const ledger = tables.rows.some(({ schemaname, tablename }) =>
          schemaname === 'drizzle' && tablename === '__drizzle_migrations');
        const metadata = tables.rows.some(({ schemaname, tablename }) =>
          schemaname === 'public' && tablename === 'app_metadata');
        if (namespaces.rows.some(({ nspname }) => nspname !== 'drizzle') ||
            tables.rows.some(({ schemaname, tablename }) =>
              schemaname === 'public' ? !appTables.has(tablename) : tablename !== '__drizzle_migrations') ||
            (tables.rows.length > 0 || namespaces.rows.length > 0) && (!ledger || !metadata)) {
          throw new Error('Migrations require a dedicated Print Pantry database without unrelated schemas or tables');
        }
        if (ledger) {
          const entries = await client.query<{ hash: string }>(
            'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1',
          );
          if (entries.rows[0]?.hash !== firstMigration.hash) {
            throw new Error('Existing migration history does not belong to Print Pantry');
          }
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
