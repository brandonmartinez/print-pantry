import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { and, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { createDatabase, schema } from '@print-pantry/db';
import { inspectThreeMf, validateImage } from './preview.js';

export type ScanStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'offline';
export type ScanResult = {
  id: string;
  status: ScanStatus;
  filesSeen: number;
  hashedFiles: number;
  errorsCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  message: string | null;
};
export type IndexerStatus = { running: boolean; lastScan: ScanResult | null };
export type IndexerOptions = {
  db: ReturnType<typeof createDatabase>;
  root: string;
  ignoredDirectoryNames?: readonly string[];
  hashConcurrency?: number;
  allowEmptyLibrary?: boolean;
};

type Kind = typeof schema.assets.$inferInsert.kind;
type ScanError = { relativePath: string | null; code: string; message: string };
type FileInfo = {
  path: string;
  fullPath: string;
  stat: Stats;
  kind: Kind;
  extension: string;
  hash: string;
  thumbnailEntry: string | null;
  validationError: string | null;
};
type Directory = { path: string; stat: Stats; files: FileInfo[]; children: Directory[] };
type Metadata = Partial<Pick<typeof schema.projects.$inferInsert,
  'description' | 'tags' | 'designer' | 'sourceUrl' | 'license' | 'notes'>>;
type FoundProject = { directory: Directory; files: FileInfo[]; metadata: Metadata };

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const defaultIgnored = ['recovery', 'temp', 'private', '.Trashes', '.Spotlight-V100'];
const kinds: Record<string, Kind> = {
  '.stl': 'mesh', '.3mf': 'mesh', '.obj': 'mesh', '.step': 'source', '.stp': 'source',
  '.f3d': 'source', '.f3z': 'source', '.scad': 'source', '.blend': 'source',
  '.fcstd': 'source', '.iges': 'source', '.igs': 'source', '.dxf': 'source',
  '.svg': 'image', '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.pdf': 'document', '.md': 'document',
  '.txt': 'document', '.json': 'document', '.url': 'document',
  '.gcode': 'print', '.bgcode': 'print', '.gx': 'print',
};
const formatFolders = new Set(['files', 'stl', '3mf', 'obj', 'source', 'sources', 'models', 'variants']);
const MAX_SIDECAR_BYTES = 128 * 1024;

function comparePaths(a: { path: string }, b: { path: string }): number {
  return collator.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function statMatches(first: Stats, second: Stats): boolean {
  return first.isFile() === second.isFile() && first.isDirectory() === second.isDirectory()
    && first.size === second.size && first.mtimeMs === second.mtimeMs
    && first.ino === second.ino && first.dev === second.dev;
}

function safeError(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(root).join('<library>');
}

async function hashFile(file: FileInfo): Promise<string> {
  const handle = await open(file.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!statMatches(file.stat, await handle.stat())) throw new Error('File changed during scan');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.fullPath, { fd: handle.fd, autoClose: false })) hash.update(chunk);
    if (!statMatches(file.stat, await handle.stat())
      || !statMatches(file.stat, await lstat(file.fullPath))) throw new Error('File changed during scan');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function sidecarMetadata(directory: Directory, errors: ScanError[], libraryRoot: string): Promise<Metadata> {
  const metadata: Metadata = {};
  for (const file of directory.files) {
    const name = basename(file.path).toLowerCase();
    if (!['project.json', 'metadata.json', 'readme.md', 'source.url'].includes(name)) continue;
    try {
      if (file.stat.size > MAX_SIDECAR_BYTES) throw new Error('Sidecar exceeds 128 KiB');
      const handle = await open(file.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try {
        if (!statMatches(file.stat, await handle.stat())) throw new Error('Sidecar changed during scan');
        const bytes = Buffer.alloc(MAX_SIDECAR_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < bytes.length) {
          const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
          if (!result.bytesRead) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_SIDECAR_BYTES) throw new Error('Sidecar exceeds 128 KiB');
        if (bytesRead !== file.stat.size || !statMatches(file.stat, await handle.stat())
          || !statMatches(file.stat, await lstat(file.fullPath))) throw new Error('Sidecar changed during scan');
        contents = bytes.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      if (name.endsWith('.json')) {
        const data: unknown = JSON.parse(contents);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Sidecar must contain an object');
        const fields = data as Record<string, unknown>;
        for (const field of ['description', 'designer', 'sourceUrl', 'license', 'notes'] as const) {
          if (typeof fields[field] === 'string') metadata[field] = fields[field];
        }
        if (Array.isArray(fields.tags) && fields.tags.every((tag) => typeof tag === 'string')) {
          metadata.tags = fields.tags as string[];
        }
      } else if (name === 'readme.md') metadata.notes ??= contents;
      else metadata.sourceUrl ??= contents.match(/^URL=(.+)$/im)?.[1]?.trim();
    } catch (error) {
      errors.push({ relativePath: file.path, code: 'INVALID_SIDECAR', message: safeError(error, libraryRoot) });
    }
  }
  return metadata;
}

function signature(files: { path: string; hash: string; size: number }[]): string {
  return JSON.stringify(files.map((file) => [file.path, file.hash, file.size])
    .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
}

export class ScanInProgressError extends Error {
  constructor() {
    super('A library scan is already running');
    this.name = 'ScanInProgressError';
  }
}

export function createLibraryIndexer({ db, root, ignoredDirectoryNames = defaultIgnored,
  hashConcurrency = 4, allowEmptyLibrary = false }: IndexerOptions) {
  if (!root || !Number.isSafeInteger(hashConcurrency) || hashConcurrency < 1 || hashConcurrency > 32) {
    throw new Error('A library root and hashConcurrency between 1 and 32 are required');
  }
  const libraryRoot = resolve(root);
  const ignored = new Set(ignoredDirectoryNames.map((name) => name.toLowerCase()));
  let running = false;
  let lastScan: ScanResult | null = null;

  async function rescan(): Promise<ScanResult> {
    if (running) throw new ScanInProgressError();
    running = true;
    const startedAt = new Date();
    const id = randomUUID();
    const result: ScanResult = { id, status: 'running', filesSeen: 0, hashedFiles: 0,
      errorsCount: 0, startedAt, finishedAt: null, message: null };
    const errors: ScanError[] = [];
    try {
      await db.insert(schema.scanRuns).values({ id, status: 'running', startedAt });
      let rootStat: Stats;
      try {
        rootStat = await lstat(libraryRoot);
        if (!rootStat.isDirectory()) {
          throw new Error('Library root must be a real directory, not a symlink');
        }
        await readdir(libraryRoot);
      } catch (error) {
        result.status = 'offline';
        result.message = safeError(error, libraryRoot);
        errors.push({ relativePath: null, code: 'LIBRARY_OFFLINE', message: result.message });
        return await finish();
      }
      const previousProjects = await db.select().from(schema.projects);
      const previousAssets = await db.select().from(schema.assets);
      const previousVersions = await db.select().from(schema.assetVersions);
      const previousVersionById = new Map(previousVersions.map((version) => [version.id, version]));
      const overrides = new Map((await db.select().from(schema.projectBoundaryOverrides))
        .map((override) => [override.relativePath, override.kind]));
      const oldAssetsByPath = new Map(previousAssets.map((asset) => [asset.relativePath, asset]));
      const allFiles: FileInfo[] = [];
      const directories: Directory[] = [];

      async function walk(path: string, stat: Stats): Promise<Directory> {
        const node: Directory = { path, stat, files: [], children: [] };
        directories.push(node);
        let entries;
        try {
          entries = await readdir(join(libraryRoot, path), { withFileTypes: true });
        } catch (error) {
          errors.push({ relativePath: path || null, code: 'READ_DIRECTORY', message: safeError(error, libraryRoot) });
          return node;
        }
        for (const entry of entries.sort((a, b) => collator.compare(a.name, b.name)
          || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          const childPath = path ? `${path}/${entry.name}` : entry.name;
          if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) continue;
          const fullPath = join(libraryRoot, childPath);
          try {
            const childStat = await lstat(fullPath);
            if (childStat.isSymbolicLink()) {
              errors.push({ relativePath: childPath, code: 'SYMLINK', message: 'Symlink skipped; paths must stay inside the library root' });
            } else if (childStat.isDirectory()) {
              node.children.push(await walk(childPath, childStat));
            } else if (childStat.isFile() && entry.name !== '.DS_Store') {
              const extension = extname(entry.name).toLowerCase();
              const file: FileInfo = { path: childPath, fullPath, stat: childStat, extension,
                kind: kinds[extension] ?? 'other', hash: '', thumbnailEntry: null, validationError: null };
              node.files.push(file);
              allFiles.push(file);
            }
          } catch (error) {
            errors.push({ relativePath: childPath, code: 'STAT_FAILED', message: safeError(error, libraryRoot) });
          }
        }
        return node;
      }

      const tree = await walk('', rootStat);
      const found: FoundProject[] = [];
      function collect(node: Directory, parentProject: FoundProject | null) {
        const depth = node.path.split('/').length;
        const override = overrides.get(node.path);
        const directModel = node.files.some((file) => ['mesh', 'source', 'print'].includes(file.kind));
        const hasFormatChild = node.children.some((child) => formatFolders.has(basename(child.path).toLowerCase()));
        const baseProject = override === 'collection' ? null : parentProject;
        const project = node.path && (override === 'project'
          || (!baseProject
            && override !== 'collection'
            && ((depth >= 2 && directModel)
              || (depth >= 3 && (node.files.length > 0 || hasFormatChild))
              || (depth === 2 && hasFormatChild))))
          ? { directory: node, files: [], metadata: {} } : baseProject;
        if (project && project !== baseProject) found.push(project);
        if (project) project.files.push(...node.files);
        else if (node.path === '' && node.files.length) {
          errors.push({ relativePath: null, code: 'UNCLASSIFIED', message: 'Files at library root require a project directory' });
        }
        for (const child of node.children) collect(child, project);
      }
      collect(tree, null);
      result.filesSeen = allFiles.length;
      const assigned = new Set(found.flatMap((project) => project.files.map((file) => file.path)));
      for (const file of allFiles) {
        if (!assigned.has(file.path)) errors.push({ relativePath: file.path, code: 'UNCLASSIFIED', message: 'File has no project boundary' });
      }
      for (const project of found) project.metadata = await sidecarMetadata(project.directory, errors, libraryRoot);

      let next = 0;
      await Promise.all(Array.from({ length: Math.min(hashConcurrency, allFiles.length) }, async () => {
        while (next < allFiles.length) {
          const file = allFiles[next++];
          try {
            const old = oldAssetsByPath.get(file.path);
            if (old?.contentHash && old.sizeBytes === file.stat.size
              && old.mtimeMs === Math.trunc(file.stat.mtimeMs)
              && old.inode === file.stat.ino && old.device === file.stat.dev) {
              file.hash = old.contentHash;
              const validationError = previousVersionById.get(old.currentVersionId ?? '')?.validationError;
              if (validationError) {
                file.validationError = validationError;
                errors.push({ relativePath: file.path, code: 'INVALID_PREVIEW', message: validationError });
              }
            } else {
              file.hash = await hashFile(file);
              result.hashedFiles++;
              if (file.extension === '.3mf') file.thumbnailEntry = await inspectThreeMf(file.fullPath);
              if (file.kind === 'image') await validateImage(file.fullPath);
            }
            if (!statMatches(file.stat, await lstat(file.fullPath))) throw new Error('File changed during scan');
          } catch (error) {
            if (file.hash && !(error instanceof Error && error.message === 'File changed during scan')) {
              file.validationError = safeError(error, libraryRoot);
              errors.push({ relativePath: file.path, code: 'INVALID_PREVIEW', message: file.validationError });
            } else {
              file.hash = '';
              errors.push({ relativePath: file.path, code: 'FILE_CHANGED_OR_UNREADABLE', message: safeError(error, libraryRoot) });
            }
          }
        }
      }));
      for (const directory of directories) {
        try {
          if (!statMatches(directory.stat, await lstat(join(libraryRoot, directory.path)))) {
            errors.push({ relativePath: directory.path || null, code: 'DIRECTORY_CHANGED', message: 'Directory changed during scan' });
          }
        } catch (error) {
          errors.push({ relativePath: directory.path || null, code: 'DIRECTORY_CHANGED', message: safeError(error, libraryRoot) });
        }
      }
      if (!allowEmptyLibrary && allFiles.length === 0
        && previousProjects.some((project) => !project.missingAt)) {
        errors.push({ relativePath: null, code: 'EMPTY_LIBRARY', message: 'Empty library with existing catalog; verify mount before marking files missing' });
      }

      const usable = found.filter((project) => project.files.some((file) => file.hash));
      const newSignatureCounts = new Map<string, number>();
      const oldSignatureCounts = new Map<string, number>();
      const oldSignatures = new Map<string, typeof previousProjects[number][]>();
      for (const project of previousProjects) {
        const projectFiles = previousAssets.filter((asset) => asset.projectId === project.id
          && asset.contentHash && !asset.missingAt);
        if (!projectFiles.length) continue;
        const key = signature(projectFiles.map((asset) => ({
          path: asset.projectRelativePath, hash: asset.contentHash!, size: asset.sizeBytes,
        })));
        oldSignatureCounts.set(key, (oldSignatureCounts.get(key) ?? 0) + 1);
        oldSignatures.set(key, [...(oldSignatures.get(key) ?? []), project]);
      }
      for (const project of usable) {
        const key = signature(project.files.filter((file) => file.hash).map((file) => ({
          path: relative(join(libraryRoot, project.directory.path), file.fullPath).split(sep).join('/'),
          hash: file.hash, size: file.stat.size,
        })));
        newSignatureCounts.set(key, (newSignatureCounts.get(key) ?? 0) + 1);
      }

      const projectByPath = new Map(previousProjects.map((project) => [project.relativePath, project]));
      const ordered = found.sort((a, b) => comparePaths(a.directory, b.directory))
        .map((project) => ({ project, files: project.files.filter((file) => file.hash).sort(comparePaths) }))
        .filter((entry) => entry.files.length);
      const projectSignature = (project: FoundProject, files: FileInfo[]) => signature(files.map((file) => ({
        path: relative(join(libraryRoot, project.directory.path), file.fullPath).split(sep).join('/'),
        hash: file.hash, size: file.stat.size,
      })));
      const uniqueTargets = new Map<string, string>();
      for (const { project, files } of ordered) {
        const key = projectSignature(project, files);
        if (files.length === project.files.length && oldSignatureCounts.get(key) === 1
          && newSignatureCounts.get(key) === 1) {
          uniqueTargets.set(oldSignatures.get(key)![0].id, project.directory.path);
        }
      }
      const plans = ordered.map(({ project, files }) => {
        const path = project.directory.path;
        const occupant = projectByPath.get(path);
        const key = projectSignature(project, files);
        const candidate = files.length === project.files.length && uniqueTargets.get(oldSignatures.get(key)?.[0]?.id ?? '') === path
          ? oldSignatures.get(key)?.[0] : undefined;
        let existing = occupant;
        if (candidate && candidate.id !== occupant?.id) {
          if (!occupant || (uniqueTargets.has(occupant.id) && uniqueTargets.get(occupant.id) !== path)) {
            existing = candidate;
          } else {
            errors.push({ relativePath: path, code: 'AMBIGUOUS_PROJECT',
              message: 'The destination path belongs to another project without an unambiguous relocation' });
          }
        } else if (!occupant && !candidate && oldSignatures.has(key)) {
          errors.push({ relativePath: path, code: 'AMBIGUOUS_PROJECT',
            message: 'Multiple projects share this file manifest; resolve duplicates before matching renames' });
        }
        return { project, files, existing };
      });
      const assetMatches = new Map<string, typeof previousAssets[number] | undefined>();
      const claimed = new Set<string>();
      const assetKey = (file: { hash: string; size: number; extension: string }) =>
        JSON.stringify([file.hash, file.size, file.extension]);
      for (const { project, files, existing } of plans) {
        const available = previousAssets.filter((asset) => asset.projectId === existing?.id);
        const oldByKey = new Map<string, typeof previousAssets>();
        const newByKey = new Map<string, number>();
        for (const asset of available) {
          if (!asset.contentHash) continue;
          const key = assetKey({ hash: asset.contentHash, size: asset.sizeBytes, extension: asset.extension });
          oldByKey.set(key, [...(oldByKey.get(key) ?? []), asset]);
        }
        for (const file of files) {
          const key = assetKey({ hash: file.hash, size: file.stat.size, extension: file.extension });
          newByKey.set(key, (newByKey.get(key) ?? 0) + 1);
        }
        const uniqueAssetTargets = new Map<string, string>();
        for (const file of files) {
          const key = assetKey({ hash: file.hash, size: file.stat.size, extension: file.extension });
          if (oldByKey.get(key)?.length === 1 && newByKey.get(key) === 1) {
            uniqueAssetTargets.set(oldByKey.get(key)![0].id, file.path);
          }
        }
        for (const file of files) {
          const path = relative(join(libraryRoot, project.directory.path), file.fullPath).split(sep).join('/');
          const occupant = available.find((asset) => asset.projectRelativePath === path);
          const key = assetKey({ hash: file.hash, size: file.stat.size, extension: file.extension });
          const candidate = oldByKey.get(key)?.length === 1 && newByKey.get(key) === 1
            ? oldByKey.get(key)![0] : undefined;
          let old = occupant;
          if (candidate && candidate.id !== occupant?.id) {
            if (!occupant || (uniqueAssetTargets.has(occupant.id) && uniqueAssetTargets.get(occupant.id) !== file.path)) {
              old = candidate;
            } else {
              errors.push({ relativePath: file.path, code: 'AMBIGUOUS_ASSET',
                message: 'The asset path belongs to another file without an unambiguous relocation' });
            }
          } else if (!old) {
            old = candidate ?? oldAssetsByPath.get(file.path);
            if (!old && oldByKey.has(key)) errors.push({ relativePath: file.path, code: 'AMBIGUOUS_ASSET',
              message: 'Duplicate content prevents unambiguous asset rename matching' });
          }
          if (old && claimed.has(old.id)) {
            errors.push({ relativePath: file.path, code: 'AMBIGUOUS_ASSET',
              message: 'The same asset matches multiple discovered files' });
            old = undefined;
          }
          if (old) claimed.add(old.id);
          assetMatches.set(file.path, old);
        }
      }

      await db.transaction(async (tx) => {
        const stage = `.__print_pantry_scan_${id}`;
        for (const { project, existing } of plans) {
          if (existing && existing.relativePath !== project.directory.path) {
            await tx.update(schema.projects).set({ relativePath: `${stage}/${existing.id}` })
              .where(eq(schema.projects.id, existing.id));
          }
        }
        for (const [path, asset] of assetMatches) {
          if (asset && asset.relativePath !== path) {
            await tx.update(schema.assets).set({ relativePath: `${stage}/${asset.id}` })
              .where(eq(schema.assets.id, asset.id));
          }
        }
        const seenProjects: string[] = [];
        const seenAssets: string[] = [];
        const categoryCache = new Map<string, string>();
        const previousVersionByAsset = new Map<string, typeof previousVersions>();
        for (const version of previousVersions) previousVersionByAsset.set(version.assetId,
          [...(previousVersionByAsset.get(version.assetId) ?? []), version]);

        async function categoryFor(projectPath: string): Promise<string | null> {
          const parts = projectPath.split('/').slice(0, -1);
          let parentId: string | null = null;
          for (let i = 0; i < parts.length; i++) {
            const relativePath = parts.slice(0, i + 1).join('/');
            if (!categoryCache.has(relativePath)) {
              const [record] = await tx.insert(schema.categories).values({ relativePath, name: parts[i], parentId })
                .onConflictDoUpdate({ target: schema.categories.relativePath,
                  set: { name: parts[i], parentId } }).returning({ id: schema.categories.id });
              categoryCache.set(relativePath, record.id);
            }
            parentId = categoryCache.get(relativePath)!;
          }
          return parentId;
        }

        for (const { project, files, existing } of plans) {
          const projectPath = project.directory.path;
          const categoryId = await categoryFor(projectPath);
          const projectId = existing?.id ?? randomUUID();
          if (existing) {
            await tx.update(schema.projects).set({
              relativePath: projectPath, categoryId, name: basename(projectPath),
              missingAt: null, updatedAt: new Date(),
            }).where(eq(schema.projects.id, projectId));
          } else {
            await tx.insert(schema.projects).values({ id: projectId, categoryId, relativePath: projectPath,
              name: basename(projectPath), ...project.metadata });
          }
          seenProjects.push(projectId);
          for (const [sortOrder, file] of files.entries()) {
            const projectRelativePath = relative(join(libraryRoot, projectPath), file.fullPath).split(sep).join('/');
            const old = assetMatches.get(file.path);
            const assetId = old?.id ?? randomUUID();
            const versions = previousVersionByAsset.get(assetId) ?? [];
            const current = versions.find((version) => version.id === old?.currentVersionId);
            const sameVersion = versions.find((version) => version.contentHash === file.hash && version.sizeBytes === file.stat.size);
            const versionId = sameVersion?.id ?? randomUUID();
            if (!old) await tx.insert(schema.assets).values({ id: assetId, projectId, relativePath: file.path,
              projectRelativePath, name: basename(file.path), sortOrder, kind: file.kind, extension: file.extension,
              sizeBytes: file.stat.size, mtimeMs: Math.trunc(file.stat.mtimeMs),
              inode: file.stat.ino, device: file.stat.dev, contentHash: file.hash,
              currentVersionId: null });
            else {
              await tx.update(schema.assets).set({ projectId, relativePath: file.path, projectRelativePath,
                name: basename(file.path), sortOrder,
                kind: file.kind, extension: file.extension, sizeBytes: file.stat.size, mtimeMs: Math.trunc(file.stat.mtimeMs),
                inode: file.stat.ino, device: file.stat.dev,
                contentHash: file.hash, missingAt: null, updatedAt: new Date() })
                .where(eq(schema.assets.id, assetId));
            }
            if (!sameVersion) await tx.insert(schema.assetVersions).values({
              id: versionId, assetId, contentHash: file.hash, sizeBytes: file.stat.size,
              mtimeMs: Math.trunc(file.stat.mtimeMs), thumbnailEntry: file.thumbnailEntry,
              validationError: file.validationError,
            });
            else if (sameVersion.missingAt) await tx.update(schema.assetVersions)
              .set({ missingAt: null }).where(eq(schema.assetVersions.id, versionId));
            if (current && current.id !== versionId && !current.missingAt) {
              await tx.update(schema.assetVersions).set({ missingAt: new Date() })
                .where(eq(schema.assetVersions.id, current.id));
            }
            await tx.update(schema.assets).set({ currentVersionId: versionId })
              .where(eq(schema.assets.id, assetId));
            seenAssets.push(assetId);
          }
          const preview = files.find((file) => file.kind === 'image');
          if (preview) {
            const asset = (await tx.select({ id: schema.assets.id }).from(schema.assets)
              .where(eq(schema.assets.relativePath, preview.path)))[0];
            if (asset) await tx.update(schema.projects).set({ previewAssetId: asset.id })
              .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.previewAssetId)));
          }
        }
        result.status = errors.length ? 'partial' : 'succeeded';
        if (result.status === 'succeeded') {
          const now = new Date();
          await tx.update(schema.assets).set({ missingAt: now })
            .where(seenAssets.length
              ? and(isNull(schema.assets.missingAt), notInArray(schema.assets.id, seenAssets))
              : isNull(schema.assets.missingAt));
          await tx.update(schema.projects).set({ missingAt: now })
            .where(seenProjects.length
              ? and(isNull(schema.projects.missingAt), notInArray(schema.projects.id, seenProjects))
              : isNull(schema.projects.missingAt));
          const missing = await tx.select({ versionId: schema.assets.currentVersionId }).from(schema.assets)
            .where(isNotNull(schema.assets.missingAt));
          for (const asset of missing) if (asset.versionId) await tx.update(schema.assetVersions)
            .set({ missingAt: now }).where(eq(schema.assetVersions.id, asset.versionId));
        }
        result.errorsCount = errors.length;
        result.finishedAt = new Date();
        if (errors.length) await tx.insert(schema.scanErrors).values(errors.map((error) => ({ runId: id, ...error })));
        await tx.update(schema.scanRuns).set({
          status: result.status, finishedAt: result.finishedAt, filesSeen: result.filesSeen,
          hashedFiles: result.hashedFiles, errorsCount: result.errorsCount,
        }).where(eq(schema.scanRuns.id, id));
      });
      lastScan = { ...result };
      return { ...result };
    } catch (error) {
      result.status = 'failed';
      result.message = safeError(error, libraryRoot);
      errors.push({ relativePath: null, code: 'SCAN_FAILED', message: result.message });
      try {
        await finish();
      } catch (persistError) {
        console.error('Unable to persist failed library scan:', persistError);
      }
      throw error;
    } finally {
      running = false;
    }

    async function finish(): Promise<ScanResult> {
      result.finishedAt = new Date();
      result.errorsCount = errors.length;
      await db.transaction(async (tx) => {
        if (errors.length) await tx.insert(schema.scanErrors).values(errors.map((error) => ({ runId: id, ...error })));
        await tx.update(schema.scanRuns).set({ status: result.status, finishedAt: result.finishedAt,
          filesSeen: result.filesSeen, hashedFiles: result.hashedFiles, errorsCount: result.errorsCount,
          message: result.message }).where(eq(schema.scanRuns.id, id));
      });
      lastScan = { ...result };
      return { ...result };
    }
  }

  return {
    rescan,
    getStatus(): IndexerStatus { return { running, lastScan: lastScan ? { ...lastScan } : null }; },
    start({ intervalMs }: { intervalMs: number }) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('intervalMs must be at least 1000');
      const timer = setInterval(() => {
        if (!running) void rescan().catch((error: unknown) => console.error('Scheduled library scan failed:', error));
      }, intervalMs);
      timer.unref();
      return { stop: () => clearInterval(timer) };
    },
  };
}
