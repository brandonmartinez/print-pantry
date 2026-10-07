import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, createPool, runMigrations } from '@print-pantry/db';
import { createLibraryIndexer } from '@print-pantry/indexer';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/print_pantry_test') {
  throw new Error('TEST_DATABASE_URL must target an isolated print_pantry_test database');
}

const pool = createPool(url);
const prefix = `requests-${randomUUID()}`;
const password = 'synthetic request test password';
const operatorName = `operator-${randomUUID().slice(0, 12)}`;
const requesterName = `requester-${randomUUID().slice(0, 12)}`;
const otherName = `requester-${randomUUID().slice(0, 12)}`;
const scanIds: string[] = [];
const requestIds: string[] = [];
let root: string;
let server: ReturnType<typeof buildServer>;
let indexer: ReturnType<typeof createLibraryIndexer>;
let projectId: string;
let otherProjectId: string;
let assetId: string;
let secondAssetId: string;
let versionId: string;
let operatorCookie: string;
let requesterCookie: string;
let otherCookie: string;

async function scan() {
  const result = await indexer.rescan();
  scanIds.push(result.id);
  return result;
}

async function login(username: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/auth/login',
    payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.headers['set-cookie']!.toString().split(';')[0];
}

async function submit(selected = [{ assetId, versionId }], overrides: Record<string, unknown> = {}) {
  const response = await server.inject({
    method: 'POST', url: '/requests', headers: { cookie: requesterCookie },
    payload: { projectId, selected, quantity: 2, material: 'PLA', color: 'blue', notes: 'For the shelf', ...overrides },
  });
  if (response.statusCode === 201) requestIds.push(response.json().request.id);
  return response;
}

async function queue() {
  const response = await server.inject({ url: '/requests/queue', headers: { cookie: operatorCookie } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function action(id: string, name: string, cookie = operatorCookie, extra: Record<string, unknown> = {}) {
  return server.inject({ method: 'PATCH', url: `/requests/${id}`, headers: { cookie },
    payload: { action: name, ...extra } });
}

beforeAll(async () => {
  await runMigrations(url);
  await runMigrations(url);
  root = await mkdtemp(path.join(tmpdir(), 'pp-requests-'));
  for (const project of ['Desk Lamp', 'Other']) {
    await mkdir(path.join(root, prefix, 'Gadgets', project, 'files'), { recursive: true });
  }
  for (const name of ['part 02.stl', 'part 10.stl']) {
    await writeFile(path.join(root, prefix, 'Gadgets', 'Desk Lamp', 'files', name),
      `solid ${name}\nendsolid ${name}`);
  }
  await writeFile(path.join(root, prefix, 'Gadgets', 'Other', 'files', 'other.stl'), 'solid other\nendsolid other');
  indexer = createLibraryIndexer({ db: createDatabase(pool), root });
  expect((await scan()).status).toBe('succeeded');
  const records = await pool.query<{ project_id: string; id: string; current_version_id: string;
    name: string; project_name: string }>(
    `SELECT a.project_id, a.id, a.current_version_id, a.name, p.name AS project_name
     FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.relative_path LIKE $1`,
    [`${prefix}/%`],
  );
  const part = records.rows.find((row) => row.name === 'part 02.stl')!;
  assetId = part.id;
  versionId = part.current_version_id;
  projectId = part.project_id;
  secondAssetId = records.rows.find((row) => row.name === 'part 10.stl')!.id;
  otherProjectId = records.rows.find((row) => row.project_name === 'Other')!.project_id;
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, username, password_hash, role) VALUES
     ($1,$2,$7,'operator'), ($3,$4,$7,'requester'), ($5,$6,$7,'requester')`,
    [randomUUID(), operatorName, randomUUID(), requesterName, randomUUID(), otherName, hash],
  );
  server = buildServer(pool, { pool, root, indexer, secureCookie: false });
  operatorCookie = await login(operatorName);
  requesterCookie = await login(requesterName);
  otherCookie = await login(otherName);
});

afterEach(async () => {
  if (!requestIds.length) return;
  await pool.query('UPDATE request_queue_state SET selected_next_id = NULL WHERE id = 1');
  await pool.query('DELETE FROM print_request_history WHERE request_id = ANY($1::uuid[])', [requestIds]);
  await pool.query('DELETE FROM print_request_files WHERE request_id = ANY($1::uuid[])', [requestIds]);
  await pool.query('DELETE FROM print_requests WHERE id = ANY($1::uuid[])', [requestIds]);
  requestIds.length = 0;
});

afterAll(async () => {
  try {
    if (server) await server.close();
    await pool.query(
      'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1::text[]))',
      [[operatorName, requesterName, otherName]],
    );
    await pool.query('DELETE FROM users WHERE username = ANY($1::text[])',
      [[operatorName, requesterName, otherName]]);
    const projects = await pool.query<{ id: string }>(
      'SELECT id FROM projects WHERE relative_path LIKE $1', [`${prefix}/%`]);
    const ids = projects.rows.map((row) => row.id);
    if (ids.length) {
      await pool.query('UPDATE assets SET current_version_id = NULL WHERE project_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE project_id = ANY($1::uuid[]))', [ids]);
      await pool.query('DELETE FROM assets WHERE project_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ids]);
    }
    const categories = await pool.query<{ id: string }>(
      'SELECT id FROM categories WHERE relative_path = $1 OR relative_path LIKE $2 ORDER BY length(relative_path) DESC',
      [prefix, `${prefix}/%`],
    );
    for (const category of categories.rows) await pool.query('DELETE FROM categories WHERE id = $1', [category.id]);
    if (scanIds.length) {
      await pool.query('DELETE FROM scan_errors WHERE run_id = ANY($1::uuid[])', [scanIds]);
      await pool.query('DELETE FROM scan_runs WHERE id = ANY($1::uuid[])', [scanIds]);
    }
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('request submission and ownership', () => {
  it('rejects missing auth, non-operator queue access, bad selections and invalid quantities', async () => {
    expect((await server.inject({ method: 'POST', url: '/requests',
      payload: { projectId, selected: [{ assetId, versionId }], quantity: 1 } })).statusCode).toBe(401);
    expect((await server.inject({ url: '/requests', headers: { cookie: otherCookie } })).json().items).toEqual([]);
    expect((await server.inject({ url: '/requests/queue', headers: { cookie: requesterCookie } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'PUT', url: '/requests/queue',
      headers: { cookie: requesterCookie }, payload: { orderedIds: [], expectedRevision: 0 } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/requests/queue/next',
      headers: { cookie: requesterCookie }, payload: { requestId: randomUUID(), expectedRevision: 0 } })).statusCode).toBe(403);
    for (const payload of [
      { selected: [] }, { selected: [{ assetId, versionId }, { assetId, versionId }] },
      { selected: [{ assetId: randomUUID(), versionId }] },
      { selected: [{ assetId, versionId: randomUUID() }] },
      { selected: [{ assetId, versionId }], projectId: otherProjectId },
      { quantity: 0 }, { quantity: 101 }, { quantity: 1.5 },
      { material: ' '.repeat(2) }, { notes: 'x'.repeat(2001) },
    ]) {
      const result = await submit([{ assetId, versionId }], payload);
      expect([400, 410]).toContain(result.statusCode);
    }
    expect((await submit()).statusCode).toBe(201);
    const secondVersion = await pool.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM assets WHERE id = $1', [secondAssetId],
    );
    const multiple = await submit([{ assetId, versionId },
      { assetId: secondAssetId, versionId: secondVersion.rows[0].current_version_id }]);
    expect(multiple.statusCode).toBe(201);
    expect(multiple.json().request.selected).toHaveLength(2);
  });

  it('returns immutable selected metadata and version-aware links, restricted to owner/operator', async () => {
    const response = await submit();
    expect(response.statusCode).toBe(201);
    const { request, revision } = response.json();
    expect(revision).toEqual(expect.any(Number));
    expect(request).toMatchObject({
      projectId, projectName: 'Desk Lamp', status: 'requested', quantity: 2,
      material: 'PLA', color: 'blue', notes: 'For the shelf', queuePosition: null,
      selected: [{ assetId, versionId, name: 'part 02.stl', relativePath: 'files/part 02.stl',
        available: true, unavailableReason: null,
        downloadUrl: `/api/catalog/assets/${assetId}/download?versionId=${versionId}` }],
      history: [{ action: 'submit', fromStatus: null, toStatus: 'requested',
        actor: { username: requesterName } }],
    });
    expect(request.createdAt).toEqual(expect.any(String));
    expect(request.history[0].createdAt).toEqual(expect.any(String));
    expect(JSON.stringify(request)).not.toContain(root);
    expect((await server.inject({ url: `/requests/${request.id}`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    expect((await server.inject({ url: `/requests/${request.id}`, headers: { cookie: operatorCookie } })).statusCode).toBe(200);
    expect((await server.inject({ url: '/requests', headers: { cookie: requesterCookie } })).json().items)
      .toMatchObject([{ id: request.id, selected: [{ versionId }] }]);
    expect((await server.inject({ url: '/requests', headers: { cookie: otherCookie } })).json().items).toEqual([]);
    expect((await action(request.id, 'cancel', otherCookie)).statusCode).toBe(404);
    expect((await action(request.id, 'approve', requesterCookie)).statusCode).toBe(403);
    expect((await action(request.id, 'cancel', operatorCookie)).statusCode).toBe(403);
  });

  it('serializes transitions, enforces selected-next and audits every status and order change', async () => {
    const first = (await submit()).json().request.id;
    const second = (await submit()).json().request.id;
    const third = (await submit()).json().request.id;
    expect((await action(first, 'approve', operatorCookie, { note: 'Approved' })).json().request.queuePosition).toBe(1);
    expect((await action(second, 'approve')).json().request.queuePosition).toBe(2);
    expect((await action(third, 'decline', operatorCookie, { note: 'Cannot print' })).json().request.status).toBe('declined');
    expect((await action(third, 'approve')).statusCode).toBe(409);
    expect((await action(first, 'start')).statusCode).toBe(409);
    const before = await queue();
    expect(before.items.map((item: { id: string }) => item.id)).toEqual([first, second]);
    expect((await server.inject({ method: 'PUT', url: '/requests/queue', headers: { cookie: operatorCookie },
      payload: { orderedIds: [first], expectedRevision: before.revision } })).statusCode).toBe(409);
    const ordered = await server.inject({ method: 'PUT', url: '/requests/queue', headers: { cookie: operatorCookie },
      payload: { orderedIds: [second, first], expectedRevision: before.revision } });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().items.map((item: { id: string; queuePosition: number }) =>
      [item.id, item.queuePosition])).toEqual([[second, 1], [first, 2]]);
    expect((await server.inject({ method: 'PUT', url: '/requests/queue', headers: { cookie: operatorCookie },
      payload: { orderedIds: [second, first], expectedRevision: before.revision } })).json())
      .toMatchObject({ error: expect.stringContaining('refresh'), currentRevision: ordered.json().revision });
    const next = await server.inject({ method: 'POST', url: '/requests/queue/next',
      headers: { cookie: operatorCookie }, payload: { requestId: second, expectedRevision: ordered.json().revision } });
    expect(next.statusCode).toBe(200);
    expect(next.json().selectedNextId).toBe(second);
    expect((await action(first, 'start')).statusCode).toBe(409);
    expect((await action(second, 'start', operatorCookie, { expectedRevision: next.json().revision,
      note: 'Printing' })).json().request.status).toBe('printing');
    expect((await queue()).selectedNextId).toBeNull();
    expect((await queue()).items[0].queuePosition).toBe(1);
    expect((await action(second, 'complete', operatorCookie, { note: 'Done' })).json().request.status).toBe('completed');
    expect((await action(second, 'complete')).statusCode).toBe(409);
    expect((await action(first, 'cancel', requesterCookie)).json().request.status).toBe('canceled');
    expect((await queue()).items).toEqual([]);
    const detail = (await server.inject({ url: `/requests/${second}`, headers: { cookie: requesterCookie } })).json().request;
    expect(detail.history.map((event: { action: string }) => event.action))
      .toEqual(['submit', 'approve', 'reorder', 'select_next', 'select_next', 'start', 'complete']);
    expect(detail.history.at(-1)).toMatchObject({ actor: { username: operatorName }, note: 'Done' });
    const canceled = (await submit()).json().request.id;
    expect((await action(canceled, 'cancel', requesterCookie)).json().request.status).toBe('canceled');
    expect((await action(canceled, 'approve')).statusCode).toBe(409);
    const selectedCancel = (await submit()).json().request.id;
    expect((await action(selectedCancel, 'approve')).statusCode).toBe(200);
    const selection = await server.inject({ method: 'POST', url: '/requests/queue/next',
      headers: { cookie: operatorCookie },
      payload: { requestId: selectedCancel, expectedRevision: (await queue()).revision } });
    expect(selection.statusCode).toBe(200);
    expect((await action(selectedCancel, 'cancel', requesterCookie)).statusCode).toBe(200);
    expect((await queue()).selectedNextId).toBeNull();
  });

  it('allows only one competing revision-guarded approval and one racing queue mutation', async () => {
    const first = (await submit()).json().request.id;
    const second = (await submit()).json().request.id;
    const revision = (await queue()).revision;
    const approvals = await Promise.all([
      action(first, 'approve', operatorCookie, { expectedRevision: revision }),
      action(second, 'approve', operatorCookie, { expectedRevision: revision }),
    ]);
    expect(approvals.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const loser = approvals[0].statusCode === 409 ? first : second;
    expect((await action(loser, 'approve')).statusCode).toBe(200);
    const state = await queue();
    expect(state.items.map((item: { queuePosition: number }) => item.queuePosition)).toEqual([1, 2]);
    const selected = await server.inject({ method: 'POST', url: '/requests/queue/next',
      headers: { cookie: operatorCookie },
      payload: { requestId: state.items[0].id, expectedRevision: state.revision } });
    expect(selected.statusCode).toBe(200);
    const raceRevision = selected.json().revision;
    const contenders = await Promise.all([
      action(state.items[0].id, 'start', operatorCookie, { expectedRevision: raceRevision }),
      server.inject({ method: 'PUT', url: '/requests/queue', headers: { cookie: operatorCookie },
        payload: { orderedIds: state.items.map((item: { id: string }) => item.id).reverse(),
          expectedRevision: raceRevision } }),
    ]);
    expect(contenders.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const after = await queue();
    expect(after.items.map((item: { queuePosition: number }) => item.queuePosition))
      .toEqual(after.items.map((_: unknown, index: number) => index + 1));
    const history = await pool.query<{ action: string }>(
      'SELECT action FROM print_request_history WHERE request_id = $1', [state.items[0].id]);
    expect(history.rows.filter((event) => event.action === 'start')).toHaveLength(contenders[0].statusCode === 200 ? 1 : 0);
    const concurrent = await Promise.all([
      submit(), submit(),
    ]);
    const creations = concurrent.map((item) => item.json().request.id);
    const appended = await Promise.all(creations.map((id) => action(id, 'approve')));
    expect(appended.every((item) => item.statusCode === 200)).toBe(true);
    const positions = (await queue()).items.map((item: { queuePosition: number }) => item.queuePosition);
    expect(positions).toEqual(positions.map((_: number, index: number) => index + 1));
  });

  it('keeps snapshots and history through rename, replacement, missing file and offline scans', async () => {
    const response = await submit([{ assetId, versionId }]);
    expect(response.statusCode).toBe(201);
    const requestId = response.json().request.id;
    const original = path.join(root, prefix, 'Gadgets', 'Desk Lamp', 'files', 'part 02.stl');
    const renamed = path.join(root, prefix, 'Gadgets', 'Desk Lamp', 'files', 'renamed part.stl');
    await rename(original, renamed);
    expect((await scan()).status).toBe('succeeded');
    let detail = (await server.inject({ url: `/requests/${requestId}`, headers: { cookie: requesterCookie } })).json().request;
    expect(detail.selected[0]).toMatchObject({ assetId, versionId, name: 'part 02.stl',
      relativePath: 'files/part 02.stl', available: true });
    await writeFile(renamed, 'solid changed\nendsolid changed');
    expect((await scan()).status).toBe('succeeded');
    detail = (await server.inject({ url: `/requests/${requestId}`, headers: { cookie: requesterCookie } })).json().request;
    expect(detail.selected[0]).toMatchObject({ name: 'part 02.stl', versionId,
      available: false, unavailableReason: 'version_not_current', downloadUrl: null });
    await unlink(renamed);
    expect((await scan()).status).toBe('succeeded');
    detail = (await server.inject({ url: `/requests/${requestId}`, headers: { cookie: requesterCookie } })).json().request;
    expect(detail.selected[0]).toMatchObject({ versionId, available: false,
      unavailableReason: expect.stringMatching(/missing/), downloadUrl: null });
    const secondVersion = await pool.query<{ current_version_id: string }>(
      'SELECT current_version_id FROM assets WHERE id = $1', [secondAssetId],
    );
    const healthyRequest = await submit([{ assetId: secondAssetId,
      versionId: secondVersion.rows[0].current_version_id }]);
    expect(healthyRequest.statusCode).toBe(201);
    const offlineRoot = `${root}-offline`;
    await rename(root, offlineRoot);
    try {
      expect((await scan()).status).toBe('offline');
      expect((await server.inject({ url: `/requests/${requestId}`, headers: { cookie: requesterCookie } })).json().request)
        .toMatchObject({ selected: [{ name: 'part 02.stl', versionId }], history: [{ action: 'submit' }] });
      const offline = (await server.inject({ url: `/requests/${healthyRequest.json().request.id}`,
        headers: { cookie: requesterCookie } })).json().request;
      expect(offline.selected[0]).toMatchObject({
        available: false, unavailableReason: 'library_offline', downloadUrl: null,
      });
      expect((await submit()).statusCode).toBe(503);
    } finally {
      await rename(offlineRoot, root);
    }
  });
});
