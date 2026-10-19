import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@print-pantry/db';
import type { LibraryManagementResponse, LibraryReorganizationPlan } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { projectSlug } from './import-storage.js';

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
const pool = createPool(database);
const prefix = `library-test-${randomUUID().slice(0, 8)}`;
const users = ['operator', 'requester'].map((role) => ({ id: randomUUID(), name: `${prefix}-${role}`, role }));
const projectIds: string[] = [];
const categoryIds: string[] = [];
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
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.map((user) => user.id)]);
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
    if (managedRoot) await rm(managedRoot, { recursive: true, force: true });
  }
});
async function project(path = `Legacy/${randomUUID()}`, storageKind = 'legacy', id?: string) {
  const row = (await pool.query<{ id: string }>(`INSERT INTO projects
    (id,name,relative_path,storage_kind,description,tags,designer,license,notes)
    VALUES (coalesce($1::bigint,nextval('project_id_seq')),$2,$3,$4,'Keep description',ARRAY['keep-tag'],'Keep designer','Keep license','Keep notes') RETURNING id`,
  [id ?? null, `${prefix} Reviewed Holder`, path, storageKind])).rows[0];
  projectIds.push(row.id);
  await mkdir(join(storageKind === 'managed' ? managedRoot : root, path), { recursive: true });
  return { id: row.id, relativePath: path, storageKind };
}
async function asset(owner: Awaited<ReturnType<typeof project>>, path = 'models/Small/part.stl') {
  const bytes = Buffer.from('Synthetic model bytes; no website access.');
  const relative = `${owner.relativePath}/${path}`;
  const absolute = join(root, relative);
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
    const submitted = await server.inject({ method: 'POST', url: '/requests', headers: headers(false), payload: {
      projectId: owner.id, selected: [{ assetId: file.id, versionId: file.versionId }], quantity: 1,
    } });
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
