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
  it('refuses unrelated schemas before writing migration state', async () => {
    await pool.query('CREATE SCHEMA pgarchive');
    try {
      await expect(runMigrations(url)).rejects.toThrow('dedicated Print Pantry database');
      const result = await pool.query(
        "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = 'pgarchive'",
      );
      expect(result.rows[0].count).toBe(1);
    } finally {
      await pool.query('DROP SCHEMA pgarchive');
    }
  });

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
      const indexes = await pool.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN ('projects_search_idx', 'assets_search_idx', 'categories_search_idx')
      `);
      expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
        'assets_search_idx', 'categories_search_idx', 'projects_search_idx',
      ]);
    } finally {
      await db.delete(schema.appMetadata).where(eq(schema.appMetadata.key, key));
    }
  });

  it('stores typed accounts and expiry-bound hashed sessions', async () => {
    const username = `test-${randomUUID()}`;
    const [user] = await createDatabase(pool).insert(schema.users).values({
      username, passwordHash: 'fixture-hash', role: 'requester',
    }).returning();
    try {
      const [session] = await createDatabase(pool).insert(schema.sessions).values({
        userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
      }).returning();
      try {
        expect(session).toMatchObject({ userId: user.id, expiresAt: expect.any(Date) });
      } finally {
        await createDatabase(pool).delete(schema.sessions).where(eq(schema.sessions.id, session.id));
      }
    } finally {
      await createDatabase(pool).delete(schema.users).where(eq(schema.users.id, user.id));
    }
  });
});
