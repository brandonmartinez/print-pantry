import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, schema } from './index.js';
import { runMigrations } from './migrate.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must point to an isolated test database');
if (new URL(url).pathname !== '/print_pantry_test') throw new Error('TEST_DATABASE_URL must target print_pantry_test');

const pool = createPool(url);
afterAll(async () => pool.end());

describe('versioned PostgreSQL migrations', () => {
  it('applies idempotently and supports typed reads and writes', async () => {
    await runMigrations(url);
    await runMigrations(url);
    const key = randomUUID();
    const db = createDatabase(pool);
    try {
      await db.insert(schema.appMetadata).values({ key, value: 'test' });
      const records = await db.select().from(schema.appMetadata).where(eq(schema.appMetadata.key, key));
      expect(records).toHaveLength(1);
      expect(records[0].value).toBe('test');
      expect(records[0].updatedAt).toBeInstanceOf(Date);
    } finally {
      await db.delete(schema.appMetadata).where(eq(schema.appMetadata.key, key));
    }
  });
});
