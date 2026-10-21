import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { createPool } from '@print-pantry/db';
import { classifyLibraryExtension } from '@print-pantry/indexer';
import type { LegacyImportEntry, LegacyImportProject, LegacyImportSession, LegacyImportSessions } from '@print-pantry/contracts';
export type { LegacyImportEntry } from '@print-pantry/contracts';
import { hashStoredFile, IntakeError, normalizeImportPath, organizeFiles, portablePath, safeDirectory, storeStream, validatePlanPaths, validateStorage, type ImportStorage } from './import-storage.js';
import { isOsMetadata } from './os-metadata.js';
import { openLibraryFile } from './files.js';
import type { createAuth } from './auth.js';

export type LegacyImportFile = {
  path: string; size: number; mtime: number; device: string; inode: string;
};
export type LegacyImportDiscovery = {
  tree: LegacyImportEntry;
  files: LegacyImportFile[];
  issues: Array<{ path: string; message: string }>;
  fingerprint: string;
};

const groupFolders = /^(files?|models?|meshes|sources?|stls?|3mfs?|objs?|steps?|variants?|parts?|small|medium|large|v\d+)$/i;
const projectSidecar = /^(readme(?:\.(?:md|txt|rst))?|licen[cs]e(?:\.[^.]+)?|project\.json|metadata\.json|agentic-plan\.json|.+\.(?:webloc|url))$/i;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const legacyImportLimits = { entries: 20000, depth: 24, projects: 100, files: 10000, bytes: 20 * 1024 ** 3 };

export function legacyEntries(tree: LegacyImportEntry): LegacyImportEntry[] {
  return [tree, ...tree.children.flatMap(legacyEntries)];
}

const containsPath = (root: string, path: string) => root === '' || path === root || path.startsWith(`${root}/`);
const readableName = (name: string) => name.normalize('NFC').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

export function validateLegacySelection(discovery: LegacyImportDiscovery, roots: string[]) {
  if (roots.length > legacyImportLimits.projects || new Set(roots).size !== roots.length) {
    throw new IntakeError('Choose up to 100 distinct project folders');
  }
  const directories = new Map(legacyEntries(discovery.tree).filter((entry) => entry.kind === 'directory').map((entry) => [entry.path, entry]));
  for (const root of roots) {
    if (!directories.has(root) || !directories.get(root)!.fileCount) throw new IntakeError('Choose nonempty folders from this library');
    if (roots.some((other) => other !== root && containsPath(other, root))) {
      throw new IntakeError('Choose either a parent project or its child projects, not both');
    }
    if (discovery.issues.some((issue) => containsPath(root, issue.path))) {
      throw new IntakeError('A selected folder contains unsafe or unreadable entries. Choose another folder or correct the source.');
    }
  }
}

export function checkLegacyProject(project: LegacyImportProject, preserve = false) {
  const blockers: string[] = [];
  try {
    validatePlanPaths(project.files.map((file) => ({ path: file.path, include: true })));
    if (preserve) {
      const directories = new Set<string>();
      const files = new Set(project.files.map((file) => file.path.normalize('NFC').toLowerCase()));
      for (const directory of project.directories) {
        portablePath(directory);
        const key = directory.normalize('NFC').toLowerCase();
        if (directories.has(key)) throw new IntakeError('Two source directories have the same portable destination. Choose standardization or smaller project roots.');
        directories.add(key);
        const parts = key.split('/');
        if (parts.some((_, index) => files.has(parts.slice(0, index + 1).join('/')))) throw new IntakeError('A destination file conflicts with a preserved directory');
      }
    }
  }
  catch (error) { blockers.push(error instanceof Error ? error.message : 'Invalid file organization'); }
  project.blockers = blockers;
}

export function planLegacySelection(
  discovery: LegacyImportDiscovery, roots: string[], layout: LegacyImportSession['layout'],
): LegacyImportProject[] {
  validateLegacySelection(discovery, roots);
  if (!roots.length) throw new IntakeError('Choose at least one project folder');
  const entries = legacyEntries(discovery.tree);
  return roots.map((root) => {
    const selected = discovery.files.filter((file) => containsPath(root, file.path));
    const files = selected.map((file) => ({ id: randomUUID(), originalPath: root ? file.path.slice(root.length + 1) : file.path,
      storedPath: file.path, hash: '', size: file.size }));
    const linked = files.some((file) => /\.(obj|gltf|sldasm|sldprt|iam|ipt|fcstd|catproduct|html?)$/i.test(file.originalPath));
    const htmlOnly = linked && !files.some((file) => /\.(obj|gltf|sldasm|sldprt|iam|ipt|fcstd|catproduct)$/i.test(file.originalPath));
    const organized = organizeFiles(files);
    const pathParts = root.split('/').filter(Boolean);
    const project: LegacyImportProject = {
      key: randomUUID(), sourcePath: root, name: readableName(pathParts.at(-1) ?? 'Legacy library').slice(0, 256),
      category: pathParts.length > 1 ? pathParts.slice(0, -1).map(readableName).join('/') : null,
      status: 'planned', linked, directories: entries.filter((entry) => entry.kind === 'directory' && entry.path !== root && containsPath(root, entry.path))
        .map((entry) => root ? entry.path.slice(root.length + 1) : entry.path),
      files: organized.files.map((file) => {
        let path = file.path;
        if (linked) path = layout === 'preserve' ? file.originalPath : `${htmlOnly ? 'docs' : 'models'}/${file.originalPath}`;
        else if (layout === 'preserve') path = file.originalPath;
        else path = normalizeImportPath(path.split('/').map(readableName).join('/')).replace(/\.[^./]+$/, (extension) => extension.toLowerCase());
        if (!linked && path.toLowerCase() === 'project.json') path = 'docs/source-project.json';
        return { id: file.id, originalPath: file.originalPath, path, size: file.size, hash: null };
      }),
      warnings: linked ? ['Linked resources stay together with unchanged relative names.'] : [], blockers: [],
    };
    const descendants = entries.filter((entry) => entry.kind === 'directory' && entry.path !== root && containsPath(root, entry.path));
    if (descendants.some((entry) => entry.evidence.includes('Project documentation') && entry.modelCount > 0 && !groupFolders.test(entry.name))) {
      project.warnings.push('This folder may contain separate projects. Check its nested folders.');
    }
    checkLegacyProject(project, layout === 'preserve');
    if (linked && project.files.some((file) => {
      try { portablePath(file.path); return false; } catch { return true; }
    })) project.blockers = ['Linked resources contain names that cannot be safely standardized without updating their references. Correct the source or choose another project.'];
    return project;
  });
}

export async function discoverLegacyLibrary(root: string, ignoredDirectories: string[] = []): Promise<LegacyImportDiscovery> {
  const canonical = await realpath(root);
  if (canonical !== resolve(root) || !(await lstat(root)).isDirectory()) {
    throw new IntakeError('Legacy storage must be a real directory without symlink components', 409);
  }
  const ignored = new Set(ignoredDirectories.map((name) => name.toLowerCase()));
  const files: LegacyImportFile[] = [];
  const issues: LegacyImportDiscovery['issues'] = [];
  const identities: unknown[] = [];
  let visited = 0;
  async function walk(path: string, depth: number): Promise<LegacyImportEntry> {
    if (depth > legacyImportLimits.depth) throw new IntakeError('This library exceeds the 24-level discovery limit. Choose a smaller source library.', 413);
    const absolute = join(root, path);
    const before = await lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(absolute) !== absolute) {
      throw new IntakeError('Legacy storage changed during discovery. Try again.', 409);
    }
    const node: LegacyImportEntry = { path, name: path ? basename(path) : 'Legacy library', kind: 'directory',
      fileCount: 0, modelCount: 0, sizeBytes: 0, suggested: false, evidence: [], children: [] };
    identities.push([path, String(before.dev), String(before.ino), before.mtimeMs]);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => natural.compare(left.name, right.name) || left.name.localeCompare(right.name))) {
      if (++visited > legacyImportLimits.entries) throw new IntakeError('This library exceeds the 20,000-entry discovery limit. Choose a smaller source library.', 413);
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      if (isOsMetadata(childPath) || (entry.isDirectory() && ignored.has(entry.name.toLowerCase()))) continue;
      const stat = await lstat(join(root, childPath));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || [...entry.name].some((character) => character.charCodeAt(0) < 32 || character === '\\')) {
        issues.push({ path: childPath, message: 'This entry cannot be imported safely.' });
        continue;
      }
      if (stat.isDirectory()) {
        node.children.push(await walk(childPath, depth + 1));
      } else {
        if (files.length >= legacyImportLimits.files) throw new IntakeError('This library exceeds the 10,000-file discovery limit. Choose a smaller source library.', 413);
        files.push({ path: childPath, size: stat.size, mtime: stat.mtimeMs, device: String(stat.dev), inode: String(stat.ino) });
        const model = ['mesh', 'source', 'print'].includes(classifyLibraryExtension(extname(entry.name)));
        node.children.push({ path: childPath, name: entry.name, kind: 'file', fileCount: 1, modelCount: model ? 1 : 0,
          sizeBytes: stat.size, suggested: false, evidence: [], children: [] });
      }
    }
    for (const child of node.children) {
      node.fileCount += child.fileCount;
      node.modelCount += child.modelCount;
      node.sizeBytes += child.sizeBytes;
    }
    const directModels = node.children.some((child) => child.kind === 'file' && child.modelCount > 0);
    const sidecar = node.children.some((child) => child.kind === 'file' && projectSidecar.test(child.name));
    const modelDirectories = node.children.filter((child) => child.kind === 'directory' && child.modelCount > 0);
    const grouped = modelDirectories.length > 0 && modelDirectories.every((child) => groupFolders.test(child.name));
    if (directModels) node.evidence.push('Print files');
    if (sidecar) node.evidence.push('Project documentation');
    if (grouped) node.evidence.push('Nested print folders');
    node.suggested = Boolean(path) && node.modelCount > 0 && (directModels || grouped || (sidecar && modelDirectories.length === 1))
      && !modelDirectories.some((child) => child.evidence.includes('Project documentation') && !groupFolders.test(child.name));
    if (node.suggested) {
      const clearSuggestions = (child: LegacyImportEntry) => { child.suggested = false; child.children.forEach(clearSuggestions); };
      node.children.forEach(clearSuggestions);
    }
    const after = await lstat(absolute);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) {
      throw new IntakeError('Legacy storage changed during discovery. Try again.', 409);
    }
    return node;
  }
  const tree = await walk('', 0);
  return { tree, files, issues, fingerprint: createHash('sha256').update(JSON.stringify({ root: canonical, identities, files, issues })).digest('hex') };
}

type Pool = ReturnType<typeof createPool>;
export type LegacyImportOptions = { root?: string; importStorage?: ImportStorage; ignoredDirectories?: string[] };
type Snapshot = {
  session: LegacyImportSession;
  discovery: LegacyImportDiscovery;
  sourceRoot: string;
  intakeRoot: string;
  managedRoot: string;
  identities: string[];
  catalogMetadata: unknown[];
};
type SessionRow = { snapshot: Snapshot; state: LegacyImportSession['state']; revision: number; created_at: Date; updated_at: Date };
const failureMessage = (error: unknown) => error instanceof IntakeError ? error.message : 'Files could not be prepared. Check storage access and retry; the original library is unchanged.';
const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function storageIdentities(paths: string[]) {
  return Promise.all(paths.map(async (path) => {
    if (await realpath(path) !== resolve(path)) throw new IntakeError('Storage paths must not contain symlinks', 409);
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new IntakeError('Storage is not a directory', 409);
    return `${stat.dev}:${stat.ino}`;
  }));
}

async function putImportFile(root: string, destination: string, stream: Readable, size: number, expectedHash?: string | null) {
  const temporary = `legacy-imports/.temporary/${randomUUID()}`;
  try {
    const stored = await storeStream(stream, root, temporary, size);
    if (stored.size !== size || (expectedHash && stored.hash !== expectedHash)) throw new IntakeError('File contents changed. Nothing will be overwritten; review the source before retrying.', 409);
    await safeDirectory(root, dirname(destination));
    try { await link(join(root, temporary), join(root, destination)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const verified = await hashStoredFile(root, destination);
    if (verified.hash !== stored.hash || verified.size !== stored.size) throw new IntakeError('A recovery or organized copy has changed. It will not be overwritten.', 409);
    return stored.hash;
  } finally { await rm(join(root, temporary), { force: true }); }
}

export function createLegacyImportService(pool: Pool, options: LegacyImportOptions) {
  function configuration() {
    if (!options.root) throw new IntakeError('Configure a legacy library folder before importing', 503);
    if (!options.importStorage) throw new IntakeError('Configure intake and managed storage before importing', 503);
    return { sourceRoot: resolve(options.root), intakeRoot: resolve(options.importStorage.intakeRoot), managedRoot: resolve(options.importStorage.managedRoot) };
  }
  async function read(client: Pick<PoolClient, 'query'>, id: string) {
    const row = (await client.query<SessionRow>('SELECT * FROM legacy_import_sessions WHERE id=$1', [id])).rows[0];
    if (!row) throw new IntakeError('Library import not found', 404);
    const snapshot = row.snapshot;
    Object.assign(snapshot.session, { state: row.state, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
    return snapshot;
  }
  async function save(client: PoolClient, snapshot: Snapshot) {
    const previous = snapshot.session.revision;
    snapshot.session.revision++;
    snapshot.session.updatedAt = new Date().toISOString();
    const result = await client.query(`UPDATE legacy_import_sessions SET snapshot=$2,state=$3,revision=revision+1,updated_at=now()
      WHERE id=$1 AND revision=$4`, [snapshot.session.id, JSON.stringify(snapshot), snapshot.session.state, previous]);
    if (result.rowCount !== 1) throw new IntakeError('This import changed. Refresh before continuing.', 409);
    return snapshot.session;
  }
  async function checkStorage(snapshot: Snapshot) {
    const roots = configuration();
    if (roots.sourceRoot !== snapshot.sourceRoot || roots.intakeRoot !== snapshot.intakeRoot || roots.managedRoot !== snapshot.managedRoot) {
      throw new IntakeError('Storage configuration changed. Restore the original folders or start a new import.', 409);
    }
    await validateStorage({ intakeRoot: roots.intakeRoot, managedRoot: roots.managedRoot }, roots.sourceRoot);
    const identities = await storageIdentities([roots.sourceRoot, roots.intakeRoot, roots.managedRoot]);
    if (JSON.stringify(identities) !== JSON.stringify(snapshot.identities)) throw new IntakeError('A storage mount was replaced. Restore it or start a new import.', 409);
  }
  async function operation<T>(id: string, revision: number | undefined, work: (client: PoolClient, snapshot: Snapshot) => Promise<T>) {
    const client = await pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,78221)) AS locked', [id])).rows[0].locked;
      if (!locked) throw new IntakeError('This import is busy. Try again shortly.', 409);
      const snapshot = await read(client, id);
      if (revision !== undefined && snapshot.session.revision !== revision) throw new IntakeError('This import changed. Refresh before continuing.', 409);
      await checkStorage(snapshot);
      return await work(client, snapshot);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,78221))', [id]);
      client.release();
    }
  }
  async function freshDiscovery(snapshot: Snapshot) {
    const current = await discoverLegacyLibrary(snapshot.sourceRoot, options.ignoredDirectories);
    if (current.fingerprint !== snapshot.discovery.fingerprint) throw new IntakeError('The legacy library changed. Start a new import to review the current files.', 409);
  }
  const service = {
    async list(): Promise<LegacyImportSessions> {
      const rows = await pool.query<{ id: string; state: LegacyImportSession['state']; updated_at: Date; project_count: number }>(
        `SELECT id,state,updated_at,jsonb_array_length(snapshot->'session'->'projects') AS project_count
         FROM legacy_import_sessions ORDER BY updated_at DESC,id LIMIT 10`);
      return { configured: Boolean(options.root && options.importStorage), sessions: rows.rows.map((row) => ({
        id: row.id, state: row.state, updatedAt: row.updated_at.toISOString(), projectCount: row.project_count,
      })) };
    },
    async get(id: string) { return (await read(pool, id)).session; },
    async create(id: string, actor: string) {
      const previous = await pool.query('SELECT id FROM legacy_import_sessions WHERE id=$1', [id]);
      if (previous.rowCount) return service.get(id);
      const roots = configuration();
      await validateStorage({ intakeRoot: roots.intakeRoot, managedRoot: roots.managedRoot }, roots.sourceRoot);
      const discovery = await discoverLegacyLibrary(roots.sourceRoot, options.ignoredDirectories);
      const now = new Date().toISOString();
      const snapshot: Snapshot = { ...roots, discovery, identities: await storageIdentities([roots.sourceRoot, roots.intakeRoot, roots.managedRoot]), catalogMetadata: [],
        session: { id, revision: 0, state: 'selecting', createdAt: now, updatedAt: now, tree: discovery.tree,
          selectedRoots: [], layout: 'standardize', projects: [], issues: discovery.issues, lastError: null } };
      await pool.query(`INSERT INTO legacy_import_sessions(id,created_by,snapshot) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [id, actor, JSON.stringify(snapshot)]);
      return service.get(id);
    },
    async select(id: string, revision: number, roots: string[], layout: LegacyImportSession['layout']) {
      return operation(id, revision, async (client, snapshot) => {
        if (!['selecting', 'planned'].includes(snapshot.session.state)) throw new IntakeError('Files are already being prepared. Start another import to change the selection.', 409);
        validateLegacySelection(snapshot.discovery, roots);
        Object.assign(snapshot.session, { selectedRoots: roots, layout, state: 'selecting', projects: [], lastError: null });
        return save(client, snapshot);
      });
    },
    async plan(id: string, revision: number) {
      return operation(id, revision, async (client, snapshot) => {
        if (snapshot.session.state !== 'selecting') throw new IntakeError('Return to project selection before creating another plan', 409);
        await freshDiscovery(snapshot);
        snapshot.session.projects = planLegacySelection(snapshot.discovery, snapshot.session.selectedRoots, snapshot.session.layout);
        const bytes = snapshot.session.projects.flatMap((project) => project.files).reduce((total, file) => total + file.size, 0);
        if (bytes > legacyImportLimits.bytes) throw new IntakeError('Select at most 20 GB per import batch', 413);
        snapshot.catalogMetadata = (await client.query(`SELECT p.* FROM projects p WHERE p.storage_kind='legacy'
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS selected(path) WHERE selected.path='' OR p.relative_path=selected.path OR starts_with(p.relative_path,selected.path || '/'))`, [snapshot.session.selectedRoots])).rows;
        snapshot.session.state = 'planned';
        return save(client, snapshot);
      });
    },
    async edit(id: string, revision: number, key: string, name: string, category: string | null, paths: Array<{ id: string; path: string }>) {
      return operation(id, revision, async (client, snapshot) => {
        if (snapshot.session.state !== 'planned') throw new IntakeError('Only an unprepared organization plan can be edited', 409);
        const project = snapshot.session.projects.find((item) => item.key === key);
        if (!project) throw new IntakeError('Project not found in this import', 404);
        if (!name.trim() || (category && category.split('/').some((part) => !part.trim() || ['.', '..'].includes(part.trim())))) throw new IntakeError('Enter a title and valid category names');
        project.name = name.trim();
        project.category = category?.split('/').map((part) => part.trim()).join('/') || null;
        if (new Set(paths.map((item) => item.id)).size !== paths.length) throw new IntakeError('File edits must be unique');
        for (const changed of paths) {
          const file = project.files.find((item) => item.id === changed.id);
          if (!file) throw new IntakeError('File not found in this project');
          if (project.linked && file.path !== changed.path) throw new IntakeError('Linked resources must keep their relative names and layout');
          file.path = changed.path;
        }
        checkLegacyProject(project, snapshot.session.layout === 'preserve');
        return save(client, snapshot);
      });
    },
    async organize(id: string, revision: number) {
      return operation(id, revision, async (client, snapshot) => {
        if (['organizing', 'organized'].includes(snapshot.session.state)) return snapshot.session;
        if (!['planned', 'failed'].includes(snapshot.session.state) || !snapshot.session.projects.length) throw new IntakeError('Review an organization plan first', 409);
        for (const project of snapshot.session.projects) {
          checkLegacyProject(project, snapshot.session.layout === 'preserve');
          if (project.blockers.length) throw new IntakeError('Resolve the file organization problems before preparing files', 409);
        }
        await freshDiscovery(snapshot);
        const disk = await statfs(snapshot.intakeRoot, { bigint: true });
        const bytes = snapshot.session.projects.flatMap((project) => project.files).reduce((total, file) => total + BigInt(file.size), 0n);
        if (disk.bavail * disk.bsize <= bytes * 2n + 16n * 1024n * 1024n) throw new IntakeError('Not enough intake space for recovery and organized copies', 409);
        snapshot.session.state = 'organizing';
        snapshot.session.lastError = null;
        return save(client, snapshot);
      });
    },
    async tick() {
      const next = (await pool.query<{ id: string }>("SELECT id FROM legacy_import_sessions WHERE state='organizing' ORDER BY updated_at,id LIMIT 1")).rows[0];
      if (!next) return;
      try {
        await operation(next.id, undefined, async (client, snapshot) => {
          if (snapshot.session.state !== 'organizing') return;
          try {
            await freshDiscovery(snapshot);
            const project = snapshot.session.projects.find((item) => item.status !== 'organized');
            if (!project) { snapshot.session.state = 'organized'; await save(client, snapshot); return; }
            const base = `legacy-imports/${snapshot.session.id}`;
            for (const file of project.files) {
              const sourcePath = project.sourcePath ? `${project.sourcePath}/${file.originalPath}` : file.originalPath;
              const expected = snapshot.discovery.files.find((item) => item.path === sourcePath)!;
              const source = await openLibraryFile(snapshot.sourceRoot, sourcePath);
              try {
                if (source.stats.size !== expected.size || source.stats.mtimeMs !== expected.mtime || String(source.stats.dev) !== expected.device || String(source.stats.ino) !== expected.inode) throw new IntakeError('A source file changed. Start a new import before proceeding.', 409);
                file.hash = await putImportFile(snapshot.intakeRoot, `${base}/originals/${project.key}/${file.id}`, source.handle.createReadStream({ autoClose: false }), file.size, file.hash);
                const after = await source.handle.stat();
                if (after.mtimeMs !== expected.mtime || after.size !== expected.size) throw new IntakeError('A source file changed while copying. Start a new import.', 409);
              } finally { await source.handle.close(); }
            }
            await save(client, snapshot);
            const recovery = Buffer.from(JSON.stringify({ schemaVersion: 1, sessionId: snapshot.session.id, project,
              sourceFingerprint: snapshot.discovery.fingerprint, layout: snapshot.session.layout, catalogMetadata: snapshot.catalogMetadata }, null, 2) + '\n');
            await putImportFile(snapshot.intakeRoot, `${base}/recovery/${project.key}.json`, Readable.from(recovery), recovery.length);
            for (const file of project.files) {
              const original = await openLibraryFile(snapshot.intakeRoot, `${base}/originals/${project.key}/${file.id}`);
              try { await putImportFile(snapshot.intakeRoot, `${base}/organized/${project.key}/${file.path}`, original.handle.createReadStream({ autoClose: false }), file.size, file.hash); }
              finally { await original.handle.close(); }
            }
            if (snapshot.session.layout === 'preserve') {
              for (const directory of project.directories) await safeDirectory(snapshot.intakeRoot, `${base}/organized/${project.key}/${directory}`);
            }
            await freshDiscovery(snapshot);
            project.status = 'organized';
            if (snapshot.session.projects.every((item) => item.status === 'organized')) snapshot.session.state = 'organized';
            await save(client, snapshot);
          } catch (error) {
            snapshot.session.state = 'failed';
            snapshot.session.lastError = failureMessage(error);
            await save(client, snapshot);
          }
        });
      } catch (error) {
        if (error instanceof IntakeError && error.message === 'This import is busy. Try again shortly.') return;
        await pool.query(`UPDATE legacy_import_sessions SET state='failed',revision=revision+1,
          snapshot=jsonb_set(snapshot,'{session,lastError}',to_jsonb($2::text)),updated_at=now() WHERE id=$1 AND state='organizing'`, [next.id, failureMessage(error)]);
      }
    },
  };
  return service;
}

export function createLegacyImportRunner(pool: Pool, options: LegacyImportOptions, log: Pick<FastifyInstance['log'], 'error'>) {
  const service = createLegacyImportService(pool, options);
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  function poll() {
    active = service.tick().catch((error: unknown) => { log.error({ err: error }, 'Legacy import worker failed'); })
      .finally(() => { active = undefined; if (!stopped) { timer = setTimeout(poll, 300); timer.unref(); } });
  }
  return {
    start() { if (stopped) { stopped = false; poll(); } },
    async stop() { stopped = true; if (timer) clearTimeout(timer); await active; },
    tick: service.tick,
  };
}

export function registerLegacyImports(server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>, options: LegacyImportOptions) {
  const service = createLegacyImportService(pool, options);
  const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } as const;
  const revisionProperty = { type: 'integer', minimum: 0 } as const;
  server.get('/library/imports', { preHandler: auth.operatorOnly }, () => service.list());
  server.get<{ Params: { id: string } }>('/library/imports/:id', { preHandler: auth.operatorOnly, schema: { params } }, async (request, reply) => {
    try { return await service.get(request.params.id); }
    catch (error) { return reply.code(error instanceof IntakeError ? error.status : 500).send({ error: failureMessage(error) }); }
  });
  server.post<{ Body: { id: string } }>('/library/imports', { preHandler: auth.operatorOnly, schema: { body: {
    type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } },
  } } }, async (request, reply) => {
    try { return await service.create(request.body.id, auth.currentUser(request).id); }
    catch (error) { server.log.error({ err: error }, 'Legacy discovery failed'); return reply.code(error instanceof IntakeError ? error.status : 500).send({ error: failureMessage(error) }); }
  });
  type Command = { expectedRevision: number; roots?: string[]; layout?: LegacyImportSession['layout']; key?: string; name?: string; category?: string | null; paths?: Array<{ id: string; path: string }> };
  const definitions = {
    selection: { roots: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 4096 } }, layout: { enum: ['standardize', 'preserve'] } },
    plan: {},
    edit: { key: { type: 'string', pattern: uuidPattern }, name: { type: 'string', minLength: 1, maxLength: 256 }, category: { type: ['string', 'null'], maxLength: 2000 },
      paths: { type: 'array', maxItems: 10000, items: { type: 'object', additionalProperties: false, required: ['id', 'path'], properties: { id: { type: 'string', pattern: uuidPattern }, path: { type: 'string', minLength: 1, maxLength: 700 } } } } },
    organize: {},
  } as const;
  for (const [action, properties] of Object.entries(definitions)) {
    server.post<{ Params: { id: string }; Body: Command }>(`/library/imports/:id/${action}`, {
      preHandler: auth.operatorOnly, bodyLimit: 8 * 1024 * 1024,
      schema: { params, body: { type: 'object', additionalProperties: false,
        required: ['expectedRevision', ...Object.keys(properties)], properties: { expectedRevision: revisionProperty, ...properties } } },
    }, async (request, reply) => {
      try {
        const body = request.body;
        if (action === 'selection') return await service.select(request.params.id, body.expectedRevision, body.roots!, body.layout!);
        if (action === 'plan') return await service.plan(request.params.id, body.expectedRevision);
        if (action === 'edit') return await service.edit(request.params.id, body.expectedRevision, body.key!, body.name!, body.category!, body.paths!);
        return await service.organize(request.params.id, body.expectedRevision);
      } catch (error) { return reply.code(error instanceof IntakeError ? error.status : 500).send({ error: failureMessage(error) }); }
    });
  }
}