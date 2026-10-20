import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, runMigrations } from '@print-pantry/db';
import type { ImportRequest, ImportPage } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { importSource } from './import-sources.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/print_pantry_test') {
  throw new Error('TEST_DATABASE_URL must target an isolated print_pantry_test database');
}
const pool = createPool(databaseUrl);
const prefix = `imports-${randomUUID().slice(0, 8)}`;
const users = [0, 1, 2].map((n) => ({ id: randomUUID(), name: `${prefix}-${n}` }));
const modelId = `${Date.now()}${randomInt(1000, 9999)}`;
const modelUrl = `https://makerworld.com/en/models/${modelId}-holder?from=search#profileId-3048005`;
const projectId = `900719925474${randomInt(10000, 99999)}`;
let server: ReturnType<typeof buildServer>;
let root: string;
let cookies: string[];

beforeAll(async () => {
  await runMigrations(databaseUrl);
  root = await mkdtemp(join(tmpdir(), 'pantry-imports-'));
  const hash = await hashPassword('synthetic import test password');
  for (const [index, user] of users.entries()) {
    await pool.query('INSERT INTO users (id, username, password_hash, role) VALUES ($1,$2,$3,$4)',
      [user.id, user.name, hash, index === 0 ? 'operator' : 'requester']);
  }
  server = buildServer(pool, {
    pool, root, secureCookie: false, indexer: {
      getStatus: () => ({ running: false, lastScan: null }),
      rescan: async () => { throw new Error('This fixture does not scan'); },
    },
  });
  cookies = [];
  for (const user of users) {
    const response = await server.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: user.name, password: 'synthetic import test password' },
    });
    expect(response.statusCode).toBe(200);
    cookies.push(response.headers['set-cookie']!.toString().split(';')[0]);
  }
});

afterAll(async () => {
  try {
    if (server) await server.close();
    const ids = users.map((u) => u.id);
    const requests = await pool.query<{ request_id: string }>(
      'SELECT DISTINCT request_id FROM import_submissions WHERE requester_id = ANY($1::uuid[])', [ids],
    );
    const requestIds = requests.rows.map((r) => r.request_id);
    await pool.query('DELETE FROM import_events WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_submissions WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_requests WHERE id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM project_sources WHERE project_id = $1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const headers = (user = 1) => ({ cookie: cookies[user] });
const submit = (url: string, user = 1, notes = 'Please add this model', key = randomUUID()) =>
  server.inject({
    method: 'POST', url: '/imports', headers: headers(user),
    payload: { url, title: 'Requested holder', notes, submissionKey: key },
  });
const check = (url: string) => server.inject({
  method: 'POST', url: '/imports/check', headers: headers(), payload: { url },
});

describe('household import intake and operator queue', () => {
  it('authenticates all surfaces and validates URLs without fetching them', async () => {
    for (const url of ['/imports', '/imports/check']) {
      const response = await server.inject({ method: url.endsWith('check') ? 'POST' : 'GET', url,
        ...(url.endsWith('check') ? { payload: { url: modelUrl } } : {}) });
      expect(response.statusCode).toBe(401);
    }
    for (const url of ['file:///tmp/private', 'https://name:secret@example.invalid/', 'invalid']) {
      expect((await check(url)).statusCode).toBe(400);
      expect((await submit(url)).statusCode).toBe(400);
    }
  });

  it('persists any-site URL/title/notes and makes retries idempotent', async () => {
    const url = `https://example.invalid/${prefix}/model?id=42#variant`;
    const key = randomUUID();
    const response = await submit(url, 1, 'Keep this exact variant', key);
    expect(response.statusCode).toBe(201);
    const item = response.json<{ request: ImportRequest }>().request;
    expect(item).toMatchObject({
      status: 'submitted', revision: 0, source: { url, provider: 'other', modelId: null },
      submissions: [{ notes: 'Keep this exact variant', requester: { id: users[1].id } }],
    });
    const retry = await submit(url, 1, 'Keep this exact variant', key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().request.id).toBe(item.id);
    expect(retry.json().request.submissions).toHaveLength(1);
    expect((await submit(url, 1, 'Different content', key)).statusCode).toBe(409);
    const found = await server.inject({ url: `/imports/${item.id}`, headers: headers() });
    expect(found.json().request.submissions[0].notes).toBe('Keep this exact variant');
    expect((await server.inject({ url: `/imports/${item.id}`, headers: headers(2) })).statusCode).toBe(404);
    const own = await server.inject({ url: '/imports', headers: headers(2) });
    expect(own.json<ImportPage>().items.map((r) => r.id)).not.toContain(item.id);
  });

  it('joins matching MakerWorld models while preserving private notes and each profile URL', async () => {
    const first = await submit(modelUrl, 1, 'Private requester one notes');
    expect(first.statusCode).toBe(201);
    const id = first.json().request.id;
    const match = await check(`https://www.makerworld.com/de/models/${modelId}-renamed#profileId-17`);
    expect(match.json()).toMatchObject({
      source: { modelId, profileId: '17' }, pending: { id, status: 'submitted' },
    });
    expect(JSON.stringify(match.json())).not.toContain('Private requester');
    const secondUrl = `https://makerworld.com/en/models/${modelId}-different#profileId-19`;
    const second = await submit(secondUrl, 2, 'Private requester two notes');
    expect(second.json()).toMatchObject({ joined: true, request: { id } });
    expect(second.json().request.submissions).toHaveLength(1);
    expect(second.json().request.submissions[0].sourceUrl).toBe(secondUrl);
    expect(JSON.stringify(second.json())).not.toContain('Private requester one notes');
    const admin = await server.inject({ url: `/imports/${id}`, headers: headers(0) });
    expect(admin.json().request.submissions).toHaveLength(2);
    expect(admin.json().request.submissions.map((s: { notes: string }) => s.notes).sort())
      .toEqual(['Private requester one notes', 'Private requester two notes']);
  });

  it('serializes simultaneous submissions and repeated network retries', async () => {
    const url = `https://example.invalid/${prefix}/concurrent`;
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const responses = await Promise.all(keys.flatMap((key) => [
      submit(url, 1, 'Concurrent notes', key), submit(url, 1, 'Concurrent notes', key),
    ]));
    expect(responses.every((r) => [200, 201].includes(r.statusCode))).toBe(true);
    expect(new Set(responses.map((r) => r.json().request.id)).size).toBe(1);
    const id = responses[0].json().request.id;
    const admin = await server.inject({ url: `/imports/${id}`, headers: headers(0) });
    expect(admin.json().request.submissions).toHaveLength(3);
  });

  it('enforces operator transitions, revision checks, reasons, and retained history', async () => {
    const url = `https://example.invalid/${prefix}/transitions`;
    const item = (await submit(url)).json<{ request: ImportRequest }>().request;
    const act = (action: string, expectedRevision: number, note?: string, user = 0) =>
      server.inject({ method: 'PATCH', url: `/imports/${item.id}`, headers: headers(user),
        payload: { action, expectedRevision, ...(note === undefined ? {} : { note }) } });
    expect((await act('accept', 0, undefined, 1)).statusCode).toBe(403);
    const accepted = await act('accept', 0, 'I will acquire the files');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().request).toMatchObject({ status: 'awaiting_files', revision: 1 });
    expect((await act('accept', 0)).statusCode).toBe(409);
    expect((await act('decline', 1, '   ')).statusCode).toBe(400);
    const declined = await act('decline', 1, 'License does not permit this use');
    expect(declined.json().request.status).toBe('declined');
    expect(declined.json().request.history).toHaveLength(3);
    expect((await act('cancel', 2, 'Too late')).statusCode).toBe(409);
    const replacement = await submit(url, 2);
    expect(replacement.json().request.id).not.toBe(item.id);
  });

  it('finds legacy scalar and structured sources, preserving bigint IDs above JS precision', async () => {
    const url = `https://makerworld.com/fr/models/${modelId}7-legacy?from=search`;
    await pool.query(
      'INSERT INTO projects (id, relative_path, name, source_url) VALUES ($1,$2,$3,$4)',
      [projectId, `${prefix}/legacy`, 'Legacy holder', url],
    );
    const match = await check(`https://makerworld.com/en/models/${modelId}7-renamed#profileId-12`);
    expect(match.json().projects).toEqual([{ id: projectId, name: 'Legacy holder', available: false, storageKind: 'legacy' }]);
    const detail = await server.inject({ url: `/catalog/projects/${projectId}`, headers: headers() });
    expect(detail.statusCode).toBe(404);
    expect((await server.inject({ url: '/catalog/projects/9223372036854775808', headers: headers() })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PATCH', url: '/catalog/projects/9223372036854775808',
      headers: headers(0), payload: { notes: 'Overflow' } })).statusCode).toBe(400);
    const structuredUrl = `https://example.invalid/${prefix}/structured-source`;
    await pool.query(
      `INSERT INTO project_sources (project_id, source_key, source_url, canonical_url, provider, evidence)
       VALUES ($1,$2,$3,$3,'other','test fixture')`,
      [projectId, importSource(structuredUrl).key, structuredUrl],
    );
    expect((await check(structuredUrl)).json().projects[0].id).toBe(projectId);
    expect(typeof (await pool.query('SELECT id FROM projects WHERE id = $1', [projectId])).rows[0].id).toBe('string');
    const typed = await createDatabase(pool).query.projects.findFirst({
      where: (project, { eq }) => eq(project.id, projectId),
    });
    expect(typed?.id).toBe(projectId);
  });

  it('paginates the queue and rejects invalid page and action input', async () => {
    const result = await server.inject({ url: '/imports?page=1&pageSize=1', headers: headers(0) });
    expect(result.statusCode).toBe(200);
    expect(result.json<ImportPage>().items).toHaveLength(1);
    expect(result.json().total).toBeGreaterThan(1);
    expect((await server.inject({ url: '/imports?pageSize=51', headers: headers() })).statusCode).toBe(400);
    expect((await server.inject({ url: '/imports/not-an-id', headers: headers() })).statusCode).toBe(400);
  });
});
