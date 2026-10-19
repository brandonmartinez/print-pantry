import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import type { ImportPlanFile } from '@print-pantry/contracts';
import { classifyLibraryExtension } from '@print-pantry/indexer';
import { openLibraryFile, validateRelativePath } from './files.js';

export const importLimits = {
  uploadBytes: 256 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  planBytes: 8 * 1024 * 1024,
  files: 1000,
  uploads: 50,
};

export class IntakeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type ImportStorage = { intakeRoot: string; managedRoot: string };
export type StoredFile = {
  id: string; originalPath: string; storedPath: string; hash: string; size: number;
};

function sourcePath(value: string): string {
  try { validateRelativePath(value); } catch { throw new IntakeError('File paths must be relative and cannot contain traversal or backslashes'); }
  if (/^[a-z]:\//i.test(value)) throw new IntakeError('File paths cannot be absolute Windows paths');
  const parts = value.split('/');
  if (value.length > 700 || parts.length > 12 || parts.some((part) =>
    Buffer.byteLength(part) > 200 || /\p{Cc}/u.test(part))) {
    throw new IntakeError('A source filename exceeds filename/depth limits or contains control characters');
  }
  return value;
}

export function portablePath(value: string): string {
  sourcePath(value);
  if (value.split('/').some((part) => /[<>:"|?*]/.test(part) ||
    /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new IntakeError(`A file path contains nonportable characters: ${JSON.stringify(value)}`);
  }
  return value;
}

export function pathKey(value: string): string { return value.normalize('NFC').toLowerCase(); }

export function normalizeImportPath(value: string): string {
  return value.split('/').map((part) => {
    const normalized = part.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '_');
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized) ? `_${normalized}` : normalized;
  }).join('/');
}

export function validatePlanPaths(files: Pick<ImportPlanFile, 'path' | 'include'>[]) {
  const paths = new Set<string>();
  for (const file of files.filter((entry) => entry.include)) {
    portablePath(file.path);
    const key = pathKey(file.path);
    if (key === 'project.json' || key.startsWith('project.json/')) {
      throw new IntakeError('project.json is reserved for the generated recovery/catalog manifest');
    }
    if (paths.has(key)) throw new IntakeError(`Two selected files have the same destination: ${file.path}`);
    paths.add(key);
  }
  for (const value of paths) {
    const parts = value.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('/'))) throw new IntakeError('A destination file conflicts with a directory');
    }
  }
}

export function projectSlug(name: string) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90).replace(/_+$/g, '') || 'print';
}

export async function safeDirectory(root: string, path = '') {
  const targetRoot = resolve(root);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  if (!(await lstat(targetRoot)).isDirectory() || await realpath(targetRoot) !== targetRoot) {
    throw new IntakeError('Import storage root must be a real directory without symlink components', 503);
  }
  let current = targetRoot;
  if (path) for (const part of portablePath(path).split('/')) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    if (!(await lstat(current)).isDirectory()) throw new IntakeError('Symlinks and non-directory storage components are not allowed', 422);
  }
  return current;
}

export async function validateStorage(storage: ImportStorage, legacyRoot: string) {
  const roots = [storage.intakeRoot, storage.managedRoot, legacyRoot].map((root) => resolve(root));
  function separate(paths: string[]) {
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      const path = relative(paths[i], paths[j]);
      const reverse = relative(paths[j], paths[i]);
      if (!path || (!path.startsWith('..') && path !== '..') || (!reverse.startsWith('..') && reverse !== '..')) {
        throw new IntakeError('Intake, managed, and legacy storage roots must be separate, non-nested directories', 503);
      }
    }
  }
  separate(roots);
  await safeDirectory(storage.intakeRoot);
  await safeDirectory(storage.managedRoot);
  let canonicalLegacy = roots[2];
  try { canonicalLegacy = await realpath(legacyRoot); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  separate([await realpath(storage.intakeRoot), await realpath(storage.managedRoot), canonicalLegacy]);
}

export async function storeStream(
  stream: Readable, root: string, path: string, limit: number,
): Promise<{ hash: string; size: number; crc: number }> {
  portablePath(path);
  await safeDirectory(root, dirname(path) === '.' ? '' : dirname(path));
  const handle = await open(join(root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  let size = 0;
  let crc = 0;
  try {
    await pipeline(stream, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(new IntakeError('Upload or expanded file exceeds the configured size limit', 413));
        hash.update(chunk);
        crc = crc32(chunk, crc);
        void handle.writeFile(chunk).then(() => callback(), callback);
      },
    }));
    await handle.sync();
    return { hash: hash.digest('hex'), size, crc };
  } finally {
    await handle.close();
  }
}

async function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, zip) => {
      if (error || !zip) reject(new IntakeError('ZIP could not be read; upload a valid, unencrypted ZIP archive'));
      else resolveZip(zip);
    });
  });
}

export async function receiveUpload(
  stream: Readable, root: string, requestId: string, name: string,
  limits = importLimits,
): Promise<{ original: { path: string; hash: string; size: number }; files: StoredFile[] }> {
  sourcePath(name);
  const batch = `${requestId}/batches/${randomUUID()}`;
  await safeDirectory(root, batch);
  try {
    await writeFile(join(root, batch, 'receipt.json'), JSON.stringify({
      schemaVersion: 1, importId: requestId, originalName: name, receivedAt: new Date().toISOString(),
    }) + '\n', { flag: 'wx', mode: 0o600 });
    return await expandUpload(stream, root, name, batch, limits);
  } catch (error) {
    await rm(join(root, batch), { recursive: true, force: true });
    throw error;
  }
}

async function expandUpload(stream: Readable, root: string, name: string, batch: string, limits: typeof importLimits) {
  const originalPath = `${batch}/original`;
  const original = await storeStream(stream, root, originalPath, limits.uploadBytes);
  const files: StoredFile[] = [];
  if (extname(name).toLowerCase() !== '.zip') {
    files.push({ id: randomUUID(), originalPath: name, storedPath: originalPath, hash: original.hash, size: original.size });
  } else {
    const zip = await openZip(join(root, originalPath));
    let count = 0;
    let expanded = 0;
    const paths = new Set<string>();
    try {
      await new Promise<void>((resolveZip, reject) => {
        zip.once('error', (error) => reject(new IntakeError(`ZIP validation failed: ${error.message}`)));
        zip.once('end', resolveZip);
        zip.on('entry', (entry: yauzl.Entry) => {
          void (async () => {
            count++;
            if (count > limits.files) throw new IntakeError('ZIP has too many entries', 413);
            const directory = entry.fileName.endsWith('/');
            const path = sourcePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if ((mode && mode !== 0o100000 && mode !== 0o040000) || (entry.generalPurposeBitFlag & 1)) {
              throw new IntakeError('ZIP symlinks, special files, and encrypted entries are not allowed', 422);
            }
            if (paths.has(pathKey(path))) throw new IntakeError('ZIP has duplicate or case-colliding paths');
            paths.add(pathKey(path));
            if (!directory) {
              if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limits.expandedBytes - expanded ||
                  (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 1000)) {
                throw new IntakeError('ZIP expansion exceeds size or compression-ratio limits', 413);
              }
              const input = await new Promise<Readable>((resolveStream, rejectStream) => {
                zip.openReadStream(entry, (error, file) => error || !file
                  ? rejectStream(new IntakeError('ZIP entry could not be read')) : resolveStream(file));
              });
              const storedPath = `${batch}/extracted/${randomUUID()}`;
              const stored = await storeStream(input, root, storedPath, limits.expandedBytes - expanded);
              if (stored.crc !== entry.crc32) throw new IntakeError('ZIP entry checksum mismatch; obtain a fresh archive');
              expanded += stored.size;
              files.push({ id: randomUUID(), originalPath: path, storedPath, hash: stored.hash, size: stored.size });
            }
            zip.readEntry();
          })().catch(reject);
        });
        zip.readEntry();
      });
    } finally {
      zip.close();
    }
    if (!files.length) throw new IntakeError('ZIP contains no files');
  }
  return { original: { path: originalPath, hash: original.hash, size: original.size }, files };
}

const osMetadataFiles = new Set([
  '.ds_store', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini',
  '.directory', '.apdisk', '.lsoverride', '.volumeicon.icns',
]);
const osMetadataDirectories = new Set([
  '__macosx', '.appledouble', '.spotlight-v100', '.trashes', '.fseventsd',
  '.temporaryitems', '$recycle.bin', 'system volume information',
]);

function isOsMetadata(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1)!;
  return osMetadataFiles.has(name) || name.startsWith('._') ||
    parts.some((part) => osMetadataDirectories.has(part) || /^\.trash(?:-\d+)?$/.test(part));
}

export function organizeFiles(files: StoredFile[]): { files: ImportPlanFile[]; warnings: string[] } {
  const included = files.filter((file) => !isOsMetadata(file.originalPath));
  const linkedModels = included.some((file) => /\.(obj|gltf|sldasm|iam|fcstd)$/i.test(file.originalPath));
  const html = included.some((file) => /\.html?$/i.test(file.originalPath));
  const warnings = ['Original uploads are retained separately. Review file grouping, source attribution, and license before publishing.'];
  if (included.length !== files.length) warnings.push('Common operating-system metadata is excluded by default. It remains in the original uploads and can be included explicitly during review.');
  if (linkedModels) warnings.push('Linked model formats detected: supporting resources retain their original paths together under models/.');
  if (html) warnings.push('HTML documentation retains its resource paths and is download-only.');
  if (linkedModels && html) warnings.push('Mixed linked models and HTML detected: non-metadata files stay together under models/ to preserve shared resources.');
  let normalizedNames = false;
  const result = files.map((file): ImportPlanFile => {
    const include = !isOsMetadata(file.originalPath);
    const extension = extname(file.originalPath).toLowerCase();
    const kind = classifyLibraryExtension(extension);
    const name = file.originalPath.split('/').at(-1)!;
    const rootMeta = /^(readme|licen[cs]e(?:[-_][^.]+)?|copying|authors|credits|attribution)(?:\.(txt|md|rst))?$/i.test(name) ||
      /^(source\.url|.+\.webloc)$/i.test(name);
    let folder: string;
    if (rootMeta) folder = '';
    else if (linkedModels && html) folder = 'models';
    else if (kind === 'mesh' || kind === 'source' || (linkedModels && !['document', 'print'].includes(kind))) folder = 'models';
    else if (kind === 'print') folder = 'exports';
    else if (kind === 'image' && !html) folder = 'images';
    else folder = 'docs';
    const preserve = folder === 'models' && linkedModels || folder === 'docs' && html;
    const parts = file.originalPath.split('/');
    if (!preserve) while (parts.length > 1 && /^(files|models|stls?|steps?|images|docs|documentation|exports)$/i.test(parts[0])) parts.shift();
    const proposedPath = rootMeta ? name : `${folder}/${parts.join('/')}`;
    const path = normalizeImportPath(proposedPath);
    normalizedNames ||= include && path !== proposedPath;
    return {
      id: file.id, versionId: randomUUID(), originalPath: file.originalPath,
      path, size: file.size, hash: file.hash, kind, include,
    };
  });
  if (normalizedNames) warnings.push('Nonportable names were normalized in the proposed paths. Original names and bytes are retained. Review renamed paths and linked-file references before publishing; references inside files are not rewritten.');
  return { files: result, warnings };
}

export async function hashStoredFile(root: string, path: string) {
  const { handle, stats } = await openLibraryFile(root, path);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) throw new IntakeError('A stored file changed while verifying it', 409);
    return { hash: hash.digest('hex'), size: stats.size, stats };
  } finally { await handle.close(); }
}
