import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, lstat, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, createPool, libraryMutationLock, runMigrations } from '@print-pantry/db';
import { createLibraryIndexer, ScanInProgressError } from '@print-pantry/indexer';
import type { LibraryManagementResponse, LibraryMigrationJob, LibraryReorganizationPlan } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { projectSlug } from './import-storage.js';
import * as importStorage from './import-storage.js';

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
const pool = createPool(database);
const prefix = `library-test-${randomUUID().slice(0, 8)}`;
const users = ['operator', 'requester'].map((role) => ({ id: randomUUID(), name: `${prefix}-${role}`, role }));
const projectIds: string[] = [];
const categoryIds: string[] = [];
const extraRoots: string[] = [];
const scanIds: string[] = [];
let root: string;
let managedRoot: string;
let server: ReturnType<typeof buildServer>;
let cookies: string[];
let scanning = false;
const indexer = {
  getStatus: () => ({ running: scanning, lastScan: null }),
  rescan: async () => { throw new Error('Dry run tests never scan a library'); },
};
const headers = (operator = true) => ({ cookie: cookies[operator ? 0 : 1] });
async function historicalRequest(app: ReturnType<typeof buildServer>, projectId: string, assetId: string, versionId: string) {
  await pool.query("UPDATE projects SET storage_kind='managed' WHERE id=$1", [projectId]);
  await pool.query("UPDATE assets SET storage_kind='managed' WHERE project_id=$1", [projectId]);
  try {
    return await app.inject({ method: 'POST', url: '/requests', headers: headers(false), payload: {
      projectId, selected: [{ assetId, versionId }], quantity: 1,
    } });
  } finally {
    await pool.query("UPDATE projects SET storage_kind='legacy' WHERE id=$1", [projectId]);
    await pool.query("UPDATE assets SET storage_kind='legacy' WHERE project_id=$1", [projectId]);
  }
}
const base = '/library/reorganization-plans';

beforeAll(async () => {
  await runMigrations(database);
  root = await mkdtemp(join(tmpdir(), 'pantry-library-preview-'));
  managedRoot = await mkdtemp(join(tmpdir(), 'pantry-library-destination-'));
  const hash = await hashPassword('synthetic library passphrase');
  for (const user of users) await pool.query('INSERT INTO users (id,username,password_hash,role) VALUES ($1,$2,$3,$4)', [user.id, user.name, hash, user.role]);
  server = buildServer(pool, { pool, root, managedRoot, indexer, secureCookie: false });
  cookies = [];
  for (const user of users) {
    const result = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: user.name, password: 'synthetic library passphrase' } });
    expect(result.statusCode).toBe(200);
    cookies.push(result.headers['set-cookie']!.toString().split(';')[0]);
  }
});
afterAll(async () => {
  try {
    await server?.close();
    await pool.query('DELETE FROM library_migration_projects WHERE migration_id IN (SELECT id FROM library_migrations WHERE created_by=ANY($1::uuid[]))', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM library_migrations WHERE created_by=ANY($1::uuid[])', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM library_reorganization_plans WHERE created_by=ANY($1::uuid[])', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM print_request_history WHERE request_id IN (SELECT id FROM print_requests WHERE project_id=ANY($1::bigint[]))', [projectIds]);
    await pool.query('DELETE FROM print_request_files WHERE request_id IN (SELECT id FROM print_requests WHERE project_id=ANY($1::bigint[]))', [projectIds]);
    await pool.query('DELETE FROM print_requests WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('UPDATE assets SET current_version_id=NULL WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE project_id=ANY($1::bigint[]))', [projectIds]);
    await pool.query('DELETE FROM assets WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM project_sources WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM projects WHERE id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM categories WHERE id=ANY($1::uuid[])', [categoryIds]);
    await pool.query('DELETE FROM scan_errors WHERE run_id=ANY($1::uuid[])', [scanIds]);
    await pool.query('DELETE FROM scan_runs WHERE id=ANY($1::uuid[])', [scanIds]);
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.map((user) => user.id)]);
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
    if (managedRoot) await rm(managedRoot, { recursive: true, force: true });
    for (const path of extraRoots) await rm(path, { recursive: true, force: true });
  }
});
async function project(path = `Legacy/${randomUUID()}`, storageKind = 'legacy', id?: string, storageRoot = root) {
  const row = (await pool.query<{ id: string }>(`INSERT INTO projects
    (id,name,relative_path,storage_kind,description,tags,designer,license,notes)
    VALUES (coalesce($1::bigint,nextval('project_id_seq')),$2,$3,$4,'Keep description',ARRAY['keep-tag'],'Keep designer','Keep license','Keep notes') RETURNING id`,
  [id ?? null, `${prefix} Reviewed Holder`, path, storageKind])).rows[0];
  projectIds.push(row.id);
  await mkdir(join(storageKind === 'managed' ? managedRoot : storageRoot, path), { recursive: true });
  return { id: row.id, relativePath: path, storageKind };
}
async function asset(owner: Awaited<ReturnType<typeof project>>, path = 'models/Small/part.stl', storageRoot = root) {
  const bytes = Buffer.from('Synthetic model bytes; no website access.');
  const relative = `${owner.relativePath}/${path}`;
  const absolute = join(storageRoot, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  const stat = await lstat(absolute);
  const id = randomUUID();
  const versionId = randomUUID();
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO assets
    (id,project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms,inode,device,content_hash)
    VALUES ($1,$2,$3,$4,$5,'mesh',$6,$7,$8,$9,$10,$11)`,
  [id, owner.id, relative, path, basename(path), extname(path), stat.size, Math.trunc(stat.mtimeMs), stat.ino, stat.dev, hash]);
  await pool.query(`INSERT INTO asset_versions (id,asset_id,content_hash,size_bytes,mtime_ms) VALUES ($1,$2,$3,$4,$5)`,
    [versionId, id, hash, stat.size, Math.trunc(stat.mtimeMs)]);
  await pool.query('UPDATE assets SET current_version_id=$1 WHERE id=$2', [versionId, id]);
  return { id, versionId, absolute, bytes, hash, path };
}
async function preview(ids: string[], configured = server) {
  const result = await configured.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: ids } });
  expect(result.statusCode).toBe(200);
  return result.json<LibraryReorganizationPlan>();
}
async function catalogSnapshot(id: string) {
  return (await pool.query(`SELECT to_jsonb(p) AS project,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM assets a WHERE a.project_id=p.id) AS assets,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM asset_versions v JOIN assets a ON a.id=v.asset_id WHERE a.project_id=p.id) AS versions,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM print_requests r WHERE r.project_id=p.id) AS requests,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM project_sources s WHERE s.project_id=p.id) AS sources,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM print_request_files f JOIN print_requests r ON r.id=f.request_id WHERE r.project_id=p.id) AS selections
    FROM projects p WHERE p.id=$1`, [id])).rows[0];
}
const codes = (plan: LibraryReorganizationPlan) => [...plan.issues, ...plan.projects.flatMap((item) => item.issues)].map((item) => item.code);

describe('read-only library management and saved migration dry runs', () => {
  it('requires operator access on every endpoint and validates exact project-count and bigint bounds', async () => {
    const owner = await project();
    const payload = { projectIds: [owner.id] };
    for (const path of ['/library/management', `${base}/${randomUUID()}`]) {
      expect((await server.inject({ url: path })).statusCode).toBe(401);
      expect((await server.inject({ url: path, headers: headers(false) })).statusCode).toBe(403);
    }
    expect((await server.inject({ method: 'POST', url: base, payload })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: base, payload, headers: headers(false) })).statusCode).toBe(403);
    for (const ids of [[], [owner.id, owner.id], ['9223372036854775808'], Array.from({ length: 26 }, (_, i) => String(i + 1))]) {
      expect((await server.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: ids } })).statusCode).toBe(400);
    }
    expect((await server.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: ['9223372036854775807'] } })).statusCode).toBe(404);
    const owners = await Promise.all(Array.from({ length: 25 }, () => project()));
    expect((await preview(owners.map((item) => item.id))).projects).toHaveLength(25);
  });

  async function approveMigration(plan: LibraryReorganizationPlan, configured = server) {
    const result = await configured.inject({ method: 'POST', url: `${base}/${plan.id}/migrate`, headers: headers(), payload: {
      expectedFingerprint: plan.fingerprint, confirmRetainedCopies: true, acknowledgeWarnings: true,
    } });
    expect(result.statusCode).toBe(200);
    return result.json<LibraryMigrationJob>();
  }
  async function migrationAction(job: LibraryMigrationJob, projectId: string, action: 'copy' | 'activate' | 'restore', configured = server) {
    return configured.inject({ method: 'POST', url: `/library/migrations/${job.id}/projects/${projectId}`, headers: headers(),
      payload: { expectedRevision: job.revision, action } });
  }
  async function successfulAction(job: LibraryMigrationJob, projectId: string, action: 'copy' | 'activate' | 'restore', configured = server) {
    const response = await migrationAction(job, projectId, action, configured);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<LibraryMigrationJob>();
  }
  async function migrationStatus(id: string, configured = server) {
    const response = await configured.inject({ url: `/library/migrations/${id}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    return response.json<LibraryMigrationJob>();
  }

  describe('recoverable copy, verify, activate and restore', () => {
    it('protects every migration route and requires explicit approval acknowledgements', async () => {
      const id = randomUUID();
      for (const [method, url, payload] of [
        ['POST', `${base}/${id}/migrate`, { expectedFingerprint: 'a'.repeat(64), confirmRetainedCopies: true, acknowledgeWarnings: true }],
        ['GET', `/library/migrations/${id}`, undefined],
        ['POST', `/library/migrations/${id}/projects/1`, { expectedRevision: 0, action: 'copy' }],
        ['POST', `/library/migrations/${id}/cancel`, { expectedRevision: 0 }],
      ] as const) {
        expect((await server.inject({ method, url, payload })).statusCode).toBe(401);
        expect((await server.inject({ method, url, payload, headers: headers(false) })).statusCode).toBe(403);
      }
      const owner = await project(); await asset(owner);
      const plan = await preview([owner.id]);
      for (const key of ['confirmRetainedCopies', 'acknowledgeWarnings']) {
        expect((await server.inject({ method: 'POST', url: `${base}/${plan.id}/migrate`, headers: headers(),
          payload: { expectedFingerprint: plan.fingerprint, confirmRetainedCopies: true, acknowledgeWarnings: true, [key]: false } })).statusCode).toBe(400);
      }
      const job = await approveMigration(plan);
      expect(await approveMigration(plan)).toEqual(job);
      const saved = (await server.inject({ url: `${base}/${plan.id}`, headers: headers() })).json<LibraryReorganizationPlan>();
      expect(saved.migration).toEqual(job);
      expect((await migrationAction(job, owner.id, 'activate')).statusCode).toBe(409);
    });

    it('copies first, preserves exact bytes and IDs through activation, serves existing requests, excludes originals on rescan, and restores', async () => {
      const isolated = await mkdtemp(join(tmpdir(), 'pantry-migration-scan-'));
      extraRoots.push(isolated);
      const realIndexer = createLibraryIndexer({ db: createDatabase(pool), root: isolated });
      const configured = buildServer(pool, { pool, root: isolated, managedRoot, indexer: realIndexer, secureCookie: false,
        managedClientMountPrefix: '/synthetic-managed' });
      try {
        const id = String(9007199254740993n + BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`));
        const owner = await project(`${prefix}/Migrated Holder`, 'legacy', id, isolated);
        const file = await asset(owner, 'models/Small/part.stl', isolated);
        await mkdir(join(isolated, owner.relativePath, 'empty-docs'));
        await writeFile(join(isolated, owner.relativePath, '.DS_Store'), 'Retained OS metadata');
        const submitted = await historicalRequest(configured, owner.id, file.id, file.versionId);
        expect(submitted.statusCode).toBe(201);
        const requestId = submitted.json().request.id;
        const before = await catalogSnapshot(owner.id);
        const plan = await preview([owner.id], configured);
        let job = await approveMigration(plan, configured);
        job = await successfulAction(job, owner.id, 'copy', configured);
        expect(job.projects[0].status).toBe('copied');
        expect(await catalogSnapshot(owner.id)).toEqual(before);
        await expect(lstat(join(managedRoot, plan.projects[0].destinationPath))).rejects.toMatchObject({ code: 'ENOENT' });
        job = await successfulAction(job, owner.id, 'activate', configured);
        expect(job.status).toBe('completed');
        expect(job.projects[0].status).toBe('activated');
        const after = await catalogSnapshot(owner.id);
        expect(after.versions).toEqual(before.versions);
        expect(after.requests).toEqual(before.requests);
        expect(after.selections).toEqual(before.selections);
        expect(after.sources).toEqual(before.sources);
        expect(after.project).toEqual({ ...before.project, storage_kind: 'managed', relative_path: plan.projects[0].destinationPath });
        expect(after.assets[0]).toMatchObject({ id: file.id, current_version_id: file.versionId, content_hash: file.hash, storage_kind: 'managed', project_relative_path: file.path });
        expect(await readFile(file.absolute)).toEqual(file.bytes);
        expect(await readFile(join(managedRoot, plan.projects[0].destinationPath, file.path))).toEqual(file.bytes);
        expect(await readFile(join(isolated, owner.relativePath, '.DS_Store'), 'utf8')).toBe('Retained OS metadata');
        expect((await lstat(join(managedRoot, plan.projects[0].destinationPath, 'empty-docs'))).isDirectory()).toBe(true);
        const download = await configured.inject({ url: `/catalog/assets/${file.id}/download?versionId=${file.versionId}`, headers: headers(false) });
        expect(download.statusCode).toBe(200);
        expect(download.rawPayload).toEqual(file.bytes);
        const request = (await configured.inject({ url: `/requests/${requestId}`, headers: headers(false) })).json();
        expect(request.request.selected[0]).toMatchObject({ assetId: file.id, versionId: file.versionId, available: true });
        const detail = (await configured.inject({ url: `/catalog/projects/${owner.id}`, headers: headers() })).json();
        expect(detail.project.files[0].clientPath).toContain('/synthetic-managed/');
        const scan = await realIndexer.rescan(); scanIds.push(scan.id);
        expect((await pool.query('SELECT id FROM projects WHERE storage_kind=$1 AND relative_path=$2', ['legacy', owner.relativePath])).rowCount).toBe(0);
        expect((await catalogSnapshot(owner.id)).project).toEqual(after.project);
        await pool.query("UPDATE projects SET name='New managed display title',notes='Keep later edits' WHERE id=$1", [owner.id]);
        job = await successfulAction(job, owner.id, 'restore', configured);
        expect(job.projects[0].status).toBe('restored');
        const restored = await catalogSnapshot(owner.id);
        expect(restored.project).toMatchObject({ storage_kind: 'legacy', relative_path: owner.relativePath, name: 'New managed display title', notes: 'Keep later edits' });
        expect(restored.versions).toEqual(before.versions);
        expect(restored.requests).toEqual(before.requests);
        expect(restored.selections).toEqual(before.selections);
        const rescan = await realIndexer.rescan(); scanIds.push(rescan.id);
        expect((await catalogSnapshot(owner.id)).project.name).toBe('New managed display title');
        const category = await pool.query<{ id: string }>('SELECT id FROM categories WHERE relative_path=$1', [prefix]);
        categoryIds.push(...category.rows.map((row) => row.id));
        expect(await successfulAction(job, owner.id, 'restore', configured)).toEqual(job);
      } finally { await configured.close(); }
    });

    it('rejects stale previews and same-size content changes even when indexed timestamps still match', async () => {
      const stale = await project(); await asset(stale);
      const oldPlan = await preview([stale.id]);
      await pool.query("UPDATE projects SET notes='New metadata' WHERE id=$1", [stale.id]);
      expect((await server.inject({ method: 'POST', url: `${base}/${oldPlan.id}/migrate`, headers: headers(), payload: {
        expectedFingerprint: oldPlan.fingerprint, confirmRetainedCopies: true, acknowledgeWarnings: true,
      } })).statusCode).toBe(409);
      const owner = await project(); const file = await asset(owner);
      const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
      await utimes(file.absolute, timestamp, timestamp);
      await pool.query('UPDATE assets SET mtime_ms=$2 WHERE id=$1', [file.id, timestamp.getTime()]);
      await pool.query('UPDATE asset_versions SET mtime_ms=$2 WHERE id=$1', [file.versionId, timestamp.getTime()]);
      const plan = await preview([owner.id]);
      const job = await approveMigration(plan);
      const stat = await lstat(file.absolute);
      const changed = Buffer.from(file.bytes); changed[0] ^= 1;
      await writeFile(file.absolute, changed);
      await utimes(file.absolute, stat.atime, stat.mtime);
      expect((await lstat(file.absolute)).mtimeMs).toBe(stat.mtimeMs);
      const response = await migrationAction(job, owner.id, 'copy');
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('hash');
      expect((await migrationStatus(job.id)).projects[0].lastError).toContain('hash');
      expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('legacy');
      const latest = await migrationStatus(job.id);
      const canceled = await server.inject({ method: 'POST', url: `/library/migrations/${job.id}/cancel`, headers: headers(), payload: { expectedRevision: latest.revision } });
      expect(canceled.statusCode).toBe(200);
      expect(canceled.json().status).toBe('canceled');
    });

    it('persists copy failure and retries safely after disk errors without changing original catalog rows', async () => {
      const owner = await project(); const file = await asset(owner);
      const plan = await preview([owner.id]);
      let job = await approveMigration(plan);
      const before = await catalogSnapshot(owner.id);
      const failure = vi.spyOn(importStorage, 'storeStream').mockRejectedValueOnce(Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }));
      try {
        expect((await migrationAction(job, owner.id, 'copy')).statusCode).toBe(500);
      } finally { failure.mockRestore(); }
      expect(await catalogSnapshot(owner.id)).toEqual(before);
      expect(await readFile(file.absolute)).toEqual(file.bytes);
      job = await migrationStatus(job.id);
      expect(job.projects[0]).toMatchObject({ status: 'copying', lastError: 'Synthetic disk full' });
      job = await successfulAction(job, owner.id, 'copy');
      expect(job.projects[0]).toMatchObject({ status: 'copied', lastError: null });
    });

    it('recovers after verified directory publication but failed catalog activation, including across server recreation', async () => {
      const owner = await project(); const file = await asset(owner);
      const plan = await preview([owner.id]);
      let job = await approveMigration(plan);
      job = await successfulAction(job, owner.id, 'copy');
      const trigger = `migration_failure_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id=${owner.id} AND NEW.storage_kind='managed' THEN RAISE EXCEPTION 'Synthetic activation failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      try { expect((await migrationAction(job, owner.id, 'activate')).statusCode).toBe(500); }
      finally {
        await pool.query(`DROP TRIGGER ${trigger} ON projects`);
        await pool.query(`DROP FUNCTION ${trigger}()`);
      }
      expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('legacy');
      expect(await readFile(join(managedRoot, plan.projects[0].destinationPath, file.path))).toEqual(file.bytes);
      const restarted = buildServer(pool, { pool, root, managedRoot, indexer, secureCookie: false });
      try {
        job = await migrationStatus(job.id, restarted);
        expect(job.projects[0].status).toBe('copied');
        const activated = await successfulAction(job, owner.id, 'activate', restarted);
        expect(activated.projects[0].status).toBe('activated');
        expect(await successfulAction(job, owner.id, 'activate', restarted)).toEqual(activated);
        expect((await catalogSnapshot(owner.id)).assets[0].id).toBe(file.id);
      } finally { await restarted.close(); }
    });

    it('detects tampered staged/managed copies and refuses restoration when retained originals changed', async () => {
      const owner = await project(); const file = await asset(owner);
      const plan = await preview([owner.id]);
      let job = await approveMigration(plan);
      job = await successfulAction(job, owner.id, 'copy');
      const journal = (await pool.query<{ id: string }>('SELECT id FROM library_migration_projects WHERE migration_id=$1', [job.id])).rows[0];
      const staged = join(managedRoot, `projects/.migration-${journal.id}`, file.path);
      await writeFile(staged, 'Tampered managed copy');
      expect((await migrationAction(job, owner.id, 'activate')).statusCode).toBe(409);
      expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('legacy');
      await writeFile(staged, file.bytes);
      job = await successfulAction(await migrationStatus(job.id), owner.id, 'activate');
      await writeFile(file.absolute, 'Changed retained original');
      expect((await migrationAction(job, owner.id, 'restore')).statusCode).toBe(409);
      expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('managed');
    });

    it('coordinates scans and publications and rejects concurrent/stale commands', async () => {
      const owner = await project(); await asset(owner);
      const job = await approveMigration(await preview([owner.id]));
      const client = await pool.connect();
      await client.query('SELECT pg_advisory_lock($1)', [libraryMutationLock]);
      try {
        expect((await migrationAction(job, owner.id, 'copy')).statusCode).toBe(409);
        const real = createLibraryIndexer({ db: createDatabase(pool), root });
        await expect(real.rescan()).rejects.toBeInstanceOf(ScanInProgressError);
      } finally { await client.query('SELECT pg_advisory_unlock($1)', [libraryMutationLock]); client.release(); }
      const copied = await successfulAction(job, owner.id, 'copy');
      expect((await migrationAction(job, owner.id, 'activate')).statusCode).toBe(409);
      expect((await successfulAction(copied, owner.id, 'activate')).projects[0].status).toBe('activated');
    });

    it('cancels remaining projects while keeping activated projects accessible and restorable', async () => {
      const a = await project(); await asset(a);
      const b = await project(); await asset(b);
      let job = await approveMigration(await preview([a.id, b.id]));
      job = await successfulAction(job, a.id, 'copy');
      job = await successfulAction(job, a.id, 'activate');
      const canceled = await server.inject({ method: 'POST', url: `/library/migrations/${job.id}/cancel`, headers: headers(), payload: { expectedRevision: job.revision } });
      expect(canceled.statusCode).toBe(200);
      job = canceled.json<LibraryMigrationJob>();
      expect(job.status).toBe('canceled');
      expect(job.projects.find((item) => item.projectId === a.id)?.status).toBe('activated');
      expect(job.projects.find((item) => item.projectId === b.id)?.status).toBe('canceled');
      expect((await catalogSnapshot(a.id)).project.storage_kind).toBe('managed');
      expect((await catalogSnapshot(b.id)).project.storage_kind).toBe('legacy');
      expect((await migrationAction(job, b.id, 'copy')).statusCode).toBe(409);
      expect((await successfulAction(job, a.id, 'restore')).projects.find((item) => item.projectId === a.id)?.status).toBe('restored');
    });

    it('cancels stale work and recovers a retained-copy rename if the cancellation transaction fails', async () => {
      const owner = await project(); const file = await asset(owner);
      const plan = await preview([owner.id]);
      let job = await approveMigration(plan);
      job = await successfulAction(job, owner.id, 'copy');
      const journal = (await pool.query<{ id: string }>('SELECT id FROM library_migration_projects WHERE migration_id=$1', [job.id])).rows[0];
      await rename(join(managedRoot, `projects/.migration-${journal.id}`), join(managedRoot, plan.projects[0].destinationPath));
      await pool.query("UPDATE projects SET notes='Metadata changed after approval' WHERE id=$1", [owner.id]);
      const trigger = `cancel_failure_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${job.id}'::uuid AND NEW.status='canceled' THEN RAISE EXCEPTION 'Synthetic cancellation failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON library_migrations FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      const cancel = () => server.inject({ method: 'POST', url: `/library/migrations/${job.id}/cancel`, headers: headers(), payload: { expectedRevision: job.revision } });
      try { expect((await cancel()).statusCode).toBe(500); }
      finally {
        await pool.query(`DROP TRIGGER ${trigger} ON library_migrations`);
        await pool.query(`DROP FUNCTION ${trigger}()`);
      }
      expect(await readFile(join(managedRoot, `projects/.retained-${journal.id}`, file.path))).toEqual(file.bytes);
      await expect(lstat(join(managedRoot, plan.projects[0].destinationPath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await cancel()).statusCode).toBe(200);
      const next = await approveMigration(await preview([owner.id]));
      expect(next.id).not.toBe(job.id);
      expect(await readFile(file.absolute)).toEqual(file.bytes);
    });

    it('does not restore over catalog version drift or missing flags', async () => {
      const owner = await project(); const file = await asset(owner);
      let job = await approveMigration(await preview([owner.id]));
      job = await successfulAction(job, owner.id, 'copy');
      job = await successfulAction(job, owner.id, 'activate');
      await pool.query('UPDATE asset_versions SET missing_at=now() WHERE id=$1', [file.versionId]);
      expect((await migrationAction(job, owner.id, 'restore')).statusCode).toBe(409);
      expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('managed');
      await pool.query('UPDATE asset_versions SET missing_at=NULL WHERE id=$1', [file.versionId]);
      const replacement = randomUUID();
      await pool.query(`INSERT INTO asset_versions (id,asset_id,content_hash,size_bytes,mtime_ms) SELECT $1,asset_id,content_hash,size_bytes,mtime_ms FROM asset_versions WHERE id=$2`, [replacement, file.versionId]);
      await pool.query('UPDATE assets SET current_version_id=$1 WHERE id=$2', [replacement, file.id]);
      expect((await migrationAction(await migrationStatus(job.id), owner.id, 'restore')).statusCode).toBe(409);
      expect((await catalogSnapshot(owner.id)).assets[0].current_version_id).toBe(replacement);
    });

    it('copies the exact 1,000-file / 2,000-entry boundary plus its generated recovery manifest', async () => {
      const source = await mkdtemp(join(tmpdir(), 'pantry-migration-limit-source-'));
      const destination = await mkdtemp(join(tmpdir(), 'pantry-migration-limit-dest-'));
      extraRoots.push(source, destination);
      const configured = buildServer(pool, { pool, root: source, managedRoot: destination, indexer, secureCookie: false });
      try {
        const owner = await project(undefined, 'legacy', undefined, source);
        for (let i = 0; i < 1000; i++) await asset(owner, `variant_${String(i).padStart(4, '0')}/part.stl`, source);
        const plan = await preview([owner.id], configured);
        expect(plan.projects[0].checkedFiles).toBe(1000);
        expect(plan.projects[0].directories).toHaveLength(1000);
        expect(codes(plan)).not.toContain('entry_limit');
        let job = await approveMigration(plan, configured);
        job = await successfulAction(job, owner.id, 'copy', configured);
        expect(job.projects[0].status).toBe('copied');
        expect((await catalogSnapshot(owner.id)).project.storage_kind).toBe('legacy');
      } finally { await configured.close(); }
    }, 60000);
  });

  it('saves an exact ID/path/metadata inventory without changing bytes, asset versions, or print-request snapshots', async () => {
    const id = String(9007199254740993n + BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`));
    const owner = await project(undefined, 'legacy', id);
    const categoryId = randomUUID();
    categoryIds.push(categoryId);
    await pool.query("INSERT INTO categories (id,name,relative_path) VALUES ($1,'Tools',$2)", [categoryId, `${prefix}/Tools`]);
    await pool.query('UPDATE projects SET category_id=$1 WHERE id=$2', [categoryId, owner.id]);
    await pool.query(`INSERT INTO project_sources (project_id,source_key,source_url,canonical_url,provider,evidence)
      VALUES ($1,'makerworld:model:123','https://makerworld.com/en/models/123','https://makerworld.com/en/models/123','makerworld','Keep provenance')`, [owner.id]);
    const file = await asset(owner);
    await mkdir(join(root, owner.relativePath, 'empty-folder'));
    await writeFile(join(root, owner.relativePath, '.DS_Store'), 'Retained OS bytes');
    const submitted = await historicalRequest(server, owner.id, file.id, file.versionId);
    expect(submitted.statusCode).toBe(201);
    const before = await catalogSnapshot(owner.id);
    const destinationBefore = await readdir(managedRoot, { recursive: true });
    const result = await preview([owner.id]);
    expect(result.kind).toBe('dry_run');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.additionalBytes).toBe(String(file.bytes.length));
    expect(BigInt(result.availableBytes!)).toBeGreaterThan(0n);
    const item = result.projects[0];
    expect(item.id).toBe(id);
    expect(item.destinationPath).toBe(`projects/${id}-${projectSlug(item.name)}`);
    expect(item.metadata).toMatchObject({ categoryId, description: 'Keep description', tags: ['keep-tag'], designer: 'Keep designer', license: 'Keep license', notes: 'Keep notes' });
    expect(item.category).toBe(`${prefix}/Tools`);
    expect(item.sourceCount).toBe(1);
    expect(item.files).toEqual([{ id: file.id, versionId: file.versionId, sourcePath: `${owner.relativePath}/${file.path}`,
      destinationPath: file.path, contentHash: file.hash, sizeBytes: String(file.bytes.length) }]);
    expect(item.directories).toContain('empty-folder');
    expect(item.checkedFiles).toBe(1);
    expect(item.inspectionComplete).toBe(true);
    expect(codes(result)).toContain('os_metadata');
    expect([...result.issues, ...item.issues].filter((entry) => entry.severity === 'blocker')).toEqual([]);
    expect(await catalogSnapshot(owner.id)).toEqual(before);
    expect(await readFile(file.absolute)).toEqual(file.bytes);
    expect(await readFile(join(root, owner.relativePath, '.DS_Store'), 'utf8')).toBe('Retained OS bytes');
    expect(await readdir(managedRoot, { recursive: true })).toEqual(destinationBefore);
    const restarted = buildServer(pool, { pool, root, managedRoot, indexer, secureCookie: false });
    try {
      const saved = await restarted.inject({ url: `${base}/${result.id}`, headers: headers() });
      expect(saved.json()).toEqual(result);
      const listing = await restarted.inject({ url: `/library/management?q=${encodeURIComponent(prefix)}`, headers: headers() });
      const data = listing.json<LibraryManagementResponse>();
      expect(data.items.find((entry) => entry.id === id)?.sizeBytes).toBe(String(file.bytes.length));
      expect(data.plans.some((entry) => entry.id === result.id)).toBe(true);
      expect((await restarted.inject({ url: `${base}/${randomUUID()}`, headers: headers() })).statusCode).toBe(404);
    } finally { await restarted.close(); }
  });

  it('blocks changed, missing, unindexed, symlinked, reserved, nonportable, and case-conflicting entries', async () => {
    const changed = await project(); const changedFile = await asset(changed);
    await writeFile(changedFile.absolute, 'Changed source bytes');
    expect(codes(await preview([changed.id]))).toContain('changed_file');
    const missing = await project(); const missingFile = await asset(missing);
    await rm(missingFile.absolute);
    expect(codes(await preview([missing.id]))).toContain('missing_file');
    const unindexed = await project(); await asset(unindexed);
    await writeFile(join(root, unindexed.relativePath, 'unindexed.pdf'), 'Keep this too');
    expect(codes(await preview([unindexed.id]))).toContain('unindexed_file');
    const linked = await project(); const linkedFile = await asset(linked);
    await symlink(linkedFile.absolute, join(root, linked.relativePath, 'linked.stl'));
    expect(codes(await preview([linked.id]))).toContain('unsafe_entry');
    for (const name of ['project.json', 'bad|name.stl']) {
      const unsafe = await project(); await asset(unsafe, name);
      expect(codes(await preview([unsafe.id]))).toContain('destination_paths');
    }
    const collision = await project(); await asset(collision, 'Case.stl'); await asset(collision, 'case.stl');
    expect(codes(await preview([collision.id]))).toContain('destination_paths');
    const directories = await project(); await asset(directories);
    await mkdir(join(root, directories.relativePath, 'Case')); await mkdir(join(root, directories.relativePath, 'case'));
    expect(codes(await preview([directories.id]))).toContain('unsafe_entry');
  });

  it('blocks overlapping project boundaries and existing or case-equivalent managed destinations', async () => {
    const parent = await project(); await asset(parent);
    await project(`${parent.relativePath}/Child`);
    expect(codes(await preview([parent.id]))).toContain('overlapping_boundary');
    const owner = await project(); await asset(owner);
    const first = await preview([owner.id]);
    await mkdir(join(managedRoot, first.projects[0].destinationPath.toUpperCase().replace('PROJECTS/', 'projects/')), { recursive: true });
    expect(codes(await preview([owner.id]))).toContain('destination_conflict');
    const managed = await project(`projects/managed-${randomUUID()}`, 'managed');
    expect(codes(await preview([managed.id]))).toContain('already_managed');
  });

  it('reports missing storage without creating roots or following root symlinks', async () => {
    const owner = await project(); await asset(owner);
    const absent = join(managedRoot, 'not-created');
    const offline = buildServer(pool, { pool, root, managedRoot: absent, indexer, secureCookie: false });
    try {
      expect(codes(await preview([owner.id], offline))).toContain('managed_unavailable');
      await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await offline.close(); }
    const alias = join(managedRoot, 'root-alias');
    await symlink(root, alias);
    const linked = buildServer(pool, { pool, root: alias, managedRoot, indexer, secureCookie: false });
    try {
      const result = await preview([owner.id], linked);
      expect(codes(result)).toContain('legacy_unavailable');
      expect(result.projects[0].checkedFiles).toBe(0);
    } finally { await linked.close(); }
  });

  it('enforces exactly 1,000 indexed files and 2,000 inspected entries with explicit partial-preview blockers', async () => {
    const owner = await project();
    await pool.query(`INSERT INTO assets (project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms)
      SELECT $1,$2||'/part-'||n||'.stl','part-'||n||'.stl','part-'||n||'.stl','mesh','.stl',1,0 FROM generate_series(1,1000) n`,
    [owner.id, owner.relativePath]);
    const atLimit = await preview([owner.id]);
    expect(atLimit.projects[0].files).toHaveLength(1000);
    expect(codes(atLimit)).not.toContain('file_limit');
    await pool.query(`INSERT INTO assets (project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms)
      VALUES ($1,$2||'/extra.stl','extra.stl','extra.stl','mesh','.stl',1,0)`, [owner.id, owner.relativePath]);
    const overLimit = await preview([owner.id]);
    expect(codes(overLimit)).toContain('file_limit');
    expect(overLimit.projects[0].files).toEqual([]);
    const entries = await project(); await asset(entries, 'part.stl');
    for (let i = 1; i < 2000; i++) await writeFile(join(root, entries.relativePath, `._${i}`), '');
    const emptyManaged = join(managedRoot, 'empty-managed');
    await mkdir(emptyManaged);
    const isolated = buildServer(pool, { pool, root, managedRoot: emptyManaged, indexer, secureCookie: false });
    try {
      const exact = await preview([entries.id], isolated);
      expect(exact.projects[0].inspectionComplete).toBe(true);
      expect(exact.projects[0].checkedFiles).toBe(1);
      expect(codes(exact)).not.toContain('entry_limit');
      await writeFile(join(root, entries.relativePath, '._extra'), '');
      const extra = await preview([entries.id], isolated);
      expect(codes(extra)).toContain('entry_limit');
      expect(extra.projects[0].inspectionComplete).toBe(false);
    } finally { await isolated.close(); }
  }, 30000);

  it('keeps byte estimates exact above JavaScript safe integers and reports insufficient disk space', async () => {
    const owner = await project(); const file = await asset(owner);
    const size = '9223372036854775807';
    await pool.query('UPDATE assets SET size_bytes=$1 WHERE id=$2', [size, file.id]);
    await pool.query('UPDATE asset_versions SET size_bytes=$1 WHERE id=$2', [size, file.versionId]);
    const result = await preview([owner.id]);
    expect(result.additionalBytes).toBe(size);
    expect(result.projects[0].files[0].sizeBytes).toBe(size);
    expect(codes(result)).toContain('insufficient_space');
  });

  it('enforces 12 path components and the 8 MiB UTF-8 snapshot limit without saving oversized previews', async () => {
    const owner = await project();
    await asset(owner, `${Array.from({ length: 11 }, (_, i) => `d${i}`).join('/')}/part.stl`);
    const exact = await preview([owner.id]);
    expect(exact.projects[0].inspectionComplete).toBe(true);
    expect(exact.projects[0].checkedFiles).toBe(1);
    const deep = await project();
    await asset(deep, `${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}/part.stl`);
    expect(codes(await preview([deep.id]))).toContain('destination_paths');
    const oversized = await project();
    await pool.query("UPDATE projects SET description=repeat('é',4*1024*1024) WHERE id=$1", [oversized.id]);
    const result = await server.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: [oversized.id] } });
    expect(result.statusCode).toBe(413);
    expect(result.json().error).toContain('8 MiB');
    expect((await pool.query('SELECT 1 FROM library_reorganization_plans WHERE snapshot @> $1::jsonb',
      [JSON.stringify({ projects: [{ id: oversized.id }] })])).rowCount).toBe(0);
  }, 10000);

  it('refuses planning during scans without saving a success-shaped snapshot', async () => {
    const owner = await project();
    scanning = true;
    try {
      expect((await server.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: [owner.id] } })).statusCode).toBe(409);
    } finally { scanning = false; }
    const saved = await pool.query('SELECT 1 FROM library_reorganization_plans WHERE snapshot @> $1::jsonb', [JSON.stringify({ projects: [{ id: owner.id }] })]);
    expect(saved.rowCount).toBe(0);
    let checks = 0;
    const racing = buildServer(pool, { pool, root, managedRoot, secureCookie: false, indexer: {
      ...indexer, getStatus: () => ({ running: ++checks > 1, lastScan: null }),
    } });
    try {
      const result = await racing.inject({ method: 'POST', url: base, headers: headers(), payload: { projectIds: [owner.id] } });
      expect(result.statusCode).toBe(409);
      expect(result.json().error).toContain('started during inspection');
      expect((await pool.query('SELECT 1 FROM library_reorganization_plans WHERE snapshot @> $1::jsonb',
        [JSON.stringify({ projects: [{ id: owner.id }] })])).rowCount).toBe(0);
    } finally { await racing.close(); }
  });

  it('paginates numerically ordered project IDs and treats search metacharacters literally', async () => {
    const owners = await Promise.all(Array.from({ length: 51 }, () => project()));
    const ids = owners.map((owner) => owner.id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const term = `${prefix} pagination`;
    await pool.query('UPDATE projects SET name=$1 WHERE id=ANY($2::bigint[])', [term, ids]);
    const first = (await server.inject({ url: `/library/management?q=${encodeURIComponent(term)}`, headers: headers() })).json<LibraryManagementResponse>();
    const second = (await server.inject({ url: `/library/management?q=${encodeURIComponent(term)}&page=2`, headers: headers() })).json<LibraryManagementResponse>();
    expect(first.total).toBe(51);
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 50));
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(50));
    const literal = `${prefix}%_`;
    await pool.query('UPDATE projects SET name=$1 WHERE id=$2', [literal, ids[0]]);
    const searched = (await server.inject({ url: `/library/management?q=${encodeURIComponent(literal)}`, headers: headers() })).json<LibraryManagementResponse>();
    expect(searched.total).toBe(1);
    expect(searched.items[0].id).toBe(ids[0]);
  });
});
