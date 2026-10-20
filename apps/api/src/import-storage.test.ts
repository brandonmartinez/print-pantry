import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  importLimits, organizeFiles, portablePath, projectSlug, receiveUpload,
  safeDirectory, validatePlanPaths, validateStorage,
} from './import-storage.js';
import { fixtureZip } from './import-fixture.js';

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'pantry-intake-unit-'));
  roots.push(path);
  return path;
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('bounded original intake and deterministic organization', () => {
  it('supports managed imports without a legacy root while still rejecting overlapping writable roots', async () => {
    const directory = await root();
    await expect(validateStorage({ intakeRoot: join(directory, 'intake'), managedRoot: join(directory, 'managed') })).resolves.toBeUndefined();
    await expect(validateStorage({ intakeRoot: directory, managedRoot: join(directory, 'nested') })).rejects.toThrow('separate, non-nested');
  });
  it('preserves a ZIP download name containing nonportable characters without using it as a storage path', async () => {
    const storage = await root();
    const name = 'Universal Drill Bit Holder | Fits Kobalt, & More.zip';
    const bytes = fixtureZip([{ name: 'holder.stl', bytes: Buffer.from('synthetic model') }]);
    const received = await receiveUpload(Readable.from(bytes), storage, randomUUID(), name);
    expect(await readFile(join(storage, received.original.path))).toEqual(bytes);
    expect(received.original.path).not.toContain(name);
    const receipt = JSON.parse(await readFile(join(storage, received.original.path, '..', 'receipt.json'), 'utf8'));
    expect(receipt.originalName).toBe(name);
    expect(organizeFiles(received.files).files[0].path).toBe('models/holder.stl');
  });

  it.each(['../bad.zip', '/bad.zip', 'bad\\name.zip', 'bad\nname.zip'])('still rejects unsafe archive upload names: %s', async (name) => {
    await expect(receiveUpload(Readable.from(Buffer.from('not needed')), await root(), randomUUID(), name)).rejects.toThrow();
  });

  it('retains nonportable ZIP entry names and proposes portable paths without changing original bytes', async () => {
    const storage = await root();
    const folder = 'Universal Drill Bit Holder | Fits Kobalt, & More';
    const bytes = fixtureZip([
      { name: `${folder}/`, bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: `${folder}/holder:6?.stl`, bytes: Buffer.from('synthetic model'), compressed: true },
      { name: `${folder}/CON.step`, bytes: Buffer.from('synthetic CAD') },
      { name: 'notes. /guide.pdf', bytes: Buffer.from('synthetic documentation') },
    ]);
    const received = await receiveUpload(Readable.from(bytes), storage, randomUUID(), `${folder}.zip`);
    expect(await readFile(join(storage, received.original.path))).toEqual(bytes);
    expect(received.files.map((file) => file.originalPath)).toEqual([
      `${folder}/holder:6?.stl`, `${folder}/CON.step`, 'notes. /guide.pdf',
    ]);
    expect(await readFile(join(storage, received.files[0].storedPath), 'utf8')).toBe('synthetic model');
    const plan = organizeFiles(received.files);
    expect(plan.files.map((file) => file.path)).toEqual([
      'models/Universal Drill Bit Holder _ Fits Kobalt, & More/holder_6_.stl',
      'models/Universal Drill Bit Holder _ Fits Kobalt, & More/_CON.step',
      'docs/notes_/guide.pdf',
    ]);
    expect(plan.warnings.some((warning) => warning.includes('Nonportable names were normalized'))).toBe(true);
    expect(() => validatePlanPaths(plan.files)).not.toThrow();
  });

  it('normalizes individual file names and leaves normalization collisions for explicit review', async () => {
    const storage = await root();
    const files = [];
    for (const name of ['part|6.stl', 'part?6.stl', 'CON.stl']) {
      const received = await receiveUpload(Readable.from(Buffer.from(name)), storage, randomUUID(), name);
      files.push(...received.files);
    }
    const plan = organizeFiles(files);
    expect(plan.files.map((file) => file.path)).toEqual(['models/part_6.stl', 'models/part_6.stl', 'models/_CON.stl']);
    expect(files.map((file) => file.originalPath)).toEqual(['part|6.stl', 'part?6.stl', 'CON.stl']);
    expect(() => validatePlanPaths(plan.files)).toThrow('same destination');
  });

  it('stores original files byte-for-byte and routes role-based paths without format subfolders', async () => {
    const storage = await root();
    const bytes = Buffer.from('synthetic mesh bytes');
    const received = await receiveUpload(Readable.from(bytes), storage, randomUUID(), 'files/Small/Part 02.stl');
    expect(await readFile(join(storage, received.original.path))).toEqual(bytes);
    expect(received.files[0]).toMatchObject({
      originalPath: 'files/Small/Part 02.stl', size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
    const plan = organizeFiles(received.files);
    expect(plan.files[0].path).toBe('models/Small/Part 02.stl');
    expect(projectSlug('Universal Drill Bit Holder — 6mm')).toBe('universal_drill_bit_holder_6mm');
    expect(projectSlug('工具架')).toBe('print');
  });

  it('expands only ZIP, validates CRC, and preserves model/document dependency groups', async () => {
    const storage = await root();
    const original = fixtureZip([
      { name: 'README.txt', bytes: Buffer.from('Read this') },
      { name: 'LICENSE.md', bytes: Buffer.from('A synthetic license') },
      { name: 'large/', bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: 'large/holder.obj', bytes: Buffer.from('mtllib holder.mtl') },
      { name: 'large/holder.mtl', bytes: Buffer.from('map_Kd textures/cover.png'), compressed: true },
      { name: 'large/textures/cover.png', bytes: Buffer.from('linked image') },
      { name: 'instructions.pdf', bytes: Buffer.from('document') },
    ]);
    const received = await receiveUpload(Readable.from(original), storage, randomUUID(), 'download.zip');
    expect(await readFile(join(storage, received.original.path))).toEqual(original);
    const plan = organizeFiles(received.files);
    expect(plan.files.map((f) => f.path)).toEqual([
      'README.txt', 'LICENSE.md', 'models/large/holder.obj', 'models/large/holder.mtl',
      'models/large/textures/cover.png', 'docs/instructions.pdf',
    ]);
    expect(plan.warnings.some((w) => w.includes('Linked model'))).toBe(true);
    const container = await receiveUpload(Readable.from(original), storage, randomUUID(), 'holder.3mf');
    expect(container.files).toHaveLength(1);
    expect(container.files[0].originalPath).toBe('holder.3mf');
  });

  it('places supporting text in docs and preserves HTML resources together', () => {
    const files = ['guide.html', 'assets/chart.png', 'assembly.txt', 'README.md', 'tool.gcode', 'body.step', 'project.json']
      .map((originalPath) => ({ id: randomUUID(), originalPath, storedPath: randomUUID(), hash: 'hash', size: 1 }));
    expect(organizeFiles(files).files.map((f) => f.path)).toEqual([
      'docs/guide.html', 'docs/assets/chart.png', 'docs/assembly.txt', 'README.md',
      'exports/tool.gcode', 'models/body.step', 'docs/project.json',
    ]);
  });

  it('keeps shared resources beside both linked models and HTML in a mixed dependency group', () => {
    const files = ['assembly/holder.obj', 'assembly/holder.mtl', 'assembly/guide.html', 'assembly/textures/cover.png', 'README.txt']
      .map((originalPath) => ({ id: randomUUID(), originalPath, storedPath: randomUUID(), hash: 'hash', size: 1 }));
    const plan = organizeFiles(files);
    expect(plan.files.map((file) => file.path)).toEqual([
      'models/assembly/holder.obj', 'models/assembly/holder.mtl', 'models/assembly/guide.html',
      'models/assembly/textures/cover.png', 'README.txt',
    ]);
    expect(plan.warnings.some((warning) => warning.startsWith('Mixed linked models and HTML'))).toBe(true);
  });

  it('excludes common OS metadata without broadly excluding hidden models, documentation, or source shortcuts', () => {
    const excluded = [
      '__MACOSX/._bit_holder.3mf', 'wrapper/__macosx/._source.webloc', 'models/._part.stl',
      '.DS_Store', 'nested/.ds_store', 'Thumbs.db', 'images/THUMBS.DB', 'ehthumbs.db',
      'ehthumbs_vista.db', 'desktop.ini', '.directory', '.apdisk', '.LSOverride', '.VolumeIcon.icns',
      '.AppleDouble/part.stl', '.Spotlight-V100/index', '.Trashes/501/part.stl',
      '.fseventsd/events', '.TemporaryItems/part.stl', '$RECYCLE.BIN/part.stl',
      'System Volume Information/index', '.Trash/part.stl', '.Trash-1000/files/part.stl',
    ];
    const included = [
      'bit_holder.stl', '.hidden.stl', '_Small/part.stl', '.parts/part.step',
      'README.md', 'source.url', 'model.webloc', '.gitignore', 'manual.ini', 'part.bak',
    ];
    const files = [...excluded, ...included].map((originalPath) => ({
      id: randomUUID(), originalPath, storedPath: randomUUID(), hash: 'hash', size: 1,
    }));
    const plan = organizeFiles(files);
    expect(plan.files.filter((file) => !file.include).map((file) => file.originalPath)).toEqual(excluded);
    expect(plan.files.filter((file) => file.include).map((file) => file.originalPath)).toEqual(included);
    expect(plan.files).toHaveLength(files.length);
    expect(plan.warnings.some((warning) => warning.includes('operating-system metadata is excluded by default'))).toBe(true);
  });

  it('does not let excluded OS sidecars influence dependency grouping or normalization warnings', () => {
    const files = ['body.stl', 'images/cover.png', '__MACOSX/._part.obj', '__MACOSX/._guide|page.html']
      .map((originalPath) => ({ id: randomUUID(), originalPath, storedPath: randomUUID(), hash: 'hash', size: 1 }));
    const plan = organizeFiles(files);
    expect(plan.files.filter((file) => file.include).map((file) => file.path)).toEqual(['models/body.stl', 'images/cover.png']);
    expect(plan.warnings.some((warning) => /Linked model|HTML|Nonportable/.test(warning))).toBe(false);
  });

  it.each(['../bad.stl', '/bad.stl', 'C:\\bad.stl', 'folder/../bad.stl', 'folder//bad.stl', 'CON.stl', 'file.stl.', 'file:stream', 'a/'.repeat(13) + 'file.stl'])(
    'rejects unsafe/nonportable paths: %s', (path) => expect(() => portablePath(path)).toThrow(),
  );

  it('rejects case/Unicode collisions, directory conflicts, and generated-manifest replacement', () => {
    for (const paths of [['models/A.stl', 'models/a.STL'], ['images/é.png', 'images/e\u0301.png'], ['models/part', 'models/part/a.stl'], ['project.json']]) {
      expect(() => validatePlanPaths(paths.map((path) => ({ path, include: true })))).toThrow();
    }
    expect(() => validatePlanPaths([{ path: 'project.json', include: false }])).not.toThrow();
  });

  it('rejects traversal, symlinks, duplicate archive entries, corrupt CRC and expansion limits', async () => {
    const storage = await root();
    const invalid = [
      fixtureZip([{ name: '../escape.stl', bytes: Buffer.from('x') }]),
      fixtureZip([{ name: 'C:/escape.stl', bytes: Buffer.from('x') }]),
      fixtureZip([{ name: 'bad\nname.stl', bytes: Buffer.from('x') }]),
      fixtureZip([{ name: 'link.stl', bytes: Buffer.from('target'), mode: 0o120777 }]),
      fixtureZip([{ name: 'x.stl', bytes: Buffer.from('x') }, { name: 'X.STL', bytes: Buffer.from('y') }]),
      fixtureZip([{ name: 'crc.stl', bytes: Buffer.from('bad checksum'), badCrc: true }]),
      fixtureZip([{ name: 'compression.stl', bytes: Buffer.alloc(1024 * 1024), compressed: true }]),
    ];
    for (const zip of invalid) {
      await expect(receiveUpload(Readable.from(zip), storage, randomUUID(), 'bad.zip')).rejects.toThrow();
    }
    await expect(receiveUpload(Readable.from(Buffer.alloc(8)), storage, randomUUID(), 'large.stl',
      { ...importLimits, uploadBytes: 4 })).rejects.toThrow('size limit');
    const zip = fixtureZip([{ name: 'file.stl', bytes: Buffer.alloc(8) }]);
    await expect(receiveUpload(Readable.from(zip), storage, randomUUID(), 'big.zip',
      { ...importLimits, expandedBytes: 4 })).rejects.toThrow('expansion');
  });

  it('keeps storage roots separate and refuses symlink directory components', async () => {
    const storage = await root();
    const legacy = join(storage, 'legacy');
    const intakeRoot = join(storage, 'intake');
    const managedRoot = join(storage, 'managed');
    await mkdir(legacy);
    await validateStorage({ intakeRoot, managedRoot }, legacy);
    await expect(validateStorage({ intakeRoot, managedRoot: join(intakeRoot, 'nested') }, legacy)).rejects.toThrow('separate');
    await symlink(legacy, join(intakeRoot, 'link'));
    await expect(safeDirectory(intakeRoot, 'link/sub')).rejects.toThrow('Symlinks');
  });
});
