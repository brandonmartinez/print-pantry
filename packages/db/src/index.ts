import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export { schema };

export function createPool(connectionString: string): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, connectionTimeoutMillis: 3000 });
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}
