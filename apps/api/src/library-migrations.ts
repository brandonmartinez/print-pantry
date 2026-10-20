import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, opendir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { libraryMutationLock, type createPool } from '@print-pantry/db';
import {
  isProjectId, projectIdPattern, type LibraryMigrationJob, type LibraryMigrationProjectStatus,
  type LibraryReorganizationPlan, type LibraryReorganizationProject,
} from '@print-pantry/contracts';
import type { createAuth } from './auth.js';
import type { CatalogOptions } from './catalog.js';
import { openLibraryFile } from './files.js';
import { hashStoredFile, IntakeError, pathKey, portablePath, safeDirectory, storeStream, validatePlanPaths } from './import-storage.js';
import {
  inspectLibraryProject, libraryFileSelect, libraryPreviewLimits, libraryProjectSelect,
  type LibraryFileRow, type LibraryProjectRow,
} from './library-management.js';

type Pool = ReturnType<typeof createPool>;
type Connection = Pick<PoolClient, 'query'>;
type RootIdentities = { legacy: { dev: string; ino: string }; managed: { dev: string; ino: string } };
type Job = {
  id: string; plan_id: string; status: LibraryMigrationJob['status']; revision: number;
  legacy_root: string; managed_root: string; root_identities: RootIdentities; created_at: Date; updated_at: Date;
};
type Snapshot = { project: LibraryReorganizationProject; files: LibraryFileRow[]; fingerprint: string };
type Item = {
  id: string; project_id: string; migration_id: string; legacy_path: string; managed_path: string;
  status: LibraryMigrationProjectStatus; snapshot: Snapshot; last_error: string | null;
};
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const jobParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const revisionBody = { type: 'object', additionalProperties: false, required: ['expectedRevision'],
  properties: { expectedRevision: { type: 'integer', minimum: 0 } } } as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown migration failure';
const identity = (stats: { dev: number; ino: number }) => ({ dev: String(stats.dev), ino: String(stats.ino) });
const stagePath = (item: Item) => `projects/.migration-${item.id}`;
const retainedPath = (item: Item) => `projects/.retained-${item.id}`;

async function transaction<T>(client: PoolClient, work: () => Promise<T>) {
  await client.query('BEGIN');
  try { const result = await work(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function roots(options: CatalogOptions): Promise<RootIdentities> {
  if (!options.managedRoot) throw new IntakeError('Managed storage is not configured', 503);
  const legacy = resolve(options.root);
  const managed = resolve(options.managedRoot);
  if (legacy === managed || legacy.startsWith(`${managed}/`) || managed.startsWith(`${legacy}/`)) {
    throw new IntakeError('Legacy and managed roots must be separate, non-nested directories', 503);
  }
  const result = await Promise.all([legacy, managed].map(async (root) => {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(root) !== root) {
      throw new IntakeError('Storage roots must be real directories without symlink components', 503);
    }
    return identity(stats);
  }));
  return { legacy: result[0], managed: result[1] };
}
async function checkedRoots(job: Pick<Job, 'legacy_root' | 'managed_root' | 'root_identities'>, options: CatalogOptions) {
  if (resolve(options.root) !== job.legacy_root || !options.managedRoot || resolve(options.managedRoot) !== job.managed_root ||
    !isDeepStrictEqual(await roots(options), job.root_identities)) {
    throw new IntakeError('Storage configuration or root identity changed. Restore the approved mounts before resuming.', 409);
  }
}
async function items(client: Connection, id: string) {
  return (await client.query<Item>('SELECT * FROM library_migration_projects WHERE migration_id=$1 ORDER BY project_id', [id])).rows;
}
export async function libraryMigrationForPlan(client: Connection, planId: string): Promise<LibraryMigrationJob | undefined> {
  const row = (await client.query<Job>('SELECT * FROM library_migrations WHERE plan_id=$1', [planId])).rows[0];
  return row ? publicJob(client, row) : undefined;
}
async function publicJob(client: Connection, row: Job): Promise<LibraryMigrationJob> {
  return {
    id: row.id, planId: row.plan_id, status: row.status, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    projects: (await items(client, row.id)).map((item) => ({
      projectId: item.project_id, name: item.snapshot.project.name, status: item.status,
      legacyPath: item.legacy_path, managedPath: item.managed_path, lastError: item.last_error,
    })),
  };
}
async function jobRow(client: Connection, id: string) {
  const row = (await client.query<Job>('SELECT * FROM library_migrations WHERE id=$1', [id])).rows[0];
  if (!row) throw new IntakeError('Migration not found', 404);
  return row;
}
async function catalog(client: Connection, ids: string[]) {
  const rows = (await client.query<LibraryProjectRow>(`${libraryProjectSelect} WHERE p.id=ANY($1::bigint[]) ORDER BY p.id`, [ids])).rows;
  if (rows.length !== ids.length || rows.some((row) => row.storage_kind !== 'legacy' || row.file_count > libraryPreviewLimits.files)) {
    throw new IntakeError('Project identity, storage, or inventory changed. Generate a fresh dry run.', 409);
  }
  const files: LibraryFileRow[][] = [];
  for (const row of rows) files.push((await client.query<LibraryFileRow>(libraryFileSelect, [row.id, libraryPreviewLimits.files + 1])).rows);
  return { rows, files, fingerprint: digest([rows, ...files]) };
}
async function originalCatalog(client: Connection, item: Item) {
  const current = await catalog(client, [item.project_id]);
  if (digest([current.rows[0], current.files[0]]) !== item.snapshot.fingerprint) {
    throw new IntakeError('Catalog metadata or file versions changed after approval. Cancel unactivated work and generate a fresh dry run.', 409);
  }
  const overlap = await client.query(`SELECT id FROM projects WHERE storage_kind='legacy' AND id<>$1
    AND (relative_path=$2 OR starts_with(relative_path,$2||'/') OR starts_with($2,relative_path||'/')) LIMIT 1`,
  [item.project_id, item.legacy_path]);
  if (overlap.rowCount) throw new IntakeError('Project boundaries now overlap; review them before migration', 409);
}
async function sourceInventory(job: Job, item: Item) {
  const project: LibraryReorganizationProject = { ...item.snapshot.project, directories: [], issues: [], checkedFiles: 0, inspectionComplete: false };
  await inspectLibraryProject(job.legacy_root, project, item.snapshot.files, { entries: 0 });
  const blockers = project.issues.filter((entry) => entry.severity === 'blocker');
  if (!project.inspectionComplete || blockers.length || project.checkedFiles !== project.fileCount ||
    !isDeepStrictEqual([...project.directories].sort(), [...item.snapshot.project.directories].sort())) {
    throw new IntakeError(`Source inventory changed or is unavailable. ${blockers[0]?.message ?? 'Generate a fresh dry run.'}`, 409);
  }
}
async function verifiedFile(root: string, path: string, file: LibraryReorganizationProject['files'][number]) {
  const verified = await hashStoredFile(root, path);
  if (verified.hash !== file.contentHash || String(verified.size) !== file.sizeBytes) {
    throw new IntakeError(`File bytes differ from the approved indexed hash: ${file.destinationPath}`, 409);
  }
  const current = await openLibraryFile(root, path);
  try {
    if (current.stats.ino !== verified.stats.ino || current.stats.dev !== verified.stats.dev ||
      current.stats.size !== verified.stats.size || current.stats.mtimeMs !== verified.stats.mtimeMs) {
      throw new IntakeError('File identity changed during verification; retry after storage is stable', 409);
    }
  } finally { await current.handle.close(); }
  return verified.stats;
}
async function sourceBytes(job: Job, item: Item) {
  const stats = [];
  for (const file of item.snapshot.project.files) stats.push(await verifiedFile(job.legacy_root, file.sourcePath, file));
  return stats;
}
function manifest(job: Job, item: Item) {
  return { schemaVersion: 1, kind: 'library_migration', migrationId: job.id, journalId: item.id,
    projectId: item.project_id, legacyPath: item.legacy_path, managedPath: item.managed_path,
    snapshotDigest: digest(item.snapshot), ...item.snapshot.project.metadata, name: item.snapshot.project.name,
    files: item.snapshot.project.files, directories: item.snapshot.project.directories };
}
async function exists(root: string, path: string) {
  try { await lstat(join(root, path)); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function verifyCopy(job: Job, item: Item, path: string) {
  const expected = manifest(job, item);
  const opened = await openLibraryFile(job.managed_root, `${path}/project.json`);
  try {
    if (opened.stats.size > libraryPreviewLimits.bytes) throw new IntakeError('Migration manifest exceeds 8 MiB', 409);
    if (!isDeepStrictEqual(JSON.parse(await opened.handle.readFile('utf8')), expected)) {
      throw new IntakeError("Destination is not this migration's verified copy; it will not be overwritten", 409);
    }
  } finally { await opened.handle.close(); }
  const remaining = new Set(['project.json', ...item.snapshot.project.files.map((file) => file.destinationPath)]);
  const directories = new Set(item.snapshot.project.directories);
  let visited = 0;
  async function walk(relative: string) {
    const absolute = join(job.managed_root, path, relative);
    const before = await lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(absolute) !== absolute) {
      throw new IntakeError('Managed copy contains unsafe directory components', 409);
    }
    for await (const entry of await opendir(absolute)) {
      if (++visited > libraryPreviewLimits.entries + 1) throw new IntakeError('Managed copy exceeds its inventory limit', 409);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.delete(name)) await walk(name);
      else if (entry.isFile() && remaining.delete(name)) continue;
      else throw new IntakeError('Managed copy has unexpected files, directories, or links; nothing will be overwritten', 409);
    }
    const after = await lstat(absolute);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) {
      throw new IntakeError('Managed directory changed during verification', 409);
    }
  }
  await walk('');
  if (remaining.size || directories.size) throw new IntakeError('Managed copy is incomplete; resume copying before activation', 409);
  const stats = [];
  for (const file of item.snapshot.project.files) stats.push(await verifiedFile(job.managed_root, `${path}/${file.destinationPath}`, file));
  return stats;
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function destinationFree(job: Job, item: Item, client: Connection) {
  const conflict = await client.query(`SELECT id FROM projects WHERE storage_kind='managed' AND id<>$1
    AND (lower(relative_path)=lower($2) OR starts_with(lower(relative_path),lower($2)||'/') OR starts_with(lower($2),lower(relative_path)||'/')) LIMIT 1`,
  [item.project_id, item.managed_path]);
  if (conflict.rowCount) throw new IntakeError('Destination overlaps another catalog project', 409);
  for await (const entry of await opendir(join(job.managed_root, 'projects'))) {
    if (pathKey(entry.name) === pathKey(item.managed_path.split('/')[1]) && entry.name !== item.managed_path.split('/')[1]) {
      throw new IntakeError('A case-equivalent destination already exists', 409);
    }
  }
}
async function audit(client: PoolClient, job: Job, actor: string, action: string, projectId?: string) {
  const event = JSON.stringify([{ actorId: actor, action, projectId: projectId ?? null, at: new Date().toISOString() }]);
  await client.query(`UPDATE library_migrations SET revision=revision+1,updated_at=clock_timestamp(),history=history||$2::jsonb,
    status=CASE WHEN status='active' AND NOT EXISTS (SELECT 1 FROM library_migration_projects WHERE migration_id=$1
      AND status IN ('pending','copying','copied')) THEN 'completed' ELSE status END WHERE id=$1`, [job.id, event]);
}
async function updateLocations(client: PoolClient, item: Item, kind: 'legacy' | 'managed', stats: Awaited<ReturnType<typeof sourceBytes>>) {
  const files = item.snapshot.project.files;
  for (const [index, file] of files.entries()) {
    const stat = stats[index];
    const changed = await client.query(`UPDATE assets SET storage_kind=$1,relative_path=$2,mtime_ms=$3,inode=$4,device=$5
      WHERE id=$6 AND project_id=$7 AND current_version_id=$8 AND content_hash=$9`,
    [kind, kind === 'legacy' ? file.sourcePath : `${item.managed_path}/${file.destinationPath}`,
      Math.trunc(stat.mtimeMs), stat.ino, stat.dev, file.id, item.project_id, file.versionId, file.contentHash]);
    if (changed.rowCount !== 1) throw new IntakeError('Asset identity or current version changed during activation', 409);
  }
  await client.query('UPDATE projects SET storage_kind=$1,relative_path=$2 WHERE id=$3',
    [kind, kind === 'legacy' ? item.legacy_path : item.managed_path, item.project_id]);
}

export { roots as migrationStorageIdentity, checkedRoots as validateMigrationStorage };
export type { RootIdentities };
export class MigrationStorageError extends IntakeError {}
export class MigrationBusyError extends IntakeError {}

export function createLibraryMigrationService(pool: Pool, options: CatalogOptions) {
  async function operation<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [libraryMutationLock])).rows[0].locked;
      if (!locked || options.indexer.getStatus().running) throw new MigrationBusyError('A scan, publication, or migration is running; retry after it finishes', 409);
      return await work(client);
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [libraryMutationLock]); }
      finally { client.release(); }
    }
  }
  return {
    get: async (id: string) => publicJob(pool, await jobRow(pool, id)),
    approve: (planId: string, expectedFingerprint: string, actorId: string) => operation(async (client) => {
      const previous = await libraryMigrationForPlan(client, planId);
      if (previous) return previous;
      const plan = (await client.query<{ snapshot: LibraryReorganizationPlan }>('SELECT snapshot FROM library_reorganization_plans WHERE id=$1', [planId])).rows[0]?.snapshot;
      if (!plan) throw new IntakeError('Dry run not found', 404);
      if (plan.fingerprint !== expectedFingerprint || plan.issues.some((entry) => entry.severity === 'blocker') ||
        !plan.projects.length || plan.projects.length > libraryPreviewLimits.projects ||
        plan.projects.some((project) => project.storageKind !== 'legacy' || !project.inspectionComplete || !project.files.length ||
          project.checkedFiles !== project.fileCount || project.issues.some((entry) => entry.severity === 'blocker'))) {
        throw new IntakeError('Review a complete, unblocked dry run before approving migration', 409);
      }
      const rootIdentities = await roots(options);
      const current = await catalog(client, plan.projects.map((project) => project.id));
      if (current.fingerprint !== plan.fingerprint) throw new IntakeError('Dry run is stale. Generate and review a fresh preview.', 409);
      if (current.files.reduce((total, files) => total + files.length, 0) > libraryPreviewLimits.files) {
        throw new IntakeError('Approved batch exceeds 1,000 files; select fewer projects', 409);
      }
      for (const [index, row] of current.rows.entries()) {
        const project = plan.projects.find((entry) => entry.id === row.id)!;
        portablePath(project.destinationPath);
        validatePlanPaths(project.files.map((file) => ({ path: file.destinationPath, include: true })));
        if (project.relativePath !== row.relative_path || !project.destinationPath.startsWith(`projects/${row.id}-`) ||
          project.destinationPath.split('/').length !== 2 || project.files.length !== current.files[index].length ||
          project.files.some((file, i) => {
            const indexed = current.files[index][i];
            return file.id !== indexed.id || file.versionId !== indexed.current_version_id || file.contentHash !== indexed.content_hash ||
              file.sizeBytes !== indexed.size_bytes || file.sourcePath !== indexed.relative_path || file.destinationPath !== indexed.project_relative_path;
          })) throw new IntakeError('Approved mappings do not match the current catalog inventory', 409);
        for (const directory of project.directories) portablePath(directory);
      }
      const active = await client.query(`SELECT project_id FROM library_migration_projects WHERE project_id=ANY($1::bigint[])
        AND status IN ('pending','copying','copied','activated') LIMIT 1`, [plan.projects.map((project) => project.id)]);
      if (active.rowCount) throw new IntakeError('A selected project already belongs to another active migration', 409);
      const id = randomUUID();
      await transaction(client, async () => {
        await client.query(`INSERT INTO library_migrations (id,plan_id,created_by,legacy_root,managed_root,root_identities,history)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, plan.id, actorId, resolve(options.root), resolve(options.managedRoot!),
          JSON.stringify(rootIdentities), JSON.stringify([{ actorId, action: 'approved', at: new Date().toISOString() }])]);
        for (const [index, row] of current.rows.entries()) {
          const project = plan.projects.find((entry) => entry.id === row.id)!;
          const snapshot: Snapshot = { project, files: current.files[index], fingerprint: digest([row, current.files[index]]) };
          await client.query(`INSERT INTO library_migration_projects (migration_id,project_id,legacy_root,legacy_path,managed_path,snapshot)
            VALUES ($1,$2,$3,$4,$5,$6)`, [id, row.id, resolve(options.root), project.relativePath, project.destinationPath, JSON.stringify(snapshot)]);
        }
      });
      return publicJob(client, await jobRow(client, id));
    }),
    action: (id: string, projectId: string, action: 'copy' | 'activate' | 'restore', expectedRevision: number, actorId: string) => operation(async (client) => {
      if (!isProjectId(projectId)) throw new IntakeError('Project not found', 404);
      const job = await jobRow(client, id);
      const item = (await items(client, job.id)).find((entry) => entry.project_id === projectId);
      if (!item) throw new IntakeError('Project is not part of this migration', 404);
      if ((action === 'copy' && ['copied', 'activated'].includes(item.status)) ||
        (action === 'activate' && item.status === 'activated') || (action === 'restore' && item.status === 'restored')) return publicJob(client, job);
      if (job.revision !== expectedRevision) throw new IntakeError('Migration changed; refresh before continuing', 409);
      if (job.status === 'canceled' && action !== 'restore') throw new IntakeError('This migration was canceled', 409);
      try {
        await checkedRoots(job, options);
        if (action === 'copy') {
          if (!['pending', 'copying'].includes(item.status)) throw new IntakeError('Project cannot be copied in its current state', 409);
          await originalCatalog(client, item);
          await sourceInventory(job, item);
          await sourceBytes(job, item);
          const parent = await safeDirectory(job.managed_root, 'projects');
          await destinationFree(job, item, client);
          if (await exists(job.managed_root, item.managed_path)) throw new IntakeError('Destination already exists; activate the recorded copy or cancel this migration', 409);
          const manifestBytes = Buffer.from(JSON.stringify(manifest(job, item), null, 2) + '\n');
          if (manifestBytes.length > libraryPreviewLimits.bytes) throw new IntakeError('Migration manifest exceeds 8 MiB', 413);
          const disk = await statfs(parent, { bigint: true });
          const required = item.snapshot.project.files.reduce((total, file) => total + BigInt(file.sizeBytes), 0n) +
            BigInt(manifestBytes.length) + BigInt(item.snapshot.project.files.length + item.snapshot.project.directories.length + 2) * disk.bsize;
          if (disk.bavail * disk.bsize <= required) throw new MigrationStorageError('Insufficient reported destination space for files, manifest, and staging overhead', 409);
          await transaction(client, async () => {
            await client.query("UPDATE library_migration_projects SET status='copying',last_error=NULL WHERE id=$1", [item.id]);
            await audit(client, job, actorId, 'copy_started', item.project_id);
          });
          const stage = stagePath(item);
          if (await exists(job.managed_root, stage)) {
            const absolute = join(job.managed_root, stage);
            if (!(await lstat(absolute)).isDirectory() || await realpath(absolute) !== absolute) throw new IntakeError('Private staging directory is unsafe', 409);
            await rm(absolute, { recursive: true });
          }
          const stageRoot = await safeDirectory(job.managed_root, stage);
          for (const directory of item.snapshot.project.directories) await safeDirectory(stageRoot, directory);
          for (const file of item.snapshot.project.files) {
            const size = Number(file.sizeBytes);
            if (!Number.isSafeInteger(size) || size < 0) throw new IntakeError('File size exceeds safe streaming limits', 409);
            const source = await openLibraryFile(job.legacy_root, file.sourcePath);
            try {
              const copied = await storeStream(source.handle.createReadStream({ autoClose: false }), stageRoot, file.destinationPath, size);
              if (String(copied.size) !== file.sizeBytes || copied.hash !== file.contentHash) throw new IntakeError('Source changed while copying; legacy location remains authoritative', 409);
            } finally { await source.handle.close(); }
          }
          await storeStream(Readable.from(manifestBytes), stageRoot, 'project.json', libraryPreviewLimits.bytes);
          await verifyCopy(job, item, stage);
          await sourceInventory(job, item);
          await sourceBytes(job, item);
          await originalCatalog(client, item);
          for (const directory of [...item.snapshot.project.directories].sort((a, b) => b.length - a.length)) await syncDirectory(join(stageRoot, directory));
          await syncDirectory(stageRoot);
          await syncDirectory(parent);
          await transaction(client, async () => {
            await client.query("UPDATE library_migration_projects SET status='copied',last_error=NULL WHERE id=$1", [item.id]);
            await audit(client, job, actorId, 'copy_verified', item.project_id);
          });
        } else if (action === 'activate') {
          if (item.status !== 'copied') throw new IntakeError('Copy and verify this project before activating it', 409);
          await originalCatalog(client, item);
          await sourceInventory(job, item);
          await sourceBytes(job, item);
          await safeDirectory(job.managed_root, 'projects');
          await destinationFree(job, item, client);
          if (!await exists(job.managed_root, item.managed_path)) {
            await verifyCopy(job, item, stagePath(item));
            await rename(join(job.managed_root, stagePath(item)), join(job.managed_root, item.managed_path));
          }
          const stats = await verifyCopy(job, item, item.managed_path);
          await syncDirectory(join(job.managed_root, 'projects'));
          await sourceInventory(job, item);
          await sourceBytes(job, item);
          await transaction(client, async () => {
            await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [item.project_id]);
            await client.query('SELECT id FROM assets WHERE project_id=$1 FOR UPDATE', [item.project_id]);
            await originalCatalog(client, item);
            await updateLocations(client, item, 'managed', stats);
            await client.query("UPDATE library_migration_projects SET status='activated',last_error=NULL WHERE id=$1", [item.id]);
            await audit(client, job, actorId, 'activated', item.project_id);
          });
        } else {
          if (item.status !== 'activated') throw new IntakeError('Only an activated project can be restored', 409);
          await sourceInventory(job, item);
          const stats = await sourceBytes(job, item);
          await verifyCopy(job, item, item.managed_path);
          await transaction(client, async () => {
            const project = (await client.query<{ storage_kind: string; relative_path: string; missing_at: Date | null }>('SELECT storage_kind,relative_path,missing_at FROM projects WHERE id=$1 FOR UPDATE', [item.project_id])).rows[0];
            const current = (await client.query<LibraryFileRow>(`${libraryFileSelect} FOR UPDATE OF a`, [item.project_id, libraryPreviewLimits.files + 1])).rows;
            if (project?.storage_kind !== 'managed' || project.relative_path !== item.managed_path || project.missing_at !== null || current.length !== item.snapshot.project.files.length ||
              current.some((file, index) => file.id !== item.snapshot.project.files[index].id || file.storage_kind !== 'managed' ||
                file.relative_path !== `${item.managed_path}/${item.snapshot.project.files[index].destinationPath}` ||
                file.project_relative_path !== item.snapshot.project.files[index].destinationPath ||
                file.current_version_id !== item.snapshot.project.files[index].versionId || file.content_hash !== item.snapshot.project.files[index].contentHash ||
                file.size_bytes !== item.snapshot.project.files[index].sizeBytes || file.missing_at !== null || file.version_missing_at !== null ||
                file.version_asset_id !== file.id || file.version_hash !== file.content_hash || file.version_size !== file.size_bytes)) {
              throw new IntakeError('Managed catalog inventory changed; restoration requires operator review', 409);
            }
            await updateLocations(client, item, 'legacy', stats);
            await client.query("UPDATE library_migration_projects SET status='restored',last_error=NULL WHERE id=$1", [item.id]);
            await audit(client, job, actorId, 'restored', item.project_id);
          });
        }
      } catch (error) {
        await transaction(client, async () => {
          await client.query('UPDATE library_migration_projects SET last_error=$2 WHERE id=$1', [item.id, errorMessage(error)]);
          await audit(client, job, actorId, `${action}_failed`, item.project_id);
        });
        throw error;
      }
      return publicJob(client, await jobRow(client, job.id));
    }),
    cancel: (id: string, expectedRevision: number, actorId: string) => operation(async (client) => {
    const job = await jobRow(client, id);
    if (job.status === 'canceled') return publicJob(client, job);
    if (job.revision !== expectedRevision) throw new IntakeError('Migration changed; refresh before canceling', 409);
    await checkedRoots(job, options);
    for (const item of await items(client, job.id)) if (['pending', 'copying', 'copied'].includes(item.status)) {
      const current = (await client.query<{ storage_kind: string; relative_path: string }>(
        'SELECT storage_kind,relative_path FROM projects WHERE id=$1', [item.project_id])).rows[0];
      if (current?.storage_kind !== 'legacy' || current.relative_path !== item.legacy_path) {
        throw new IntakeError('Unactivated project location changed; review the journal before canceling', 409);
      }
      if (await exists(job.managed_root, item.managed_path)) {
        await verifyCopy(job, item, item.managed_path);
        if (await exists(job.managed_root, retainedPath(item))) throw new IntakeError('Retained-copy destination is occupied; review storage before canceling', 409);
        await rename(join(job.managed_root, item.managed_path), join(job.managed_root, retainedPath(item)));
        await syncDirectory(join(job.managed_root, 'projects'));
      } else if (await exists(job.managed_root, retainedPath(item))) {
        await verifyCopy(job, item, retainedPath(item));
        await syncDirectory(join(job.managed_root, 'projects'));
      }
    }
    await transaction(client, async () => {
      await client.query("UPDATE library_migration_projects SET status='canceled',last_error=NULL WHERE migration_id=$1 AND status IN ('pending','copying','copied')", [job.id]);
      await client.query("UPDATE library_migrations SET status='canceled' WHERE id=$1", [job.id]);
      await audit(client, job, actorId, 'canceled');
    });
    return publicJob(client, await jobRow(client, job.id));
    }),
  };
}

export function registerLibraryMigrations(server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>, options: CatalogOptions) {
  const service = createLibraryMigrationService(pool, options);
  async function respond(reply: FastifyReply, work: () => Promise<LibraryMigrationJob>) {
    try { return await work(); }
    catch (error) {
      server.log.error({ err: error }, 'Library migration operation failed');
      return reply.code(error instanceof IntakeError ? error.status : 500).send({
        error: error instanceof IntakeError ? error.message : `Migration stopped: ${errorMessage(error)}. The journal is retained; refresh before retrying.`,
      });
    }
  }
  server.post<{ Params: { id: string }; Body: { expectedFingerprint: string } }>('/library/reorganization-plans/:id/migrate', {
    preHandler: auth.operatorOnly, schema: { params: jobParams, body: {
      type: 'object', additionalProperties: false, required: ['expectedFingerprint', 'confirmRetainedCopies', 'acknowledgeWarnings'],
      properties: { expectedFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, confirmRetainedCopies: { const: true }, acknowledgeWarnings: { const: true } },
    } },
  }, (request, reply) => respond(reply, () => service.approve(request.params.id, request.body.expectedFingerprint, auth.currentUser(request).id)));
  server.get<{ Params: { id: string } }>('/library/migrations/:id', { preHandler: auth.operatorOnly, schema: { params: jobParams } },
    (request, reply) => respond(reply, () => service.get(request.params.id)));
  server.post<{ Params: { id: string; projectId: string }; Body: { expectedRevision: number; action: 'copy' | 'activate' | 'restore' } }>(
    '/library/migrations/:id/projects/:projectId', {
      preHandler: auth.operatorOnly, schema: { params: {
        ...jobParams, required: ['id', 'projectId'], properties: { ...jobParams.properties, projectId: { type: 'string', pattern: projectIdPattern } },
      }, body: { ...revisionBody, required: ['expectedRevision', 'action'], properties: { ...revisionBody.properties, action: { enum: ['copy', 'activate', 'restore'] } } } },
    }, (request, reply) => respond(reply, () => service.action(request.params.id, request.params.projectId, request.body.action, request.body.expectedRevision, auth.currentUser(request).id)));
  server.post<{ Params: { id: string }; Body: { expectedRevision: number } }>('/library/migrations/:id/cancel', {
    preHandler: auth.operatorOnly, schema: { params: jobParams, body: revisionBody },
  }, (request, reply) => respond(reply, () => service.cancel(request.params.id, request.body.expectedRevision, auth.currentUser(request).id)));
}
