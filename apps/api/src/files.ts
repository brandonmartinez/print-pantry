import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export function validateRelativePath(relativePath: string): string[] {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new InvalidLibraryPathError();
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new InvalidLibraryPathError();
  return parts;
}

export class InvalidLibraryPathError extends Error {
  constructor() { super('Invalid or unsafe library path'); }
}

export class LibraryUnavailableError extends Error {
  constructor() { super('Library storage is unavailable'); }
}

export function clientPath(prefix: string | undefined, relativePath: string): string | null {
  if (!prefix) return null;
  if (!path.posix.isAbsolute(prefix) || prefix.includes('\0') || prefix.includes('\\')) {
    throw new Error('CLIENT_MOUNT_PREFIX must be an absolute POSIX path');
  }
  const parts = validateRelativePath(relativePath);
  return path.posix.join(prefix, ...parts);
}

export async function openLibraryFile(root: string, relativePath: string) {
  const parts = validateRelativePath(relativePath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EIO')) {
      throw new LibraryUnavailableError();
    }
    throw error;
  }
  let cursor = canonicalRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) throw new InvalidLibraryPathError();
  }
  const canonicalFile = await realpath(cursor);
  if (!canonicalFile.startsWith(canonicalRoot + path.sep)) throw new InvalidLibraryPathError();
  const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new InvalidLibraryPathError();
    return { handle, stats, canonicalFile };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
