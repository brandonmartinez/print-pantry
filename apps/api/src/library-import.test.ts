import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@print-pantry/db';
import type { LegacyImportSession } from '@print-pantry/contracts';
import { createLegacyImportService, discoverLegacyLibrary, planLegacySelection, type LegacyImportEntry } from './library-import.js';
import { buildServer } from './server.js';
import { hashPassword } from './auth.js';

const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'pantry-library-import-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}
function suggested(node: LegacyImportEntry): string[] {
  return [...(node.suggested ? [node.path] : []), ...node.children.flatMap(suggested)];
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('finds project roots at inconsistent depths and keeps nested variants together', async () => {
  const root = await fixture({
    'Holder/holder.stl': 'mesh',
    'Home/Workshop/Tools/Drill/README.md': 'Instructions',
    'Home/Workshop/Tools/Drill/files/Small/part.stl': 'small',
    'Home/Workshop/Tools/Drill/files/Large/part.step': 'large',
  });
  const discovery = await discoverLegacyLibrary(root);
  expect(suggested(discovery.tree)).toEqual(['Holder', 'Home/Workshop/Tools/Drill']);
  expect(discovery.tree.fileCount).toBe(4);
  expect(await readFile(join(root, 'Holder/holder.stl'), 'utf8')).toBe('mesh');
});

it('does not turn category documentation into a project or merge independently documented children', async () => {
  const root = await fixture({
    'Home/README.md': 'Collection notes',
    'Home/One/README.md': 'One', 'Home/One/one.stl': 'one',
    'Home/Two/README.md': 'Two', 'Home/Two/two.stl': 'two',
    'Other/Docs/README.md': 'Not a print',
  });
  expect(suggested((await discoverLegacyLibrary(root)).tree)).toEqual(['Home/One', 'Home/Two']);
});

it('reports unsafe entries without following links and ignores operating-system metadata', async () => {
  const root = await fixture({ 'Print/part.stl': 'mesh', 'Print/.DS_Store': 'metadata', 'Print/._part.stl': 'metadata' });
  await symlink('/etc', join(root, 'Print', 'external'));
  const discovery = await discoverLegacyLibrary(root);
  expect(discovery.files.map((file) => file.path)).toEqual(['Print/part.stl']);
  expect(discovery.issues).toEqual([{ path: 'Print/external', message: 'This entry cannot be imported safely.' }]);
});

it('fingerprints changed inputs and respects explicit ignored directories', async () => {
  const root = await fixture({ 'Print/part.stl': 'mesh', 'private/part.stl': 'private' });
  const first = await discoverLegacyLibrary(root, ['private']);
  await writeFile(join(root, 'Print/part.stl'), 'changed mesh');
  const second = await discoverLegacyLibrary(root, ['private']);
  expect(first.fingerprint).not.toBe(second.fingerprint);
  expect(second.tree.fileCount).toBe(1);
});

it('captures ancestor categories and sanitizes independent files without losing nested variants', async () => {
  const root = await fixture({
    'Home_Tools/Workshop/Drill_Holder/README.md': 'Read me',
    'Home_Tools/Workshop/Drill_Holder/files/Small/Part_02.STL': 'small',
    'Home_Tools/Workshop/Drill_Holder/files/Large/Part:10.STEP': 'large',
    'Home_Tools/Workshop/Drill_Holder/photo.PNG': 'image',
  });
  const [plan] = planLegacySelection(await discoverLegacyLibrary(root), ['Home_Tools/Workshop/Drill_Holder'], 'standardize');
  expect(plan).toMatchObject({ name: 'Drill Holder', category: 'Home Tools/Workshop', blockers: [] });
  expect(plan.files.map((file) => file.path).sort()).toEqual([
    'README.md', 'images/photo.png', 'models/Large/Part 10.step', 'models/Small/Part 02.stl',
  ]);
});

it('blocks overlapping roots, arbitrary paths, unsafe descendants and empty selections', async () => {
  const root = await fixture({ 'Project/files/part.stl': 'mesh' });
  const discovery = await discoverLegacyLibrary(root);
  for (const selection of [['Project', 'Project/files'], ['../outside'], []]) {
    expect(() => planLegacySelection(discovery, selection, 'standardize')).toThrow();
  }
  await symlink('/etc', join(root, 'Project', 'unsafe'));
  expect(() => planLegacySelection(discovery, ['Project'], 'preserve')).not.toThrow();
  expect(() => planLegacySelection({ ...discovery, issues: [{ path: 'Project/unsafe', message: 'Unsafe' }] }, ['Project'], 'preserve')).toThrow('unsafe');
});

it('keeps linked model and HTML resources together and leaves unsafe linked renames blocked', async () => {
  const root = await fixture({
    'Assembly/Parts/model.OBJ': 'mtllib model.mtl', 'Assembly/Parts/model.mtl': 'map_Kd ../Textures/Color.PNG',
    'Assembly/Textures/Color.PNG': 'texture', 'Assembly/guide.html': 'Parts/model.OBJ',
    'Unsafe/model:1.obj': 'linked',
  });
  const discovery = await discoverLegacyLibrary(root);
  const [plan] = planLegacySelection(discovery, ['Assembly'], 'standardize');
  expect(plan.linked).toBe(true);
  expect(plan.files.map((file) => file.path).sort()).toEqual([
    'models/Parts/model.OBJ', 'models/Parts/model.mtl', 'models/Textures/Color.PNG', 'models/guide.html',
  ]);
  expect(plan.blockers).toEqual([]);
  expect(planLegacySelection(discovery, ['Unsafe'], 'standardize')[0].blockers.length).toBe(1);
});

it('leaves case-insensitive destination collisions for explicit review', async () => {
  const root = await fixture({ 'Print/Part.stl': 'one', 'Print/part.STL': 'two' });
  const [plan] = planLegacySelection(await discoverLegacyLibrary(root), ['Print'], 'standardize');
  expect(plan.files).toHaveLength(2);
  expect(plan.blockers.join(' ')).toContain('same destination');
});

it('reviews empty-directory portability and file conflicts before preserving layout', async () => {
  const root = await fixture({ 'Unsafe/part.stl': 'mesh', 'Conflict/empty': 'file', 'Case/part.stl': 'mesh' });
  await mkdir(join(root, 'Unsafe/bad:name'));
  await mkdir(join(root, 'Conflict/EMPTY'));
  await mkdir(join(root, 'Case/Empty'));
  await mkdir(join(root, 'Case/empty'));
  const discovery = await discoverLegacyLibrary(root);
  expect(planLegacySelection(discovery, ['Unsafe'], 'preserve')[0].blockers.join(' ')).toContain('nonportable');
  expect(planLegacySelection(discovery, ['Conflict'], 'preserve')[0].blockers.join(' ')).toContain('preserved directory');
  expect(planLegacySelection(discovery, ['Case'], 'preserve')[0].blockers.join(' ')).toContain('same portable destination');
  expect(planLegacySelection(discovery, ['Unsafe', 'Conflict', 'Case'], 'standardize').every((project) => !project.blockers.length)).toBe(true);
});

describe('saved operator library imports', () => {
  const database = process.env.TEST_DATABASE_URL;
  if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
  const pool = createPool(database);
  const actor = randomUUID();
  const requester = randomUUID();
  const username = `legacy-${randomUUID().slice(0, 8)}`;
  let source: string;
  let intake: string;
  let managed: string;
  let server: ReturnType<typeof buildServer>;
  let service: ReturnType<typeof createLegacyImportService>;
  let cookie: string;
  let requesterCookie: string;
  beforeAll(async () => {
    await runMigrations(database);
    const password = await hashPassword('Synthetic legacy import password');
    await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4),($5,$6,$3,$7)',
      [actor, username, password, 'operator', requester, `${username}-member`, 'requester']);
  });
  beforeEach(async () => {
    source = await fixture({ 'Home/Holder/README.md': 'Instructions', 'Home/Holder/files/Part_02.STL': 'synthetic mesh' });
    await mkdir(join(source, 'Home/Holder/empty'));
    intake = await fixture({});
    managed = await fixture({});
    const options = { root: source, importStorage: { intakeRoot: intake, managedRoot: managed } };
    service = createLegacyImportService(pool, options);
    server = buildServer(pool, { ...options, pool, managedRoot: managed, secureCookie: false,
      indexer: { getStatus: () => ({ running: false, lastScan: null }), rescan: async () => { throw new Error('Tests never scan real libraries'); } } });
    for (const name of [username, `${username}-member`]) {
      const response = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: name, password: 'Synthetic legacy import password' } });
      expect(response.statusCode).toBe(200);
      const value = response.headers['set-cookie']!.toString().split(';')[0];
      if (name === username) cookie = value; else requesterCookie = value;
    }
  });
  afterEach(async () => {
    await server.close();
    await pool.query('DELETE FROM legacy_import_sessions WHERE created_by=$1', [actor]);
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [[actor, requester]]);
  });
  afterAll(async () => { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[actor, requester]]); await pool.end(); });

  async function create() {
    const response = await server.inject({ method: 'POST', url: '/library/imports', headers: { cookie }, payload: { id: randomUUID() } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<LegacyImportSession>();
  }
  async function command(session: LegacyImportSession, action: string, body = {}) {
    const response = await server.inject({ method: 'POST', url: `/library/imports/${session.id}/${action}`, headers: { cookie },
      payload: { expectedRevision: session.revision, ...body } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<LegacyImportSession>();
  }
  async function plan() {
    const session = await command(await create(), 'selection', { roots: ['Home/Holder'], layout: 'standardize' });
    return command(session, 'plan');
  }

  it('requires operator access and never exposes host paths in session responses', async () => {
    const session = await create();
    for (const route of ['/library/imports', `/library/imports/${session.id}`]) {
      expect((await server.inject({ url: route })).statusCode).toBe(401);
      expect((await server.inject({ url: route, headers: { cookie: requesterCookie } })).statusCode).toBe(403);
    }
    expect((await server.inject({ method: 'POST', url: `/library/imports/${session.id}/plan`, headers: { cookie: requesterCookie }, payload: { expectedRevision: session.revision } })).statusCode).toBe(403);
    expect(JSON.stringify(session)).not.toContain(source);
    expect(JSON.stringify(session)).not.toContain(intake);
    const repeated = await server.inject({ method: 'POST', url: '/library/imports', headers: { cookie }, payload: { id: session.id } });
    expect(repeated.json().id).toBe(session.id);
  });

  it('persists root choices and edits while rejecting overlapping roots and stale revisions', async () => {
    const session = await create();
    const invalid = await server.inject({ method: 'POST', url: `/library/imports/${session.id}/selection`, headers: { cookie }, payload: { expectedRevision: 0, roots: ['Home', 'Home/Holder'], layout: 'standardize' } });
    expect(invalid.statusCode).toBe(400);
    const planned = await plan();
    const project = planned.projects[0];
    const edited = await command(planned, 'edit', { key: project.key, name: 'Desk holder', category: 'Home/Desk', paths: [] });
    expect((await service.get(edited.id)).projects[0]).toMatchObject({ name: 'Desk holder', category: 'Home/Desk' });
    const stale = await server.inject({ method: 'POST', url: `/library/imports/${edited.id}/organize`, headers: { cookie }, payload: { expectedRevision: planned.revision } });
    expect(stale.statusCode).toBe(409);
  });

  it('creates verified recovery and organized copies and resumes from a new service instance without publishing', async () => {
    let session = await command(await plan(), 'organize');
    expect(session.state).toBe('organizing');
    const resumed = createLegacyImportService(pool, { root: source, importStorage: { intakeRoot: intake, managedRoot: managed } });
    await resumed.tick();
    session = await resumed.get(session.id);
    expect(session.state).toBe('organized');
    const project = session.projects[0];
    const base = join(intake, 'legacy-imports', session.id);
    const model = project.files.find((file) => file.originalPath.endsWith('.STL'))!;
    expect(await readFile(join(base, 'organized', project.key, model.path), 'utf8')).toBe('synthetic mesh');
    expect(await readFile(join(base, 'originals', project.key, model.id), 'utf8')).toBe('synthetic mesh');
    const recovery = JSON.parse(await readFile(join(base, 'recovery', `${project.key}.json`), 'utf8'));
    expect(recovery.project.directories).toContain('empty');
    expect(recovery.project.files.every((file: { hash: string }) => /^[a-f0-9]{64}$/.test(file.hash))).toBe(true);
    expect(await readFile(join(source, 'Home/Holder/files/Part_02.STL'), 'utf8')).toBe('synthetic mesh');
    expect(await readdir(managed)).toEqual([]);
    expect((await service.list()).sessions.some((item) => item.id === session.id && item.state === 'organized')).toBe(true);
  });

  it('blocks changed sources before copying and retains a retryable failure after a mount changes', async () => {
    const planned = await plan();
    await writeFile(join(source, 'Home/Holder/files/Part_02.STL'), 'changed mesh bytes');
    const response = await server.inject({ method: 'POST', url: `/library/imports/${planned.id}/organize`, headers: { cookie }, payload: { expectedRevision: planned.revision } });
    expect(response.statusCode).toBe(409);
    expect(await readdir(intake)).toEqual([]);
    const queued = await command(await plan(), 'organize');
    const different = await fixture({});
    await createLegacyImportService(pool, { root: different, importStorage: { intakeRoot: intake, managedRoot: managed } }).tick();
    const failed = await service.get(queued.id);
    expect(failed.state).toBe('failed');
    expect(failed.lastError).toContain('configuration changed');
  });

  it('does not overwrite a foreign recovery file and can retry when the obstruction is removed', async () => {
    let session = await command(await plan(), 'organize');
    const project = session.projects[0];
    const file = project.files[0];
    const blocked = join(intake, 'legacy-imports', session.id, 'originals', project.key, file.id);
    await mkdir(dirname(blocked), { recursive: true });
    await writeFile(blocked, 'foreign bytes');
    await service.tick();
    session = await service.get(session.id);
    expect(session.state).toBe('failed');
    expect(await readFile(blocked, 'utf8')).toBe('foreign bytes');
    await rm(blocked);
    session = await command(session, 'organize');
    await service.tick();
    expect((await service.get(session.id)).state).toBe('organized');
  });
});