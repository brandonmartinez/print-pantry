import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientPath, InvalidLibraryPathError, LibraryUnavailableError, openLibraryFile } from './files.js';

const paths: string[] = [];
afterEach(async () => {
  for (const folder of paths.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('library file access', () => {
  it('rejects traversal and translates only validated library-relative paths', () => {
    expect(() => clientPath('/Volumes/Models', 'Things/Kit/part 02.stl')).not.toThrow();
    expect(clientPath('/Volumes/Models', 'Things/Kit/part 02.stl'))
      .toBe('/Volumes/Models/Things/Kit/part 02.stl');
    expect(clientPath(undefined, 'Things/Kit')).toBeNull();
    for (const invalid of ['../secrets', '/etc/passwd', 'a/../b', 'a//b', 'a\\b', 'a/\0b']) {
      expect(() => clientPath('/Volumes/Models', invalid)).toThrow(InvalidLibraryPathError);
    }
    expect(() => clientPath('relative/mount', 'models/part.stl')).toThrow();
  });

  it('opens regular library files but rejects symlink escapes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pantry-library-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'pantry-outside-'));
    paths.push(root, outside);
    await mkdir(path.join(root, 'models'));
    await writeFile(path.join(root, 'models', 'part.stl'), 'solid test\nendsolid test');
    await writeFile(path.join(outside, 'secret.stl'), 'secret');
    const opened = await openLibraryFile(root, 'models/part.stl');
    expect(opened.stats.isFile()).toBe(true);
    await opened.handle.close();
    await symlink(outside, path.join(root, 'escape'));
    await symlink(path.join(outside, 'secret.stl'), path.join(root, 'models', 'linked.stl'));
    await expect(openLibraryFile(root, 'escape/secret.stl')).rejects.toThrow(InvalidLibraryPathError);
    await expect(openLibraryFile(root, 'models/linked.stl')).rejects.toThrow(InvalidLibraryPathError);
    await expect(openLibraryFile(root, '../outside/secret.stl')).rejects.toThrow(InvalidLibraryPathError);
  });

  it('distinguishes an unavailable root from a missing indexed file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pantry-library-'));
    paths.push(root);
    await expect(openLibraryFile(root, 'gone.stl')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(openLibraryFile(path.join(root, 'unmounted'), 'gone.stl'))
      .rejects.toThrow(LibraryUnavailableError);
  });
});
