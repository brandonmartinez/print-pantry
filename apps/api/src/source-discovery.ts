import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import type { createPool } from '@print-pantry/db';
import { isProjectId, projectIdPattern, type SourceDiscoveryCandidate, type SourceDiscoveryPreview } from '@print-pantry/contracts';
import type { createAuth } from './auth.js';
import { openLibraryFile } from './files.js';
import { importSource, InvalidSourceUrlError } from './import-sources.js';
import { isSourceSidecar, sidecarUrls, sourceSidecarLimit, SourceSidecarError } from './source-sidecars.js';

type Pool = ReturnType<typeof createPool>;
type Inputs = {
  project: { id: string; name: string; relative_path: string; storage_kind: 'legacy' | 'managed'; source_url: string | null };
  files: Array<{ id: string; relative_path: string; project_relative_path: string; current_version_id: string | null }>;
};
type Snapshot = { fingerprint: string; preview: SourceDiscoveryPreview };
type PreviewRow = { snapshot: Snapshot; approved_candidate_ids: string[] | null; applied_at: Date | null };
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const params = {
  type: 'object', additionalProperties: false, required: ['projectId'],
  properties: { projectId: { type: 'string', pattern: projectIdPattern }, previewId: { type: 'string', pattern: uuid } },
} as const;

class DiscoveryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function inputs(client: PoolClient, id: string): Promise<Inputs> {
  if (!isProjectId(id)) throw new DiscoveryError('Project not found', 404);
  const projects = await client.query<Inputs['project']>(
    'SELECT id,name,relative_path,storage_kind,source_url FROM projects WHERE id=$1', [id],
  );
  if (!projects.rows[0]) throw new DiscoveryError('Project not found', 404);
  const files = await client.query<Inputs['files'][number]>(
    `SELECT id,relative_path,project_relative_path,current_version_id FROM assets
     WHERE project_id=$1 AND storage_kind=$2 AND missing_at IS NULL
       AND (lower(name) LIKE '%.webloc' OR lower(name) LIKE '%.url'
         OR lower(name) IN ('project.json','metadata.json','agentic-plan.json'))
     ORDER BY relative_path,id LIMIT 101`, [id, projects.rows[0].storage_kind],
  );
  return { project: projects.rows[0], files: files.rows };
}

const fingerprint = (value: Inputs) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readSidecar(root: string | undefined, file: Inputs['files'][number], project: Inputs['project']) {
  if (!root) throw new SourceSidecarError('Storage for this project is not configured');
  const expected = project.relative_path ? `${project.relative_path}/${file.project_relative_path}` : file.project_relative_path;
  if (file.relative_path !== expected) throw new SourceSidecarError('Sidecar location does not match its catalog project boundary');
  const { handle, stats } = await openLibraryFile(root, file.relative_path);
  try {
    if (stats.size > sourceSidecarLimit) throw new SourceSidecarError('Source sidecar exceeds 128 KiB');
    const buffer = Buffer.alloc(sourceSidecarLimit + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await handle.read(buffer, size, buffer.length - size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(join(root, file.relative_path));
    if (size > sourceSidecarLimit || size !== stats.size || after.mtimeMs !== stats.mtimeMs ||
        current.isSymbolicLink() || current.ino !== stats.ino || current.dev !== stats.dev || current.size !== stats.size) {
      throw new SourceSidecarError('Source sidecar changed while reading; rediscover before approving');
    }
    const bytes = buffer.subarray(0, size);
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

function publicPreview(row: PreviewRow): SourceDiscoveryPreview {
  return {
    ...row.snapshot.preview, appliedAt: row.applied_at?.toISOString() ?? null,
    approvedCandidateIds: row.approved_candidate_ids ?? [],
  };
}

export function registerSourceDiscovery(
  server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>,
  roots: { root?: string; managedRoot?: string },
) {
  const rootOf = (project: Inputs['project']) => project.storage_kind === 'managed' ? roots.managedRoot : roots.root;
  async function operation<T>(id: string, reply: FastifyReply, work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,98421)) AS locked', [id]);
      locked = result.rows[0].locked;
      if (!locked) throw new DiscoveryError('Source discovery is already running for this project; retry shortly', 409);
      return await work(client);
    } catch (error) {
      server.log.error({ err: error, projectId: id }, 'Source discovery operation failed');
      return reply.code(error instanceof DiscoveryError ? error.status : 500).send({
        error: error instanceof DiscoveryError ? error.message : 'Source discovery failed. No library files were changed; check the server log.',
      });
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,98421))', [id]); }
      finally { client.release(); }
    }
  }

  server.post<{ Params: { projectId: string } }>('/catalog/projects/:projectId/source-discovery', {
    preHandler: auth.operatorOnly, schema: { params },
  }, async (request, reply) => operation(request.params.projectId, reply, async (client) => {
    const state = await inputs(client, request.params.projectId);
    const existing = await client.query<{ source_key: string }>('SELECT source_key FROM project_sources WHERE project_id=$1', [state.project.id]);
    const known = new Set(existing.rows.map((row) => row.source_key));
    const candidates = new Map<string, SourceDiscoveryCandidate>();
    const issues: SourceDiscoveryPreview['issues'] = [];
    let fields = 0;
    function add(url: string, relativePath: string | null, hash: string | null) {
      if (++fields > 256) {
        if (fields === 257) issues.push({ relativePath: null, message: 'Only the first 256 URL fields were inspected. This preview is partial; review the recognized sidecars before approving.' });
        return;
      }
      try {
        const source = importSource(url);
        let candidate = candidates.get(source.key);
        if (!candidate) {
          if (candidates.size >= 128) throw new SourceSidecarError('Project exceeds its 128 source-candidate limit');
          candidate = { id: randomUUID(), source, alreadyAssociated: known.has(source.key), conflicting: false, evidence: [] };
          candidates.set(source.key, candidate);
        }
        if (!candidate.evidence.some((entry) => entry.relativePath === relativePath && entry.url === source.url)) {
          candidate.evidence.push({ relativePath, url: source.url, profileId: source.profileId, hash });
        }
      } catch (error) {
        if (!(error instanceof InvalidSourceUrlError || error instanceof SourceSidecarError)) throw error;
        issues.push({ relativePath, message: error.message });
      }
    }
    if (state.project.source_url) add(state.project.source_url, null, null);
    if (state.files.length > 100) issues.push({ relativePath: null, message: 'Only the first 100 indexed sidecars were inspected. This preview is partial; bulk discovery is not available yet.' });
    for (const file of state.files.slice(0, 100)) {
      if (!isSourceSidecar(file.relative_path)) continue;
      try {
        const read = await readSidecar(rootOf(state.project), file, state.project);
        for (const url of sidecarUrls(file.relative_path, read.bytes)) add(url, file.relative_path, read.hash);
      } catch (error) {
        server.log.warn({ err: error, projectId: state.project.id, assetId: file.id }, 'Source sidecar could not be inspected');
        issues.push({ relativePath: file.relative_path, message: error instanceof SourceSidecarError
          ? error.message : 'Sidecar could not be safely read; check storage, permissions, and symlinks, then rediscover.' });
      }
    }
    const keys = new Set([...known, ...candidates.keys()]);
    for (const candidate of candidates.values()) {
      candidate.conflicting = Boolean(candidate.source.modelId && [...keys].some((key) =>
        key !== candidate.source.key && key.startsWith(`${candidate.source.provider}:model:`)));
    }
    const preview: SourceDiscoveryPreview = {
      id: randomUUID(), projectId: state.project.id, projectName: state.project.name,
      candidates: [...candidates.values()], issues, createdAt: new Date().toISOString(), appliedAt: null, approvedCandidateIds: [],
    };
    await client.query('INSERT INTO source_discovery_previews (id,project_id,created_by,snapshot) VALUES ($1,$2,$3,$4)',
      [preview.id, state.project.id, auth.currentUser(request).id, JSON.stringify({ fingerprint: fingerprint(state), preview })]);
    return preview;
  }));

  async function previewRow(client: PoolClient, projectId: string, previewId: string) {
    if (!isProjectId(projectId)) throw new DiscoveryError('Project not found', 404);
    const rows = await client.query<PreviewRow>(
      'SELECT snapshot,approved_candidate_ids,applied_at FROM source_discovery_previews WHERE id=$1 AND project_id=$2',
      [previewId, projectId],
    );
    if (!rows.rows[0]) throw new DiscoveryError('Source discovery preview not found', 404);
    return rows.rows[0];
  }

  server.get<{ Params: { projectId: string; previewId: string } }>('/catalog/projects/:projectId/source-discovery/:previewId', {
    preHandler: auth.operatorOnly, schema: { params: { ...params, required: ['projectId', 'previewId'] } },
  }, async (request, reply) => operation(request.params.projectId, reply, async (client) =>
    publicPreview(await previewRow(client, request.params.projectId, request.params.previewId))));

  server.get<{ Params: { projectId: string } }>('/catalog/projects/:projectId/source-discovery', {
    preHandler: auth.operatorOnly, schema: { params },
  }, async (request, reply) => operation(request.params.projectId, reply, async (client) => {
    await inputs(client, request.params.projectId);
    const latest = await client.query<PreviewRow>(
      `SELECT snapshot,approved_candidate_ids,applied_at FROM source_discovery_previews
       WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [request.params.projectId],
    );
    return { preview: latest.rows[0] ? publicPreview(latest.rows[0]) : null };
  }));

  server.post<{ Params: { projectId: string; previewId: string }; Body: { candidateIds: string[] } }>(
    '/catalog/projects/:projectId/source-discovery/:previewId/apply', {
      preHandler: auth.operatorOnly, schema: {
        params: { ...params, required: ['projectId', 'previewId'] },
        body: { type: 'object', additionalProperties: false, required: ['candidateIds'], properties: {
          candidateIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', pattern: uuid } },
        } },
      },
    }, async (request, reply) => operation(request.params.projectId, reply, async (client) => {
      const row = await previewRow(client, request.params.projectId, request.params.previewId);
      const ids = [...request.body.candidateIds].sort();
      if (row.applied_at) {
        if (JSON.stringify([...(row.approved_candidate_ids ?? [])].sort()) !== JSON.stringify(ids)) {
          throw new DiscoveryError('This preview was already approved with a different selection; discover again', 409);
        }
        return publicPreview(row);
      }
      const selected = row.snapshot.preview.candidates.filter((candidate) => ids.includes(candidate.id));
      if (selected.length !== ids.length) throw new DiscoveryError('Selection contains a candidate outside this preview');
      const state = await inputs(client, request.params.projectId);
      if (fingerprint(state) !== row.snapshot.fingerprint) throw new DiscoveryError('Project or sidecar inventory changed after discovery; discover again before approving', 409);
      const witnesses = new Map(selected.flatMap((candidate) => candidate.evidence
        .filter((evidence) => evidence.relativePath !== null)
        .map((evidence) => [evidence.relativePath!, evidence.hash] as const)));
      for (const [path, hash] of witnesses) {
        const file = state.files.find((entry) => entry.relative_path === path);
        if (!file) throw new DiscoveryError('Source evidence is no longer associated with this project; discover again', 409);
        try {
          if ((await readSidecar(rootOf(state.project), file, state.project)).hash !== hash) {
            throw new DiscoveryError('Source evidence changed after discovery; discover again before approving', 409);
          }
        } catch (error) {
          if (error instanceof DiscoveryError) throw error;
          server.log.warn({ err: error, projectId: state.project.id }, 'Source evidence revalidation failed');
          throw new DiscoveryError('Source evidence is unavailable or changed; restore storage and discover again before approving', 409);
        }
      }
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [state.project.id]);
        if (fingerprint(await inputs(client, state.project.id)) !== row.snapshot.fingerprint) throw new DiscoveryError('Project changed during approval; discover again', 409);
        for (const candidate of selected) {
          const source = candidate.source;
          await client.query(
            `INSERT INTO project_sources (project_id,source_key,source_url,canonical_url,provider,external_model_id,external_profile_id,evidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (project_id,source_key) DO NOTHING`,
            [state.project.id, source.key, source.url, source.canonicalUrl, source.provider, source.modelId, source.profileId,
              JSON.stringify({ kind: 'operator-approved discovery', previewId: row.snapshot.preview.id, evidence: candidate.evidence })],
          );
        }
        const saved = await client.query<PreviewRow>(
          `UPDATE source_discovery_previews SET approved_candidate_ids=$2,applied_by=$3,applied_at=now()
           WHERE id=$1 RETURNING snapshot,approved_candidate_ids,applied_at`,
          [request.params.previewId, JSON.stringify(ids), auth.currentUser(request).id],
        );
        await client.query('COMMIT');
        return publicPreview(saved.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }),
  );
}
