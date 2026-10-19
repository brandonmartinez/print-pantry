import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@print-pantry/db';
import type { ImportIntakeResult, ImportMetadata, ImportRequest } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { fixtureZip } from './import-fixture.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/print_pantry_test') throw new Error('An isolated print_pantry_test database is required');
const pool = createPool(url);
const token = `intake-${randomUUID().slice(0, 8)}`;
const requestIds: string[] = [];
const projectIds: string[] = [];
const users = ['operator', 'requester'].map((role) => ({ id: randomUUID(), name: `${token}-${role}`, role }));
const metadata: ImportMetadata = {
  name: 'Universal Drill Bit Holder', category: `${token}/Holders`,
  description: 'An imported synthetic test model', designer: 'Fixture designer',
  license: 'Synthetic test license', notes: null, tags: ['holder'],
};
const stl = Buffer.from('solid holder\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid holder');
let root: string;
let legacyRoot: string;
let intakeRoot: string;
let managedRoot: string;
let server: ReturnType<typeof buildServer>;
let disabled: ReturnType<typeof buildServer>;
let options: NonNullable<Parameters<typeof buildServer>[1]>;
let cookies: string[];
let offline = false;

beforeAll(async () => {
  await runMigrations(url);
  root = await mkdtemp(join(tmpdir(), 'pantry-manual-import-'));
  legacyRoot = join(root, 'legacy');
  intakeRoot = join(root, 'intake');
  managedRoot = join(root, 'managed');
  options = {
    pool, root: legacyRoot, managedRoot, secureCookie: false, managedClientMountPrefix: '/Volumes/Synthetic Managed',
    indexer: {
      getStatus: () => ({
        running: false, lastScan: offline ? {
          id: randomUUID(), status: 'offline', filesSeen: 0, hashedFiles: 0, errorsCount: 1,
          startedAt: new Date(), finishedAt: new Date(),
        } : null,
      }),
      rescan: async () => { throw new Error('This test does not scan any filesystem library'); },
    },
  };
  server = buildServer(pool, { ...options, importStorage: { intakeRoot, managedRoot } });
  disabled = buildServer(pool, options);
  const hash = await hashPassword('synthetic manual import password');
  for (const user of users) {
    await pool.query('INSERT INTO users (id,username,password_hash,role) VALUES ($1,$2,$3,$4)',
      [user.id, user.name, hash, user.role]);
  }
  cookies = [];
  for (const user of users) {
    const response = await server.inject({
      method: 'POST', url: '/auth/login', payload: { username: user.name, password: 'synthetic manual import password' },
    });
    cookies.push(response.headers['set-cookie']!.toString().split(';')[0]);
  }
});

afterAll(async () => {
  try {
    await server?.close();
    await disabled?.close();
    const imports = await pool.query<{ project_id: string }>(
      'SELECT project_id FROM import_requests WHERE id = ANY($1::uuid[]) AND project_id IS NOT NULL', [requestIds],
    );
    projectIds.push(...imports.rows.map((r) => r.project_id));
    const prints = await pool.query<{ id: string }>('SELECT id FROM print_requests WHERE project_id = ANY($1::bigint[])', [projectIds]);
    const printIds = prints.rows.map((p) => p.id);
    await pool.query('DELETE FROM print_request_history WHERE request_id = ANY($1::uuid[])', [printIds]);
    await pool.query('DELETE FROM print_request_files WHERE request_id = ANY($1::uuid[])', [printIds]);
    await pool.query('DELETE FROM print_requests WHERE id = ANY($1::uuid[])', [printIds]);
    await pool.query('DELETE FROM import_files WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_uploads WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_intakes WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_events WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_submissions WHERE request_id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM import_requests WHERE id = ANY($1::uuid[])', [requestIds]);
    await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1::bigint[])', [projectIds]);
    await pool.query('UPDATE assets SET current_version_id = NULL WHERE project_id = ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE project_id = ANY($1::bigint[]))', [projectIds]);
    await pool.query('DELETE FROM assets WHERE project_id = ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::bigint[])', [projectIds]);
    const categories = await pool.query<{ id: string }>('SELECT id FROM categories WHERE relative_path = $1 OR relative_path LIKE $2 ORDER BY length(relative_path) DESC',
      [token, `${token}/%`]);
    for (const category of categories.rows) await pool.query('DELETE FROM categories WHERE id = $1', [category.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [users.map((u) => u.id)]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users.map((u) => u.id)]);
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const headers = (operator = true) => ({ cookie: cookies[operator ? 0 : 1] });
const revisionOf = async (id: string) => (await server.inject({ url: `/imports/${id}`, headers: headers() })).json<{ request: ImportRequest }>().request.revision;
async function accepted(source = `https://example.invalid/${token}/${randomUUID()}`) {
  const response = await server.inject({
    method: 'POST', url: '/imports', headers: headers(false),
    payload: { url: source, notes: 'Requester notes must not become published metadata', submissionKey: randomUUID() },
  });
  const id = response.json<{ request: ImportRequest }>().request.id;
  requestIds.push(id);
  const accept = await server.inject({
    method: 'PATCH', url: `/imports/${id}`, headers: headers(),
    payload: { action: 'accept', expectedRevision: 0 },
  });
  expect(accept.statusCode).toBe(200);
  return id;
}
async function prepare(id: string) {
  return server.inject({ method: 'POST', url: `/imports/${id}/prepare`, headers: headers(),
    payload: { expectedRevision: await revisionOf(id) } });
}
async function upload(id: string, name: string, bytes: Buffer, key = randomUUID(), expectedRevision?: number) {
  return server.inject({
    method: 'POST', url: `/imports/${id}/files?name=${encodeURIComponent(name)}&uploadKey=${key}&expectedRevision=${expectedRevision ?? await revisionOf(id)}`,
    headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: bytes,
  });
}
async function plan(id: string) {
  return server.inject({ method: 'POST', url: `/imports/${id}/plan`, headers: headers(),
    payload: { expectedRevision: await revisionOf(id), metadata } });
}
async function publish(id: string, confirmDuplicates = true) {
  return server.inject({ method: 'POST', url: `/imports/${id}/publish`, headers: headers(),
    payload: { expectedRevision: await revisionOf(id), confirmDuplicates } });
}

describe('operator manual import lifecycle', () => {
  it('requires configured isolated storage and operator permission on intake surfaces', async () => {
    const id = await accepted();
    expect((await disabled.inject({ url: `/imports/${id}/intake`, headers: headers() })).json().intake.configured).toBe(false);
    expect((await disabled.inject({ method: 'POST', url: `/imports/${id}/prepare`, headers: headers(),
      payload: { expectedRevision: 1 } })).statusCode).toBe(503);
    expect((await server.inject({ url: `/imports/${id}/intake`, headers: headers(false) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: `/imports/${id}/prepare`, headers: headers(false),
      payload: { expectedRevision: 1 } })).statusCode).toBe(403);
    const ready = await prepare(id);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().intake).toMatchObject({ configured: true, prepared: true, uploads: [], plan: null });
    expect((await prepare(id)).statusCode).toBe(200);
    expect(await readdir(intakeRoot)).toContain(id);
    expect((await server.inject({ method: 'POST', url: `/imports/${id}/files?name=x.stl&uploadKey=${randomUUID()}&expectedRevision=1`,
      headers: { ...headers(false), 'content-type': 'application/octet-stream' }, payload: stl })).statusCode).toBe(403);
  });

  it('retains ZIP originals, reviews paths, publishes and serves the managed project without legacy storage', async () => {
    const id = await accepted();
    await prepare(id);
    const sourceFolder = 'Universal Drill Bit Holder | Fits Kobalt, & More';
    const managedFolder = 'Universal Drill Bit Holder _ Fits Kobalt, & More';
    const bytes = fixtureZip([
      { name: `${sourceFolder}/`, bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: `${sourceFolder}/README.md`, bytes: Buffer.from('Fixture instructions') },
      { name: `${sourceFolder}/LICENSE.txt`, bytes: Buffer.from('Fixture license') },
      { name: `${sourceFolder}/files/Small/holder.stl`, bytes: stl },
      { name: `${sourceFolder}/files/Large/holder.step`, bytes: Buffer.from('synthetic STEP source') },
      { name: `${sourceFolder}/instructions.pdf`, bytes: Buffer.from('synthetic PDF') },
    ]);
    const key = randomUUID();
    const archiveName = 'Universal Drill Bit Holder | Fits Kobalt, & More.zip';
    const uploaded = await upload(id, archiveName, bytes, key);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().intake.uploads).toEqual([{ id: key, name: archiveName, size: bytes.length, fileCount: 5 }]);
    const retry = await upload(id, archiveName, bytes, key, 1);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().intake.uploads).toHaveLength(1);
    expect(retry.json().revision).toBe(uploaded.json().revision);
    expect((await upload(id, 'changed.zip', bytes, key)).statusCode).toBe(409);
    const original = await server.inject({ url: `/imports/${id}/files/${key}/original`, headers: headers() });
    expect(original.rawPayload).toEqual(bytes);
    expect((await server.inject({ url: `/imports/${id}/files/${key}/original`, headers: headers(false) })).statusCode).toBe(403);
    const processed = await plan(id);
    expect(processed.statusCode).toBe(200);
    const proposal = processed.json<ImportIntakeResult>();
    expect(proposal.intake.plan?.files.map((f) => f.path).sort()).toEqual([
      'LICENSE.txt', 'README.md', `docs/${managedFolder}/instructions.pdf`,
      `models/${managedFolder}/files/Large/holder.step`, `models/${managedFolder}/files/Small/holder.stl`,
    ]);
    expect(proposal.intake.plan!.files.every((file) => file.originalPath.startsWith(`${sourceFolder}/`))).toBe(true);
    expect(proposal.intake.plan!.warnings.some((warning) => warning.includes('Nonportable names were normalized'))).toBe(true);
    const invalid = await server.inject({ method: 'POST', url: `/imports/${id}/plan`, headers: headers(),
      payload: { expectedRevision: proposal.revision, metadata, files: proposal.intake.plan!.files.map((f, index) =>
        ({ id: f.id, path: index === 0 ? '../escape.stl' : f.path, include: f.include })) } });
    expect(invalid.statusCode).toBe(400);
    const published = await publish(id);
    expect(published.statusCode).toBe(200);
    const result = published.json<ImportIntakeResult>();
    expect(result.projectId).toMatch(/^[1-9][0-9]*$/);
    expect(result.intake.publishedPath).toBe(`projects/${result.projectId}-universal_drill_bit_holder`);
    const manifest = JSON.parse(await readFile(join(managedRoot, result.intake.publishedPath!, 'project.json'), 'utf8'));
    expect(manifest.projectId).toBe(result.projectId);
    expect(manifest.notes).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain('Requester notes');
    const duplicatePublish = await publish(id);
    expect(duplicatePublish.json().projectId).toBe(result.projectId);
    const catalog = await server.inject({ url: `/catalog/projects/${result.projectId}`, headers: headers(false) });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().project).toMatchObject({
      name: metadata.name, storageKind: 'managed', category: token,
      clientPath: `/Volumes/Synthetic Managed/${result.intake.publishedPath}`,
    });
    const file = catalog.json().project.files.find((f: { extension: string }) => f.extension === '.stl');
    expect(file.variant).toBe(`${managedFolder}/Small`);
    const download = await server.inject({ url: `/catalog/assets/${file.id}/download?versionId=${file.versionId}`, headers: headers(false) });
    expect(download.rawPayload).toEqual(stl);
    expect((await server.inject({ url: `/catalog/assets/${file.id}/preview`, headers: headers(false) })).statusCode).toBe(200);
    offline = true;
    const print = await server.inject({ method: 'POST', url: '/requests', headers: headers(false),
      payload: { projectId: result.projectId, selected: [{ assetId: file.id, versionId: file.versionId }], quantity: 1 } });
    expect(print.statusCode).toBe(201);
    expect(print.json().request.selected[0].available).toBe(true);
    offline = false;
  });

  it('invalidates approval on input changes and retains originals removed from the plan', async () => {
    const id = await accepted();
    await prepare(id);
    const key = randomUUID();
    await upload(id, 'holder.stl', stl, key);
    const processed = await plan(id);
    const oldRevision = processed.json().revision;
    const second = await upload(id, 'holder.stl', stl);
    expect(second.json().intake.plan).toBeNull();
    const conflicts = await plan(id);
    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json().intake.plan.warnings.some((warning: string) => warning.startsWith('Resolve destination conflicts'))).toBe(true);
    expect((await server.inject({ method: 'POST', url: `/imports/${id}/publish`, headers: headers(),
      payload: { expectedRevision: oldRevision, confirmDuplicates: true } })).statusCode).toBe(409);
    const resolved = await server.inject({ method: 'POST', url: `/imports/${id}/plan`, headers: headers(),
      payload: { expectedRevision: await revisionOf(id), metadata, files: conflicts.json<ImportIntakeResult>().intake.plan!.files.map((file, index) =>
        ({ id: file.id, path: index === 0 ? 'models/alternate_holder.stl' : file.path, include: true })) } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().intake.plan.warnings.some((warning: string) => warning.startsWith('Resolve destination conflicts'))).toBe(false);
    const secondKey = second.json().intake.uploads.find((u: { id: string }) => u.id !== key).id;
    const removed = await server.inject({ method: 'DELETE', url: `/imports/${id}/files/${secondKey}`, headers: headers(),
      payload: { expectedRevision: await revisionOf(id) } });
    expect(removed.statusCode).toBe(200);
    expect((await server.inject({ url: `/imports/${id}/files/${secondKey}/original`, headers: headers() })).rawPayload).toEqual(stl);
    expect((await plan(id)).statusCode).toBe(200);
  });

  it('requires duplicate acknowledgement and never merges existing projects', async () => {
    const id = await accepted();
    await prepare(id);
    await upload(id, 'another.stl', stl);
    const processed = await plan(id);
    expect(processed.json().intake.plan.duplicates.length).toBeGreaterThan(0);
    const denied = await publish(id, false);
    expect(denied.statusCode).toBe(409);
    const published = await publish(id, true);
    expect(published.statusCode).toBe(200);
    expect(published.json().projectId).toBeTruthy();
  });

  it('requires reviewing normalized-name collisions and publishes distinct bytes only after they are resolved', async () => {
    const id = await accepted();
    await prepare(id);
    const first = Buffer.concat([stl, Buffer.from('\nfirst normalized-name fixture')]);
    const second = Buffer.concat([stl, Buffer.from('\nsecond normalized-name fixture')]);
    expect((await upload(id, 'collisions.zip', fixtureZip([
      { name: 'holder|6.stl', bytes: first },
      { name: 'holder?6.stl', bytes: second },
    ]))).statusCode).toBe(200);
    const processed = (await plan(id)).json<ImportIntakeResult>();
    expect(processed.intake.plan!.files.map((file) => file.path)).toEqual(['models/holder_6.stl', 'models/holder_6.stl']);
    expect(processed.intake.plan!.warnings.some((warning) => warning.startsWith('Resolve destination conflicts'))).toBe(true);
    expect((await publish(id)).statusCode).toBe(400);
    const edits = processed.intake.plan!.files.map((file) => ({
      id: file.id, path: file.originalPath === 'holder|6.stl' ? 'models/first_holder_6.stl' : 'models/second_holder_6.stl', include: true,
    }));
    const saved = await server.inject({ method: 'POST', url: `/imports/${id}/plan`, headers: headers(),
      payload: { expectedRevision: await revisionOf(id), metadata, files: edits } });
    expect(saved.statusCode).toBe(200);
    const published = await publish(id);
    expect(published.statusCode).toBe(200);
    const directory = join(managedRoot, published.json().intake.publishedPath);
    expect(await readFile(join(directory, 'models/first_holder_6.stl'))).toEqual(first);
    expect(await readFile(join(directory, 'models/second_holder_6.stl'))).toEqual(second);
  });

  it('defaults OS metadata to excluded, preserves originals, and publishes only reviewed selections', async () => {
    const id = await accepted();
    await prepare(id);
    const key = randomUUID();
    const bytes = fixtureZip([
      { name: 'bit_holder.stl', bytes: stl },
      { name: 'source.webloc', bytes: Buffer.from('synthetic source shortcut') },
      { name: '__MACOSX/._bit_holder.stl', bytes: Buffer.from('macOS resource fork') },
      { name: '._source.webloc', bytes: Buffer.from('macOS resource fork') },
      { name: '.DS_Store', bytes: Buffer.from('macOS folder metadata') },
      { name: 'Thumbs.db', bytes: Buffer.from('Windows thumbnail cache') },
      { name: 'nested/desktop.ini', bytes: Buffer.from('Windows folder metadata') },
      { name: '.directory', bytes: Buffer.from('KDE folder metadata') },
    ]);
    expect((await upload(id, 'os-metadata.zip', bytes, key)).statusCode).toBe(200);
    const processed = await plan(id);
    expect(processed.statusCode).toBe(200);
    const proposal = processed.json<ImportIntakeResult>().intake.plan!;
    expect(proposal.files).toHaveLength(8);
    expect(proposal.files.filter((file) => file.include).map((file) => file.originalPath)).toEqual(['bit_holder.stl', 'source.webloc']);
    const edit = async (includeCache: boolean) => server.inject({
      method: 'POST', url: `/imports/${id}/plan`, headers: headers(),
      payload: { expectedRevision: await revisionOf(id), metadata, files: proposal.files.map((file) => ({
        id: file.id, path: file.path, include: file.originalPath === 'Thumbs.db' ? includeCache : file.include,
      })) },
    });
    const overridden = await edit(true);
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json<ImportIntakeResult>().intake.plan!.files.find((file) => file.originalPath === 'Thumbs.db')!.include).toBe(true);
    expect((await edit(false)).statusCode).toBe(200);
    const published = await publish(id);
    expect(published.statusCode).toBe(200);
    const manifest = JSON.parse(await readFile(join(managedRoot, published.json().intake.publishedPath, 'project.json'), 'utf8'));
    expect(manifest.files.map((file: { originalPath: string }) => file.originalPath)).toEqual(['bit_holder.stl', 'source.webloc']);
    const assets = await pool.query<{ name: string }>('SELECT name FROM assets WHERE project_id = $1 ORDER BY name', [published.json().projectId]);
    expect(assets.rows.map((asset) => asset.name)).toEqual(['bit_holder.stl', 'project.json', 'source.webloc']);
    const original = await server.inject({ url: `/imports/${id}/files/${key}/original`, headers: headers() });
    expect(original.rawPayload).toEqual(bytes);
  });

  it('stops on changed originals, cleans partial staging, and retries with the same project identity', async () => {
    const id = await accepted();
    await prepare(id);
    const bytes = Buffer.concat([stl, Buffer.from('\noriginal verification fixture')]);
    await upload(id, 'verified.stl', bytes);
    await plan(id);
    const source = await pool.query<{ stored_path: string }>('SELECT stored_path FROM import_files WHERE request_id = $1', [id]);
    const path = join(intakeRoot, source.rows[0].stored_path);
    await writeFile(path, 'changed after review');
    expect((await publish(id)).statusCode).toBe(409);
    const intake = (await server.inject({ url: `/imports/${id}/intake`, headers: headers() })).json<ImportIntakeResult>();
    expect((await readdir(join(managedRoot, '.staging'))).filter((entry) => entry.startsWith(id))).toEqual([]);
    await expect(readFile(join(managedRoot, intake.intake.publishedPath!, 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, bytes);
    const recovered = await publish(id);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().intake.publishedPath).toBe(intake.intake.publishedPath);
  });

  it('recovers files-saved/catalog-pending after a registration failure without republishing', async () => {
    const id = await accepted();
    await prepare(id);
    await upload(id, 'recoverable.stl', Buffer.concat([stl, Buffer.from('\nrecovery fixture')]));
    const proposal = (await plan(id)).json<ImportIntakeResult>();
    const file = proposal.intake.plan!.files[0];
    const blocker = await pool.query<{ id: string }>('INSERT INTO projects (relative_path,name) VALUES ($1,$2) RETURNING id',
      [`${token}/blocker`, 'Synthetic registration blocker']);
    projectIds.push(blocker.rows[0].id);
    await pool.query(
      `INSERT INTO assets (id,project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms)
       VALUES ($1,$2,$3,'blocker.stl','blocker.stl','mesh','.stl',1,0)`,
      [file.id, blocker.rows[0].id, `${token}/blocker.stl`],
    );
    const failed = await publish(id);
    expect(failed.statusCode).toBe(500);
    const pending = await server.inject({ url: `/imports/${id}`, headers: headers() });
    expect(pending.json().request.status).toBe('catalog_pending');
    const saved = await server.inject({ url: `/imports/${id}/intake`, headers: headers() });
    const destination = saved.json<ImportIntakeResult>().intake.publishedPath!;
    const savedBytes = await readFile(join(managedRoot, destination, file.path));
    expect(savedBytes).toEqual(Buffer.concat([stl, Buffer.from('\nrecovery fixture')]));
    await writeFile(join(managedRoot, destination, 'unexpected.txt'), 'unexpected');
    expect((await publish(id)).statusCode).toBe(409);
    await rm(join(managedRoot, destination, 'unexpected.txt'));
    const manifestPath = join(managedRoot, destination, 'project.json');
    const originalManifest = await readFile(manifestPath);
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest.toString()), name: 'Changed outside the application' }));
    expect((await publish(id)).statusCode).toBe(409);
    await writeFile(manifestPath, originalManifest);
    await pool.query('DELETE FROM assets WHERE id = $1', [file.id]);
    const restarted = buildServer(pool, { ...options, importStorage: { intakeRoot, managedRoot } });
    try {
      const recovered = await restarted.inject({
        method: 'POST', url: `/imports/${id}/publish`, headers: headers(),
        payload: { expectedRevision: await revisionOf(id), confirmDuplicates: true },
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().intake.publishedPath).toBe(destination);
    } finally { await restarted.close(); }
    expect((await readdir(join(managedRoot, 'projects'))).filter((path) => destination.endsWith(path))).toHaveLength(1);
  });

  it('uses a database operation lock to prevent overlapping uploads and operator cancellation', async () => {
    const id = await accepted();
    await prepare(id);
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,98419))', [id]);
      expect((await plan(id)).statusCode).toBe(409);
      const cancel = await server.inject({ method: 'PATCH', url: `/imports/${id}`, headers: headers(),
        payload: { action: 'cancel', expectedRevision: await revisionOf(id), note: 'Concurrent action' } });
      expect(cancel.statusCode).toBe(409);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,98419))', [id]);
      client.release();
    }
  });

  it('reviews and publishes the complete 1000-file limit with portable Unicode paths and a large manifest', async () => {
    const id = await accepted();
    await prepare(id);
    const parent = Array.from({ length: 10 }, () => '界'.repeat(66)).join('/');
    const bytes = fixtureZip(Array.from({ length: 1000 }, (_, index) => ({
      name: `${parent}/part_${index.toString().padStart(4, '0')}.stl`,
      bytes: Buffer.from(`solid fixture_${index}\nendsolid fixture_${index}`),
    })));
    expect((await upload(id, 'large-path-inventory.zip', bytes)).statusCode).toBe(200);
    const processed = await plan(id);
    expect(processed.statusCode).toBe(200);
    const proposal = processed.json<ImportIntakeResult>();
    expect(proposal.intake.plan!.files).toHaveLength(1000);
    const body = {
      expectedRevision: proposal.revision, metadata,
      files: proposal.intake.plan!.files.map(({ id, path, include }) => ({ id, path, include })),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1024 * 1024);
    expect((await server.inject({ method: 'POST', url: `/imports/${id}/plan`, headers: headers(), payload: body })).statusCode).toBe(200);
    const published = await publish(id);
    expect(published.statusCode).toBe(200);
    const manifest = await readFile(join(managedRoot, published.json().intake.publishedPath, 'project.json'));
    expect(manifest.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(JSON.parse(manifest.toString()).files).toHaveLength(1000);
  }, 60_000);
});
