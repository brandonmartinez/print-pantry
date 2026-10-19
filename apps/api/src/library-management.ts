import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { createPool } from '@print-pantry/db';
import {
  isProjectId, projectIdPattern, type LibraryManagementProject, type LibraryManagementResponse,
  type LibraryPlanIssue, type LibraryReorganizationPlan, type LibraryReorganizationProject, type LibraryMigrationJob,
} from '@print-pantry/contracts';
import type { createAuth } from './auth.js';
import type { CatalogOptions } from './catalog.js';
import { openLibraryFile, validateRelativePath } from './files.js';
import { IntakeError, pathKey, portablePath, projectSlug, validatePlanPaths } from './import-storage.js';
import { isOsMetadata } from './os-metadata.js';

type Pool = ReturnType<typeof createPool>;
export type LibraryProjectRow = {
  id: string; name: string; storage_kind: 'legacy' | 'managed'; relative_path: string;
  category: string | null; category_id: string | null; missing_at: Date | null;
  description: string | null; tags: string[]; designer: string | null; source_url: string | null;
  license: string | null; notes: string | null; file_count: number; size_bytes: string; source_count: number;
};
export type LibraryFileRow = {
  id: string; current_version_id: string | null; relative_path: string; project_relative_path: string;
  storage_kind: string; size_bytes: string; mtime_ms: string; inode: string | null; device: string | null;
  content_hash: string | null; version_hash: string | null; version_size: string | null;
  version_asset_id: string | null; missing_at: Date | null; version_missing_at: Date | null;
};
export const libraryPreviewLimits = { projects: 25, files: 1000, entries: 2000, depth: 12, bytes: 8 * 1024 * 1024 };
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const libraryProjectSelect = `SELECT p.*,c.relative_path AS category,
  (SELECT count(*)::int FROM assets a WHERE a.project_id=p.id) AS file_count,
  (SELECT coalesce(sum(a.size_bytes),0)::text FROM assets a WHERE a.project_id=p.id) AS size_bytes,
  (SELECT count(*)::int FROM project_sources s WHERE s.project_id=p.id) AS source_count
  FROM projects p LEFT JOIN categories c ON c.id=p.category_id`;
export const libraryFileSelect = `SELECT a.*,v.content_hash AS version_hash,v.size_bytes::text AS version_size,
  v.asset_id AS version_asset_id,v.missing_at AS version_missing_at FROM assets a
  LEFT JOIN asset_versions v ON v.id=a.current_version_id WHERE a.project_id=$1 ORDER BY a.project_relative_path,a.id
  LIMIT $2`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Unknown filesystem error';
function summary(row: LibraryProjectRow): LibraryManagementProject {
  return {
    id: row.id, name: row.name, storageKind: row.storage_kind, relativePath: row.relative_path,
    category: row.category, available: !row.missing_at, fileCount: row.file_count,
    sizeBytes: row.size_bytes, sourceCount: row.source_count,
  };
}
function issue(issues: LibraryPlanIssue[], code: string, text: string, relativePath: string | null = null, severity: LibraryPlanIssue['severity'] = 'blocker') {
  issues.push({ severity, code, relativePath, message: text });
}

export async function inspectLibraryProject(
  root: string, project: LibraryReorganizationProject, files: LibraryFileRow[], budget: { entries: number },
) {
  const known = new Map(files.map((file) => [file.project_relative_path, file]));
  const seen = new Set<string>();
  const entryNames = new Map<string, string>();
  let complete = true;
  let ignored = 0;
  async function walk(relative: string, depth: number) {
    if (depth > libraryPreviewLimits.depth) {
      issue(project.issues, 'depth_limit', 'Directory depth exceeds the 12-level inspection limit.', relative);
      complete = false;
      return;
    }
    const libraryPath = relative ? `${project.relativePath}/${relative}` : project.relativePath;
    const absolute = join(root, libraryPath);
    try {
      const before = await lstat(absolute);
      if (!before.isDirectory() || before.isSymbolicLink() || await realpath(absolute) !== absolute) {
        throw new Error('Directory is a symlink or is outside its expected storage location');
      }
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        if (++budget.entries > libraryPreviewLimits.entries) {
          issue(project.issues, 'entry_limit', 'The batch exceeds 2,000 filesystem entries. Select a smaller batch.');
          complete = false;
          break;
        }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (isOsMetadata(path) && !known.has(path) && !files.some((file) => file.project_relative_path.startsWith(`${path}/`))) { ignored++; continue; }
        try {
          portablePath(path);
          const key = pathKey(path);
          if (entryNames.has(key) && entryNames.get(key) !== path) throw new Error('Case or Unicode-normalized destination paths collide');
          entryNames.set(key, path);
          if (pathKey(path) === 'project.json') throw new Error('project.json is reserved for the managed manifest');
          const stats = await lstat(join(root, project.relativePath, path));
          if (stats.isSymbolicLink()) throw new Error('Symlinks cannot be migrated');
          if (stats.isDirectory()) {
            project.directories.push(path);
            await walk(path, depth + 1);
          } else if (stats.isFile()) {
            const file = known.get(path);
            if (!file) {
              issue(project.issues, 'unindexed_file', 'File is not owned by this catalog project. Rescan and review project boundaries.', path);
              continue;
            }
            seen.add(path);
            const opened = await openLibraryFile(root, file.relative_path);
            try {
              project.checkedFiles++;
              const stat = opened.stats;
              if (String(stat.size) !== file.size_bytes || String(Math.trunc(stat.mtimeMs)) !== file.mtime_ms ||
                (file.inode !== null && String(stat.ino) !== file.inode) ||
                (file.device !== null && String(stat.dev) !== file.device)) {
                issue(project.issues, 'changed_file', 'File differs from its last indexed size, timestamp, or identity. Rescan before planning.', path);
              }
            } finally { await opened.handle.close(); }
          } else throw new Error('Special filesystem entries cannot be migrated');
        } catch (error) {
          issue(project.issues, 'unsafe_entry', message(error), path);
          complete = false;
        }
        if (budget.entries > libraryPreviewLimits.entries) break;
      }
      const after = await lstat(absolute);
      if (after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) {
        throw new Error('Directory changed during inspection; generate a fresh dry run');
      }
    } catch (error) {
      issue(project.issues, 'unavailable_directory', message(error), relative || null);
      complete = false;
    }
  }
  await walk('', 0);
  if (complete) for (const file of files) {
    if (!seen.has(file.project_relative_path)) issue(project.issues, 'missing_file', 'Indexed file was not found in this project directory.', file.project_relative_path);
  }
  if (ignored) issue(project.issues, 'os_metadata', `${ignored} unindexed OS metadata entries were ignored; they remain in the retained legacy copy.`, null, 'warning');
  project.inspectionComplete = complete;
}

export function registerLibraryManagement(
  server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>, options: CatalogOptions,
  migrationForPlan: (id: string) => Promise<LibraryMigrationJob | undefined>,
) {
  server.get<{ Querystring: { q?: string; page?: number } }>('/library/management', {
    preHandler: auth.operatorOnly,
    schema: { querystring: {
      type: 'object', additionalProperties: false, properties: {
        q: { type: 'string', maxLength: 200 }, page: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
      },
    } },
  }, async (request): Promise<LibraryManagementResponse> => {
    const page = request.query.page ?? 1;
    const term = request.query.q ?? '';
    const filter = `WHERE position(lower($1) IN lower(p.name))>0 OR position(lower($1) IN lower(p.relative_path))>0`;
    const [items, count, totals, plans] = await Promise.all([
      pool.query<LibraryProjectRow>(`${libraryProjectSelect} ${filter} ORDER BY p.id LIMIT 50 OFFSET $2`, [term, (page - 1) * 50]),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM projects p ${filter}`, [term]),
      pool.query<LibraryManagementResponse['summary']>(`SELECT count(*) FILTER (WHERE storage_kind='legacy')::int AS legacy,
        count(*) FILTER (WHERE storage_kind='managed')::int AS managed,
        count(*) FILTER (WHERE missing_at IS NOT NULL)::int AS missing FROM projects`),
      pool.query<{ id: string; created_at: Date; project_count: number }>(`SELECT id,created_at,
        jsonb_array_length(snapshot->'projects') AS project_count FROM library_reorganization_plans ORDER BY created_at DESC,id LIMIT 10`),
    ]);
    return {
      items: items.rows.map(summary), total: count.rows[0].total, page, pageSize: 50, summary: totals.rows[0],
      plans: plans.rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString(), projectCount: row.project_count })),
    };
  });

  server.get<{ Params: { id: string } }>('/library/reorganization-plans/:id', {
    preHandler: auth.operatorOnly, schema: { params: {
      type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuid } },
    } },
  }, async (request, reply) => {
    const result = await pool.query<{ snapshot: LibraryReorganizationPlan }>('SELECT snapshot FROM library_reorganization_plans WHERE id=$1', [request.params.id]);
    const snapshot = result.rows[0]?.snapshot;
    if (!snapshot) return reply.code(404).send({ error: 'Reorganization preview not found' });
    const migration = await migrationForPlan(request.params.id);
    return migration ? { ...snapshot, migration } : snapshot;
  });

  server.post<{ Body: { projectIds: string[] } }>('/library/reorganization-plans', {
    preHandler: auth.operatorOnly, schema: { body: {
      type: 'object', additionalProperties: false, required: ['projectIds'], properties: {
        projectIds: { type: 'array', minItems: 1, maxItems: libraryPreviewLimits.projects, uniqueItems: true,
          items: { type: 'string', pattern: projectIdPattern } },
      },
    } },
  }, async (request, reply) => {
    if (request.body.projectIds.some((id) => !isProjectId(id))) return reply.code(400).send({ error: 'Invalid project ID' });
    if (options.indexer.getStatus().running) return reply.code(409).send({ error: 'Wait for the library scan to finish before generating a dry run' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const rows = (await client.query<LibraryProjectRow>(`${libraryProjectSelect} WHERE p.id=ANY($1::bigint[]) ORDER BY p.id`, [request.body.projectIds])).rows;
      if (rows.length !== request.body.projectIds.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'One or more selected projects no longer exist' });
      }
      const plan: LibraryReorganizationPlan = {
        id: randomUUID(), createdAt: new Date().toISOString(), kind: 'dry_run', fingerprint: '',
        projects: [], additionalBytes: '0', availableBytes: null, issues: [],
      };
      issue(plan.issues, 'verification_required', 'Preview hashes come from indexed versions. Migration requires separate approval, fresh byte verification, and explicit activation.', null, 'warning');
      issue(plan.issues, 'retained_originals', 'Legacy originals stay in place. Additional bytes are a lower-bound estimate excluding manifests and filesystem overhead; retained copies are not independent backups.', null, 'warning');
      let legacyRoot: string | undefined;
      let managedRoot: string | undefined;
      try {
        legacyRoot = await realpath(options.root);
        if (legacyRoot !== resolve(options.root) || !(await lstat(legacyRoot)).isDirectory()) throw new Error('Legacy root must be a real directory without symlink components');
      } catch (error) { issue(plan.issues, 'legacy_unavailable', `Legacy storage is unavailable: ${message(error)}`); legacyRoot = undefined; }
      try {
        if (!options.managedRoot) throw new Error('Managed storage is not configured');
        managedRoot = await realpath(options.managedRoot);
        if (managedRoot !== resolve(options.managedRoot) || !(await lstat(managedRoot)).isDirectory()) throw new Error('Managed root must be a real directory without symlink components');
        if (legacyRoot && (managedRoot === legacyRoot || managedRoot.startsWith(`${legacyRoot}/`) || legacyRoot.startsWith(`${managedRoot}/`))) {
          throw new Error('Managed and legacy storage must be separate, non-nested roots');
        }
        await access(managedRoot, constants.W_OK);
        const disk = await statfs(managedRoot, { bigint: true });
        plan.availableBytes = String(disk.bavail * disk.bsize);
      } catch (error) { issue(plan.issues, 'managed_unavailable', `Managed storage is unavailable: ${message(error)}`); managedRoot = undefined; }
      const budget = { entries: 0 };
      const occupied = new Set<string>();
      if (managedRoot) try {
        const parent = join(managedRoot, 'projects');
        try {
          const stat = await lstat(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed projects directory is not a real directory');
          await access(parent, constants.W_OK);
          const disk = await statfs(parent, { bigint: true });
          plan.availableBytes = String(disk.bavail * disk.bsize);
          const directory = await opendir(parent);
          for await (const entry of directory) {
            if (++budget.entries > libraryPreviewLimits.entries) {
              issue(plan.issues, 'entry_limit', 'Managed directory exceeds the 2,000-entry batch inspection limit. Destination checks are incomplete.');
              break;
            }
            occupied.add(pathKey(entry.name));
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      } catch (error) { issue(plan.issues, 'destination_unavailable', message(error)); managedRoot = undefined; }
      let remainingFiles = libraryPreviewLimits.files;
      const evidence: unknown[] = [rows];
      for (const row of rows) {
        const project: LibraryReorganizationProject = {
          ...summary(row), destinationPath: `projects/${row.id}-${projectSlug(row.name)}`,
          metadata: { categoryId: row.category_id, description: row.description, tags: row.tags,
            designer: row.designer, sourceUrl: row.source_url, license: row.license, notes: row.notes },
          files: [], directories: [], checkedFiles: 0, inspectionComplete: false, issues: [],
        };
        plan.projects.push(project);
        if (row.storage_kind !== 'legacy') { issue(project.issues, 'already_managed', 'Project already uses managed storage; no legacy reorganization is needed.'); continue; }
        plan.additionalBytes = String(BigInt(plan.additionalBytes) + BigInt(row.size_bytes));
        if (row.missing_at) issue(project.issues, 'missing_project', 'Project is marked missing in the catalog.');
        if (!row.source_count) issue(project.issues, 'source_recovery', 'No approved source associations. Review Manage sources before migration.', null, 'warning');
        if (!row.file_count) issue(project.issues, 'empty_project', 'Project has no indexed files.');
        if (row.file_count > remainingFiles) { issue(project.issues, 'file_limit', 'The batch exceeds 1,000 indexed files. Select a smaller batch.'); continue; }
        remainingFiles -= row.file_count;
        const overlaps = await client.query(`SELECT id FROM projects WHERE storage_kind='legacy' AND id<>$1
          AND (relative_path=$2 OR starts_with(relative_path,$2 || '/') OR starts_with($2,relative_path || '/')) LIMIT 1`, [row.id, row.relative_path]);
        if (overlaps.rowCount) issue(project.issues, 'overlapping_boundary', 'This project overlaps another catalog project. Review project boundaries before migration.');
        const files = (await client.query<LibraryFileRow>(libraryFileSelect, [row.id, libraryPreviewLimits.files + 1])).rows;
        evidence.push(files);
        for (const file of files) {
          project.files.push({ id: file.id, versionId: file.current_version_id, sourcePath: file.relative_path,
            destinationPath: file.project_relative_path, contentHash: file.content_hash, sizeBytes: file.size_bytes });
          if (file.storage_kind !== 'legacy' || file.relative_path !== `${row.relative_path}/${file.project_relative_path}`) {
            issue(project.issues, 'asset_boundary', 'Asset storage or path does not match its catalog project boundary.', file.project_relative_path);
          }
          if (file.missing_at || file.version_missing_at || !file.current_version_id || file.version_asset_id !== file.id ||
            !file.content_hash || !/^[a-f0-9]{64}$/.test(file.content_hash) ||
            file.version_hash !== file.content_hash || file.version_size !== file.size_bytes) {
            issue(project.issues, 'unverified_version', 'File has a missing or inconsistent indexed version/hash. Rescan before planning.', file.project_relative_path);
          }
        }
        try {
          validateRelativePath(row.relative_path);
          validatePlanPaths(project.files.map((file) => ({ path: file.destinationPath, include: true })));
        } catch (error) { issue(project.issues, 'destination_paths', message(error)); }
        if (managedRoot) try {
          const registered = await client.query(`SELECT id FROM projects WHERE storage_kind='managed' AND
            (lower(relative_path)=lower($1) OR starts_with(lower(relative_path),lower($1)||'/') OR starts_with(lower($1),lower(relative_path)||'/')) LIMIT 1`, [project.destinationPath]);
          if (registered.rowCount) issue(project.issues, 'destination_conflict', 'Destination overlaps a registered managed project.');
          if (occupied.has(pathKey(project.destinationPath.split('/')[1]))) {
            issue(project.issues, 'destination_conflict', 'Destination already exists on disk; nothing will be overwritten.');
          }
        } catch (error) { issue(project.issues, 'destination_unavailable', message(error)); }
        if (legacyRoot && !project.issues.some((entry) => entry.severity === 'blocker') && budget.entries <= libraryPreviewLimits.entries) {
          await inspectLibraryProject(legacyRoot, project, files, budget);
        }
      }
      if (budget.entries > libraryPreviewLimits.entries && !plan.issues.some((entry) => entry.code === 'entry_limit')) {
        issue(plan.issues, 'entry_limit', 'The batch exceeded 2,000 filesystem entries. Inspection is incomplete; select a smaller batch.');
      }
      if (plan.availableBytes !== null && BigInt(plan.additionalBytes) >= BigInt(plan.availableBytes)) {
        issue(plan.issues, 'insufficient_space', 'Catalog file bytes meet or exceed free managed storage. Staging and manifest overhead require additional space.');
      }
      if (options.indexer.getStatus().running) throw new IntakeError('A library scan started during inspection; wait for it to finish and generate a fresh dry run', 409);
      plan.fingerprint = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
      const snapshot = JSON.stringify(plan);
      if (Buffer.byteLength(snapshot) > libraryPreviewLimits.bytes) throw new IntakeError('Dry run exceeds 8 MiB; select a smaller batch', 413);
      await client.query('INSERT INTO library_reorganization_plans (id,created_by,snapshot,created_at) VALUES ($1,$2,$3,$4)',
        [plan.id, auth.currentUser(request).id, snapshot, plan.createdAt]);
      await client.query('COMMIT');
      return plan;
    } catch (error) {
      await client.query('ROLLBACK');
      server.log.error({ err: error }, 'Library reorganization preview failed');
      return reply.code(error instanceof IntakeError ? error.status : 500).send({
        error: error instanceof IntakeError ? error.message : 'Could not save the dry run. No files were changed; check the server log and retry.',
      });
    } finally { client.release(); }
  });
}
