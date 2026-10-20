import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { libraryMutationLock, type createPool } from '@print-pantry/db';
import {
  isProjectId, projectIdPattern, type LibraryAdoptionCommand, type LibraryAdoptionItem,
  type LibraryAdoptionItems, type LibraryAdoptionItemStatus, type LibraryAdoptionRun,
  type LibraryAdoptionState, type LibraryPlanIssue,
} from '@print-pantry/contracts';
import type { createAuth } from './auth.js';
import type { CatalogOptions } from './catalog.js';
import { IntakeError } from './import-storage.js';
import { createLibraryPreview } from './library-management.js';
import {
  createLibraryMigrationService, migrationStorageIdentity, MigrationBusyError, MigrationStorageError,
  libraryMigrationForPlan, validateMigrationStorage, type RootIdentities,
} from './library-migrations.js';

type Pool = ReturnType<typeof createPool>;
type Run = {
  id: string; created_by: string; actor_id: string; state: LibraryAdoptionState; resume_state: LibraryAdoptionState | null;
  revision: number; legacy_root: string; managed_root: string; root_identities: RootIdentities; fingerprint: string;
  available_bytes: string | null; last_error: string | null; created_at: Date; updated_at: Date;
  copy_approved_at: Date | null; activation_approved_at: Date | null;
};
type Item = {
  project_id: string; name: string; status: LibraryAdoptionItemStatus; plan_id: string | null; migration_id: string | null;
  fingerprint: string | null; size_bytes: string; file_count: number; issues: LibraryPlanIssue[];
  last_error: string | null; failed_action: string | null;
};
type Connection = Pick<PoolClient, 'query'>;
type CommandBody = {
  action: LibraryAdoptionCommand; expectedRevision: number; expectedFingerprint?: string;
  confirmRetainedCopies?: boolean; acknowledgeWarnings?: boolean; confirmActivation?: boolean;
  confirmRestoration?: boolean; confirmCancellation?: boolean; stage?: 'copy' | 'activate' | 'restore' | 'cancel';
};
const workingStates = ['planning', 'copying', 'activating', 'restoring', 'canceling'];
const terminalStates = ['completed', 'partial', 'canceled', 'restored'];
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } as const;
const message = (error: unknown) => error instanceof Error ? error.message : 'Unknown library adoption failure';

async function getRun(client: Connection, id: string, lock = false) {
  const run = (await client.query<Run>(`SELECT * FROM library_adoption_runs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!run) throw new IntakeError('Library adoption run not found', 404);
  return run;
}
async function publicRun(client: Connection, run: Run): Promise<LibraryAdoptionRun> {
  const rows = (await client.query<{ status: LibraryAdoptionItemStatus; count: number; bytes: string }>(
    `SELECT status,count(*)::int AS count,coalesce(sum(size_bytes::numeric),0)::text AS bytes
      FROM library_adoption_items WHERE run_id=$1 GROUP BY status`, [run.id])).rows;
  const counts: LibraryAdoptionRun['counts'] = { pending: 0, ready: 0, blocked: 0, copying: 0, copied: 0, activated: 0, failed: 0, restored: 0, canceled: 0 };
  let total = 0;
  let bytes = 0n;
  for (const row of rows) {
    counts[row.status] = row.count; total += row.count;
    if (!['blocked', 'canceled'].includes(row.status)) bytes += BigInt(row.bytes);
  }
  return {
    id: run.id, state: run.state, resumeState: run.resume_state, revision: run.revision, fingerprint: run.fingerprint,
    legacyRoot: run.legacy_root, managedRoot: run.managed_root, additionalBytes: String(bytes), availableBytes: run.available_bytes,
    counts, total, lastError: run.last_error, createdAt: run.created_at.toISOString(), updatedAt: run.updated_at.toISOString(),
  };
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { client.release(); }
}
async function setItem(client: Connection, run: Run, item: Item, status: LibraryAdoptionItemStatus, error: string | null = null, failedAction: string | null = null) {
  await transactionUpdate(client, run.id, `UPDATE library_adoption_items SET status=$3,last_error=$4,failed_action=$5
    WHERE run_id=$1 AND project_id=$2`, [run.id, item.project_id, status, error, failedAction]);
}
async function transactionUpdate(client: Connection, id: string, sql: string, values: unknown[]) {
  await client.query(sql, values);
  await client.query('UPDATE library_adoption_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1', [id]);
}
async function fingerprint(client: Connection, id: string) {
  const hash = createHash('sha256');
  let cursor = '0';
  for (;;) {
    const rows = (await client.query<Item>(`SELECT project_id,plan_id,fingerprint,status FROM library_adoption_items
      WHERE run_id=$1 AND project_id>$2::bigint ORDER BY project_id LIMIT 100`, [id, cursor])).rows;
    for (const row of rows) hash.update(JSON.stringify([row.project_id, row.plan_id, row.fingerprint, row.status]) + '\n');
    if (rows.length < 100) break;
    cursor = rows.at(-1)!.project_id;
  }
  return hash.digest('hex');
}

export function createLibraryAdoptionService(pool: Pool, options: CatalogOptions) {
  return {
    get: async (id: string) => publicRun(pool, await getRun(pool, id)),
    list: async () => {
      const rows = (await pool.query<Run>('SELECT * FROM library_adoption_runs ORDER BY created_at DESC,id LIMIT 20')).rows;
      return Promise.all(rows.map((run) => publicRun(pool, run)));
    },
    items: async (id: string, cursor = '0', status?: LibraryAdoptionItemStatus): Promise<LibraryAdoptionItems> => {
      await getRun(pool, id);
      if (cursor !== '0' && !isProjectId(cursor)) throw new IntakeError('Invalid project cursor', 400);
      const rows = (await pool.query<Item>(`SELECT * FROM library_adoption_items WHERE run_id=$1 AND project_id>$2::bigint
        AND ($3::text IS NULL OR status=$3) ORDER BY project_id LIMIT 51`, [id, cursor, status ?? null])).rows;
      const items: LibraryAdoptionItem[] = rows.slice(0, 50).map((row) => ({
        projectId: row.project_id, name: row.name, status: row.status, planId: row.plan_id, migrationId: row.migration_id,
        sizeBytes: row.size_bytes, fileCount: row.file_count, issues: row.issues, lastError: row.last_error,
      }));
      return { items, nextCursor: rows.length > 50 ? items.at(-1)!.projectId : null };
    },
    create: async (id: string, actorId: string) => {
      const previous = (await pool.query<Run>('SELECT * FROM library_adoption_runs WHERE id=$1', [id])).rows[0];
      if (previous) return publicRun(pool, previous);
      const identities = await migrationStorageIdentity(options);
      const managedRoot = options.managedRoot;
      if (!managedRoot) throw new MigrationStorageError('Managed storage is not configured', 503);
      if (options.indexer.getStatus().running) throw new MigrationBusyError('Wait for the scan to finish before planning adoption', 409);
      const disk = await statfs(managedRoot, { bigint: true });
      return transaction(pool, async (client) => {
        const claim = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [libraryMutationLock])).rows[0].locked;
        if (!claim) throw new MigrationBusyError('A scan or storage operation is running; retry planning later', 409);
        const active = await client.query(`SELECT id FROM library_adoption_runs WHERE legacy_root=$1 AND managed_root=$2
          AND state NOT IN ('completed','partial','canceled','restored') LIMIT 1`, [resolve(options.root), resolve(managedRoot)]);
        if (active.rowCount) throw new IntakeError('An adoption run already exists for these roots; reopen or cancel it first', 409);
        await client.query(`INSERT INTO library_adoption_runs(id,created_by,actor_id,legacy_root,managed_root,root_identities,available_bytes,history)
          VALUES($1,$2,$2,$3,$4,$5,$6,$7)`, [id, actorId, resolve(options.root), resolve(managedRoot),
          JSON.stringify(identities), String(disk.bavail * disk.bsize), JSON.stringify([{ action: 'plan', actorId, at: new Date().toISOString() }])]);
        const inventory = await client.query(`INSERT INTO library_adoption_items(run_id,project_id,name,size_bytes,file_count)
          SELECT $1,p.id,p.name,(SELECT coalesce(sum(a.size_bytes),0)::text FROM assets a WHERE a.project_id=p.id),
            (SELECT count(*)::int FROM assets a WHERE a.project_id=p.id) FROM projects p WHERE p.storage_kind='legacy'`, [id]);
        if (!inventory.rowCount) throw new IntakeError('No legacy projects found. Index the existing library before planning adoption.', 409);
        return publicRun(client, await getRun(client, id));
      });
    },
    command: (id: string, body: CommandBody, actorId: string) => transaction(pool, async (client) => {
      const run = await getRun(client, id, true);
      if (run.revision !== body.expectedRevision) throw new IntakeError('Adoption progress changed; refresh before continuing', 409);
      const current = await publicRun(client, run);
      let next: LibraryAdoptionState;
      let resumeState = run.resume_state;
      if (body.action === 'approve_copy') {
        if (run.state !== 'review' || !current.counts.ready || body.expectedFingerprint !== run.fingerprint ||
          body.confirmRetainedCopies !== true || body.acknowledgeWarnings !== true) throw new IntakeError('Review the saved plan and acknowledge backup, retention, notes, and partial results before copying', 409);
        await validateMigrationStorage(run, options);
        const disk = await statfs(run.managed_root, { bigint: true });
        if (BigInt(current.additionalBytes) >= disk.bavail * disk.bsize) throw new MigrationStorageError('The approved batch file bytes meet or exceed reported free storage. Free space or choose a different managed location before copying; manifests and filesystem overhead need extra space.', 409);
        next = 'copying';
        await client.query('UPDATE library_adoption_runs SET copy_approved_at=clock_timestamp(),available_bytes=$2 WHERE id=$1', [id, String(disk.bavail * disk.bsize)]);
      } else if (body.action === 'activate') {
        if (run.state !== 'awaiting_activation' || !current.counts.copied || body.expectedFingerprint !== run.fingerprint ||
          body.confirmActivation !== true || !run.copy_approved_at) throw new IntakeError('Review verified copies and explicitly approve batch activation', 409);
        next = 'activating';
        await client.query('UPDATE library_adoption_runs SET activation_approved_at=clock_timestamp() WHERE id=$1', [id]);
      } else if (body.action === 'pause') {
        if (!workingStates.includes(run.state)) throw new IntakeError('Only running adoption work can be paused', 409);
        next = 'paused'; resumeState = run.state;
      } else if (body.action === 'resume') {
        if (run.state !== 'paused' || !run.resume_state) throw new IntakeError('There is no paused operation to resume', 409);
        next = run.resume_state; resumeState = null;
      } else if (body.action === 'cancel') {
        if (body.confirmCancellation !== true || run.state === 'canceled') throw new IntakeError('Confirm cancellation of remaining work', 409);
        next = 'canceling';
      } else if (body.action === 'restore') {
        if (!terminalStates.includes(run.state) || !current.counts.activated || body.confirmRestoration !== true) {
          throw new IntakeError('Confirm restoration of activated projects in a stopped run', 409);
        }
        next = 'restoring';
      } else {
        const stage = body.stage;
        if (!stage || !['partial', 'awaiting_activation', 'paused'].includes(run.state)) throw new IntakeError('Choose a failed stage in a stopped run to retry', 409);
        if ((stage === 'copy' && !run.copy_approved_at) || (stage === 'activate' && !run.activation_approved_at)) throw new IntakeError('This stage has not been approved', 409);
        const status = stage === 'copy' ? 'ready' : stage === 'activate' ? 'copied' : stage === 'restore' ? 'activated' : 'ready';
        const changed = await client.query(`UPDATE library_adoption_items SET status=$3,last_error=NULL,failed_action=NULL
          WHERE run_id=$1 AND status='failed' AND failed_action=$2`, [id, stage, status]);
        if (!changed.rowCount) throw new IntakeError('No failures for the selected stage; resume paused work or create a fresh plan for blockers', 409);
        next = stage === 'copy' ? 'copying' : stage === 'activate' ? 'activating' : stage === 'restore' ? 'restoring' : 'canceling';
      }
      await client.query(`UPDATE library_adoption_runs SET state=$2,resume_state=$3,actor_id=$4,revision=revision+1,last_error=NULL,
        updated_at=clock_timestamp(),history=history||$5::jsonb WHERE id=$1`, [id, next, resumeState, actorId,
        JSON.stringify([{ action: body.action, stage: body.stage, actorId, at: new Date().toISOString() }])]);
      return publicRun(client, await getRun(client, id));
    }),
  };
}

export function createLibraryAdoptionRunner(pool: Pool, options: CatalogOptions, log: Pick<FastifyInstance['log'], 'error'>) {
  const migration = createLibraryMigrationService(pool, options);
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  async function step(client: PoolClient) {
    const run = (await client.query<Run>(`SELECT * FROM library_adoption_runs WHERE legacy_root=$1 AND managed_root=$2
      AND state=ANY($3::text[]) ORDER BY created_at,id LIMIT 1`, [resolve(options.root), options.managedRoot ? resolve(options.managedRoot) : '', workingStates])).rows[0];
    if (!run || options.indexer.getStatus().running) return false;
    let currentItem: Item | undefined;
    try {
      try { await validateMigrationStorage(run, options); }
      catch (error) { throw new MigrationStorageError(message(error), 503); }
      const statuses = run.state === 'planning' ? ['pending'] : run.state === 'copying' ? ['ready', 'copying'] :
        run.state === 'activating' ? ['copied'] : run.state === 'restoring' ? ['activated'] : ['pending', 'ready', 'copying', 'copied', 'failed'];
      const item = (await client.query<Item>(`SELECT * FROM library_adoption_items WHERE run_id=$1 AND status=ANY($2::text[])
        AND NOT (status='failed' AND failed_action='cancel')
        ORDER BY project_id LIMIT 1`, [run.id, statuses])).rows[0];
      currentItem = item;
      if (!item) {
        const current = await publicRun(client, run);
        const partial = current.counts.failed + current.counts.blocked + current.counts.canceled > 0;
        const next = run.state === 'planning' ? 'review' : run.state === 'copying' ? (current.counts.copied ? 'awaiting_activation' : 'partial') :
          run.state === 'activating' ? (partial ? 'partial' : 'completed') : run.state === 'restoring' ? (partial ? 'partial' : 'restored') :
          current.counts.failed ? 'partial' : 'canceled';
        const hash = run.state === 'planning' ? await fingerprint(client, run.id) : run.fingerprint;
        await client.query(`UPDATE library_adoption_runs SET state=$3,fingerprint=$4,revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND state=$2`, [run.id, run.state, next, hash]);
        return true;
      }
      if (run.state === 'planning') {
        const plan = await createLibraryPreview(pool, options, [item.project_id], run.created_by, true);
        const storageProblem = plan.issues.find((issue) => ['legacy_unavailable', 'managed_unavailable', 'destination_unavailable', 'insufficient_space'].includes(issue.code));
        if (storageProblem) throw new MigrationStorageError(storageProblem.message, 503);
        const issues = [...plan.issues, ...plan.projects.flatMap((project) => project.issues)];
        const blocked = issues.some((issue) => issue.severity === 'blocker') || !plan.projects[0]?.inspectionComplete;
        await transaction(pool, async (tx) => {
          await tx.query(`UPDATE library_adoption_items SET plan_id=$3,fingerprint=$4,issues=$5,name=$6,size_bytes=$7,file_count=$8
            WHERE run_id=$1 AND project_id=$2`, [run.id, item.project_id, plan.id, plan.fingerprint, JSON.stringify(issues),
            plan.projects[0].name, plan.projects[0].sizeBytes, plan.projects[0].fileCount]);
          await setItem(tx, run, item, blocked ? 'blocked' : 'ready');
        });
      } else {
        let job = item.migration_id ? await migration.get(item.migration_id) :
          item.plan_id ? await libraryMigrationForPlan(pool, item.plan_id) : undefined;
        if (!job && run.state === 'canceling') {
          await transaction(pool, (tx) => setItem(tx, run, item, 'canceled'));
          return true;
        }
        if (!job) {
          if (!item.plan_id || !item.fingerprint) throw new IntakeError('Project has no reviewed plan; create a fresh adoption run', 409);
          job = await migration.approve(item.plan_id, item.fingerprint, run.actor_id);
          await client.query('UPDATE library_adoption_items SET migration_id=$3 WHERE run_id=$1 AND project_id=$2', [run.id, item.project_id, job.id]);
        }
        const action = run.state === 'copying' ? 'copy' : run.state === 'activating' ? 'activate' : 'restore';
        if (run.state === 'copying') await transaction(pool, (tx) => setItem(tx, run, item, 'copying'));
        job = run.state === 'canceling' ? await migration.cancel(job.id, job.revision, run.actor_id) :
          await migration.action(job.id, item.project_id, action, job.revision, run.actor_id);
        const result = job.projects.find((project) => project.projectId === item.project_id);
        if (!result || !['copied', 'activated', 'restored', 'canceled'].includes(result.status)) throw new Error('Migration returned an unexpected project state');
        await transaction(pool, (tx) => setItem(tx, run, item, result.status === 'copied' ? 'copied' : result.status === 'activated' ? 'activated' : result.status === 'restored' ? 'restored' : 'canceled'));
      }
      return true;
    } catch (error) {
      if (error instanceof MigrationBusyError) return false;
      log.error({ err: error, adoptionRunId: run.id }, 'Library adoption operation stopped');
      const action = run.state === 'planning' ? 'plan' : run.state === 'copying' ? 'copy' : run.state === 'activating' ? 'activate' : run.state === 'restoring' ? 'restore' : 'cancel';
      const projectError = error instanceof IntakeError && !(error instanceof MigrationStorageError) && error.status < 500;
      if (projectError) {
        const item = currentItem;
        if (!item) throw error;
        await transaction(pool, (tx) => setItem(tx, run, item, run.state === 'planning' ? 'blocked' : 'failed', message(error), action));
        return true;
      }
      await client.query(`UPDATE library_adoption_runs SET state='paused',resume_state=$2,last_error=$3,revision=revision+1,
        updated_at=clock_timestamp() WHERE id=$1 AND state=$2`, [run.id, run.state, message(error)]);
      return false;
    }
  }
  async function tick(maxSteps = 1) {
    const client = await pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(98422) AS locked')).rows[0].locked;
      if (!locked) return;
      for (let i = 0; i < maxSteps; i++) if (!await step(client)) break;
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(98422)'); }
      finally { client.release(); }
    }
  }
  function poll() {
    if (stopped) return;
    active = tick(10).catch((error: unknown) => { log.error({ err: error }, 'Library adoption runner failed; durable work remains pending'); })
      .finally(() => { active = undefined; if (!stopped) { timer = setTimeout(poll, 500); timer.unref(); } });
  }
  return {
    tick,
    start() { if (stopped) { stopped = false; poll(); } },
    async stop() { stopped = true; if (timer) clearTimeout(timer); await active; },
  };
}

export function registerLibraryAdoption(server: FastifyInstance, pool: Pool, auth: ReturnType<typeof createAuth>, options: CatalogOptions) {
  const service = createLibraryAdoptionService(pool, options);
  async function respond<T>(reply: FastifyReply, work: () => Promise<T>) {
    try { return await work(); }
    catch (error) {
      server.log.error({ err: error }, 'Library adoption request failed');
      return reply.code(error instanceof IntakeError ? error.status : 500).send({
        error: error instanceof IntakeError ? error.message : 'Library adoption request failed. Refresh progress before retrying; check the server log.',
      });
    }
  }
  server.get('/library/adoptions', { preHandler: auth.operatorOnly }, (_request, reply) => respond(reply, async () => ({ runs: await service.list() })));
  server.post<{ Body: { requestKey: string } }>('/library/adoptions', {
    preHandler: auth.operatorOnly, schema: { body: { type: 'object', additionalProperties: false, required: ['requestKey'],
      properties: { requestKey: { type: 'string', pattern: uuid } } } },
  }, (request, reply) => respond(reply, () => service.create(request.body.requestKey, auth.currentUser(request).id)));
  server.get<{ Params: { id: string } }>('/library/adoptions/:id', { preHandler: auth.operatorOnly, schema: { params } },
    (request, reply) => respond(reply, () => service.get(request.params.id)));
  server.get<{ Params: { id: string }; Querystring: { after?: string; status?: LibraryAdoptionItemStatus } }>('/library/adoptions/:id/items', {
    preHandler: auth.operatorOnly, schema: { params, querystring: { type: 'object', additionalProperties: false, properties: {
      after: { type: 'string', pattern: projectIdPattern },
      status: { enum: ['pending', 'ready', 'blocked', 'copying', 'copied', 'activated', 'failed', 'restored', 'canceled'] },
    } } },
  }, (request, reply) => respond(reply, () => service.items(request.params.id, request.query.after, request.query.status)));
  server.post<{ Params: { id: string }; Body: CommandBody }>('/library/adoptions/:id/commands', {
    preHandler: auth.operatorOnly, schema: { params, body: { type: 'object', additionalProperties: false,
      required: ['action', 'expectedRevision'], properties: {
        action: { enum: ['approve_copy', 'activate', 'pause', 'resume', 'retry', 'cancel', 'restore'] },
        expectedRevision: { type: 'integer', minimum: 0 }, expectedFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        confirmRetainedCopies: { type: 'boolean' }, acknowledgeWarnings: { type: 'boolean' },
        confirmActivation: { type: 'boolean' }, confirmRestoration: { type: 'boolean' }, confirmCancellation: { type: 'boolean' },
        stage: { enum: ['copy', 'activate', 'restore', 'cancel'] },
      } } },
  }, (request, reply) => respond(reply, () => service.command(request.params.id, request.body, auth.currentUser(request).id)));
}
