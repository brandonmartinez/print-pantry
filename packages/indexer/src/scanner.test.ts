import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, runMigrations, schema } from '@print-pantry/db';
import { createLibraryIndexer, Invalid3mfError, read3mfThumbnail, read3mfThumbnailFromHandle,
  ScanInProgressError } from './index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must point to an isolated test database');
if (new URL(url).pathname !== '/print_pantry_test') throw new Error('TEST_DATABASE_URL must target print_pantry_test');

const pool = createPool(url);
const db = createDatabase(pool);
let root = '';
let prefix = '';
let offlineRoot = '';
const runIds: string[] = [];

function zipFixture(files: Record<string, Buffer> | [string, Buffer][]): Buffer {
  const entries = Array.isArray(files) ? files : Object.entries(files);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + content.length;
  }
  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function fixture(path: string, content: string | Buffer = 'solid fixture'): Promise<void> {
  const fullPath = join(root, prefix, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content);
}

async function scan(indexer: ReturnType<typeof createLibraryIndexer>) {
  const result = await indexer.rescan();
  runIds.push(result.id);
  return result;
}

beforeAll(async () => runMigrations(url));
afterAll(async () => pool.end());
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pp-indexer-'));
  prefix = randomUUID();
  offlineRoot = '';
});
afterEach(async () => {
  if (offlineRoot) await rm(offlineRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  const overrides = await db.select().from(schema.projectBoundaryOverrides)
    .where(like(schema.projectBoundaryOverrides.relativePath, `${prefix}/%`));
  for (const override of overrides) {
    await db.delete(schema.projectBoundaryOverrides)
      .where(eq(schema.projectBoundaryOverrides.relativePath, override.relativePath));
  }
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(like(schema.projects.relativePath, `${prefix}/%`));
  const ids = projects.map((project) => project.id);
  if (ids.length) {
    const assets = await db.select({ id: schema.assets.id }).from(schema.assets)
      .where(inArray(schema.assets.projectId, ids));
    const assetIds = assets.map((asset) => asset.id);
    if (assetIds.length) {
      await db.update(schema.assets).set({ currentVersionId: null }).where(inArray(schema.assets.id, assetIds));
      await db.delete(schema.assetVersions).where(inArray(schema.assetVersions.assetId, assetIds));
      await db.delete(schema.assets).where(inArray(schema.assets.id, assetIds));
    }
    await db.delete(schema.projects).where(inArray(schema.projects.id, ids));
  }
  const categories = await db.select().from(schema.categories)
    .where(like(schema.categories.relativePath, `${prefix}%`));
  for (const category of categories.sort((a, b) => b.relativePath.length - a.relativePath.length)) {
    await db.delete(schema.categories).where(eq(schema.categories.id, category.id));
  }
  if (runIds.length) {
    await db.delete(schema.scanErrors).where(inArray(schema.scanErrors.runId, runIds));
    await db.delete(schema.scanRuns).where(inArray(schema.scanRuns.id, runIds));
    runIds.length = 0;
  }
});

describe('read-only catalog reconciliation', () => {
  it('indexes sidecars and associated paths, then skips unchanged hashes and preserves authored metadata', async () => {
    await fixture('Models/Project/parts/Part 2.stl');
    await fixture('Models/Project/parts/Part 10.stl');
    await fixture('Models/Project/metadata.json', JSON.stringify({
      description: 'From sidecar', tags: ['useful'], designer: 'Designer', sourceUrl: 'https://example.invalid/model',
      license: 'CC0', notes: 'Original notes',
    }));
    const indexer = createLibraryIndexer({ db, root });
    const first = await scan(indexer);
    expect(first.status).toBe('succeeded');
    expect(first.hashedFiles).toBe(3);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.relativePath, `${prefix}/Models/Project`));
    expect(project).toMatchObject({ description: 'From sidecar', tags: ['useful'], designer: 'Designer', license: 'CC0' });
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, project.id));
    expect(assets.map((asset) => asset.projectRelativePath).sort()).toEqual([
      'metadata.json', 'parts/Part 10.stl', 'parts/Part 2.stl',
    ]);
    expect(assets.sort((a, b) => a.sortOrder - b.sortOrder).map((asset) => asset.name))
      .toEqual(['metadata.json', 'Part 2.stl', 'Part 10.stl']);
    await db.update(schema.projects).set({ description: 'Edited by user', tags: ['custom'] })
      .where(eq(schema.projects.id, project.id));
    const second = await scan(indexer);
    expect(second).toMatchObject({ status: 'succeeded', hashedFiles: 0 });
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0])
      .toMatchObject({ description: 'Edited by user', tags: ['custom'] });
    const versionCount = await db.select().from(schema.assetVersions);
    expect(versionCount).toHaveLength(3);
    await fixture('Models/Project/parts/Part 2.stl', 'updated mesh content');
    const third = await scan(indexer);
    expect(third.hashedFiles).toBe(1);
    const versions = await db.select().from(schema.assetVersions);
    expect(versions).toHaveLength(4);
  });

  it('keeps project, asset, and version IDs through unambiguous moves and marks missing on authoritative scans', async () => {
    await fixture('Category/Sub/Original/a.stl', 'part a');
    await fixture('Category/Sub/Original/b.stl', 'part b');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Original`));
    const initial = await db.select().from(schema.assets).where(eq(schema.assets.projectId, project.id));
    await rename(join(root, prefix, 'Category/Sub/Original'), join(root, prefix, 'Category/Sub/Renamed'));
    expect((await scan(indexer)).status).toBe('succeeded');
    const [renamed] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(renamed.relativePath).toBe(`${prefix}/Category/Sub/Renamed`);
    await rename(join(root, renamed.relativePath, 'a.stl'), join(root, renamed.relativePath, 'renamed.stl'));
    expect((await scan(indexer)).status).toBe('succeeded');
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, initial.find((item) => item.name === 'a.stl')!.id));
    expect(asset).toMatchObject({ name: 'renamed.stl', currentVersionId: initial.find((item) => item.name === 'a.stl')!.currentVersionId });
    await unlink(join(root, renamed.relativePath, 'b.stl'));
    expect((await scan(indexer)).status).toBe('succeeded');
    const [missing] = await db.select().from(schema.assets).where(eq(schema.assets.id, initial.find((item) => item.name === 'b.stl')!.id));
    expect(missing.missingAt).toBeInstanceOf(Date);
    const [version] = await db.select().from(schema.assetVersions).where(eq(schema.assetVersions.id, missing.currentVersionId!));
    expect(version.missingAt).toBeInstanceOf(Date);
    await fixture('Category/Sub/Renamed/b.stl', 'part b');
    expect((await scan(indexer)).status).toBe('succeeded');
    const [restored] = await db.select().from(schema.assets).where(eq(schema.assets.id, missing.id));
    expect(restored).toMatchObject({ currentVersionId: missing.currentVersionId, missingAt: null });
    expect((await db.select().from(schema.assetVersions).where(eq(schema.assetVersions.id, version.id)))[0].missingAt).toBeNull();
  });

  it('preserves a moved project and its files when another project reuses the old path', async () => {
    await fixture('Category/Sub/Original/model.stl', 'original model');
    const indexer = createLibraryIndexer({ db, root });
    expect((await scan(indexer)).status).toBe('succeeded');
    const [original] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Original`));
    const [originalAsset] = await db.select().from(schema.assets)
      .where(eq(schema.assets.projectId, original.id));
    await db.update(schema.projects).set({ notes: 'Keep with original' }).where(eq(schema.projects.id, original.id));
    await rename(join(root, original.relativePath), join(root, prefix, 'Category/Sub/Relocated'));
    await fixture('Category/Sub/Original/model.stl', 'replacement model');

    expect((await scan(indexer)).status).toBe('succeeded');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, original.id)))[0])
      .toMatchObject({ relativePath: `${prefix}/Category/Sub/Relocated`, notes: 'Keep with original' });
    const [replacement] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Original`));
    expect(replacement.id).not.toBe(original.id);
    const [movedAsset] = await db.select().from(schema.assets)
      .where(eq(schema.assets.id, originalAsset.id));
    expect(movedAsset).toMatchObject({
      projectId: original.id, relativePath: `${prefix}/Category/Sub/Relocated/model.stl`,
      currentVersionId: originalAsset.currentVersionId,
    });
    const [replacementAsset] = await db.select().from(schema.assets)
      .where(eq(schema.assets.projectId, replacement.id));
    expect(replacementAsset.id).not.toBe(originalAsset.id);
  });

  it('preserves a renamed asset when a different file reuses its filename', async () => {
    await fixture('Category/Sub/Project/a.stl', 'original part');
    const indexer = createLibraryIndexer({ db, root });
    expect((await scan(indexer)).status).toBe('succeeded');
    const [original] = await db.select().from(schema.assets)
      .where(eq(schema.assets.relativePath, `${prefix}/Category/Sub/Project/a.stl`));
    const parent = join(root, prefix, 'Category/Sub/Project');
    await rename(join(parent, 'a.stl'), join(parent, 'b.stl'));
    await fixture('Category/Sub/Project/a.stl', 'replacement part');

    expect((await scan(indexer)).status).toBe('succeeded');
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, original.id)))[0])
      .toMatchObject({
        relativePath: `${prefix}/Category/Sub/Project/b.stl`,
        currentVersionId: original.currentVersionId,
      });
    const [replacement] = await db.select().from(schema.assets)
      .where(eq(schema.assets.relativePath, `${prefix}/Category/Sub/Project/a.stl`));
    expect(replacement.id).not.toBe(original.id);
  });

  it('reports duplicate rename ambiguity without merging project identities', async () => {
    await fixture('Category/Sub/One/model.stl', 'duplicate');
    await fixture('Category/Sub/Two/model.stl', 'duplicate');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const [original] = await db.select().from(schema.projects).where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/One`));
    await rename(join(root, original.relativePath), join(root, prefix, 'Category/Sub/Three'));
    const result = await scan(indexer);
    expect(result.status).toBe('partial');
    const errors = await db.select().from(schema.scanErrors).where(eq(schema.scanErrors.runId, result.id));
    expect(errors.map((error) => error.code)).toContain('AMBIGUOUS_PROJECT');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, original.id)))[0].missingAt).toBeNull();
  });

  it('leaves both project identities untouched when one moves onto the vacated path of another', async () => {
    await fixture('Category/Sub/A/model.stl', 'content from A');
    await fixture('Category/Sub/B/model.stl', 'content from B');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const originalProjects = await db.select().from(schema.projects);
    const a = originalProjects.find((project) => project.relativePath === `${prefix}/Category/Sub/A`)!;
    const b = originalProjects.find((project) => project.relativePath === `${prefix}/Category/Sub/B`)!;
    await db.update(schema.projects).set({ notes: 'authored for A' }).where(eq(schema.projects.id, a.id));
    await db.update(schema.projects).set({ notes: 'authored for B' }).where(eq(schema.projects.id, b.id));
    const originalAssets = await db.select().from(schema.assets);
    await rm(join(root, prefix, 'Category/Sub/B'), { recursive: true });
    await rename(join(root, prefix, 'Category/Sub/A'), join(root, prefix, 'Category/Sub/B'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await scan(indexer);
      expect(result.status).toBe('partial');
      expect((await db.select().from(schema.scanErrors).where(eq(schema.scanErrors.runId, result.id)))
        .map((error) => error.code)).toContain('AMBIGUOUS_PROJECT');
      expect((await db.select().from(schema.projects).where(eq(schema.projects.id, a.id)))[0])
        .toMatchObject({ relativePath: a.relativePath, notes: 'authored for A', missingAt: null });
      expect((await db.select().from(schema.projects).where(eq(schema.projects.id, b.id)))[0])
        .toMatchObject({ relativePath: b.relativePath, notes: 'authored for B', missingAt: null });
      const currentAssets = await db.select().from(schema.assets);
      expect(currentAssets.map((asset) => [asset.id, asset.projectId, asset.relativePath, asset.currentVersionId])
        .sort()).toEqual(originalAssets.map((asset) => [asset.id, asset.projectId, asset.relativePath, asset.currentVersionId])
        .sort());
      expect(currentAssets.every((asset) => asset.missingAt === null)).toBe(true);
    }
    expect(await db.select().from(schema.assetVersions)).toHaveLength(2);
  });

  it('leaves both asset identities untouched when one moves onto a vacated filename', async () => {
    await fixture('Category/Sub/Project/a.stl', 'content from A');
    await fixture('Category/Sub/Project/b.stl', 'content from B');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const original = await db.select().from(schema.assets);
    const parent = join(root, prefix, 'Category/Sub/Project');
    await unlink(join(parent, 'b.stl'));
    await rename(join(parent, 'a.stl'), join(parent, 'b.stl'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await scan(indexer);
      expect(result.status).toBe('partial');
      expect((await db.select().from(schema.scanErrors).where(eq(schema.scanErrors.runId, result.id)))
        .map((error) => error.code)).toContain('AMBIGUOUS_ASSET');
      const current = await db.select().from(schema.assets);
      expect(current.map((asset) => [asset.id, asset.relativePath, asset.currentVersionId])
        .sort()).toEqual(original.map((asset) => [asset.id, asset.relativePath, asset.currentVersionId]).sort());
      expect(current.every((asset) => asset.missingAt === null)).toBe(true);
    }
    expect(await db.select().from(schema.assetVersions)).toHaveLength(2);
  });

  it('protects metadata and missing state when storage is offline, empty, or only partially scanned', async () => {
    await fixture('Category/Sub/Project/model.stl');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Project`));
    await db.update(schema.projects).set({ notes: 'Keep this note' }).where(eq(schema.projects.id, project.id));
    offlineRoot = `${root}-offline`;
    await rename(root, offlineRoot);
    expect((await scan(indexer)).status).toBe('offline');
    await rename(offlineRoot, root);
    offlineRoot = '';
    await rm(join(root, prefix), { recursive: true });
    expect((await scan(indexer)).status).toBe('partial');
    await mkdir(join(root, prefix, 'Category/Sub/Project'), { recursive: true });
    await symlink(join(tmpdir(), 'outside-library'), join(root, prefix, 'Category/Sub/Project/unsafe.stl'));
    const partial = await scan(indexer);
    expect(partial.status).toBe('partial');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0])
      .toMatchObject({ notes: 'Keep this note', missingAt: null });
    await unlink(join(root, prefix, 'Category/Sub/Project/unsafe.stl'));
  });

  it('keeps identities and authored metadata with the content when occupied project paths swap', async () => {
    await fixture('Category/Sub/A/model.stl', 'model-A');
    await fixture('Category/Sub/B/model.stl', 'model-B');
    const aFile = join(root, prefix, 'Category/Sub/A/model.stl');
    const bFile = join(root, prefix, 'Category/Sub/B/model.stl');
    const sameTime = new Date('2020-01-01T00:00:00Z');
    await utimes(aFile, sameTime, sameTime);
    await utimes(bFile, sameTime, sameTime);
    const indexer = createLibraryIndexer({ db, root });
    expect((await scan(indexer)).status).toBe('succeeded');
    const initialProjects = await db.select().from(schema.projects);
    const a = initialProjects.find((item) => item.relativePath === `${prefix}/Category/Sub/A`)!;
    const b = initialProjects.find((item) => item.relativePath === `${prefix}/Category/Sub/B`)!;
    const initialAssets = await db.select().from(schema.assets);
    const aAsset = initialAssets.find((item) => item.projectId === a.id)!;
    const bAsset = initialAssets.find((item) => item.projectId === b.id)!;
    await db.update(schema.projects).set({ notes: 'A authored', tags: ['A'] }).where(eq(schema.projects.id, a.id));
    await db.update(schema.projects).set({ notes: 'B authored', tags: ['B'] }).where(eq(schema.projects.id, b.id));
    const parent = join(root, prefix, 'Category/Sub');
    await rename(join(parent, 'A'), join(parent, 'moving'));
    await rename(join(parent, 'B'), join(parent, 'A'));
    await rename(join(parent, 'moving'), join(parent, 'B'));
    const result = await scan(indexer);
    expect(result).toMatchObject({ status: 'succeeded', hashedFiles: 2 });
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, a.id)))[0])
      .toMatchObject({ relativePath: `${prefix}/Category/Sub/B`, notes: 'A authored', tags: ['A'], missingAt: null });
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, b.id)))[0])
      .toMatchObject({ relativePath: `${prefix}/Category/Sub/A`, notes: 'B authored', tags: ['B'], missingAt: null });
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, aAsset.id)))[0])
      .toMatchObject({ projectId: a.id, relativePath: `${prefix}/Category/Sub/B/model.stl`,
        currentVersionId: aAsset.currentVersionId, missingAt: null });
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, bAsset.id)))[0])
      .toMatchObject({ projectId: b.id, relativePath: `${prefix}/Category/Sub/A/model.stl`,
        currentVersionId: bAsset.currentVersionId, missingAt: null });
  });

  it('keeps stable asset and version IDs when two filenames exchange contents', async () => {
    await fixture('Category/Sub/Project/one.stl', 'part-one');
    await fixture('Category/Sub/Project/two.stl', 'part-two');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    const initial = await db.select().from(schema.assets);
    const one = initial.find((asset) => asset.name === 'one.stl')!;
    const two = initial.find((asset) => asset.name === 'two.stl')!;
    const parent = join(root, prefix, 'Category/Sub/Project');
    await rename(join(parent, 'one.stl'), join(parent, 'moving.stl'));
    await rename(join(parent, 'two.stl'), join(parent, 'one.stl'));
    await rename(join(parent, 'moving.stl'), join(parent, 'two.stl'));
    expect((await scan(indexer)).status).toBe('succeeded');
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, one.id)))[0])
      .toMatchObject({ name: 'two.stl', currentVersionId: one.currentVersionId });
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, two.id)))[0])
      .toMatchObject({ name: 'one.stl', currentVersionId: two.currentVersionId });
  });

  it('never reads an external metadata sidecar through a symlink', async () => {
    await fixture('Category/Sub/Project/model.stl');
    const outside = await mkdtemp(join(tmpdir(), 'pp-sidecar-external-'));
    try {
      const external = join(outside, 'metadata.json');
      await writeFile(external, JSON.stringify({ description: 'external secret' }));
      await symlink(external, join(root, prefix, 'Category/Sub/Project/metadata.json'));
      const result = await scan(createLibraryIndexer({ db, root }));
      expect(result.status).toBe('partial');
      const errors = await db.select().from(schema.scanErrors).where(eq(schema.scanErrors.runId, result.id));
      expect(errors.some((error) => error.code === 'SYMLINK')).toBe(true);
      expect(errors.every((error) => !error.message.includes('external secret'))).toBe(true);
      const [project] = await db.select().from(schema.projects)
        .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Project`));
      expect(project.description).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('respects explicit collection and project boundaries and configurable ignored names', async () => {
    await fixture('Category/Sub/Collection/First/a.stl');
    await fixture('Category/Sub/Collection/Second/b.stl');
    await fixture('Category/Sub/_recovery/keep.stl');
    await fixture('Category/Sub/temp/skip.stl');
    const indexer = createLibraryIndexer({ db, root });
    expect((await scan(indexer)).status).toBe('succeeded');
    const before = await db.select().from(schema.projects);
    expect(before.filter((project) => project.relativePath.startsWith(`${prefix}/`))
      .map((project) => project.name).sort()).toEqual(['First', 'Second', '_recovery'].sort());
    await db.insert(schema.projectBoundaryOverrides).values({
      relativePath: `${prefix}/Category/Sub/Collection`, kind: 'project',
    });
    expect((await scan(indexer)).status).toBe('succeeded');
    const after = await db.select().from(schema.projects);
    const collection = after.find((project) => project.relativePath === `${prefix}/Category/Sub/Collection`);
    expect(collection?.missingAt).toBeNull();
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, collection!.id));
    expect(assets.sort((a, b) => a.sortOrder - b.sortOrder).map((asset) => asset.projectRelativePath))
      .toEqual(['First/a.stl', 'Second/b.stl']);
    await db.delete(schema.projectBoundaryOverrides).where(eq(schema.projectBoundaryOverrides.relativePath,
      `${prefix}/Category/Sub/Collection`));
  });

  it('validates malformed 3MF archives and extracts bounded embedded thumbnails', async () => {
    await fixture('Category/Sub/Project/broken.3mf', 'not a zip');
    const indexer = createLibraryIndexer({ db, root });
    const result = await scan(indexer);
    expect(result.status).toBe('partial');
    const errors = await db.select().from(schema.scanErrors).where(eq(schema.scanErrors.runId, result.id));
    expect(errors.map((error) => error.code)).toContain('INVALID_PREVIEW');
    expect(await readFile(join(root, prefix, 'Category/Sub/Project/broken.3mf'), 'utf8')).toBe('not a zip');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64',
    );
    const valid = join(root, prefix, 'Category/Sub/Project/valid.3mf');
    await writeFile(valid, zipFixture({
      '[Content_Types].xml': Buffer.from('<Types/>'),
      '3D/3dmodel.model': Buffer.from('<model/>'),
      'Metadata/thumbnail.png': png,
    }));
    expect(await read3mfThumbnail(valid)).toEqual({ mimeType: 'image/png', bytes: png });
    const duplicate = join(root, prefix, 'Category/Sub/Project/duplicate.3mf');
    await writeFile(duplicate, zipFixture([
      ['[Content_Types].xml', Buffer.from('<Types/>')],
      ['3D/3dmodel.model', Buffer.from('<model/>')],
      ['Metadata/thumbnail.png', png],
      ['Metadata/thumbnail.png', Buffer.alloc(4 * 1024 * 1024 + 1)],
    ]));
    expect(await read3mfThumbnail(duplicate)).toEqual({ mimeType: 'image/png', bytes: png });
    const second = await scan(indexer);
    expect(second.status).toBe('partial');
    const [validAsset] = await db.select().from(schema.assets).where(eq(schema.assets.relativePath,
      `${prefix}/Category/Sub/Project/valid.3mf`));
    const [version] = await db.select().from(schema.assetVersions).where(eq(schema.assetVersions.id,
      validAsset.currentVersionId!));
    expect(version.thumbnailEntry).toBe('Metadata/thumbnail.png');
  });

  it('reads 3MF previews from the supplied open handle even if its old path is replaced', async () => {
    await fixture('Category/Sub/Project/broken.3mf', 'not a zip');
    const broken = join(root, prefix, 'Category/Sub/Project/broken.3mf');
    const invalidHandle = await open(broken, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await expect(read3mfThumbnailFromHandle(invalidHandle)).rejects.toBeInstanceOf(Invalid3mfError);
      expect((await invalidHandle.stat()).size).toBeGreaterThan(0);
    } finally {
      await invalidHandle.close();
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64',
    );
    const file = join(root, prefix, 'Category/Sub/Project/valid.3mf');
    await writeFile(file, zipFixture({
      '[Content_Types].xml': Buffer.from('<Types/>'),
      '3D/3dmodel.model': Buffer.from('<model/>'),
      'Metadata/thumbnail.png': png,
    }));
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await rename(file, `${file}.moved`);
      await writeFile(file, 'replacement is not a zip');
      expect(await read3mfThumbnailFromHandle(handle)).toEqual({ mimeType: 'image/png', bytes: png });
      expect((await handle.stat()).size).toBeGreaterThan(png.length);
      await expect(read3mfThumbnail(file)).rejects.toBeInstanceOf(Invalid3mfError);
    } finally {
      await handle.close();
    }
  });

  it('persists image validation errors while retaining malformed covers and healthy mesh assets', async () => {
    await fixture('Category/Sub/Project/model.stl', 'mesh bytes');
    await fixture('Category/Sub/Project/cover.png', '<html>not an image</html>');
    const indexer = createLibraryIndexer({ db, root });
    const result = await scan(indexer);
    expect(result.status).toBe('partial');
    const [project] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Project`));
    expect(project.previewAssetId).toBeNull();
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, project.id));
    expect(assets).toHaveLength(2);
    const cover = assets.find((asset) => asset.name === 'cover.png')!;
    const model = assets.find((asset) => asset.name === 'model.stl')!;
    const [badVersion] = await db.select().from(schema.assetVersions)
      .where(eq(schema.assetVersions.id, cover.currentVersionId!));
    const [goodVersion] = await db.select().from(schema.assetVersions)
      .where(eq(schema.assetVersions.id, model.currentVersionId!));
    expect(badVersion.validationError).toContain('Image header');
    expect(goodVersion.validationError).toBeNull();
    expect(await readFile(join(root, cover.relativePath), 'utf8')).toBe('<html>not an image</html>');
    expect((await scan(indexer)).status).toBe('partial');
    expect(await db.select().from(schema.assetVersions)).toHaveLength(2);
  });

  it('rejects overlapping rescans without starting a second run', async () => {
    await fixture('Category/Sub/Project/model.stl');
    const indexer = createLibraryIndexer({ db, root });
    const first = indexer.rescan();
    await expect(indexer.rescan()).rejects.toBeInstanceOf(ScanInProgressError);
    runIds.push((await first).id);
    expect(indexer.getStatus()).toMatchObject({ running: false, lastScan: { status: 'succeeded' } });
  });

  it('allows an intentional empty-root reconciliation only with explicit opt-in', async () => {
    await fixture('Category/Sub/Project/model.stl');
    const cautious = createLibraryIndexer({ db, root });
    await scan(cautious);
    const [project] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Project`));
    await rm(join(root, prefix), { recursive: true });
    await mkdir(join(root, 'lost+found'));
    expect((await scan(cautious)).status).toBe('partial');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0].missingAt).toBeNull();
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.projectId, project.id));
    expect(asset.missingAt).toBeNull();
    const intentional = createLibraryIndexer({ db, root, allowEmptyLibrary: true });
    expect((await scan(intentional)).status).toBe('succeeded');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0].missingAt)
      .toBeInstanceOf(Date);
  });

  it('honors an explicit child project inside a recognized parent project', async () => {
    await fixture('Category/Sub/Parent/model.stl');
    await fixture('Category/Sub/Parent/Child/part.stl');
    const indexer = createLibraryIndexer({ db, root });
    await scan(indexer);
    await db.insert(schema.projectBoundaryOverrides).values({
      relativePath: `${prefix}/Category/Sub/Parent/Child`, kind: 'project',
    });
    expect((await scan(indexer)).status).toBe('succeeded');
    const [child] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Parent/Child`));
    const [asset] = await db.select().from(schema.assets)
      .where(eq(schema.assets.relativePath, `${prefix}/Category/Sub/Parent/Child/part.stl`));
    expect(asset.projectId).toBe(child.id);
  });

  it('clears a preferred preview when an explicit boundary moves its asset into a child project', async () => {
    await fixture('Category/Sub/Parent/model.stl', 'parent model');
    await fixture('Category/Sub/Parent/Child/cover.png', Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64',
    ));
    const indexer = createLibraryIndexer({ db, root });
    expect((await scan(indexer)).status).toBe('succeeded');
    const [parent] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Parent`));
    const [cover] = await db.select().from(schema.assets)
      .where(eq(schema.assets.relativePath, `${prefix}/Category/Sub/Parent/Child/cover.png`));
    expect(parent.previewAssetId).toBe(cover.id);
    await db.insert(schema.projectBoundaryOverrides).values({
      relativePath: `${prefix}/Category/Sub/Parent/Child`, kind: 'project',
    });
    expect((await scan(indexer)).status).toBe('succeeded');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, parent.id)))[0].previewAssetId)
      .toBeNull();
    const [child] = await db.select().from(schema.projects)
      .where(eq(schema.projects.relativePath, `${prefix}/Category/Sub/Parent/Child`));
    expect((await db.select().from(schema.assets).where(eq(schema.assets.id, cover.id)))[0].projectId)
      .toBe(child.id);
  });
});
