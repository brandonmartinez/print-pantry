import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, createPool, runMigrations } from '@print-pantry/db';
import { createLibraryIndexer, read3mfThumbnailFromHandle } from '@print-pantry/indexer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from './auth.js';
import { buildServer } from './server.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/print_pantry_test') {
  throw new Error('TEST_DATABASE_URL must target an isolated print_pantry_test database');
}

const pool = createPool(url);
const token = randomUUID().slice(0, 8);
const rootName = `pantry-${token}`;
const username = `operator-${token}`;
const requesterName = `requester-${token}`;
const scanIds: string[] = [];
let root: string;
let outside: string;
let server: ReturnType<typeof buildServer>;
let indexer: ReturnType<typeof createLibraryIndexer>;
let operatorCookie: string;
let requesterCookie: string;
let projectId: string;
let assetId: string;
let versionId: string;

async function scanLibrary() {
  const result = await indexer.rescan();
  scanIds.push(result.id);
  return result;
}

async function login(name: string): Promise<string> {
  const result = await server.inject({
    method: 'POST', url: '/auth/login', payload: { username: name, password: 'a synthetic test passphrase' },
  });
  expect(result.statusCode).toBe(200);
  return result.headers['set-cookie']!.toString().split(';')[0];
}

beforeAll(async () => {
  await runMigrations(url);
  root = await mkdtemp(path.join(tmpdir(), 'print-pantry-api-'));
  outside = await mkdtemp(path.join(tmpdir(), 'print-pantry-outside-'));
  const projectFolder = path.join(root, rootName, 'Gadgets', 'Desk Lamp');
  await mkdir(path.join(projectFolder, 'files'), { recursive: true });
  await writeFile(path.join(projectFolder, 'files', 'part 02.stl'),
    'solid lamp\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid lamp');
  await writeFile(path.join(projectFolder, 'files', 'part 10.stl'),
    'solid lamp\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 2 0\nendloop\nendfacet\nendsolid lamp');
  await writeFile(path.join(projectFolder, 'cover.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9ZlHkAAAAASUVORK5CYII=',
    'base64',
  ));
  await writeFile(path.join(outside, 'private.stl'), 'outside the library');
  indexer = createLibraryIndexer({ db: createDatabase(pool), root, hashConcurrency: 2 });
  const scan = await scanLibrary();
  expect(scan.status).toBe('succeeded');
  const passwordHash = await hashPassword('a synthetic test passphrase');
  await pool.query(
    `INSERT INTO users (id, username, password_hash, role) VALUES
     ($1, $2, $3, 'operator'), ($4, $5, $3, 'requester')`,
    [randomUUID(), username, passwordHash, randomUUID(), requesterName],
  );
  server = buildServer(pool, {
    pool, root, indexer, read3mfThumbnail: read3mfThumbnailFromHandle, secureCookie: false,
    clientMountPrefix: '/Volumes/Synthetic Library',
  });
  operatorCookie = await login(username);
  requesterCookie = await login(requesterName);
});

afterAll(async () => {
  try {
    if (server) await server.close();
    await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username IN ($1, $2))',
      [username, requesterName]);
    await pool.query('DELETE FROM users WHERE username IN ($1, $2)', [username, requesterName]);
    await pool.query('DELETE FROM project_boundary_overrides WHERE relative_path = $1 OR relative_path LIKE $2',
      [rootName, `${rootName}/%`]);
    const projects = await pool.query<{ id: string }>(
      'SELECT id FROM projects WHERE relative_path LIKE $1', [`${rootName}/%`]);
    const ids = projects.rows.map(({ id }) => id);
    if (ids.length) {
      await pool.query('UPDATE assets SET current_version_id = NULL WHERE project_id = ANY($1::uuid[])', [ids]);
      await pool.query(
        'DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE project_id = ANY($1::uuid[]))',
        [ids],
      );
      await pool.query('DELETE FROM assets WHERE project_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ids]);
    }
    const categories = await pool.query<{ id: string }>(
      'SELECT id FROM categories WHERE relative_path = $1 OR relative_path LIKE $2 ORDER BY length(relative_path) DESC',
      [rootName, `${rootName}/%`],
    );
    for (const category of categories.rows) {
      await pool.query('DELETE FROM categories WHERE id = $1', [category.id]);
    }
    if (scanIds.length) {
      await pool.query('DELETE FROM scan_errors WHERE run_id = ANY($1::uuid[])', [scanIds]);
      await pool.query('DELETE FROM scan_runs WHERE id = ANY($1::uuid[])', [scanIds]);
    }
  } finally {
    await pool.end();
    if (root) await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  }
});

describe('authenticated catalog and local files', () => {
  it('denies unauthenticated reads and requester-only operator actions', async () => {
    expect((await server.inject('/catalog/projects')).statusCode).toBe(401);
    expect((await server.inject('/catalog/status')).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/catalog/rescan' })).statusCode).toBe(401);
    expect((await server.inject({
      method: 'POST', url: '/catalog/rescan', headers: { cookie: requesterCookie },
    })).statusCode).toBe(403);
  });

  it('searches and paginates grouped projects, preserving file order and client paths', async () => {
    const response = await server.inject({
      method: 'GET', url: '/catalog/projects?q=part&category=' + rootName +
        '&fileType=mesh&page=1&pageSize=1', headers: { cookie: requesterCookie },
    });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].name).toBe('Desk Lamp');
    expect(page.items[0].clientPath).toContain('/Volumes/Synthetic Library/');
    projectId = page.items[0].id;

    const detail = await server.inject({
      method: 'GET', url: `/catalog/projects/${projectId}`, headers: { cookie: requesterCookie },
    });
    expect(detail.statusCode).toBe(200);
    const project = detail.json().project;
    expect(project.isBoundary).toBe(false);
    expect(project.files.map((file: { name: string }) => file.name))
      .toEqual(['cover.png', 'part 02.stl', 'part 10.stl']);
    const part = project.files.find((file: { name: string }) => file.name === 'part 02.stl');
    expect(part.relativePath).toBe('files/part 02.stl');
    expect(part.clientPath).toContain('files/part 02.stl');
    assetId = part.id;
    versionId = part.versionId;
    expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/download`,
    })).statusCode).toBe(401);
    const traversal = await server.inject({
      method: 'GET', url: '/catalog/assets/%2e%2e/download', headers: { cookie: requesterCookie },
    });
    expect(traversal.statusCode).not.toBe(200);
    const download = await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/download?versionId=${versionId}`,
      headers: { cookie: requesterCookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain('solid lamp');
    const preview = await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/preview`, headers: { cookie: requesterCookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/svg+xml');
    const geometry = await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/geometry`, headers: { cookie: requesterCookie },
    });
    expect(geometry.statusCode).toBe(200);
    expect(geometry.json().triangles).toHaveLength(1);
    expect((await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/geometry`,
    })).statusCode).toBe(401);
    const projectPreview = await server.inject({
      method: 'GET', url: `/catalog/projects/${projectId}/preview`, headers: { cookie: requesterCookie },
    });
    expect(projectPreview.statusCode).toBe(200);
    expect(projectPreview.headers['content-type']).toContain('image/png');
  });

  it('does not download substituted bytes when size and mtime match the selected version', async () => {
    const file = path.join(root, rootName, 'Gadgets', 'Desk Lamp', 'files', 'part 02.stl');
    const original = await readFile(file, 'utf8');
    const before = await stat(file);
    const replacement = original.replace('vertex 1 0 0', 'vertex 9 0 0');
    expect(replacement).not.toBe(original);
    expect(replacement.length).toBe(original.length);
    try {
      await writeFile(file, replacement);
      await utimes(file, before.atimeMs / 1000, before.mtimeMs / 1000);
      const download = await server.inject({
        method: 'GET', url: `/catalog/assets/${assetId}/download?versionId=${versionId}`,
        headers: { cookie: requesterCookie },
      });
      expect(download.statusCode).toBe(409);
      expect(download.json().error).toContain('content changed');
    } finally {
      await writeFile(file, original);
      await utimes(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    }
  });

  it('enforces operator mutations and preserves metadata and version identity', async () => {
    const url = `/catalog/projects/${projectId}`;
    expect((await server.inject({
      method: 'PATCH', url, headers: { cookie: requesterCookie },
      payload: { description: 'Authored text' },
    })).statusCode).toBe(403);
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: requesterCookie },
      payload: { projectId, isBoundary: true },
    })).statusCode).toBe(403);
    expect((await server.inject({
      method: 'PATCH', url, headers: { cookie: operatorCookie },
      payload: { sourceUrl: 'javascript:alert(1)' },
    })).statusCode).toBe(400);
    expect((await server.inject({
      method: 'PATCH', url, headers: { cookie: operatorCookie },
      payload: { sourceUrl: 'https://username:password@example.org/model' },
    })).statusCode).toBe(400);
    expect((await server.inject({
      method: 'PATCH', url, headers: { cookie: operatorCookie },
      payload: { description: 'Authored text', tags: ['test'], sourceUrl: 'https://example.org/model' },
    })).statusCode).toBe(200);
    const scan = await scanLibrary();
    expect(scan.hashedFiles).toBe(0);
    const detail = await server.inject({ method: 'GET', url, headers: { cookie: operatorCookie } });
    expect(detail.json().project.description).toBe('Authored text');
    expect(detail.json().project.tags).toEqual(['test']);
    expect(detail.json().project.sourceUrl).toBe('https://example.org/model');
    const part = detail.json().project.files.find((file: { name: string }) => file.name === 'part 02.stl');
    expect(part.id).toBe(assetId);
    expect(part.versionId).toBe(versionId);
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: operatorCookie },
      payload: { projectId, isBoundary: true },
    })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url, headers: { cookie: operatorCookie } }))
      .json().project.isBoundary).toBe(true);
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: operatorCookie },
      payload: { projectId, isBoundary: false },
    })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url, headers: { cookie: operatorCookie } }))
      .json().project.isBoundary).toBe(false);
  });

  it('falls back to a valid mesh when a preferred cover image becomes malformed', async () => {
    const cover = path.join(root, rootName, 'Gadgets', 'Desk Lamp', 'cover.png');
    const valid = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9ZlHkAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(cover, 'not a PNG');
    expect((await scanLibrary()).status).toBe('partial');
    const preview = await server.inject({
      method: 'GET', url: `/catalog/projects/${projectId}/preview`, headers: { cookie: requesterCookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/svg+xml');
    await writeFile(cover, valid);
    expect((await scanLibrary()).status).toBe('succeeded');
  });

  it('rejects symlink escapes and marks historical versions unavailable', async () => {
    const file = path.join(root, rootName, 'Gadgets', 'Desk Lamp', 'files', 'part 02.stl');
    await rm(file);
    await symlink(path.join(outside, 'private.stl'), file);
    expect((await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/download`, headers: { cookie: operatorCookie },
    })).statusCode).toBe(422);
    await rm(file);
    await writeFile(file,
      'solid changed\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 3 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid changed');
    expect((await scanLibrary()).status).toBe('succeeded');
    const detail = await server.inject({
      method: 'GET', url: `/catalog/projects/${projectId}`, headers: { cookie: operatorCookie },
    });
    const part = detail.json().project.files.find((file: { name: string }) => file.name === 'part 02.stl');
    expect(part.id).toBe(assetId);
    expect(part.versionId).not.toBe(versionId);
    expect((await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/download?versionId=${versionId}`,
      headers: { cookie: operatorCookie },
    })).statusCode).toBe(410);
  });

  it('does not treat an offline library root as a missing asset', async () => {
    const offline = `${root}-offline`;
    await rename(root, offline);
    root = offline;
    const response = await server.inject({
      method: 'GET', url: `/catalog/assets/${assetId}/download`,
      headers: { cookie: operatorCookie },
    });
    expect(response.statusCode).toBe(503);
    expect((await scanLibrary()).status).toBe('offline');
    const detail = await server.inject({
      method: 'GET', url: `/catalog/projects/${projectId}`, headers: { cookie: operatorCookie },
    });
    const part = detail.json().project.files.find((file: { name: string }) => file.name === 'part 02.stl');
    expect(part.available).toBe(true);
  });

  it('keeps household identities and sessions server-enforced', async () => {
    const me = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: requesterCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ username: requesterName, role: 'requester' });
    const invalid = await server.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: username, password: 'an incorrect passphrase' },
    });
    expect(invalid.statusCode).toBe(401);
    const boundary = `${rootName}/Gadgets`;
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: requesterCookie },
      payload: { relativePath: boundary, kind: 'collection' },
    })).statusCode).toBe(403);
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: operatorCookie },
      payload: { relativePath: '../outside', kind: 'project' },
    })).statusCode).toBe(422);
    expect((await server.inject({
      method: 'PUT', url: '/catalog/boundaries', headers: { cookie: operatorCookie },
      payload: { relativePath: boundary, kind: 'collection' },
    })).statusCode).toBe(200);
    expect((await server.inject({
      method: 'DELETE', url: '/catalog/boundaries', headers: { cookie: operatorCookie },
      payload: { relativePath: boundary },
    })).statusCode).toBe(204);
    const logout = await server.inject({
      method: 'POST', url: '/auth/logout', headers: { cookie: requesterCookie },
    });
    expect(logout.statusCode).toBe(204);
    expect((await server.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: requesterCookie },
    })).statusCode).toBe(401);
  });

  it('reserves sign-in attempts before asynchronous password checks', async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, () => server.inject({
      method: 'POST', url: '/auth/login',
      payload: { username, password: 'an incorrect passphrase' },
    })));
    expect(attempts.filter((response) => response.statusCode === 429).length).toBeGreaterThanOrEqual(3);
    expect((await server.inject({
      method: 'POST', url: '/auth/login',
      payload: { username, password: 'an incorrect passphrase' },
    })).statusCode).toBe(429);
  });
});
