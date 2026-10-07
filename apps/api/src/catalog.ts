import type { FastifyInstance, FastifyReply } from 'fastify';
import type { createPool } from '@print-pantry/db';
import { clientPath, InvalidLibraryPathError, LibraryUnavailableError, openLibraryFile } from './files.js';
import { renderStlPreview } from './mesh-preview.js';
import { validatedImageType } from './image-validation.js';
import type { createAuth } from './auth.js';

type Pool = ReturnType<typeof createPool>;
type Auth = ReturnType<typeof createAuth>;
export type ScanResult = {
  id: string; status: string; filesSeen: number; hashedFiles: number; errorsCount: number;
  startedAt: Date; finishedAt: Date | null; message?: string | null;
};
export type Indexer = {
  rescan(): Promise<ScanResult>;
  getStatus(): { running: boolean; lastScan: ScanResult | null };
};
export type ThumbnailReader = (path: string) => Promise<{ mimeType: string; bytes: Buffer } | null>;
export type CatalogOptions = {
  pool: Pool; root: string; clientMountPrefix?: string; indexer: Indexer;
  read3mfThumbnail?: ThumbnailReader;
};

type ProjectRow = {
  id: string; name: string; relative_path: string; category_path: string | null;
  description: string | null; tags: string[]; designer: string | null; source_url: string | null;
  license: string | null; notes: string | null; missing_at: Date | null;
  asset_count: number; preview_asset_id: string | null;
};
type AssetRow = {
  id: string; project_id: string; relative_path: string; project_relative_path: string;
  name: string; kind: string; extension: string; size_bytes: string | number;
  mtime_ms: string | number; current_version_id: string | null; missing_at: Date | null;
};
type ScanRow = {
  id: string; status: string; started_at: Date; finished_at: Date | null;
  files_seen: number; hashed_files: number; errors_count: number; message: string | null;
};

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const searchableProject = `to_tsvector('simple', coalesce(p.name,'') || ' ' || coalesce(p.description,'') ||
  ' ' || coalesce(array_to_string(p.tags,' '),'') || ' ' || coalesce(p.designer,'') ||
  ' ' || coalesce(p.source_url,'') || ' ' || coalesce(p.license,'') || ' ' ||
  coalesce(p.notes,''))`;
const searchableCategory = `to_tsvector('simple', coalesce(c.name,'') || ' ' || coalesce(c.relative_path,''))`;

function safeSource(source: string | null): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function summary(row: ProjectRow, mount?: string) {
  const segments = row.category_path?.split('/') ?? [];
  return {
    id: row.id, name: row.name, category: segments[0] ?? null,
    subcategory: segments.slice(1).join('/') || null,
    description: row.description, tags: row.tags, available: !row.missing_at,
    assetCount: Number(row.asset_count), clientPath: clientPath(mount, row.relative_path),
    previewUrl: row.preview_asset_id ? `/api/catalog/projects/${row.id}/preview` : null,
  };
}

async function scanStatus(pool: Pool, indexer: Indexer) {
  const live = indexer.getStatus();
  const latest = await pool.query<ScanRow>(
    'SELECT id, status, started_at, finished_at, files_seen, hashed_files, errors_count, message FROM scan_runs ORDER BY started_at DESC LIMIT 1',
  );
  const successful = await pool.query<{ finished_at: Date }>(
    "SELECT finished_at FROM scan_runs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
  );
  const last = live.lastScan ?? (latest.rows[0] ? {
    id: latest.rows[0].id, status: latest.rows[0].status, startedAt: latest.rows[0].started_at,
    finishedAt: latest.rows[0].finished_at, filesSeen: latest.rows[0].files_seen,
    hashedFiles: latest.rows[0].hashed_files, errorsCount: latest.rows[0].errors_count,
    message: latest.rows[0].message,
  } : null);
  return {
    state: live.running ? 'running' : last?.status ?? 'never',
    lastSuccessfulAt: successful.rows[0]?.finished_at ?? null,
    lastError: last && last.status !== 'succeeded' ? last.message ?? `${last.errorsCount} indexing errors` : null,
    lastScan: last,
  };
}

async function projectById(pool: Pool, id: string): Promise<ProjectRow | undefined> {
  const result = await pool.query<ProjectRow>(
    `SELECT p.id, p.name, p.relative_path, c.relative_path AS category_path, p.description,
       p.tags, p.designer, p.source_url, p.license, p.notes, p.missing_at,
       (SELECT count(*)::int FROM assets a WHERE a.project_id = p.id AND a.missing_at IS NULL) AS asset_count,
       coalesce(
         (SELECT a.id FROM assets a WHERE a.id = p.preview_asset_id AND a.missing_at IS NULL),
         (SELECT a.id FROM assets a WHERE a.project_id = p.id AND a.missing_at IS NULL
            AND a.kind IN ('image','mesh') ORDER BY CASE WHEN a.kind = 'image' THEN 0 ELSE 1 END, a.relative_path LIMIT 1)
       ) AS preview_asset_id
     FROM projects p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1`,
    [id],
  );
  return result.rows[0];
}

async function assetById(pool: Pool, id: string): Promise<AssetRow | undefined> {
  const result = await pool.query<AssetRow>(
    `SELECT id, project_id, relative_path, project_relative_path, name, kind, extension,
       size_bytes, mtime_ms, current_version_id, missing_at FROM assets WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

function assetResponse(row: AssetRow, mount?: string) {
  const folders = row.project_relative_path.split('/').slice(0, -1);
  const variantFolders = folders.filter((folder) =>
    !['files', 'stl', '3mf', 'obj', 'images', 'source', 'sources'].includes(folder.toLowerCase()));
  return {
    id: row.id, versionId: row.current_version_id, name: row.name,
    relativePath: row.project_relative_path, variant: variantFolders.join('/') || null,
    fileType: row.kind, extension: row.extension, size: Number(row.size_bytes),
    available: !row.missing_at, clientPath: clientPath(mount, row.relative_path),
    downloadUrl: `/api/catalog/assets/${row.id}/download`,
    previewUrl: row.kind === 'image' || row.kind === 'mesh' ?
      `/api/catalog/assets/${row.id}/preview` : null,
  };
}

function libraryError(reply: FastifyReply, error: unknown) {
  if (error instanceof InvalidLibraryPathError) return reply.code(422).send({ error: error.message });
  if (error instanceof LibraryUnavailableError) return reply.code(503).send({ error: error.message });
  if (error instanceof Error && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    return reply.code(410).send({ error: 'File is no longer available; rescan the library' });
  }
  if (error instanceof Error && 'code' in error &&
    (error.code === 'EACCES' || error.code === 'EIO' || error.code === 'ENETUNREACH')) {
    return reply.code(503).send({ error: 'Library storage is unavailable' });
  }
  throw error;
}

export function registerCatalog(server: FastifyInstance, options: CatalogOptions, auth: Auth) {
  const { pool, root, indexer, clientMountPrefix: mount } = options;
  let rescanPending = false;

  server.get('/catalog/status', { preHandler: auth.authenticate }, async () => {
    const scan = await scanStatus(pool, indexer);
    const errors = scan.lastScan?.id ? await pool.query<{ relative_path: string | null; code: string; message: string }>(
      'SELECT relative_path, code, message FROM scan_errors WHERE run_id = $1 ORDER BY relative_path NULLS FIRST LIMIT 25',
      [scan.lastScan.id],
    ) : null;
    return { scan: { ...scan, state: rescanPending ? 'running' : scan.state, errors: errors?.rows ?? [] } };
  });

  server.post('/catalog/rescan', { preHandler: auth.operatorOnly }, async (_request, reply) => {
    if (rescanPending || indexer.getStatus().running) {
      return reply.code(409).send({ error: 'A rescan is already running' });
    }
    rescanPending = true;
    void indexer.rescan()
      .catch((error: unknown) => server.log.error({ err: error }, 'Library rescan failed'))
      .finally(() => { rescanPending = false; });
    return reply.code(202).send({ scan: { ...await scanStatus(pool, indexer), state: 'running' } });
  });

  server.get<{ Querystring: { q?: string; category?: string; fileType?: string; page?: string; pageSize?: string } }>(
    '/catalog/projects', {
      preHandler: auth.authenticate,
      schema: { querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 150 }, category: { type: 'string', maxLength: 200 },
          fileType: { type: 'string', enum: ['mesh', 'source', 'image', 'document', 'print', 'other'] },
          page: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' },
          pageSize: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
        },
      } },
    }, async (request) => {
      const { q = '', category, fileType } = request.query;
      const page = Math.min(Number(request.query.page ?? 1), 100000);
      const pageSize = Math.min(Number(request.query.pageSize ?? 24), 50);
      const where = `($1 = '' OR ${searchableProject} @@ plainto_tsquery('simple', $1)
        OR ${searchableCategory} @@ plainto_tsquery('simple', $1)
        OR EXISTS (SELECT 1 FROM assets a WHERE a.project_id = p.id AND
          to_tsvector('simple', coalesce(a.name,'') || ' ' || coalesce(a.project_relative_path,''))
          @@ plainto_tsquery('simple', $1)))
        AND ($2::text IS NULL OR split_part(c.relative_path, '/', 1) = $2)
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM assets a WHERE a.project_id = p.id
          AND a.missing_at IS NULL AND a.kind = $3))`;
      const values = [q.trim(), category ?? null, fileType ?? null];
      const count = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM projects p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where}`,
        values,
      );
      const rows = await pool.query<ProjectRow>(
        `SELECT p.id, p.name, p.relative_path, c.relative_path AS category_path, p.description,
           p.tags, p.designer, p.source_url, p.license, p.notes, p.missing_at,
           (SELECT count(*)::int FROM assets a WHERE a.project_id = p.id AND a.missing_at IS NULL) AS asset_count,
           coalesce(
             (SELECT a.id FROM assets a WHERE a.id = p.preview_asset_id AND a.missing_at IS NULL),
             (SELECT a.id FROM assets a WHERE a.project_id = p.id AND a.missing_at IS NULL
                AND a.kind IN ('image','mesh') ORDER BY CASE WHEN a.kind = 'image' THEN 0 ELSE 1 END, a.relative_path LIMIT 1)
           ) AS preview_asset_id
         FROM projects p LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${where} ORDER BY lower(p.name), p.id LIMIT $4 OFFSET $5`,
        [...values, pageSize, (page - 1) * pageSize],
      );
      const categories = await pool.query<{ category: string }>(
        "SELECT DISTINCT split_part(c.relative_path, '/', 1) AS category FROM categories c JOIN projects p ON p.category_id = c.id ORDER BY category",
      );
      return {
        items: rows.rows.map((row) => summary(row, mount)), total: Number(count.rows[0].total),
        page, pageSize, categories: categories.rows.map((row) => row.category),
        fileTypes: ['mesh', 'source', 'image', 'document', 'print', 'other'],
        scan: await scanStatus(pool, indexer),
      };
    },
  );

  server.get<{ Params: { id: string } }>('/catalog/projects/:id', {
    preHandler: auth.authenticate, schema: { params: idParams },
  }, async (request, reply) => {
    const row = await projectById(pool, request.params.id);
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    const assets = await pool.query<AssetRow>(
      `SELECT id, project_id, relative_path, project_relative_path, name, kind, extension,
         size_bytes, mtime_ms, current_version_id, missing_at FROM assets WHERE project_id = $1`,
      [row.id],
    );
    return { project: {
      ...summary(row, mount), designer: row.designer, sourceUrl: safeSource(row.source_url),
      license: row.license, notes: row.notes,
      files: assets.rows.sort((a, b) => natural.compare(a.project_relative_path, b.project_relative_path))
        .map((asset) => assetResponse(asset, mount)),
    } };
  });

  server.patch<{ Params: { id: string }; Body: {
    description?: string | null; tags?: string[]; designer?: string | null;
    sourceUrl?: string | null; license?: string | null; notes?: string | null;
  } }>('/catalog/projects/:id', {
    preHandler: auth.operatorOnly,
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          description: { type: ['string', 'null'], maxLength: 10000 },
          tags: { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
          designer: { type: ['string', 'null'], maxLength: 256 },
          sourceUrl: { type: ['string', 'null'], maxLength: 2048 },
          license: { type: ['string', 'null'], maxLength: 512 },
          notes: { type: ['string', 'null'], maxLength: 10000 },
        },
      },
    },
  }, async (request, reply) => {
    const fields: Record<string, string> = {
      description: 'description', tags: 'tags', designer: 'designer', sourceUrl: 'source_url',
      license: 'license', notes: 'notes',
    };
    const input = request.body;
    if (input.sourceUrl && !safeSource(input.sourceUrl)) {
      return reply.code(400).send({ error: 'Source URL must use http or https' });
    }
    const keys = Object.keys(input);
    const values = keys.map((key) => input[key as keyof typeof input]);
    const result = await pool.query(
      `UPDATE projects SET ${keys.map((key, index) => `${fields[key]} = $${index + 2}`).join(', ')},
       updated_at = now() WHERE id = $1 RETURNING id`,
      [request.params.id, ...values],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'Project not found' });
    const project = await projectById(pool, request.params.id);
    return { project: summary(project!, mount) };
  });

  server.put<{ Body: { projectId: string; isBoundary: boolean } }>('/catalog/boundaries', {
    preHandler: auth.operatorOnly,
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['projectId', 'isBoundary'],
      properties: { projectId: { type: 'string', pattern: uuid }, isBoundary: { type: 'boolean' } },
    } },
  }, async (request, reply) => {
    const project = await projectById(pool, request.body.projectId);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (request.body.isBoundary) {
      await pool.query(
        `INSERT INTO project_boundary_overrides (relative_path, kind) VALUES ($1, 'project')
         ON CONFLICT (relative_path) DO UPDATE SET kind = 'project'`,
        [project.relative_path],
      );
    } else {
      await pool.query('DELETE FROM project_boundary_overrides WHERE relative_path = $1', [project.relative_path]);
    }
    return { projectId: project.id, isBoundary: request.body.isBoundary };
  });

  server.get<{ Params: { id: string }; Querystring: { versionId?: string } }>('/catalog/assets/:id/download', {
    preHandler: auth.authenticate,
    schema: {
      params: idParams, querystring: {
        type: 'object', additionalProperties: false,
        properties: { versionId: { type: 'string', pattern: uuid } },
      },
    },
  }, async (request, reply) => {
    const asset = await assetById(pool, request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });
    if (asset.missing_at || !asset.current_version_id ||
      (request.query.versionId && request.query.versionId !== asset.current_version_id)) {
      return reply.code(410).send({ error: 'Requested version is unavailable' });
    }
    try {
      const { handle, stats } = await openLibraryFile(root, asset.relative_path);
      if (stats.size !== Number(asset.size_bytes) || Math.abs(stats.mtimeMs - Number(asset.mtime_ms)) > 1) {
        await handle.close();
        return reply.code(409).send({ error: 'File changed since indexing; rescan before downloading' });
      }
      const filename = Array.from(asset.name, (character) =>
        character === '"' || character === '\\' || character.codePointAt(0)! < 32
          ? '_' : character).join('');
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_');
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(handle.createReadStream());
    } catch (error) {
      return libraryError(reply, error);
    }
  });

  async function servePreview(asset: AssetRow, reply: FastifyReply) {
    if (asset.missing_at || !asset.current_version_id) return reply.code(410).send({ error: 'Preview source is unavailable' });
    try {
      const { handle, stats, canonicalFile } = await openLibraryFile(root, asset.relative_path);
      try {
        if (stats.size !== Number(asset.size_bytes) || Math.abs(stats.mtimeMs - Number(asset.mtime_ms)) > 1) {
          return reply.code(409).send({ error: 'Preview source changed since indexing' });
        }
        let bytes: Buffer;
        let mimeType: string;
        if (asset.kind === 'image') {
          if (stats.size > 8 * 1024 * 1024) return reply.code(422).send({ error: 'Image is too large to preview' });
          bytes = Buffer.alloc(stats.size);
          if ((await handle.read(bytes, 0, stats.size, 0)).bytesRead !== stats.size) {
            return reply.code(409).send({ error: 'Image changed during preview' });
          }
          mimeType = validatedImageType(bytes) ?? '';
          if (!mimeType) return reply.code(422).send({ error: 'Image content is unsupported or invalid' });
        } else if (asset.extension.toLowerCase() === '.stl') {
          bytes = await renderStlPreview(handle, stats.size);
          mimeType = 'image/svg+xml';
        } else if (asset.extension.toLowerCase() === '.3mf' && options.read3mfThumbnail) {
          const thumbnail = await options.read3mfThumbnail(canonicalFile);
          if (!thumbnail) return reply.code(422).send({ error: 'No validated 3MF thumbnail is available' });
          bytes = thumbnail.bytes;
          mimeType = thumbnail.mimeType;
        } else return reply.code(415).send({ error: 'Preview is not supported for this file type' });
        reply.header('Content-Type', mimeType);
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, max-age=300');
        return reply.send(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      return libraryError(reply, error);
    }
  }

  server.get<{ Params: { id: string } }>('/catalog/assets/:id/preview', {
    preHandler: auth.authenticate, schema: { params: idParams },
  }, async (request, reply) => {
    const asset = await assetById(pool, request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });
    return servePreview(asset, reply);
  });

  server.get<{ Params: { id: string } }>('/catalog/projects/:id/preview', {
    preHandler: auth.authenticate, schema: { params: idParams },
  }, async (request, reply) => {
    const project = await projectById(pool, request.params.id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (!project.preview_asset_id) return reply.code(404).send({ error: 'No preview is available' });
    const asset = await assetById(pool, project.preview_asset_id);
    if (!asset) return reply.code(404).send({ error: 'Preview asset not found' });
    return servePreview(asset, reply);
  });
}
