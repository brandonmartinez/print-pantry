import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { createPool } from '@print-pantry/db';
import type {
  ImportMatch, ImportPage, ImportRequest, ImportSource, ImportStatus, SubmitImport,
} from '@print-pantry/contracts';
import type { createAuth, User } from './auth.js';
import { importSource, InvalidSourceUrlError } from './import-sources.js';

type Pool = ReturnType<typeof createPool>;
type Connection = Pool | PoolClient;
type ImportRow = {
  id: string; source_key: string; source_url: string; canonical_url: string;
  provider: ImportSource['provider']; external_model_id: string | null;
  external_profile_id: string | null; title: string | null; status: ImportStatus;
  revision: number; project_id: string | null; created_at: Date; updated_at: Date;
};
type SubmissionRow = {
  id: string; request_id: string; requester_id: string; username: string; role: User['role'];
  source_url: string; title: string | null; notes: string | null; created_at: Date;
};
type EventRow = {
  id: string; actor_id: string; username: string; role: User['role'];
  status: ImportStatus; note: string | null; created_at: Date;
};

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const urlBody = {
  type: 'object', additionalProperties: false, required: ['url'],
  properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
} as const;
const visible = `($2::uuid IS NULL OR EXISTS
  (SELECT 1 FROM import_submissions s WHERE s.request_id = r.id AND s.requester_id = $2))`;
const text = (value?: string) => value?.trim() || null;
const activeStatuses = ['submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending'];

function sourceOf(row: ImportRow): ImportSource {
  return {
    url: row.source_url, canonicalUrl: row.canonical_url, key: row.source_key,
    provider: row.provider, modelId: row.external_model_id, profileId: row.external_profile_id,
  };
}

async function detail(client: Connection, user: User, id: string): Promise<ImportRequest | null> {
  const rows = await client.query<ImportRow>(
    `SELECT r.* FROM import_requests r WHERE r.id = $1 AND ${visible}`,
    [id, user.role === 'operator' ? null : user.id],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const submissions = await client.query<SubmissionRow>(
    `SELECT s.*, u.username, u.role FROM import_submissions s JOIN users u ON u.id = s.requester_id
     WHERE s.request_id = $1 AND ($2::uuid IS NULL OR s.requester_id = $2)
     ORDER BY s.created_at DESC, s.id DESC LIMIT 100`,
    [id, user.role === 'operator' ? null : user.id],
  );
  const events = await client.query<EventRow>(
    `SELECT e.*, u.username, u.role FROM import_events e JOIN users u ON u.id = e.actor_id
     WHERE e.request_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`, [id],
  );
  return {
    id: row.id, source: sourceOf(row), title: row.title, status: row.status,
    revision: row.revision, projectId: row.project_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    submissions: submissions.rows.map((s) => ({
      id: s.id, requester: { id: s.requester_id, username: s.username, role: s.role },
      sourceUrl: s.source_url, title: s.title, notes: s.notes, createdAt: s.created_at.toISOString(),
    })),
    history: events.rows.map((e) => ({
      id: e.id, actor: { id: e.actor_id, username: e.username, role: e.role },
      status: e.status, note: e.note, createdAt: e.created_at.toISOString(),
    })),
  };
}

function legacySourcePattern(source: ImportSource): string | null {
  if (!source.modelId) return null;
  const model = source.modelId;
  const end = '(-|/|[?#]|$)';
  if (source.provider === 'makerworld') return `^https?://(www\\.)?makerworld\\.com/([a-z]{2}(-[a-z]{2})?/)?models/${model}${end}`;
  if (source.provider === 'printables') return `^https?://(www\\.)?printables\\.com/([a-z]{2}/)?model/${model}${end}`;
  if (source.provider === 'thingiverse') return `^https?://(www\\.)?thingiverse\\.com/thing:${model}(/|[?#]|$)`;
  return null;
}

export async function findImportMatches(client: Connection, source: ImportSource): Promise<ImportMatch> {
  const projects = await client.query<ImportMatch['projects'][number]>(
    `SELECT p.id, p.name, p.storage_kind AS "storageKind", (p.storage_kind='managed' AND p.missing_at IS NULL) AS available FROM projects p
     WHERE EXISTS (SELECT 1 FROM project_sources s WHERE s.project_id = p.id AND s.source_key = $1)
        OR p.source_url = ANY($2::text[])
        OR ($3::text IS NOT NULL AND p.source_url ~* $3)
     ORDER BY p.id LIMIT 50`,
    [source.key, [source.url, source.canonicalUrl], legacySourcePattern(source)],
  );
  const pending = await client.query<{ id: string; status: ImportStatus }>(
    `SELECT id, status FROM import_requests WHERE source_key = $1
     AND status = ANY($2::text[])`, [source.key, activeStatuses],
  );
  return { source, projects: projects.rows, pending: pending.rows[0] ?? null };
}

export function registerImports(
  server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>,
) {
  server.post<{ Body: { url: string } }>('/imports/check', {
    preHandler: auth.authenticate, schema: { body: urlBody },
  }, async (request, reply) => {
    try {
      return await findImportMatches(pool, importSource(request.body.url));
    } catch (error) {
      if (!(error instanceof InvalidSourceUrlError)) throw error;
      return reply.code(400).send({ error: error.message });
    }
  });

  server.get<{ Querystring: { page?: number; pageSize?: number } }>('/imports', {
    preHandler: auth.authenticate,
    schema: { querystring: {
      type: 'object', additionalProperties: false, properties: {
        page: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    } },
  }, async (request): Promise<ImportPage> => {
    const user = auth.currentUser(request);
    const { page = 1, pageSize = 20 } = request.query;
    const ids = await pool.query<{ id: string }>(
      `SELECT r.id FROM import_requests r WHERE ($1::uuid IS NULL OR EXISTS
       (SELECT 1 FROM import_submissions s WHERE s.request_id = r.id AND s.requester_id = $1))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
      [user.role === 'operator' ? null : user.id, pageSize, (page - 1) * pageSize],
    );
    const count = await pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM import_requests r WHERE ($1::uuid IS NULL OR EXISTS
       (SELECT 1 FROM import_submissions s WHERE s.request_id = r.id AND s.requester_id = $1))`,
      [user.role === 'operator' ? null : user.id],
    );
    const items: ImportRequest[] = [];
    for (const row of ids.rows) {
      const item = await detail(pool, user, row.id);
      if (item) items.push(item);
    }
    return { items, page, pageSize, total: count.rows[0].total };
  });

  server.get<{ Params: { id: string } }>('/imports/:id', {
    preHandler: auth.authenticate, schema: { params },
  }, async (request, reply) => {
    const item = await detail(pool, auth.currentUser(request), request.params.id);
    if (!item) return reply.code(404).send({ error: 'Import request not found' });
    return { request: item };
  });

  server.post<{ Body: SubmitImport }>('/imports', {
    preHandler: auth.authenticate,
    schema: { body: {
      ...urlBody, required: ['url', 'submissionKey'],
      properties: {
        ...urlBody.properties, title: { type: 'string', maxLength: 256 },
        notes: { type: 'string', maxLength: 2000 },
        submissionKey: { type: 'string', pattern: uuid },
      },
    } },
  }, async (request, reply) => {
    let source: ImportSource;
    try {
      source = importSource(request.body.url);
    } catch (error) {
      if (!(error instanceof InvalidSourceUrlError)) throw error;
      return reply.code(400).send({ error: error.message });
    }
    const user = auth.currentUser(request);
    const input = request.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 98417))', [`${user.id}:${input.submissionKey}`]);
      const previous = await client.query<{ request_id: string; source_url: string; title: string | null; notes: string | null }>(
        `SELECT request_id, source_url, title, notes FROM import_submissions
         WHERE requester_id = $1 AND submission_key = $2`, [user.id, input.submissionKey],
      );
      if (previous.rows[0]) {
        const entry = previous.rows[0];
        if (entry.source_url !== source.url || entry.title !== text(input.title) || entry.notes !== text(input.notes)) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Submission key was already used for different content; submit again with a new key' });
        }
        const item = await detail(client, user, entry.request_id);
        await client.query('COMMIT');
        return { request: item, joined: true };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 98418))', [source.key]);
      const pending = await client.query<{ id: string }>(
        `SELECT id FROM import_requests WHERE source_key = $1
         AND status = ANY($2::text[]) FOR UPDATE`, [source.key, activeStatuses],
      );
      let id = pending.rows[0]?.id;
      const joined = !!id;
      if (!id) {
        const added = await client.query<{ id: string }>(
          `INSERT INTO import_requests
           (source_key, source_url, canonical_url, provider, external_model_id, external_profile_id, title)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [source.key, source.url, source.canonicalUrl, source.provider, source.modelId, source.profileId, text(input.title)],
        );
        id = added.rows[0].id;
        await client.query(
          `INSERT INTO import_events (request_id, actor_id, status) VALUES ($1,$2,'submitted')`, [id, user.id],
        );
      }
      await client.query(
        `INSERT INTO import_submissions (request_id, requester_id, submission_key, source_url, title, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, user.id, input.submissionKey, source.url, text(input.title), text(input.notes)],
      );
      const item = await detail(client, user, id);
      await client.query('COMMIT');
      return reply.code(201).send({ request: item, joined });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  server.patch<{ Params: { id: string }; Body: {
    action: 'accept' | 'decline' | 'cancel'; expectedRevision: number; note?: string;
  } }>('/imports/:id', {
    preHandler: auth.operatorOnly,
    schema: { params, body: {
      type: 'object', additionalProperties: false, required: ['action', 'expectedRevision'],
      properties: {
        action: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
        expectedRevision: { type: 'integer', minimum: 0 },
        note: { type: 'string', maxLength: 2000 },
      },
    } },
  }, async (request, reply) => {
    const input = request.body;
    const note = text(input.note);
    if (input.action !== 'accept' && !note) {
      return reply.code(400).send({ error: 'A reason is required when declining or canceling an import' });
    }
    const user = auth.currentUser(request);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 98419)) AS locked', [request.params.id],
      );
      if (!claim.rows[0].locked) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Files are being processed; retry after the current operation finishes' });
      }
      const locked = await client.query<ImportRow>('SELECT * FROM import_requests WHERE id = $1 FOR UPDATE', [request.params.id]);
      const row = locked.rows[0];
      if (!row || row.revision !== input.expectedRevision ||
          !['submitted', 'awaiting_files', 'ready_for_review'].includes(row.status) ||
          (input.action === 'accept' && row.status !== 'submitted')) {
        await client.query('ROLLBACK');
        return reply.code(row ? 409 : 404).send({
          error: row ? 'Import changed or action is unavailable; refresh and retry' : 'Import request not found',
        });
      }
      const status: ImportStatus = input.action === 'accept' ? 'awaiting_files' : input.action === 'decline' ? 'declined' : 'canceled';
      await client.query(
        'UPDATE import_requests SET status = $2, revision = revision + 1, updated_at = now() WHERE id = $1',
        [row.id, status],
      );
      await client.query(
        'INSERT INTO import_events (request_id, actor_id, status, note) VALUES ($1,$2,$3,$4)',
        [row.id, user.id, status, note],
      );
      const item = await detail(client, user, row.id);
      await client.query('COMMIT');
      return { request: item };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
