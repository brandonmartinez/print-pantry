import { relations, sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').references(() => categories.id),
  relativePath: text('relative_path').notNull().unique(),
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
  projectId: uuid('project_id').notNull().references(() => projects.id),
  relativePath: text('relative_path').notNull().unique(),
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
  projectId: uuid('project_id').notNull().references(() => projects.id),
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
