import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDatabase, createPool, runMigrations } from '@print-pantry/db';
import { createLibraryIndexer, ScanInProgressError } from '@print-pantry/indexer';
import type { LibraryAdoptionRun } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { createLibraryAdoptionRunner, createLibraryAdoptionService } from './library-adoption.js';
import * as storage from './import-storage.js';
import { runLibraryCli } from './library-cli.js';

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
const pool = createPool(database);
const users = ['operator', 'requester'].map((role) => ({ id: randomUUID(), name: `adopt-${randomUUID().slice(0, 8)}`, role }));
let root: string;
let managedRoot: string;
let server: ReturnType<typeof buildServer>;
let service: ReturnType<typeof createLibraryAdoptionService>;
let runner: ReturnType<typeof createLibraryAdoptionRunner>;
let cookie: string;
let requesterCookie: string;
let ids: string[] = [];
const indexer = { getStatus: () => ({ running: false, lastScan: null }), rescan: async () => { throw new Error('Tests do not scan real libraries'); } };
const headers = () => ({ cookie });

beforeAll(async () => {
  await runMigrations(database);
  const hash = await hashPassword('Synthetic adoption passphrase');
  for (const user of users) await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)', [user.id, user.name, hash, user.role]);
});
beforeEach(async () => {
  ids = [];
  root = await mkdtemp(join(tmpdir(), 'pantry-adoption-source-'));
  managedRoot = await mkdtemp(join(tmpdir(), 'pantry-adoption-target-'));
  const options = { pool, root, managedRoot, indexer, secureCookie: false };
  server = buildServer(pool, options);
  service = createLibraryAdoptionService(pool, options);
  runner = createLibraryAdoptionRunner(pool, options, server.log);
  for (const [i, user] of users.entries()) {
    const response = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: user.name, password: 'Synthetic adoption passphrase' } });
    expect(response.statusCode).toBe(200);
    const value = response.headers['set-cookie']!.toString().split(';')[0];
    if (i === 0) cookie = value; else requesterCookie = value;
  }
});
afterEach(async () => {
  await runner?.stop();
  await server?.close();
  await pool.query('DELETE FROM library_adoption_items WHERE run_id IN (SELECT id FROM library_adoption_runs WHERE created_by=$1)', [users[0].id]);
  await pool.query('DELETE FROM library_adoption_runs WHERE created_by=$1', [users[0].id]);
  await pool.query('DELETE FROM library_migration_projects WHERE migration_id IN (SELECT id FROM library_migrations WHERE created_by=$1)', [users[0].id]);
  await pool.query('DELETE FROM library_migrations WHERE created_by=$1', [users[0].id]);
  await pool.query('DELETE FROM library_reorganization_plans WHERE created_by=$1', [users[0].id]);
  await pool.query('UPDATE assets SET current_version_id=NULL WHERE project_id=ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE project_id=ANY($1::bigint[]))', [ids]);
  await pool.query('DELETE FROM assets WHERE project_id=ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM projects WHERE id=ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users.map((user) => user.id)]);
  if (root) await rm(root, { recursive: true, force: true });
  if (managedRoot) await rm(managedRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.map((user) => user.id)]);
  await pool.end();
});
async function project(id?: string) {
  const path = `Original/${randomUUID()}`;
  const row = (await pool.query<{ id: string }>(`INSERT INTO projects(id,name,relative_path,notes,tags)
    VALUES(coalesce($1::bigint,nextval('project_id_seq')),'Synthetic holder',$2,'Keep notes',ARRAY['keep']) RETURNING id`, [id ?? null, path])).rows[0];
  ids.push(row.id);
  await mkdir(join(root, path), { recursive: true });
  return { id: row.id, path, ...await addFile({ id: row.id, path }, 'part.stl') };
}
async function addFile(owner: { id: string; path: string }, filename: string) {
  const bytes = Buffer.from('Synthetic model bytes');
  const absolute = join(root, owner.path, filename);
  await writeFile(absolute, bytes);
  await utimes(absolute, 1700000000, 1700000000);
  const stat = await lstat(absolute);
  const assetId = randomUUID(); const versionId = randomUUID();
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO assets(id,project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms,inode,device,content_hash)
    VALUES($1,$2,$3,$9,$9,'mesh','.stl',$4,$5,$6,$7,$8)`, [assetId, owner.id, `${owner.path}/${filename}`, bytes.length, Math.trunc(stat.mtimeMs), stat.ino, stat.dev, hash, filename]);
  await pool.query('INSERT INTO asset_versions(id,asset_id,content_hash,size_bytes,mtime_ms) VALUES($1,$2,$3,$4,$5)', [versionId, assetId, hash, bytes.length, Math.trunc(stat.mtimeMs)]);
  await pool.query('UPDATE assets SET current_version_id=$2 WHERE id=$1', [assetId, versionId]);
  return { assetId, versionId, bytes, absolute };
}
async function create() {
  const response = await server.inject({ method: 'POST', url: '/library/adoptions', headers: headers(), payload: { requestKey: randomUUID() } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<LibraryAdoptionRun>();
}
async function drain(id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await service.get(id);
    if (!['planning', 'copying', 'activating', 'restoring', 'canceling'].includes(run.state)) return run;
    await runner.tick();
  }
  throw new Error('Synthetic adoption did not settle within 200 project operations');
}
async function command(id: string, action: 'approve_copy' | 'activate' | 'pause' | 'resume' | 'cancel' | 'restore', flags = {}) {
  const run = await service.get(id);
  return service.command(id, { action, expectedRevision: run.revision, expectedFingerprint: run.fingerprint,
    confirmRetainedCopies: true, acknowledgeWarnings: true, confirmActivation: true, confirmCancellation: true, confirmRestoration: true, ...flags }, users[0].id);
}

it('requires operator access on all routes and refuses copying/activation without separate approvals', async () => {
  await project();
  const run = await create();
  for (const [method, url, payload] of [
    ['GET', '/library/adoptions', undefined],
    ['POST', '/library/adoptions', { requestKey: randomUUID() }],
    ['GET', `/library/adoptions/${run.id}`, undefined],
    ['GET', `/library/adoptions/${run.id}/items`, undefined],
    ['POST', `/library/adoptions/${run.id}/commands`, { action: 'pause', expectedRevision: 0 }],
  ] as const) {
    expect((await server.inject({ method, url, payload })).statusCode).toBe(401);
    expect((await server.inject({ method, url, payload, headers: { cookie: requesterCookie } })).statusCode).toBe(403);
  }
  const reviewed = await drain(run.id);
  expect(reviewed.state).toBe('review');
  await expect(command(run.id, 'approve_copy', { confirmRetainedCopies: false })).rejects.toThrow('acknowledge');
  await expect(command(run.id, 'activate')).rejects.toThrow('approve batch activation');
  await expect(service.command(run.id, { action: 'pause', expectedRevision: 0 }, users[0].id)).rejects.toThrow('changed');
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [ids[0]])).rows[0].storage_kind).toBe('legacy');
});

it('keeps legacy projects migration-only and serves activated copies without any legacy configuration', async () => {
  const owner = await project();
  const paths = [`/catalog/projects/${owner.id}`, `/catalog/projects/${owner.id}/preview`,
    ...['download', 'preview', 'geometry'].map((action) => `/catalog/assets/${owner.assetId}/${action}`)];
  for (const url of paths) expect((await server.inject({ url, headers: headers() })).statusCode).toBe(404);
  const listing = (await server.inject({ url: '/catalog/projects?q=Synthetic', headers: headers() })).json();
  expect(listing.items.some((item: { id: string }) => item.id === owner.id)).toBe(false);
  expect((await server.inject({ method: 'PATCH', url: `/catalog/projects/${owner.id}`, headers: headers(), payload: { notes: 'Must not edit through ordinary catalog' } })).statusCode).toBe(404);
  const rejected = await server.inject({ method: 'POST', url: '/requests', headers: { cookie: requesterCookie },
    payload: { projectId: owner.id, selected: [{ assetId: owner.assetId, versionId: owner.versionId }], quantity: 1 } });
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json().error).toContain('migrated');
  const inventory = (await server.inject({ url: '/library/management', headers: headers() })).json();
  expect(inventory.items.some((item: { id: string }) => item.id === owner.id)).toBe(true);
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy'); await drain(run.id);
  expect((await server.inject({ url: paths[0], headers: headers() })).statusCode).toBe(404);
  await command(run.id, 'activate'); await drain(run.id);
  const rescan = vi.fn(async () => { throw new Error('No legacy indexing should be attempted'); });
  const managedOnly = buildServer(pool, { pool, managedRoot, secureCookie: false, indexer: { ...indexer, rescan } });
  try {
    expect((await managedOnly.inject({ url: paths[0], headers: headers() })).json().project.storageKind).toBe('managed');
    const downloaded = await managedOnly.inject({ url: paths[2], headers: { cookie: requesterCookie } });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(owner.bytes);
    expect((await managedOnly.inject({ url: '/library/legacy-scan', headers: headers() })).json().configured).toBe(false);
    expect((await managedOnly.inject({ method: 'POST', url: '/library/legacy-scan', headers: headers() })).statusCode).toBe(503);
    expect((await managedOnly.inject({ url: '/library/legacy-scan', headers: { cookie: requesterCookie } })).statusCode).toBe(403);
    expect(rescan).not.toHaveBeenCalled();
    await command(run.id, 'restore'); await drain(run.id);
    expect((await managedOnly.inject({ url: paths[0], headers: headers() })).statusCode).toBe(404);
    expect((await managedOnly.inject({ url: paths[2], headers: headers() })).statusCode).toBe(404);
  } finally { await managedOnly.close(); }
});

it('reports asynchronous legacy indexing failures instead of returning an old successful scan state', async () => {
  const rescan = vi.fn(async () => { throw new ScanInProgressError(); });
  const configured = buildServer(pool, { pool, root, managedRoot, secureCookie: false, indexer: { ...indexer, rescan } });
  try {
    expect(rescan).not.toHaveBeenCalled();
    expect((await configured.inject({ method: 'POST', url: '/library/legacy-scan', headers: headers() })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const result = (await configured.inject({ url: '/library/legacy-scan', headers: headers() })).json();
      expect(result.scan.state).toBe('failed');
      expect(result.scan.lastError).toBeTruthy();
    });
    expect(rescan).toHaveBeenCalledTimes(1);
  } finally { await configured.close(); }
});

it('plans over 25 projects, paginates exact bigint IDs, and freezes membership without copying files', async () => {
  for (let i = 0; i < 51; i++) await project();
  const big = await project(String(9007199254740993n + BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`)));
  const run = await create();
  await project();
  const planned = await drain(run.id);
  expect(planned.total).toBe(52);
  expect(planned.counts.ready).toBe(52);
  expect(planned.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const first = await service.items(run.id);
  expect(first.items).toHaveLength(50);
  const second = await service.items(run.id, first.nextCursor!);
  expect(second.items).toHaveLength(2);
  expect(second.items.some((item) => item.projectId === big.id)).toBe(true);
  expect(second.nextCursor).toBeNull();
  expect((await pool.query("SELECT count(*)::int AS count FROM projects WHERE id=ANY($1::bigint[]) AND storage_kind='managed'", [ids])).rows[0].count).toBe(0);
  const duplicate = await server.inject({ method: 'POST', url: '/library/adoptions', headers: headers(), payload: { requestKey: run.id } });
  expect(duplicate.json().id).toBe(run.id);
  expect((await server.inject({ method: 'POST', url: '/library/adoptions', headers: headers(), payload: { requestKey: randomUUID() } })).statusCode).toBe(409);
});

it('copies eligible projects, reports blockers, waits for batch activation, then restores stable identities', async () => {
  const good = await project(); const blocked = await project();
  await writeFile(join(root, blocked.path, 'unindexed.txt'), 'Do not silently omit this file');
  const run = await create();
  expect((await drain(run.id)).counts).toMatchObject({ ready: 1, blocked: 1 });
  const blockedItems = await service.items(run.id, '0', 'blocked');
  expect(blockedItems.items[0].issues.some((issue) => issue.code === 'unindexed_file')).toBe(true);
  await command(run.id, 'approve_copy');
  const copied = await drain(run.id);
  expect(copied.state).toBe('awaiting_activation');
  expect(copied.counts).toMatchObject({ copied: 1, blocked: 1, activated: 0 });
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [good.id])).rows[0].storage_kind).toBe('legacy');
  const restarted = createLibraryAdoptionRunner(pool, { pool, root, managedRoot, indexer }, server.log);
  await restarted.tick();
  expect((await service.get(run.id)).counts.activated).toBe(0);
  await command(run.id, 'activate');
  expect((await drain(run.id)).state).toBe('partial');
  const asset = (await pool.query('SELECT current_version_id,storage_kind FROM assets WHERE id=$1', [good.assetId])).rows[0];
  expect(asset).toMatchObject({ current_version_id: good.versionId, storage_kind: 'managed' });
  expect(await readFile(good.absolute)).toEqual(good.bytes);
  await command(run.id, 'restore');
  const restored = await drain(run.id);
  expect(restored.counts).toMatchObject({ restored: 1, blocked: 1 });
  expect((await pool.query('SELECT storage_kind,notes,tags FROM projects WHERE id=$1', [good.id])).rows[0]).toEqual({ storage_kind: 'legacy', notes: 'Keep notes', tags: ['keep'] });
});

it('continues unrelated projects after a per-project source change without approving changed evidence', async () => {
  const changed = await project(); await project();
  const run = await create();
  await drain(run.id);
  await writeFile(changed.absolute, 'Changed after approval snapshot');
  await command(run.id, 'approve_copy');
  const result = await drain(run.id);
  expect(result.state).toBe('awaiting_activation');
  expect(result.counts).toMatchObject({ failed: 1, copied: 1 });
  expect((await service.items(run.id, '0', 'failed')).items[0].lastError).toContain('changed');
});

it('pauses on storage failure and resumes after restart without automatically activating verified copies', async () => {
  const owner = await project();
  const run = await create();
  await drain(run.id);
  await command(run.id, 'approve_copy');
  const failure = vi.spyOn(storage, 'storeStream').mockRejectedValueOnce(Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }));
  try { await runner.tick(); } finally { failure.mockRestore(); }
  const paused = await service.get(run.id);
  expect(paused).toMatchObject({ state: 'paused', resumeState: 'copying', lastError: 'Synthetic disk full' });
  expect(await readFile(owner.absolute)).toEqual(owner.bytes);
  await command(run.id, 'resume');
  runner = createLibraryAdoptionRunner(pool, { pool, root, managedRoot, indexer }, server.log);
  const copied = await drain(run.id);
  expect(copied.state).toBe('awaiting_activation');
  expect(copied.counts.copied).toBe(1);
  await command(run.id, 'activate');
  expect((await drain(run.id)).state).toBe('completed');
});

it('honors a pause during copying after finishing only the in-flight project', async () => {
  await project(); await project();
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy');
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const original = storage.storeStream;
  const delayed = vi.spyOn(storage, 'storeStream').mockImplementationOnce(async (...args) => { entered(); await released; return original(...args); });
  const copying = runner.tick();
  try {
    await waiting;
    const competing = createLibraryAdoptionRunner(pool, { pool, root, managedRoot, indexer }, server.log);
    await competing.tick();
    expect((await service.get(run.id)).counts.copied).toBe(0);
    await command(run.id, 'pause');
  }
  finally { release(); await copying; delayed.mockRestore(); }
  expect((await service.get(run.id))).toMatchObject({ state: 'paused', counts: { copied: 1, ready: 1 } });
  await runner.tick();
  expect((await service.get(run.id)).counts.copied).toBe(1);
  await command(run.id, 'resume');
  expect((await drain(run.id)).counts.copied).toBe(2);
});

it('cancels unactivated work while retaining activated projects and stops rescans invalidating reviewed evidence', async () => {
  const owner = await project();
  const run = await create(); await drain(run.id);
  const real = createLibraryIndexer({ db: createDatabase(pool), root });
  await expect(real.rescan()).rejects.toBeInstanceOf(ScanInProgressError);
  await command(run.id, 'approve_copy'); await drain(run.id);
  await command(run.id, 'cancel');
  const canceled = await drain(run.id);
  expect(canceled.state).toBe('canceled');
  expect(canceled.counts.canceled).toBe(1);
  expect(await readFile(owner.absolute)).toEqual(owner.bytes);
  expect((await pool.query('SELECT status FROM library_migration_projects WHERE project_id=$1', [owner.id])).rows[0].status).toBe('canceled');
});

it('pauses rather than processing a different or unavailable approved storage mount', async () => {
  await project();
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy');
  const original = `${managedRoot}-saved`;
  await rename(managedRoot, original);
  try {
    await runner.tick();
    expect((await service.get(run.id)).state).toBe('paused');
  } finally { await rename(original, managedRoot); }
  await command(run.id, 'resume');
  expect((await drain(run.id)).state).toBe('awaiting_activation');
});

it('handles more than 1,000 total library files in independently bounded project plans', async () => {
  const a = await project(); const b = await project();
  for (let i = 0; i < 500; i++) {
    await addFile(a, `part_${i}.stl`);
    await addFile(b, `part_${i}.stl`);
  }
  const run = await create();
  const planned = await drain(run.id);
  expect(planned.counts).toMatchObject({ ready: 2, blocked: 0 });
  expect((await service.items(run.id)).items.reduce((total, item) => total + item.fileCount, 0)).toBe(1002);
}, 60000);

it('keeps activated projects managed when remaining batch activation is canceled, then permits bulk restoration', async () => {
  await project(); await project();
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy'); await drain(run.id);
  await command(run.id, 'activate'); await runner.tick();
  expect((await service.get(run.id)).counts).toMatchObject({ activated: 1, copied: 1 });
  await command(run.id, 'cancel');
  const canceled = await drain(run.id);
  expect(canceled.state).toBe('canceled');
  expect(canceled.counts).toMatchObject({ activated: 1, canceled: 1 });
  await command(run.id, 'restore');
  expect((await drain(run.id)).counts).toMatchObject({ restored: 1, canceled: 1 });
});

it('reports a failed cancellation once instead of repeatedly retrying a damaged final copy', async () => {
  await project();
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy'); await drain(run.id);
  const item = (await service.items(run.id)).items[0];
  const journal = (await pool.query<{ id: string; managed_path: string }>('SELECT id,managed_path FROM library_migration_projects WHERE migration_id=$1', [item.migrationId])).rows[0];
  await rename(join(managedRoot, `projects/.migration-${journal.id}`), join(managedRoot, journal.managed_path));
  await writeFile(join(managedRoot, journal.managed_path, 'part.stl'), 'Damaged managed copy');
  await command(run.id, 'cancel');
  const result = await drain(run.id);
  expect(result.state).toBe('partial');
  expect(result.counts.failed).toBe(1);
  expect((await service.items(run.id)).items[0].lastError).toContain('hash');
});

it('streams a managed directory larger than the manual preview limit without truncating destination checks', async () => {
  await project();
  await mkdir(join(managedRoot, 'projects'));
  for (let i = 0; i < 2001; i++) await mkdir(join(managedRoot, 'projects', `unrelated_${i}`));
  const run = await create();
  expect((await drain(run.id)).counts).toMatchObject({ ready: 1, blocked: 0 });
  await command(run.id, 'approve_copy');
  expect((await drain(run.id)).counts.copied).toBe(1);
}, 30000);

it('runs the authenticated utility through the same API for planning, copying, separate activation and restoration', async () => {
  const owner = await project();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new Error('Unexpected utility HTTP method');
    const response = await server.inject({ method, url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: init?.body ? String(init.body) : undefined });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    }
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers });
  };
  const out = vi.fn(); const err = vi.fn();
  const io = { fetch: fetcher, password: async () => 'Synthetic adoption passphrase', sleep: () => runner.tick(10), out, err };
  const args = ['--username', users[0].name, '--password-stdin', '--json', '--wait'];
  expect(await runLibraryCli(['plan', ...args], io)).toBe(0);
  const planned: LibraryAdoptionRun = JSON.parse(out.mock.calls.at(-1)![0]);
  expect(planned.state).toBe('review');
  expect(await runLibraryCli(['copy', planned.id, ...args, '--fingerprint', planned.fingerprint, '--confirm-retained-copies', '--acknowledge-warnings'], io)).toBe(0);
  expect(JSON.parse(out.mock.calls.at(-1)![0]).state).toBe('awaiting_activation');
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [owner.id])).rows[0].storage_kind).toBe('legacy');
  expect(await runLibraryCli(['activate', planned.id, ...args, '--fingerprint', planned.fingerprint, '--confirm-activation'], io)).toBe(0);
  expect(JSON.parse(out.mock.calls.at(-1)![0]).state).toBe('completed');
  expect(await runLibraryCli(['restore', planned.id, ...args, '--confirm-restoration'], io)).toBe(0);
  expect(JSON.parse(out.mock.calls.at(-1)![0]).state).toBe('restored');
  expect(err).not.toHaveBeenCalled();
});

it('surfaces changed server root configuration as a paused run rather than silently leaving work running', async () => {
  await project();
  const run = await create(); await drain(run.id);
  await command(run.id, 'approve_copy');
  const otherRoot = await mkdtemp(join(tmpdir(), 'pantry-adoption-wrong-config-'));
  try {
    const reconfigured = createLibraryAdoptionRunner(pool, { pool, root, managedRoot: otherRoot, indexer }, server.log);
    await reconfigured.tick();
    const result = await service.get(run.id);
    expect(result.state).toBe('paused');
    expect(result.lastError).toContain('Storage configuration');
    expect(result.counts.copied).toBe(0);
  } finally { await rm(otherRoot, { recursive: true, force: true }); }
});

it('does not reuse an old activation approval for copies verified by a later retry', async () => {
  const a = await project(); const b = await project(); const c = await project();
  const run = await create(); await drain(run.id);
  const original = await lstat(c.absolute);
  await writeFile(c.absolute, 'Changed source');
  await command(run.id, 'approve_copy'); await drain(run.id);
  const bItem = (await service.items(run.id)).items.find((item) => item.projectId === b.id)!;
  const bJournal = (await pool.query<{ id: string }>('SELECT id FROM library_migration_projects WHERE migration_id=$1', [bItem.migrationId])).rows[0];
  const staged = join(managedRoot, `projects/.migration-${bJournal.id}`, 'part.stl');
  await writeFile(staged, 'Tampered staged model');
  await command(run.id, 'activate');
  expect((await drain(run.id)).counts).toMatchObject({ activated: 1, failed: 2 });
  await writeFile(c.absolute, c.bytes); await utimes(c.absolute, original.atime, original.mtime);
  await writeFile(staged, b.bytes);
  let current = await service.get(run.id);
  await service.command(run.id, { action: 'retry', stage: 'copy', expectedRevision: current.revision }, users[0].id);
  expect((await drain(run.id)).state).toBe('awaiting_activation');
  current = await service.get(run.id);
  await service.command(run.id, { action: 'retry', stage: 'activate', expectedRevision: current.revision }, users[0].id);
  const afterRetry = await drain(run.id);
  expect(afterRetry.state).toBe('awaiting_activation');
  expect(afterRetry.counts).toMatchObject({ activated: 2, copied: 1 });
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [c.id])).rows[0].storage_kind).toBe('legacy');
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [a.id])).rows[0].storage_kind).toBe('managed');
  await command(run.id, 'activate');
  expect((await drain(run.id)).state).toBe('completed');
});

it('does not reuse a restoration approval for projects activated after that approval', async () => {
  const a = await project(); const b = await project();
  const original = await lstat(b.absolute);
  const run = await create(); await drain(run.id);
  await writeFile(b.absolute, 'Changed source');
  await command(run.id, 'approve_copy'); await drain(run.id);
  await command(run.id, 'activate'); await drain(run.id);
  const aItem = (await service.items(run.id)).items.find((item) => item.projectId === a.id)!;
  const journal = (await pool.query<{ managed_path: string }>('SELECT managed_path FROM library_migration_projects WHERE migration_id=$1', [aItem.migrationId])).rows[0];
  const managed = join(managedRoot, journal.managed_path, 'part.stl');
  await writeFile(managed, 'Tampered managed model');
  await command(run.id, 'restore');
  expect((await drain(run.id)).counts.failed).toBe(2);
  await writeFile(managed, a.bytes);
  await writeFile(b.absolute, b.bytes); await utimes(b.absolute, original.atime, original.mtime);
  let current = await service.get(run.id);
  await service.command(run.id, { action: 'retry', stage: 'copy', expectedRevision: current.revision }, users[0].id);
  await drain(run.id); await command(run.id, 'activate'); await drain(run.id);
  current = await service.get(run.id);
  await service.command(run.id, { action: 'retry', stage: 'restore', expectedRevision: current.revision }, users[0].id);
  const afterRetry = await drain(run.id);
  expect(afterRetry.state).toBe('partial');
  expect(afterRetry.counts).toMatchObject({ restored: 1, activated: 1 });
  expect((await pool.query('SELECT storage_kind FROM projects WHERE id=$1', [b.id])).rows[0].storage_kind).toBe('managed');
  await command(run.id, 'restore');
  expect((await drain(run.id)).state).toBe('restored');
});
