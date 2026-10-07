import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { createPool } from '@print-pantry/db';
import type { PoolClient } from 'pg';
import type {
  PrintRequestAction, PrintRequestDetail, PrintRequestEvent, PrintRequestFile,
  PrintRequestQueue, PrintRequestStatus, PrintRequestSummary, SubmitPrintRequest,
} from '@print-pantry/contracts';
import type { createAuth, User } from './auth.js';

type Pool = ReturnType<typeof createPool>;
type Client = PoolClient;
type Connection = Pool | Client;
type Auth = ReturnType<typeof createAuth>;
type Indexer = { getStatus(): { lastScan: { status: string } | null } };
type RequestRow = {
  id: string; project_id: string; project_name: string; requester_id: string;
  username: string; role: User['role']; status: PrintRequestStatus; quantity: number;
  material: string | null; color: string | null; notes: string | null;
  queue_position: number | null; created_at: Date; updated_at: Date;
};
type FileRow = {
  request_id: string; asset_id: string; version_id: string; name: string;
  relative_path: string; file_type: PrintRequestFile['fileType']; extension: string;
  size_bytes: string; content_hash: string; project_missing: boolean;
  asset_missing: boolean; version_missing: boolean; current_version_id: string | null;
};
type HistoryRow = {
  id: string; actor_id: string; username: string; role: User['role'];
  action: PrintRequestEvent['action']; from_status: PrintRequestStatus | null;
  to_status: PrintRequestStatus | null; from_position: number | null;
  to_position: number | null; note: string | null; created_at: Date;
};
type QueueState = { revision: number; selected_next_id: string | null };
type AvailableFile = {
  id: string; name: string; project_relative_path: string;
  kind: PrintRequestFile['fileType']; extension: string; current_version_id: string | null;
  asset_missing: boolean; project_missing: boolean; version_id: string | null;
  version_missing: boolean; size_bytes: string; content_hash: string | null;
};

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const revisionSchema = { type: 'integer', minimum: 0 } as const;
const noteSchema = { type: ['string', 'null'], maxLength: 2000 } as const;

class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly currentRevision?: number) {
    super(message);
  }
}

function errorReply(reply: FastifyReply, error: unknown) {
  if (!(error instanceof RequestError)) throw error;
  return reply.code(error.status).send({
    error: error.message,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
  });
}

function text(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function variant(relativePath: string): string | null {
  const folders = relativePath.split('/').slice(0, -1);
  return folders.filter((folder) =>
    !['files', 'stl', '3mf', 'obj', 'images', 'source', 'sources'].includes(folder.toLowerCase()))
    .join('/') || null;
}

async function withQueueMutation<T>(
  pool: Pool, expectedRevision: number | undefined, work: (client: Client, state: QueueState) => Promise<T>,
): Promise<{ value: T; revision: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<QueueState>(
      'SELECT revision, selected_next_id FROM request_queue_state WHERE id = 1 FOR UPDATE',
    );
    const state = locked.rows[0];
    if (!state) throw new Error('Request queue state is missing; apply database migrations');
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new RequestError(409, 'Queue changed; refresh it and retry with the current revision', state.revision);
    }
    const value = await work(client, state);
    const updated = await client.query<QueueState>(
      'UPDATE request_queue_state SET revision = revision + 1 WHERE id = 1 RETURNING revision',
    );
    await client.query('COMMIT');
    return { value, revision: updated.rows[0].revision };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readQueue<T>(pool: Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function history(
  client: Connection, requestId: string, actorId: string, action: PrintRequestEvent['action'],
  fromStatus: PrintRequestStatus | null, toStatus: PrintRequestStatus | null,
  fromPosition: number | null, toPosition: number | null, note: string | null = null,
) {
  await client.query(
    `INSERT INTO print_request_history
      (id, request_id, actor_id, action, from_status, to_status, from_position, to_position, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
    [randomUUID(), requestId, actorId, action, fromStatus, toStatus, fromPosition, toPosition, note],
  );
}

async function requestRows(client: Connection, user: User, id?: string): Promise<RequestRow[]> {
  const result = await client.query<RequestRow>(
    `SELECT r.id, r.project_id, r.project_name, r.requester_id, u.username, u.role,
            r.status, r.quantity, r.material, r.color, r.notes, r.queue_position,
            r.created_at, r.updated_at
     FROM print_requests r JOIN users u ON u.id = r.requester_id
     WHERE ($1::uuid IS NULL OR r.id = $1)
       AND ($2::uuid IS NULL OR r.requester_id = $2)
     ORDER BY r.created_at DESC, r.id DESC`,
    [id ?? null, user.role === 'operator' ? null : user.id],
  );
  return result.rows;
}

async function latestScanStatus(client: Connection, indexer: Indexer): Promise<string | null> {
  const current = indexer.getStatus().lastScan;
  if (current) return current.status;
  const scan = await client.query<{ status: string }>(
    'SELECT status FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT 1',
  );
  return scan.rows[0]?.status ?? null;
}

async function fileRows(client: Connection, ids: string[], indexer: Indexer): Promise<Map<string, PrintRequestFile[]>> {
  if (!ids.length) return new Map();
  const offline = await latestScanStatus(client, indexer) === 'offline';
  const result = await client.query<FileRow>(
    `SELECT f.request_id, f.asset_id, f.version_id, f.name, f.relative_path,
            f.file_type, f.extension, f.size_bytes, f.content_hash,
            (p.missing_at IS NOT NULL) AS project_missing,
            (a.missing_at IS NOT NULL OR a.project_id <> r.project_id) AS asset_missing,
            (v.missing_at IS NOT NULL OR v.asset_id <> a.id) AS version_missing,
            a.current_version_id
     FROM print_request_files f
     JOIN print_requests r ON r.id = f.request_id
     JOIN projects p ON p.id = r.project_id
     JOIN assets a ON a.id = f.asset_id
     JOIN asset_versions v ON v.id = f.version_id
     WHERE f.request_id = ANY($1::uuid[])
     ORDER BY f.name, f.id`,
    [ids],
  );
  const files = new Map<string, PrintRequestFile[]>();
  for (const row of result.rows) {
    const unavailableReason = row.project_missing ? 'project_missing'
      : row.asset_missing ? 'asset_missing'
      : row.current_version_id && row.current_version_id !== row.version_id ? 'version_not_current'
      : row.version_missing ? 'version_missing'
      : row.current_version_id !== row.version_id ? 'version_not_current'
      : offline ? 'library_offline' : null;
    const item: PrintRequestFile = {
      assetId: row.asset_id, versionId: row.version_id, name: row.name,
      relativePath: row.relative_path, variant: variant(row.relative_path),
      fileType: row.file_type, extension: row.extension, size: Number(row.size_bytes),
      contentHash: row.content_hash, available: unavailableReason === null,
      unavailableReason,
      downloadUrl: unavailableReason ? null
        : `/api/catalog/assets/${row.asset_id}/download?versionId=${row.version_id}`,
    };
    const list = files.get(row.request_id) ?? [];
    list.push(item);
    files.set(row.request_id, list);
  }
  return files;
}

async function summaries(client: Connection, rows: RequestRow[], indexer: Indexer): Promise<PrintRequestSummary[]> {
  const files = await fileRows(client, rows.map((row) => row.id), indexer);
  return rows.map((row) => ({
    id: row.id, projectId: row.project_id, projectName: row.project_name,
    requester: { id: row.requester_id, username: row.username, role: row.role },
    status: row.status, quantity: row.quantity, material: row.material,
    color: row.color, notes: row.notes, selected: files.get(row.id) ?? [],
    queuePosition: row.queue_position, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

async function detail(client: Connection, user: User, id: string, indexer: Indexer): Promise<PrintRequestDetail> {
  const rows = await requestRows(client, user, id);
  if (!rows.length) throw new RequestError(404, 'Request not found');
  const [summary] = await summaries(client, rows, indexer);
  const result = await client.query<HistoryRow>(
    `SELECT h.id, h.actor_id, u.username, u.role, h.action, h.from_status, h.to_status,
            h.from_position, h.to_position, h.note, h.created_at
     FROM print_request_history h JOIN users u ON u.id = h.actor_id
     WHERE h.request_id = $1 ORDER BY h.created_at, h.id`,
    [id],
  );
  return {
    ...summary,
    history: result.rows.map((row) => ({
      id: row.id, actor: { id: row.actor_id, username: row.username, role: row.role },
      action: row.action, fromStatus: row.from_status, toStatus: row.to_status,
      fromPosition: row.from_position, toPosition: row.to_position,
      note: row.note, createdAt: row.created_at.toISOString(),
    })),
  };
}

async function queued(client: Connection): Promise<{ id: string; position: number }[]> {
  const result = await client.query<{ id: string; position: number }>(
    "SELECT id, queue_position AS position FROM print_requests WHERE status = 'queued' ORDER BY queue_position, id",
  );
  return result.rows;
}

async function reorder(client: Connection, orderedIds: string[], actorId: string) {
  const before = await queued(client);
  const old = new Map(before.map((row) => [row.id, row.position]));
  for (const [index, id] of orderedIds.entries()) {
    const position = index + 1;
    if (old.get(id) === position) continue;
    await client.query('UPDATE print_requests SET queue_position = $2, updated_at = now() WHERE id = $1', [id, position]);
    await history(client, id, actorId, 'reorder', 'queued', 'queued', old.get(id) ?? null, position);
  }
}

async function queueView(client: Connection, indexer: Indexer): Promise<PrintRequestQueue> {
  const state = await client.query<QueueState>('SELECT revision, selected_next_id FROM request_queue_state WHERE id = 1');
  if (!state.rows[0]) throw new Error('Request queue state is missing; apply database migrations');
  const rows = await client.query<RequestRow>(
    `SELECT r.id, r.project_id, r.project_name, r.requester_id, u.username, u.role,
            r.status, r.quantity, r.material, r.color, r.notes, r.queue_position,
            r.created_at, r.updated_at
     FROM print_requests r JOIN users u ON u.id = r.requester_id
     WHERE r.status = 'queued' ORDER BY r.queue_position, r.id`,
  );
  return { revision: state.rows[0].revision, selectedNextId: state.rows[0].selected_next_id,
    items: await summaries(client, rows.rows, indexer) };
}

// submit: (none)->requested; approve: requested->queued; decline: requested->declined;
// start: selected queued->printing; complete: printing->completed;
// cancel: own requested/queued->canceled. Terminal states never transition.
const transitions: Record<PrintRequestAction, { from: PrintRequestStatus[]; to: PrintRequestStatus }> = {
  approve: { from: ['requested'], to: 'queued' },
  decline: { from: ['requested'], to: 'declined' },
  start: { from: ['queued'], to: 'printing' },
  complete: { from: ['printing'], to: 'completed' },
  cancel: { from: ['requested', 'queued'], to: 'canceled' },
};

export function registerRequests(server: FastifyInstance, pool: Pool, auth: Auth, indexer: Indexer) {
  server.post<{ Body: SubmitPrintRequest }>('/requests', {
    preHandler: auth.authenticate,
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['projectId', 'selected', 'quantity'],
      properties: {
        projectId: { type: 'string', pattern: uuid },
        selected: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false, required: ['assetId', 'versionId'],
          properties: { assetId: { type: 'string', pattern: uuid }, versionId: { type: 'string', pattern: uuid } },
        } },
        quantity: { type: 'integer', minimum: 1, maximum: 100 },
        material: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
        color: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
        notes: noteSchema,
      },
    } },
  }, async (request, reply) => {
    const input = request.body;
    if (new Set(input.selected.map((item) => item.assetId)).size !== input.selected.length ||
      new Set(input.selected.map((item) => item.versionId)).size !== input.selected.length) {
      return reply.code(400).send({ error: 'Select each asset and version only once' });
    }
    if ([input.material, input.color].some((value) => value !== null && value !== undefined && !value.trim())) {
      return reply.code(400).send({ error: 'Material and color must not be blank' });
    }
    const user = auth.currentUser(request);
    try {
      const { value, revision } = await withQueueMutation(pool, undefined, async (client) => {
        if (await latestScanStatus(client, indexer) === 'offline') {
          throw new RequestError(503, 'Library is offline; retry after a successful scan');
        }
        const project = await client.query<{ name: string; missing_at: Date | null }>(
          'SELECT name, missing_at FROM projects WHERE id = $1', [input.projectId],
        );
        if (!project.rows[0]) throw new RequestError(404, 'Project not found');
        if (project.rows[0].missing_at) throw new RequestError(410, 'Project is unavailable; refresh the catalog');
        const files: AvailableFile[] = [];
        for (const item of input.selected) {
          const result = await client.query<AvailableFile>(
            `SELECT a.id, a.name, a.project_relative_path, a.kind, a.extension,
                    a.current_version_id, (a.missing_at IS NOT NULL) AS asset_missing,
                    (p.missing_at IS NOT NULL) AS project_missing, v.id AS version_id,
                    (v.missing_at IS NOT NULL) AS version_missing, v.size_bytes, v.content_hash
             FROM assets a JOIN projects p ON p.id = a.project_id
             LEFT JOIN asset_versions v ON v.id = $2 AND v.asset_id = a.id
             WHERE a.id = $1 AND a.project_id = $3 FOR SHARE OF a`,
            [item.assetId, item.versionId, input.projectId],
          );
          const file = result.rows[0];
          if (!file) throw new RequestError(400, 'Every selected file must belong to the chosen project');
          if (file.asset_missing || file.project_missing || !file.version_id ||
            file.version_missing || file.current_version_id !== item.versionId) {
            throw new RequestError(410, 'Selected version is unavailable; refresh the project and choose its current file');
          }
          const version = await client.query<{ id: string }>(
            'SELECT id FROM asset_versions WHERE id = $1 AND asset_id = $2 AND missing_at IS NULL FOR SHARE',
            [item.versionId, item.assetId],
          );
          if (!version.rows[0]) {
            throw new RequestError(410, 'Selected version is unavailable; refresh the project and choose its current file');
          }
          files.push(file);
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO print_requests
             (id, project_id, project_name, requester_id, status, quantity, material, color, notes)
           VALUES ($1,$2,$3,$4,'requested',$5,$6,$7,$8)`,
          [id, input.projectId, project.rows[0].name, user.id, input.quantity,
            text(input.material), text(input.color), text(input.notes)],
        );
        for (const [index, file] of files.entries()) {
          await client.query(
            `INSERT INTO print_request_files
              (id, request_id, asset_id, version_id, name, relative_path, file_type, extension, size_bytes, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [randomUUID(), id, file.id, input.selected[index].versionId, file.name,
              file.project_relative_path, file.kind, file.extension, file.size_bytes, file.content_hash],
          );
        }
        await history(client, id, user.id, 'submit', null, 'requested', null, null);
        return detail(client, user, id, indexer);
      });
      return reply.code(201).send({ request: value, revision });
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  server.get('/requests', { preHandler: auth.authenticate }, async (request) => {
    const user = auth.currentUser(request);
    return { items: await readQueue(pool, async (client) =>
      summaries(client, await requestRows(client, user), indexer)) };
  });

  server.get<{ Params: { id: string } }>('/requests/:id', {
    preHandler: auth.authenticate, schema: { params: idParams },
  }, async (request, reply) => {
    try {
      return { request: await readQueue(pool, (client) =>
        detail(client, auth.currentUser(request), request.params.id, indexer)) };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  server.get('/requests/queue', { preHandler: auth.operatorOnly }, async () =>
    readQueue(pool, (client) => queueView(client, indexer)));

  server.patch<{ Params: { id: string }; Body: {
    action: PrintRequestAction; note?: string | null; expectedRevision?: number;
  } }>('/requests/:id', {
    preHandler: auth.authenticate,
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['approve', 'decline', 'start', 'complete', 'cancel'] },
        note: noteSchema, expectedRevision: revisionSchema,
      } },
    },
  }, async (request, reply) => {
    const user = auth.currentUser(request);
    const { action, expectedRevision } = request.body;
    if ((action === 'cancel' && user.role !== 'requester') ||
      (action !== 'cancel' && user.role !== 'operator')) {
      return reply.code(403).send({ error: action === 'cancel'
        ? 'Only the requester can cancel their request' : 'Operator access required' });
    }
    try {
      const { value, revision } = await withQueueMutation(pool, expectedRevision, async (client, state) => {
        const result = await client.query<{ requester_id: string; status: PrintRequestStatus; queue_position: number | null }>(
          'SELECT requester_id, status, queue_position FROM print_requests WHERE id = $1',
          [request.params.id],
        );
        const row = result.rows[0];
        if (!row || (action === 'cancel' && row.requester_id !== user.id)) {
          throw new RequestError(404, 'Request not found');
        }
        const transition = transitions[action];
        if (!transition.from.includes(row.status)) {
          throw new RequestError(409, `Cannot ${action} a ${row.status} request; refresh its status`, state.revision);
        }
        if (action === 'start' && state.selected_next_id !== request.params.id) {
          throw new RequestError(409, 'Select this queued request as next before starting it', state.revision);
        }
        const before = row.status === 'queued' ? await queued(client) : [];
        const position = action === 'approve' ? (await queued(client)).length + 1 : null;
        await client.query(
          `UPDATE print_requests SET status = $2, queue_position = $3, updated_at = now() WHERE id = $1`,
          [request.params.id, transition.to, position],
        );
        if (row.status === 'queued') {
          if (state.selected_next_id === request.params.id) {
            await client.query('UPDATE request_queue_state SET selected_next_id = NULL WHERE id = 1');
            await history(client, request.params.id, user.id,
              'select_next', 'queued', 'queued', null, null, 'Selection cleared');
          }
          await reorder(client, before.filter((item) => item.id !== request.params.id).map((item) => item.id), user.id);
        }
        await history(client, request.params.id, user.id, action, row.status, transition.to,
          row.queue_position, position, text(request.body.note));
        return detail(client, user, request.params.id, indexer);
      });
      return { request: value, revision };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  server.put<{ Body: { orderedIds: string[]; expectedRevision: number } }>('/requests/queue', {
    preHandler: auth.operatorOnly,
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['orderedIds', 'expectedRevision'], properties: {
        orderedIds: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: uuid } },
        expectedRevision: revisionSchema,
      } } },
  }, async (request, reply) => {
    try {
      const { value, revision } = await withQueueMutation(pool, request.body.expectedRevision, async (client, state) => {
        const members = await queued(client);
        const memberIds = new Set(members.map((item) => item.id));
        if (members.length !== request.body.orderedIds.length ||
          request.body.orderedIds.some((id) => !memberIds.has(id))) {
          throw new RequestError(409, 'Queue membership changed; refresh and submit every queued ID exactly once', state.revision);
        }
        await reorder(client, request.body.orderedIds, auth.currentUser(request).id);
        return queueView(client, indexer);
      });
      return { ...value, revision };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  server.post<{ Body: { requestId: string; expectedRevision: number } }>('/requests/queue/next', {
    preHandler: auth.operatorOnly,
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['requestId', 'expectedRevision'], properties: {
        requestId: { type: 'string', pattern: uuid }, expectedRevision: revisionSchema,
      } } },
  }, async (request, reply) => {
    try {
      const { value, revision } = await withQueueMutation(pool, request.body.expectedRevision, async (client, state) => {
        const members = await queued(client);
        if (!members.some((item) => item.id === request.body.requestId)) {
          throw new RequestError(409, 'Selected request is no longer queued; refresh the queue', state.revision);
        }
        if (state.selected_next_id !== request.body.requestId) {
          if (state.selected_next_id) {
            await history(client, state.selected_next_id, auth.currentUser(request).id,
              'select_next', 'queued', 'queued', null, null, 'Selection cleared');
          }
          await client.query('UPDATE request_queue_state SET selected_next_id = $1 WHERE id = 1', [request.body.requestId]);
          await history(client, request.body.requestId, auth.currentUser(request).id,
            'select_next', 'queued', 'queued', null, null, 'Selected as next');
        }
        return queueView(client, indexer);
      });
      return { ...value, revision };
    } catch (error) {
      return errorReply(reply, error);
    }
  });
}
