import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, runMigrations, schema } from '@print-pantry/db';
import { createLibraryIndexer, read3mfThumbnail, ScanInProgressError } from './index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must point to an isolated test database');
if (new URL(url).pathname !== '/print_pantry_test') throw new Error('TEST_DATABASE_URL must target print_pantry_test');

const pool = createPool(url);
const db = createDatabase(pool);
let root = '';
let prefix = '';
let offlineRoot = '';
const runIds: string[] = [];

function zipFixture(files: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
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
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function fixture(path: string, content = 'solid fixture'): Promise<void> {
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
    const second = await scan(indexer);
    expect(second.status).toBe('partial');
    const [validAsset] = await db.select().from(schema.assets).where(eq(schema.assets.relativePath,
      `${prefix}/Category/Sub/Project/valid.3mf`));
    const [version] = await db.select().from(schema.assetVersions).where(eq(schema.assetVersions.id,
      validAsset.currentVersionId!));
    expect(version.thumbnailEntry).toBe('Metadata/thumbnail.png');
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
    expect((await scan(cautious)).status).toBe('partial');
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0].missingAt).toBeNull();
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
});
