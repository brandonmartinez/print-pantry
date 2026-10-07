import { relations, sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, timestamp, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
