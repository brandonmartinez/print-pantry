import { relations, sql } from 'drizzle-orm';
import { bigint, check, customType, index, integer, jsonb, pgSequence, pgTable, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const projectIdSequence = pgSequence('project_id_seq');
const projectIdType = customType<{ data: string; driverData: string }>({
  dataType: () => 'bigint',
  fromDriver: (value) => String(value),
});

export const importRequests = pgTable('import_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceKey: text('source_key').notNull(),
  sourceUrl: text('source_url').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  provider: text('provider').notNull(),
  externalModelId: text('external_model_id'),
  externalProfileId: text('external_profile_id'),
  title: text('title'),
  status: text('status', { enum: ['submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported', 'declined', 'canceled'] }).notNull().default('submitted'),
  revision: integer('revision').notNull().default(0),
  projectId: projectIdType('project_id').references(() => projects.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('import_requests_active_source_idx').on(table.sourceKey)
    .where(sql`${table.status} IN ('submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending')`),
  index('import_requests_created_idx').on(table.createdAt),
  check('import_requests_status_check', sql`${table.status} IN ('submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported', 'declined', 'canceled')`),
]);

export const importSubmissions = pgTable('import_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => importRequests.id),
  requesterId: uuid('requester_id').notNull().references(() => users.id),
  submissionKey: uuid('submission_key').notNull(),
  sourceUrl: text('source_url').notNull(),
  title: text('title'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('import_submissions_idempotency_idx').on(table.requesterId, table.submissionKey),
  index('import_submissions_request_idx').on(table.requestId),
]);

export const importEvents = pgTable('import_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => importRequests.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  status: text('status', { enum: ['submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported', 'declined', 'canceled'] }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('import_events_request_idx').on(table.requestId)]);

export const projectSources = pgTable('project_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  sourceKey: text('source_key').notNull(),
  sourceUrl: text('source_url').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  provider: text('provider').notNull(),
  externalModelId: text('external_model_id'),
  externalProfileId: text('external_profile_id'),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('project_sources_project_source_idx').on(table.projectId, table.sourceKey),
  index('project_sources_key_idx').on(table.sourceKey),
]);

export const importIntakes = pgTable('import_intakes', {
  requestId: uuid('request_id').primaryKey().references(() => importRequests.id),
  plan: jsonb('plan'),
  lastError: text('last_error'),
  reservedProjectId: projectIdType('reserved_project_id'),
  publishedPath: text('published_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sourceDiscoveryPreviews = pgTable('source_discovery_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  snapshot: jsonb('snapshot').notNull(),
  approvedCandidateIds: jsonb('approved_candidate_ids').$type<string[]>(),
  appliedBy: uuid('applied_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, (table) => [index('source_discovery_project_idx').on(table.projectId)]);

export const libraryReorganizationPlans = pgTable('library_reorganization_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('library_reorganization_created_idx').on(table.createdAt)]);

export const libraryMigrations = pgTable('library_migrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => libraryReorganizationPlans.id).unique(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  status: text('status', { enum: ['active', 'completed', 'canceled'] }).notNull().default('active'),
  revision: integer('revision').notNull().default(0),
  legacyRoot: text('legacy_root').notNull(),
  managedRoot: text('managed_root').notNull(),
  rootIdentities: jsonb('root_identities').notNull(),
  history: jsonb('history').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('library_migrations_status_check', sql`${table.status} IN ('active','completed','canceled')`),
]);

export const libraryMigrationProjects = pgTable('library_migration_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  migrationId: uuid('migration_id').notNull().references(() => libraryMigrations.id),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  legacyRoot: text('legacy_root').notNull(),
  legacyPath: text('legacy_path').notNull(),
  managedPath: text('managed_path').notNull(),
  status: text('status', { enum: ['pending', 'copying', 'copied', 'activated', 'restored', 'canceled'] }).notNull().default('pending'),
  snapshot: jsonb('snapshot').notNull(),
  lastError: text('last_error'),
}, (table) => [
  uniqueIndex('library_migration_project_job_idx').on(table.migrationId, table.projectId),
  uniqueIndex('library_migration_project_active_idx').on(table.projectId)
    .where(sql`${table.status} IN ('pending','copying','copied','activated')`),
  index('library_migration_legacy_idx').on(table.legacyRoot, table.status),
  check('library_migration_projects_status_check', sql`${table.status} IN ('pending','copying','copied','activated','restored','canceled')`),
]);

export const libraryAdoptionRuns = pgTable('library_adoption_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  state: text('state').notNull().default('planning'),
  resumeState: text('resume_state'),
  revision: integer('revision').notNull().default(0),
  legacyRoot: text('legacy_root').notNull(),
  managedRoot: text('managed_root').notNull(),
  rootIdentities: jsonb('root_identities').notNull(),
  fingerprint: text('fingerprint').notNull().default(''),
  availableBytes: text('available_bytes'),
  copyApprovedAt: timestamp('copy_approved_at', { withTimezone: true }),
  activationApprovedAt: timestamp('activation_approved_at', { withTimezone: true }),
  history: jsonb('history').notNull().default([]),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('library_adoption_updated_idx').on(table.updatedAt),
  uniqueIndex('library_adoption_active_roots_idx').on(table.legacyRoot, table.managedRoot)
    .where(sql`${table.state} NOT IN ('completed','partial','canceled','restored')`),
  check('library_adoption_state_check', sql`${table.state} IN ('planning','review','copying','awaiting_activation','activating','restoring','canceling','paused','completed','partial','canceled','restored')`),
]);

export const libraryAdoptionItems = pgTable('library_adoption_items', {
  runId: uuid('run_id').notNull().references(() => libraryAdoptionRuns.id),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  planId: uuid('plan_id').references(() => libraryReorganizationPlans.id),
  migrationId: uuid('migration_id').references(() => libraryMigrations.id),
  fingerprint: text('fingerprint'),
  sizeBytes: text('size_bytes').notNull(),
  fileCount: integer('file_count').notNull(),
  issues: jsonb('issues').notNull().default([]),
  failedAction: text('failed_action'),
  lastError: text('last_error'),
}, (table) => [
  uniqueIndex('library_adoption_item_idx').on(table.runId, table.projectId),
  index('library_adoption_work_idx').on(table.runId, table.status, table.projectId),
  check('library_adoption_item_status_check', sql`${table.status} IN ('pending','ready','blocked','copying','copied','activated','failed','restored','canceled')`),
]);

export const importUploads = pgTable('import_uploads', {
  id: uuid('id').primaryKey(),
  requestId: uuid('request_id').notNull().references(() => importIntakes.requestId),
  name: text('name').notNull(),
  storedPath: text('stored_path').notNull(),
  contentHash: text('content_hash').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (table) => [index('import_uploads_request_idx').on(table.requestId)]);

export const importFiles = pgTable('import_files', {
  id: uuid('id').primaryKey(),
  requestId: uuid('request_id').notNull().references(() => importIntakes.requestId),
  uploadId: uuid('upload_id').notNull().references(() => importUploads.id),
  originalPath: text('original_path').notNull(),
  storedPath: text('stored_path').notNull(),
  contentHash: text('content_hash').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
}, (table) => [index('import_files_request_idx').on(table.requestId)]);

export const appMetadata = pgTable('app_metadata', {
  key: varchar('key', { length: 128 }).primaryKey(),
  value: varchar('value', { length: 1024 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
  name: text('name').notNull(),
  relativePath: text('relative_path').notNull().unique(),
}, (table) => [index('categories_search_idx').using('gin',
  sql`to_tsvector('simple', coalesce(${table.name}, '') || ' ' || coalesce(${table.relativePath}, ''))`)]);

export const projects = pgTable('projects', {
  id: projectIdType('id').primaryKey().default(sql`nextval('project_id_seq')`),
  categoryId: uuid('category_id').references(() => categories.id),
  storageKind: text('storage_kind', { enum: ['legacy', 'managed'] }).notNull().default('legacy'),
  relativePath: text('relative_path').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  tags: text('tags').array().notNull().default([]),
  designer: text('designer'),
  sourceUrl: text('source_url'),
  license: text('license'),
  notes: text('notes'),
  previewAssetId: uuid('preview_asset_id'),
  missingAt: timestamp('missing_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('projects_storage_path_idx').on(table.storageKind, table.relativePath),
  index('projects_category_idx').on(table.categoryId),
  index('projects_search_idx').using('gin', sql`to_tsvector('simple', coalesce(${table.name}, '') || ' ' ||
    coalesce(${table.description}, '') || ' ' || coalesce(print_pantry_tags_text(${table.tags}), '') || ' ' ||
    coalesce(${table.designer}, '') || ' ' || coalesce(${table.sourceUrl}, '') || ' ' ||
    coalesce(${table.license}, '') || ' ' || coalesce(${table.notes}, ''))`),
]);

export const projectBoundaryOverrides = pgTable('project_boundary_overrides', {
  relativePath: text('relative_path').primaryKey(),
  kind: text('kind', { enum: ['project', 'collection'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  storageKind: text('storage_kind', { enum: ['legacy', 'managed'] }).notNull().default('legacy'),
  relativePath: text('relative_path').notNull(),
  projectRelativePath: text('project_relative_path').notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  kind: text('kind', { enum: ['mesh', 'source', 'image', 'document', 'print', 'other'] }).notNull(),
  extension: text('extension').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull(),
  inode: bigint('inode', { mode: 'number' }),
  device: bigint('device', { mode: 'number' }),
  contentHash: text('content_hash'),
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => assetVersions.id),
  missingAt: timestamp('missing_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('assets_storage_path_idx').on(table.storageKind, table.relativePath),
  index('assets_project_idx').on(table.projectId),
  index('assets_search_idx').using('gin',
    sql`to_tsvector('simple', coalesce(${table.name}, '') || ' ' || coalesce(${table.projectRelativePath}, ''))`),
]);

export const assetVersions = pgTable('asset_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  contentHash: text('content_hash').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull(),
  thumbnailEntry: text('thumbnail_entry'),
  validationError: text('validation_error'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  missingAt: timestamp('missing_at', { withTimezone: true }),
}, (table) => [index('asset_versions_asset_idx').on(table.assetId)]);

export const scanRuns = pgTable('scan_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status', { enum: ['running', 'succeeded', 'partial', 'failed', 'offline'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  filesSeen: integer('files_seen').notNull().default(0),
  hashedFiles: integer('hashed_files').notNull().default(0),
  errorsCount: integer('errors_count').notNull().default(0),
  message: text('message'),
});

export const scanErrors = pgTable('scan_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => scanRuns.id),
  relativePath: text('relative_path'),
  code: text('code').notNull(),
  message: text('message').notNull(),
}, (table) => [index('scan_errors_run_idx').on(table.runId)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['operator', 'requester'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('sessions_user_idx').on(table.userId)]);

export const printRequests = pgTable('print_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: projectIdType('project_id').notNull().references(() => projects.id),
  projectName: text('project_name').notNull(),
  requesterId: uuid('requester_id').notNull().references(() => users.id),
  status: text('status', { enum: ['requested', 'queued', 'printing', 'completed', 'declined', 'canceled'] }).notNull(),
  quantity: integer('quantity').notNull(),
  material: varchar('material', { length: 100 }),
  color: varchar('color', { length: 100 }),
  notes: varchar('notes', { length: 2000 }),
  queuePosition: integer('queue_position'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('print_requests_requester_idx').on(table.requesterId, table.createdAt),
  index('print_requests_queue_idx').on(table.status, table.queuePosition),
  check('print_requests_quantity_check', sql`${table.quantity} BETWEEN 1 AND 100`),
  check('print_requests_queue_position_check', sql`(${table.status} = 'queued' AND ${table.queuePosition} > 0) OR (${table.status} <> 'queued' AND ${table.queuePosition} IS NULL)`),
]);

export const printRequestFiles = pgTable('print_request_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => printRequests.id),
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  versionId: uuid('version_id').notNull().references(() => assetVersions.id),
  name: text('name').notNull(),
  relativePath: text('relative_path').notNull(),
  fileType: text('file_type').notNull(),
  extension: text('extension').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  contentHash: text('content_hash').notNull(),
}, (table) => [
  index('print_request_files_request_idx').on(table.requestId),
  check('print_request_files_relative_path_check', sql`${table.relativePath} !~ '^/'`),
]);

export const printRequestHistory = pgTable('print_request_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => printRequests.id),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  action: text('action', { enum: ['submit', 'approve', 'decline', 'start', 'complete', 'cancel', 'reorder', 'select_next'] }).notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  fromPosition: integer('from_position'),
  toPosition: integer('to_position'),
  note: varchar('note', { length: 2000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('print_request_history_request_idx').on(table.requestId, table.createdAt)]);

export const requestQueueState = pgTable('request_queue_state', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  selectedNextId: uuid('selected_next_id').references(() => printRequests.id),
}, (table) => [
  check('request_queue_state_singleton_check', sql`${table.id} = 1`),
  check('request_queue_state_revision_check', sql`${table.revision} >= 0`),
]);

export const projectRelations = relations(projects, ({ one, many }) => ({
  category: one(categories, { fields: [projects.categoryId], references: [categories.id] }),
  assets: many(assets),
}));

export const assetRelations = relations(assets, ({ one, many }) => ({
  project: one(projects, { fields: [assets.projectId], references: [projects.id] }),
  versions: many(assetVersions),
  currentVersion: one(assetVersions, { fields: [assets.currentVersionId], references: [assetVersions.id], relationName: 'currentVersion' }),
}));

export const assetVersionRelations = relations(assetVersions, ({ one }) => ({
  asset: one(assets, { fields: [assetVersions.assetId], references: [assets.id] }),
}));
