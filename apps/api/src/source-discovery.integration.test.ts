import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@print-pantry/db';
import type { ImportMatch, SourceDiscoveryPreview } from '@print-pantry/contracts';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';
import { binaryWebloc } from './import-fixture.js';

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
const pool = createPool(database);
const users = ['operator', 'requester'].map((role) => ({ id: randomUUID(), name: `source-${randomUUID().slice(0, 8)}`, role }));
const projectIds: string[] = [];
const source = 'https://makerworld.com/en/models/2747706-holder#profileId-3048005';
let root: string;
let managedRoot: string;
let server: ReturnType<typeof buildServer>;
let cookies: string[];
const indexer = {
  getStatus: () => ({ running: false, lastScan: null }),
  rescan: async () => { throw new Error('Discovery tests never scan a library'); },
};
const headers = (operator = true) => ({ cookie: cookies[operator ? 0 : 1] });
const base = (id: string) => `/catalog/projects/${id}/source-discovery`;
const xml = (url: string) => Buffer.from(`<plist><dict><key>URL</key><string>${url.replaceAll('&', '&amp;')}</string></dict></plist>`);

beforeAll(async () => {
  await runMigrations(database);
  root = await mkdtemp(join(tmpdir(), 'pantry-source-discovery-'));
  managedRoot = await mkdtemp(join(tmpdir(), 'pantry-managed-source-'));
  const hash = await hashPassword('synthetic discovery passphrase');
  for (const user of users) await pool.query('INSERT INTO users (id,username,password_hash,role) VALUES ($1,$2,$3,$4)', [user.id, user.name, hash, user.role]);
  server = buildServer(pool, { pool, root, indexer, secureCookie: false });
  cookies = [];
  for (const user of users) {
    const result = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: user.name, password: 'synthetic discovery passphrase' } });
    expect(result.statusCode).toBe(200);
    cookies.push(result.headers['set-cookie']!.toString().split(';')[0]);
  }
});
afterAll(async () => {
  try {
    await server?.close();
    await pool.query('DELETE FROM source_discovery_previews WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM project_sources WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM assets WHERE project_id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM projects WHERE id=ANY($1::bigint[])', [projectIds]);
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users.map((user) => user.id)]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.map((user) => user.id)]);
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
    if (managedRoot) await rm(managedRoot, { recursive: true, force: true });
  }
});

async function project(relativePath = `Legacy/${randomUUID()}`, storageKind: 'legacy' | 'managed' = 'legacy') {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (relative_path,name,description,tags,designer,notes,storage_kind)
     VALUES ($1,'Operator title','Keep description',ARRAY['keep-tag'],'Keep designer','Keep notes',$2) RETURNING id`, [relativePath, storageKind],
  );
  const id = result.rows[0].id;
  projectIds.push(id);
  return { id, relativePath, storageKind };
}
async function asset(owner: Awaited<ReturnType<typeof project>>, path: string, bytes: Buffer, storageRoot = root) {
  const relative = `${owner.relativePath}/${path}`;
  await mkdir(dirname(join(storageRoot, relative)), { recursive: true });
  await writeFile(join(storageRoot, relative), bytes);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assets (id,project_id,relative_path,project_relative_path,name,kind,extension,size_bytes,mtime_ms,storage_kind)
     VALUES ($1,$2,$3,$4,$5,'document',$6,$7,0,$8)`,
    [id, owner.id, relative, path, basename(path), extname(path), bytes.length, owner.storageKind],
  );
  return { id, path: join(storageRoot, relative), relative, bytes };
}
async function discover(id: string) {
  const result = await server.inject({ method: 'POST', url: base(id), headers: headers() });
  expect(result.statusCode).toBe(200);
  return result.json<SourceDiscoveryPreview>();
}
const approve = (preview: SourceDiscoveryPreview, candidateIds = [preview.candidates[0].id]) =>
  server.inject({ method: 'POST', url: `${base(preview.projectId)}/${preview.id}/apply`, headers: headers(), payload: { candidateIds } });

describe('approved existing-source discovery', () => {
  it('requires operator access and validates bigint project identity', async () => {
    const owner = await project();
    expect((await server.inject({ method: 'POST', url: base(owner.id) })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: base(owner.id), headers: headers(false) })).statusCode).toBe(403);
    expect((await server.inject({ url: base(owner.id), headers: headers(false) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: base('9223372036854775808'), headers: headers() })).statusCode).toBe(404);
  });

  it('previews XML/binary shortcuts and nested boundaries, reports conflicts and malformed evidence, and survives restart', async () => {
    const owner = await project();
    const files = [
      await asset(owner, 'variants/Small/model.webloc', xml(source)),
      await asset(owner, 'variants/Large/model.webloc', binaryWebloc('https://makerworld.com/en/models/2747706#profileId-777', 'URLString')),
      await asset(owner, 'source.url', Buffer.from('[InternetShortcut]\nURL=https://makerworld.com/en/models/123-another')),
      await asset(owner, 'metadata.json', Buffer.from('{"sourceUrl":"https://www.thingiverse.com/thing:345"}')),
      await asset(owner, 'README.md', Buffer.from('https://makerworld.com/en/models/999-arbitrary-doc-link')),
      await asset(owner, 'broken.webloc', Buffer.from('<plist>broken')),
    ];
    const nested = await project(`${owner.relativePath}/Separate Project`);
    await asset(nested, 'source.webloc', xml('https://makerworld.com/en/models/888-separate-project'));
    const preview = await discover(owner.id);
    expect(preview.candidates).toHaveLength(3);
    const maker = preview.candidates.find((candidate) => candidate.source.modelId === '2747706')!;
    expect(maker.evidence.map((evidence) => evidence.profileId).sort()).toEqual(['3048005', '777']);
    expect(maker.conflicting).toBe(true);
    expect(preview.candidates.find((candidate) => candidate.source.provider === 'thingiverse')!.conflicting).toBe(false);
    expect(preview.issues).toEqual([expect.objectContaining({ relativePath: `${owner.relativePath}/broken.webloc` })]);
    expect((await pool.query('SELECT id FROM project_sources WHERE project_id=$1', [owner.id])).rowCount).toBe(0);
    for (const file of files) expect(await readFile(file.path)).toEqual(file.bytes);
    const restarted = buildServer(pool, { pool, root, indexer, secureCookie: false });
    try {
      const restored = await restarted.inject({ url: base(owner.id), headers: headers() });
      expect(restored.json().preview.id).toBe(preview.id);
    } finally { await restarted.close(); }
  });

  it('applies only selected associations idempotently, preserves metadata, and enables existing-import duplicate detection', async () => {
    const owner = await project();
    await asset(owner, 'source.webloc', xml(source));
    const before = (await pool.query('SELECT * FROM projects WHERE id=$1', [owner.id])).rows[0];
    const preview = await discover(owner.id);
    expect((await approve(preview, [])).statusCode).toBe(400);
    const applied = await approve(preview);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().appliedAt).toBeTruthy();
    expect((await approve(preview)).statusCode).toBe(200);
    expect((await approve(preview, [randomUUID()])).statusCode).toBe(409);
    const associations = await pool.query('SELECT * FROM project_sources WHERE project_id=$1', [owner.id]);
    expect(associations.rowCount).toBe(1);
    expect(JSON.parse(associations.rows[0].evidence).previewId).toBe(preview.id);
    expect(JSON.parse(associations.rows[0].evidence).evidence[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await pool.query('SELECT * FROM projects WHERE id=$1', [owner.id])).rows[0]).toEqual(before);
    const matches = await server.inject({ method: 'POST', url: '/imports/check', headers: headers(false), payload: { url: source } });
    expect(matches.statusCode).toBe(200);
    expect(matches.json<ImportMatch>().projects.some((match) => match.id === owner.id)).toBe(true);
    const next = await discover(owner.id);
    expect(next.candidates[0].alreadyAssociated).toBe(true);
    expect((await approve(next)).statusCode).toBe(200);
    expect((await pool.query('SELECT * FROM project_sources WHERE project_id=$1', [owner.id])).rows).toEqual(associations.rows);
  });

  it('rechecks byte evidence and project ownership before approval without writing partial associations', async () => {
    const owner = await project();
    const file = await asset(owner, 'source.webloc', xml(source));
    const preview = await discover(owner.id);
    await writeFile(file.path, xml('https://makerworld.com/en/models/321-changed'));
    expect((await approve(preview)).statusCode).toBe(409);
    expect((await pool.query('SELECT id FROM project_sources WHERE project_id=$1', [owner.id])).rowCount).toBe(0);
    await writeFile(file.path, file.bytes);
    await pool.query('UPDATE projects SET source_url=$2 WHERE id=$1', [owner.id, 'https://example.test/changed-display']);
    expect((await approve(preview)).statusCode).toBe(409);
    expect((await pool.query('SELECT applied_at FROM source_discovery_previews WHERE id=$1', [preview.id])).rows[0].applied_at).toBeNull();
  });

  it('reports unsafe/unavailable/oversized sidecars while allowing an explicitly approved catalog URL', async () => {
    const owner = await project();
    await pool.query('UPDATE projects SET source_url=$2 WHERE id=$1', [owner.id, source]);
    const link = await asset(owner, 'link.webloc', xml(source));
    await rm(link.path);
    await symlink('/dev/null', link.path);
    await asset(owner, 'large.webloc', Buffer.alloc(128 * 1024 + 1));
    const preview = await discover(owner.id);
    expect(preview.issues).toHaveLength(2);
    expect(preview.candidates[0].evidence).toEqual([expect.objectContaining({ relativePath: null, hash: null })]);
    expect((await approve(preview)).statusCode).toBe(200);
  });

  it('serializes discovery and rejects selections that do not belong to the persisted preview', async () => {
    const owner = await project();
    await asset(owner, 'source.webloc', xml(source));
    const preview = await discover(owner.id);
    expect((await approve(preview, [randomUUID()])).statusCode).toBe(400);
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,98421))', [owner.id]);
      expect((await server.inject({ method: 'POST', url: base(owner.id), headers: headers() })).statusCode).toBe(409);
      expect((await approve(preview)).statusCode).toBe(409);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,98421))', [owner.id]);
      client.release();
    }
  });

  it('uses managed storage for managed projects and never falls back to the legacy root', async () => {
    const owner = await project(`projects/${randomUUID()}`, 'managed');
    const file = await asset(owner, 'source.webloc', xml('https://makerworld.com/en/models/432-managed'), managedRoot);
    await mkdir(dirname(join(root, file.relative)), { recursive: true });
    await writeFile(join(root, file.relative), xml('https://makerworld.com/en/models/999-wrong-root'));
    const unavailable = await discover(owner.id);
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.issues[0].message).toContain('not configured');
    const configured = buildServer(pool, { pool, root, managedRoot, indexer, secureCookie: false });
    try {
      const result = await configured.inject({ method: 'POST', url: base(owner.id), headers: headers() });
      expect(result.statusCode).toBe(200);
      expect(result.json<SourceDiscoveryPreview>().candidates.map((candidate) => candidate.source.modelId)).toEqual(['432']);
    } finally { await configured.close(); }
  });

  it('reports partial previews at the exact sidecar, URL-field, and distinct-candidate limits', async () => {
    const manyFiles = await project();
    for (let i = 1; i <= 101; i++) await asset(manyFiles, `${String(i).padStart(3, '0')}.url`,
      Buffer.from(`[InternetShortcut]\nURL=https://makerworld.com/en/models/1001#profileId-${i}`));
    const limitedFiles = await discover(manyFiles.id);
    expect(limitedFiles.candidates).toHaveLength(1);
    expect(limitedFiles.candidates[0].evidence).toHaveLength(100);
    expect(limitedFiles.candidates[0].evidence.some((evidence) => evidence.profileId === '101')).toBe(false);
    expect(limitedFiles.issues.some((issue) => issue.message.includes('first 100 indexed sidecars'))).toBe(true);

    const manyFields = await project();
    for (const directory of ['a', 'b', 'c']) await asset(manyFields, `${directory}/agentic-plan.json`, Buffer.from(JSON.stringify({
      files: Array.from({ length: 128 }, (_, i) => ({ sourceUrl: `https://makerworld.com/en/models/1002#profileId-${i + 1}` })),
    })));
    const limitedFields = await discover(manyFields.id);
    expect(limitedFields.candidates[0].evidence).toHaveLength(256);
    expect(limitedFields.issues.some((issue) => issue.message.includes('first 256 URL fields'))).toBe(true);

    const manyCandidates = await project();
    await asset(manyCandidates, 'a/agentic-plan.json', Buffer.from(JSON.stringify({
      files: Array.from({ length: 128 }, (_, i) => ({ sourceUrl: `https://example.test/${i}` })),
    })));
    await asset(manyCandidates, 'b/source.url', Buffer.from('[InternetShortcut]\nURL=https://example.test/129'));
    const limitedCandidates = await discover(manyCandidates.id);
    expect(limitedCandidates.candidates).toHaveLength(128);
    expect(limitedCandidates.issues.some((issue) => issue.message.includes('128 source-candidate limit'))).toBe(true);
  });
});
