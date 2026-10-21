import { createDatabase, createPool } from '@print-pantry/db';
import { createLibraryIndexer, read3mfGeometryFromHandle, read3mfThumbnailFromHandle } from '@print-pantry/indexer';
import { clientPath } from './files.js';
import { productionOrigin } from './production-config.js';
import { buildServer } from './server.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateStorage } from './import-storage.js';
import { createLibraryAdoptionRunner } from './library-adoption.js';
import { createLegacyImportRunner } from './library-import.js';
import { loadAiEncryptionKey } from './ai-secrets.js';

const pool = createPool(process.env.DATABASE_URL ?? '');
if (process.env.LIBRARY_ROOT) throw new Error('LIBRARY_ROOT was renamed to LEGACY_LIBRARY_ROOT and is migration-only; update the container configuration');
const root = process.env.LEGACY_LIBRARY_ROOT || undefined;
const cookieSecure = process.env.COOKIE_SECURE ?? 'false';
if (cookieSecure !== 'true' && cookieSecure !== 'false') throw new Error('COOKIE_SECURE must be true or false');
if (process.env.ALLOW_INSECURE_HTTP && process.env.ALLOW_INSECURE_HTTP !== 'true' &&
    process.env.ALLOW_INSECURE_HTTP !== 'false') {
  throw new Error('ALLOW_INSECURE_HTTP must be true or false');
}
const publicOrigin = productionOrigin(process.env, cookieSecure === 'true');
const allowEmptyLibrary = process.env.LEGACY_LIBRARY_ALLOW_EMPTY ?? 'false';
if (allowEmptyLibrary !== 'true' && allowEmptyLibrary !== 'false') {
  throw new Error('LEGACY_LIBRARY_ALLOW_EMPTY must be true or false');
}
const ignoredDirectoryNames = (process.env.LEGACY_LIBRARY_IGNORED_DIRS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
for (const name of ignoredDirectoryNames) {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('LEGACY_LIBRARY_IGNORED_DIRS must contain directory names, not paths');
  }
}
if (process.env.MANAGED_CLIENT_MOUNT_PREFIX) clientPath(process.env.MANAGED_CLIENT_MOUNT_PREFIX, 'configuration-check');
const developmentStorage = process.env.NODE_ENV === 'production' ? undefined :
  fileURLToPath(new URL('../../../.pantry-data/', import.meta.url));
const intakeRoot = process.env.IMPORT_STORAGE_ROOT || (developmentStorage && join(developmentStorage, 'intake'));
const managedRoot = process.env.MANAGED_LIBRARY_ROOT || (developmentStorage && join(developmentStorage, 'library'));
if (!intakeRoot || !managedRoot) throw new Error('IMPORT_STORAGE_ROOT and MANAGED_LIBRARY_ROOT must both be configured');
const importStorage = { intakeRoot, managedRoot };
const encryptionKey = await loadAiEncryptionKey(process.env.AI_SETTINGS_KEY_FILE || (developmentStorage && join(developmentStorage, 'ai-settings.key')), Boolean(developmentStorage));
await validateStorage(importStorage, root);
const indexer = root ? createLibraryIndexer({
  db: createDatabase(pool), root, ignoredDirectoryNames,
  hashConcurrency: 2, allowEmptyLibrary: allowEmptyLibrary === 'true',
}) : {
  getStatus: () => ({ running: false, lastScan: null }),
  rescan: async () => { throw new Error('Configure LEGACY_LIBRARY_ROOT to index a library for migration'); },
};
const server = buildServer(pool, {
  pool, root,
  indexer, read3mfGeometry: read3mfGeometryFromHandle,
  read3mfThumbnail: read3mfThumbnailFromHandle, secureCookie: cookieSecure === 'true',
  managedRoot, managedClientMountPrefix: process.env.MANAGED_CLIENT_MOUNT_PREFIX,
  importStorage, ai: { encryptionKey },
}, publicOrigin);
const adoption = createLibraryAdoptionRunner(pool, { pool, root, managedRoot, indexer }, server.log);
const legacyImports = createLegacyImportRunner(pool, { root, importStorage, ignoredDirectories: ignoredDirectoryNames }, server.log);
const port = Number(process.env.API_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');

let closing: Promise<void> | undefined;
const close = async () => {
  if (closing) return closing;
  closing = (async () => {
  await legacyImports.stop();
  await adoption.stop();
  await server.close();
  await pool.end();
  })();
  return closing;
};
const shutdown = () => {
  void close().catch((error: unknown) => {
    server.log.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

try {
  await server.listen({ host: '0.0.0.0', port });
  adoption.start();
  legacyImports.start();
} catch (error) {
  server.log.error(error);
  await close();
  process.exitCode = 1;
}
