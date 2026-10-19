import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { libraryMutationLock, type createPool } from '@print-pantry/db';
import type {
  ImportIntakeResult, ImportMetadata, ImportPlan, ImportStatus,
} from '@print-pantry/contracts';
import type { createAuth, User } from './auth.js';
import { openLibraryFile } from './files.js';
import { importSource } from './import-sources.js';
import { findImportMatches } from './imports.js';
import {
  hashStoredFile, importLimits, IntakeError, normalizeImportPath, organizeFiles, portablePath,
  projectSlug, receiveUpload, safeDirectory, storeStream, validatePlanPaths,
  validateStorage, type ImportStorage, type StoredFile,
} from './import-storage.js';

type Pool = ReturnType<typeof createPool>;
type RequestRow = {
  id: string; status: ImportStatus; revision: number; title: string | null;
  source_url: string; source_key: string; project_id: string | null;
};
type IntakeRow = {
  request_id: string; plan: ImportPlan | null; last_error: string | null;
  reserved_project_id: string | null; published_path: string | null;
};
type FileRow = {
  id: string; original_path: string; stored_path: string; content_hash: string; size_bytes: string;
};
type UploadRow = { id: string; name: string; content_hash: string; size_bytes: string; removed_at: Date | null };
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const revision = { type: 'integer', minimum: 0 } as const;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const revisionBody = {
  type: 'object', additionalProperties: false, required: ['expectedRevision'],
  properties: { expectedRevision: revision },
} as const;
const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength });
const metadataSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'category', 'description', 'designer', 'license', 'notes', 'tags'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 256 },
    category: nullableText(200), description: nullableText(10000), designer: nullableText(256),
    license: nullableText(512), notes: nullableText(10000),
    tags: { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
  },
} as const;

async function transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const value = await work();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function requestRow(client: PoolClient, id: string): Promise<RequestRow> {
  const result = await client.query<RequestRow>('SELECT * FROM import_requests WHERE id = $1', [id]);
  if (!result.rows[0]) throw new IntakeError('Import request not found', 404);
  return result.rows[0];
}

async function intakeRow(client: PoolClient, id: string): Promise<IntakeRow> {
  const result = await client.query<IntakeRow>('SELECT * FROM import_intakes WHERE request_id = $1', [id]);
  if (!result.rows[0]) throw new IntakeError('Prepare the import folder before uploading or processing files', 409);
  return result.rows[0];
}

async function activeFiles(client: PoolClient, id: string): Promise<StoredFile[]> {
  const rows = await client.query<FileRow>(
    `SELECT f.* FROM import_files f JOIN import_uploads u ON u.id = f.upload_id
     WHERE f.request_id = $1 AND u.removed_at IS NULL ORDER BY f.original_path, f.id`, [id],
  );
  return rows.rows.map((f) => ({
    id: f.id, originalPath: f.original_path, storedPath: f.stored_path,
    hash: f.content_hash, size: Number(f.size_bytes),
  })).sort((a, b) => natural.compare(a.originalPath, b.originalPath) || a.id.localeCompare(b.id));
}

async function verifyInventory(root: string, directory: string, expected: string[]) {
  const remaining = new Set(expected);
  let visited = 0;
  async function walk(path: string) {
    if (++visited > 16000) throw new IntakeError('Published directory exceeds inventory limits', 409);
    for (const entry of await readdir(join(root, directory, path), { withFileTypes: true })) {
      const relativePath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relativePath);
      else if (!entry.isFile() || !remaining.delete(relativePath)) {
        throw new IntakeError('Published directory has unexpected files or symlinks; it will not be overwritten', 409);
      }
    }
  }
  await walk('');
  if (remaining.size) throw new IntakeError('Published directory is incomplete; restore its expected files before retrying', 409);
}

async function result(client: PoolClient, id: string, configured: boolean): Promise<ImportIntakeResult> {
  const row = await requestRow(client, id);
  const intake = (await client.query<IntakeRow>('SELECT * FROM import_intakes WHERE request_id = $1', [id])).rows[0];
  const uploads = await client.query<{ id: string; name: string; size: string; file_count: number }>(
    `SELECT u.id, u.name, u.size_bytes AS size,
       (SELECT count(*)::int FROM import_files f WHERE f.upload_id = u.id) AS file_count
     FROM import_uploads u WHERE u.request_id = $1 AND u.removed_at IS NULL ORDER BY u.id`, [id],
  );
  return {
    revision: row.revision, ...(row.project_id ? { projectId: row.project_id } : {}),
    intake: {
      configured, prepared: !!intake,
      uploads: uploads.rows.map((u) => ({ id: u.id, name: u.name, size: Number(u.size), fileCount: u.file_count })),
      plan: intake?.plan ?? null, lastError: intake?.last_error ?? null, publishedPath: intake?.published_path ?? null,
    },
  };
}

function checkEditable(row: RequestRow, expectedRevision: number) {
  if (row.revision !== expectedRevision) throw new IntakeError('Import changed; refresh and review before trying again', 409);
  if (!['awaiting_files', 'ready_for_review'].includes(row.status)) {
    throw new IntakeError('Only accepted imports awaiting files or review can be edited', 409);
  }
}

async function updateStatus(client: PoolClient, row: RequestRow, status: ImportStatus, user: User) {
  await client.query('UPDATE import_requests SET status = $2, revision = revision + 1, updated_at = now() WHERE id = $1', [row.id, status]);
  if (status !== row.status) await client.query(
    'INSERT INTO import_events (request_id, actor_id, status) VALUES ($1,$2,$3)', [row.id, user.id, status],
  );
}

async function duplicates(client: PoolClient, row: RequestRow, plan: ImportPlan, excluded?: string) {
  const source = await findImportMatches(client, importSource(row.source_url));
  const hashes = plan.files.filter((f) => f.include).map((f) => f.hash);
  const content = await client.query<{ project_id: string; name: string; matching_files: number }>(
    `SELECT p.id AS project_id, p.name, count(DISTINCT a.id)::int AS matching_files
     FROM assets a JOIN projects p ON p.id = a.project_id
     WHERE a.content_hash = ANY($1::text[]) AND a.missing_at IS NULL AND p.missing_at IS NULL
     GROUP BY p.id, p.name LIMIT 50`, [hashes],
  );
  const found = new Map(source.projects.map((p) => [p.id, { projectId: p.id, name: p.name, matchingFiles: 0 }]));
  for (const entry of content.rows) found.set(entry.project_id, {
    projectId: entry.project_id, name: entry.name, matchingFiles: entry.matching_files,
  });
  if (excluded) found.delete(excluded);
  return [...found.values()];
}

function normalizeMetadata(input: ImportMetadata): ImportMetadata {
  const optional = (value: string | null) => value?.trim() || null;
  const name = input.name.trim();
  if (!name) throw new IntakeError('Enter a project title before processing');
  const category = optional(input.category);
  if (category) {
    const parts = category.split('/');
    if (parts.length > 6 || parts.some((part) => !part.trim() || ['.', '..'].includes(part.trim()))) {
      throw new IntakeError('Category must contain up to six nonempty slash-separated names');
    }
  }
  const tags = input.tags.map((tag) => tag.trim());
  if (tags.some((tag) => !tag) || new Set(tags).size !== tags.length) throw new IntakeError('Tags must be nonblank and unique');
  return {
    name, category: category?.split('/').map((part) => part.trim()).join('/') ?? null,
    description: optional(input.description), designer: optional(input.designer),
    license: optional(input.license), notes: optional(input.notes), tags,
  };
}

async function categoryId(client: PoolClient, category: string | null): Promise<string | null> {
  if (!category) return null;
  let parentId: string | null = null;
  const parts = category.split('/');
  for (let i = 0; i < parts.length; i++) {
    const row: { rows: Array<{ id: string }> } = await client.query(
      `INSERT INTO categories (name, relative_path, parent_id) VALUES ($1,$2,$3)
       ON CONFLICT (relative_path) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [parts[i], parts.slice(0, i + 1).join('/'), parentId],
    );
    parentId = row.rows[0].id;
  }
  return parentId;
}

export function registerImportIntake(
  server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>,
  legacyRoot: string, storage?: ImportStorage,
) {
  server.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));

  async function operation<T>(
    id: string, reply: FastifyReply,
    work: (client: PoolClient) => Promise<T>, requiresStorage = true,
  ) {
    const client = await pool.connect();
    let locked = false;
    try {
      const claim = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,98419)) AS locked', [id],
      );
      locked = claim.rows[0].locked;
      if (!locked) throw new IntakeError('Another operation is working on this import; refresh and retry', 409);
      await requestRow(client, id);
      if (requiresStorage) {
        if (!storage) throw new IntakeError('Configure IMPORT_STORAGE_ROOT and MANAGED_LIBRARY_ROOT to enable file intake', 503);
        await validateStorage(storage, legacyRoot);
      }
      return await work(client);
    } catch (error) {
      server.log.error({ err: error, importId: id }, 'Import operation failed');
      let message: string;
      let status: number;
      if (error instanceof IntakeError) {
        message = error.message; status = error.status;
      } else if (error instanceof Error && 'code' in error &&
          ['ENOSPC', 'EROFS', 'EACCES', 'ENOENT', 'EIO', 'ENOTDIR'].includes(String(error.code))) {
        message = `Import storage is unavailable (${error.code}); verify mounts, permissions, and free space. Originals are retained.`;
        status = 503;
      } else {
        message = 'Import failed; originals are retained. Check the server log and retry the operation.';
        status = 500;
      }
      if (locked) {
        try { await client.query('UPDATE import_intakes SET last_error = $2 WHERE request_id = $1', [id, message]); }
        catch (recordError) { server.log.error({ err: recordError, importId: id }, 'Could not record import failure'); }
      }
      return reply.code(status).send({ error: message });
    } finally {
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,98419))', [id]);
      } finally { client.release(); }
    }
  }

  server.get<{ Params: { id: string } }>('/imports/:id/intake', {
    preHandler: auth.operatorOnly, schema: { params: idParams },
  }, async (request, reply) => operation(request.params.id, reply,
    (client) => result(client, request.params.id, !!storage), false));

  server.get<{ Params: { id: string; uploadId: string } }>('/imports/:id/files/:uploadId/original', {
    preHandler: auth.operatorOnly,
    schema: { params: { ...idParams, required: ['id', 'uploadId'], properties: {
      ...idParams.properties, uploadId: { type: 'string', pattern: uuid },
    } } },
  }, async (request, reply) => operation(request.params.id, reply, async (client) => {
    const upload = (await client.query<{ stored_path: string; name: string }>(
      'SELECT stored_path, name FROM import_uploads WHERE id = $1 AND request_id = $2',
      [request.params.uploadId, request.params.id],
    )).rows[0];
    if (!upload) throw new IntakeError('Original upload not found', 404);
    const { handle } = await openLibraryFile(storage!.intakeRoot, upload.stored_path);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(upload.name.split('/').at(-1)!)}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(handle.createReadStream());
  }));

  server.post<{ Params: { id: string }; Body: { expectedRevision: number } }>('/imports/:id/prepare', {
    preHandler: auth.operatorOnly, schema: { params: idParams, body: revisionBody },
  }, async (request, reply) => operation(request.params.id, reply, async (client) => {
    const row = await requestRow(client, request.params.id);
    checkEditable(row, request.body.expectedRevision);
    await safeDirectory(storage!.intakeRoot, row.id);
    await client.query('INSERT INTO import_intakes (request_id) VALUES ($1) ON CONFLICT DO NOTHING', [row.id]);
    return result(client, row.id, true);
  }));

  server.post<{ Params: { id: string }; Querystring: { name: string; uploadKey: string; expectedRevision: number }; Body: Readable }>(
    '/imports/:id/files', {
      preHandler: auth.operatorOnly, bodyLimit: importLimits.uploadBytes,
      schema: { params: idParams, querystring: {
        type: 'object', additionalProperties: false, required: ['name', 'uploadKey', 'expectedRevision'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 700 },
          uploadKey: { type: 'string', pattern: uuid }, expectedRevision: revision,
        },
      } },
    }, async (request, reply) => operation(request.params.id, reply, async (client) => {
      const row = await requestRow(client, request.params.id);
      const prior = (await client.query<UploadRow>('SELECT * FROM import_uploads WHERE id = $1 AND request_id = $2',
        [request.query.uploadKey, row.id])).rows[0];
      if (!prior) checkEditable(row, request.query.expectedRevision);
      else if (!['awaiting_files', 'ready_for_review'].includes(row.status)) throw new IntakeError('This import is no longer accepting uploads', 409);
      await intakeRow(client, row.id);
      if (!request.body || typeof request.body.pipe !== 'function') throw new IntakeError('Upload files with application/octet-stream content type', 415);
      const totals = await client.query<{ count: number; bytes: string; files: number; expanded_bytes: string }>(
        `SELECT count(*)::int AS count, coalesce(sum(size_bytes),0)::text AS bytes,
           (SELECT count(*)::int FROM import_files WHERE request_id = $1) AS files,
           (SELECT coalesce(sum(size_bytes),0)::text FROM import_files WHERE request_id = $1) AS expanded_bytes
         FROM import_uploads WHERE request_id = $1`, [row.id],
      );
      if (!prior && (totals.rows[0].count >= importLimits.uploads || Number(totals.rows[0].bytes) >= importLimits.totalBytes)) {
        throw new IntakeError('This import reached its retained-upload count or size limit', 413);
      }
      const received = await receiveUpload(request.body, storage!.intakeRoot, row.id, request.query.name);
      if (prior) {
        await rm(join(storage!.intakeRoot, dirname(received.original.path)), { recursive: true, force: true });
        if (prior.content_hash !== received.original.hash || prior.name !== request.query.name || prior.removed_at) {
          throw new IntakeError('Upload key was already used for different or removed content; choose a new upload key', 409);
        }
        return result(client, row.id, true);
      }
      if (Number(totals.rows[0].bytes) + received.original.size > importLimits.totalBytes ||
          totals.rows[0].files + received.files.length > importLimits.files) {
        await rm(join(storage!.intakeRoot, dirname(received.original.path)), { recursive: true, force: true });
        throw new IntakeError('This import exceeds its total upload or file-count limit', 413);
      }
      if (Number(totals.rows[0].expanded_bytes) + received.files.reduce((sum, f) => sum + f.size, 0) > importLimits.totalBytes) {
        await rm(join(storage!.intakeRoot, dirname(received.original.path)), { recursive: true, force: true });
        throw new IntakeError('This import exceeds its total expanded-data limit', 413);
      }
      await writeFile(join(storage!.intakeRoot, dirname(received.original.path), 'recovery.json'), JSON.stringify({
        schemaVersion: 1, importId: row.id, uploadId: request.query.uploadKey,
        originalName: request.query.name, source: importSource(row.source_url),
        original: received.original, files: received.files,
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await transaction(client, async () => {
        await client.query(
          `INSERT INTO import_uploads (id, request_id, name, stored_path, content_hash, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [request.query.uploadKey, row.id, request.query.name, received.original.path, received.original.hash, received.original.size],
        );
        for (const file of received.files) await client.query(
          `INSERT INTO import_files (id, request_id, upload_id, original_path, stored_path, content_hash, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [file.id, row.id, request.query.uploadKey, file.originalPath, file.storedPath, file.hash, file.size],
        );
        await client.query('UPDATE import_intakes SET plan = NULL, last_error = NULL WHERE request_id = $1', [row.id]);
        await updateStatus(client, row, 'awaiting_files', auth.currentUser(request));
      });
      return result(client, row.id, true);
    }),
  );

  server.delete<{ Params: { id: string; uploadId: string }; Body: { expectedRevision: number } }>('/imports/:id/files/:uploadId', {
    preHandler: auth.operatorOnly,
    schema: { params: { ...idParams, required: ['id', 'uploadId'], properties: {
      ...idParams.properties, uploadId: { type: 'string', pattern: uuid },
    } }, body: revisionBody },
  }, async (request, reply) => operation(request.params.id, reply, async (client) => {
    const row = await requestRow(client, request.params.id);
    checkEditable(row, request.body.expectedRevision);
    await transaction(client, async () => {
      const removed = await client.query(
        'UPDATE import_uploads SET removed_at = now() WHERE id = $1 AND request_id = $2 AND removed_at IS NULL RETURNING id',
        [request.params.uploadId, row.id],
      );
      if (!removed.rowCount) throw new IntakeError('Active upload not found', 404);
      await client.query('UPDATE import_intakes SET plan = NULL, last_error = NULL WHERE request_id = $1', [row.id]);
      await updateStatus(client, row, 'awaiting_files', auth.currentUser(request));
    });
    return result(client, row.id, true);
  }));

  server.post<{ Params: { id: string }; Body: {
    expectedRevision: number; metadata: ImportMetadata; files?: Array<{ id: string; path: string; include: boolean }>;
  } }>('/imports/:id/plan', {
    preHandler: auth.operatorOnly, bodyLimit: importLimits.planBytes, schema: { params: idParams, body: {
      ...revisionBody, required: ['expectedRevision', 'metadata'],
      properties: {
        ...revisionBody.properties, metadata: metadataSchema,
        files: { type: 'array', maxItems: importLimits.files, items: {
          type: 'object', additionalProperties: false, required: ['id', 'path', 'include'],
          properties: { id: { type: 'string', pattern: uuid }, path: { type: 'string', minLength: 1, maxLength: 700 }, include: { type: 'boolean' } },
        } },
      },
    } },
  }, async (request, reply) => operation(request.params.id, reply, async (client) => {
    const row = await requestRow(client, request.params.id);
    checkEditable(row, request.body.expectedRevision);
    await intakeRow(client, row.id);
    const files = await activeFiles(client, row.id);
    if (!files.length) throw new IntakeError('Upload model files before processing');
    for (const file of files) {
      const current = await hashStoredFile(storage!.intakeRoot, file.storedPath);
      if (current.hash !== file.hash || current.size !== file.size) throw new IntakeError('An original upload changed; restore it before processing', 409);
    }
    const organized = organizeFiles(files);
    if (request.body.files) {
      const edits = new Map(request.body.files.map((file) => [file.id, file]));
      if (edits.size !== files.length || request.body.files.length !== files.length ||
          files.some((file) => !edits.has(file.id))) {
        throw new IntakeError('A reviewed plan must contain every input file exactly once');
      }
      organized.files = organized.files.map((file) => ({ ...file, ...edits.get(file.id)! }));
    }
    try {
      validatePlanPaths(organized.files);
    } catch (error) {
      if (!(error instanceof IntakeError) || request.body.files) throw error;
      organized.warnings.push(`Resolve destination conflicts before publishing: ${error.message}. Rename or exclude conflicting files, then save the plan.`);
    }
    if (organized.files.some((file) => extname(file.path).toLowerCase() !== extname(normalizeImportPath(file.originalPath)).toLowerCase())) {
      throw new IntakeError('Renaming a file must preserve its extension');
    }
    if (!organized.files.some((file) => file.include && ['mesh', 'source', 'print'].includes(file.kind))) {
      throw new IntakeError('Select at least one model, CAD source, or print-export file');
    }
    const plan: ImportPlan = {
      schemaVersion: 1, metadata: normalizeMetadata(request.body.metadata),
      ...organized, duplicates: [],
    };
    plan.duplicates = await duplicates(client, row, plan);
    await transaction(client, async () => {
      await client.query('UPDATE import_intakes SET plan = $2, last_error = NULL WHERE request_id = $1', [row.id, JSON.stringify(plan)]);
      await updateStatus(client, row, 'ready_for_review', auth.currentUser(request));
    });
    return result(client, row.id, true);
  }));

  server.post<{ Params: { id: string }; Body: { expectedRevision: number; confirmDuplicates: boolean } }>('/imports/:id/publish', {
    preHandler: auth.operatorOnly, schema: { params: idParams, body: {
      ...revisionBody, required: ['expectedRevision', 'confirmDuplicates'],
      properties: { ...revisionBody.properties, confirmDuplicates: { type: 'boolean' } },
    } },
  }, async (request, reply) => operation(request.params.id, reply, async (client) => {
    let row = await requestRow(client, request.params.id);
    if (row.status === 'imported') return result(client, row.id, true);
    if (row.revision !== request.body.expectedRevision ||
        !['ready_for_review', 'publishing', 'catalog_pending'].includes(row.status)) {
      throw new IntakeError('Import changed or has no approved plan; refresh and review before publishing', 409);
    }
    let intake = await intakeRow(client, row.id);
    if (!intake.plan) throw new IntakeError('Process and review the files before publishing', 409);
    const plan = intake.plan;
    validatePlanPaths(plan.files);
    const claim = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [libraryMutationLock]);
    if (!claim.rows[0].locked) throw new IntakeError('A scan, publication, or migration is running; retry after it finishes', 409);
    try {
      const currentDuplicates = await duplicates(client, row, plan, intake.reserved_project_id ?? undefined);
      if (currentDuplicates.length && !request.body.confirmDuplicates) {
        throw new IntakeError('Matching source or file content already exists. Regenerate/review the plan and explicitly confirm a separate project', 409);
      }
      if (!intake.reserved_project_id) {
        await transaction(client, async () => {
          const id = (await client.query<{ id: string }>("SELECT nextval('project_id_seq')::text AS id")).rows[0].id;
          const path = `projects/${id}-${projectSlug(plan.metadata.name)}`;
          await client.query('UPDATE import_intakes SET reserved_project_id = $2, published_path = $3, last_error = NULL WHERE request_id = $1', [row.id, id, path]);
          await updateStatus(client, row, 'publishing', auth.currentUser(request));
        });
        row = await requestRow(client, row.id);
        intake = await intakeRow(client, row.id);
      }
      const projectId = intake.reserved_project_id!;
      const finalPath = intake.published_path!;
      portablePath(finalPath);
      const planDigest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
      const expectedManifest = {
        schemaVersion: 1, projectId, importId: row.id, planDigest,
        ...plan.metadata, source: importSource(row.source_url),
        files: plan.files.filter((file) => file.include),
      };
      let exists = true;
      try { await lstat(join(storage!.managedRoot, finalPath)); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        exists = false;
      }
      if (!exists) {
        const stage = `.staging/${row.id}-${randomUUID()}`;
        const stageRoot = await safeDirectory(storage!.managedRoot, stage);
        try {
          const sourceFiles = new Map((await activeFiles(client, row.id)).map((file) => [file.id, file]));
          for (const file of plan.files.filter((entry) => entry.include)) {
            const source = sourceFiles.get(file.id);
            if (!source) throw new IntakeError('The approved input inventory no longer exists', 409);
            const { handle } = await openLibraryFile(storage!.intakeRoot, source.storedPath);
            try {
              const copied = await storeStream(handle.createReadStream({ autoClose: false }), stageRoot, file.path, importLimits.expandedBytes);
              if (copied.hash !== file.hash || copied.size !== file.size) throw new IntakeError('An original changed after review; publication stopped without replacing library files', 409);
            } finally { await handle.close(); }
          }
          const manifestPath = join(storage!.managedRoot, stage, 'project.json');
          await writeFile(manifestPath, JSON.stringify(expectedManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          const manifestHandle = await open(manifestPath, 'r');
          try { await manifestHandle.sync(); } finally { await manifestHandle.close(); }
          await safeDirectory(storage!.managedRoot, 'projects');
          await rename(join(storage!.managedRoot, stage), join(storage!.managedRoot, finalPath));
        } finally {
          await rm(join(storage!.managedRoot, stage), { recursive: true, force: true });
        }
      }
      const { handle: manifestHandle, stats: manifestStats } = await openLibraryFile(storage!.managedRoot, `${finalPath}/project.json`);
      try {
        if (manifestStats.size > importLimits.planBytes) throw new IntakeError('Published manifest exceeds its validation limit', 409);
        const manifest: unknown = JSON.parse(await manifestHandle.readFile('utf8'));
        if (!isDeepStrictEqual(manifest, expectedManifest)) {
          throw new IntakeError('Destination is not the verified publication for this import; it will not be overwritten', 409);
        }
      } finally { await manifestHandle.close(); }
      await verifyInventory(storage!.managedRoot, finalPath, [
        'project.json', ...plan.files.filter((file) => file.include).map((file) => file.path),
      ]);
      const registered: Array<{
        id: string; versionId: string; path: string; hash: string; size: number;
        kind: ImportPlan['files'][number]['kind']; stats: Awaited<ReturnType<typeof hashStoredFile>>['stats'];
      }> = [];
      for (const file of plan.files.filter((entry) => entry.include)) {
        const verified = await hashStoredFile(storage!.managedRoot, `${finalPath}/${file.path}`);
        if (verified.hash !== file.hash || verified.size !== file.size) throw new IntakeError('Published content differs from the approved plan; nothing will be overwritten', 409);
        registered.push({ ...file, stats: verified.stats });
      }
      const generated = await hashStoredFile(storage!.managedRoot, `${finalPath}/project.json`);
      registered.push({
        id: randomUUID(), versionId: randomUUID(), path: 'project.json',
        hash: generated.hash, size: generated.size, kind: 'document', stats: generated.stats,
      });
      if (row.status !== 'catalog_pending') {
        await transaction(client, () => updateStatus(client, row, 'catalog_pending', auth.currentUser(request)));
        row = await requestRow(client, row.id);
      }
      await transaction(client, async () => {
        const category = await categoryId(client, plan.metadata.category);
        await client.query(
          `INSERT INTO projects (id, storage_kind, relative_path, name, category_id, description, tags, designer, source_url, license, notes)
           VALUES ($1,'managed',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [projectId, finalPath, plan.metadata.name, category, plan.metadata.description, plan.metadata.tags,
            plan.metadata.designer, row.source_url, plan.metadata.license, plan.metadata.notes],
        );
        for (const [sortOrder, file] of registered.entries()) {
          await client.query(
            `INSERT INTO assets (id, project_id, storage_kind, relative_path, project_relative_path, name, sort_order, kind,
               extension, size_bytes, mtime_ms, inode, device, content_hash)
             VALUES ($1,$2,'managed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [file.id, projectId, `${finalPath}/${file.path}`, file.path, file.path.split('/').at(-1), sortOrder,
              file.kind, extname(file.path).toLowerCase(), file.size, Math.trunc(file.stats.mtimeMs),
              file.stats.ino, file.stats.dev, file.hash],
          );
          await client.query(
            `INSERT INTO asset_versions (id, asset_id, content_hash, size_bytes, mtime_ms) VALUES ($1,$2,$3,$4,$5)`,
            [file.versionId, file.id, file.hash, file.size, Math.trunc(file.stats.mtimeMs)],
          );
          await client.query('UPDATE assets SET current_version_id = $2 WHERE id = $1', [file.id, file.versionId]);
        }
        const source = importSource(row.source_url);
        await client.query(
          `INSERT INTO project_sources (project_id, source_key, source_url, canonical_url, provider,
             external_model_id, external_profile_id, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [projectId, source.key, source.url, source.canonicalUrl, source.provider, source.modelId, source.profileId, `operator-reviewed import:${row.id}`],
        );
        await client.query('UPDATE import_requests SET project_id = $2, title = $3 WHERE id = $1', [row.id, projectId, plan.metadata.name]);
        await client.query('UPDATE import_intakes SET last_error = NULL WHERE request_id = $1', [row.id]);
        await updateStatus(client, row, 'imported', auth.currentUser(request));
      });
      return result(client, row.id, true);
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [libraryMutationLock]); }
  }));
}
