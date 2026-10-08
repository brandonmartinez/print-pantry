import { createDatabase, createPool } from '@print-pantry/db';
import { createLibraryIndexer, read3mfGeometryFromHandle, read3mfThumbnailFromHandle } from '@print-pantry/indexer';
import { clientPath } from './files.js';
import { productionOrigin } from './production-config.js';
import { buildServer } from './server.js';

const pool = createPool(process.env.DATABASE_URL ?? '');
const root = process.env.LIBRARY_ROOT;
if (!root) throw new Error('LIBRARY_ROOT must point to the read-only mounted library');
const intervalMinutes = Number(process.env.SCAN_INTERVAL_MINUTES ?? 30);
if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) {
  throw new Error('SCAN_INTERVAL_MINUTES must be between 1 and 10080');
}
const cookieSecure = process.env.COOKIE_SECURE ?? 'false';
if (cookieSecure !== 'true' && cookieSecure !== 'false') throw new Error('COOKIE_SECURE must be true or false');
if (process.env.ALLOW_INSECURE_HTTP && process.env.ALLOW_INSECURE_HTTP !== 'true' &&
    process.env.ALLOW_INSECURE_HTTP !== 'false') {
  throw new Error('ALLOW_INSECURE_HTTP must be true or false');
}
const publicOrigin = productionOrigin(process.env, cookieSecure === 'true');
const allowEmptyLibrary = process.env.LIBRARY_ALLOW_EMPTY ?? 'false';
if (allowEmptyLibrary !== 'true' && allowEmptyLibrary !== 'false') {
  throw new Error('LIBRARY_ALLOW_EMPTY must be true or false');
}
const ignoredDirectoryNames = (process.env.LIBRARY_IGNORED_DIRS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
for (const name of ignoredDirectoryNames) {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('LIBRARY_IGNORED_DIRS must contain directory names, not paths');
  }
}
if (process.env.CLIENT_MOUNT_PREFIX) clientPath(process.env.CLIENT_MOUNT_PREFIX, 'configuration-check');
const indexer = createLibraryIndexer({
  db: createDatabase(pool), root, ignoredDirectoryNames,
  hashConcurrency: 2, allowEmptyLibrary: allowEmptyLibrary === 'true',
});
const server = buildServer(pool, {
  pool, root, clientMountPrefix: process.env.CLIENT_MOUNT_PREFIX,
  indexer, read3mfGeometry: read3mfGeometryFromHandle,
  read3mfThumbnail: read3mfThumbnailFromHandle, secureCookie: cookieSecure === 'true',
}, publicOrigin);
const port = Number(process.env.API_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');

const scheduler = indexer.start({ intervalMs: intervalMinutes * 60 * 1000 });
let closing: Promise<void> | undefined;
const close = async () => {
  if (closing) return closing;
  closing = (async () => {
  scheduler.stop();
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
  void indexer.rescan().catch((error: unknown) => server.log.error({ err: error }, 'Initial library scan failed'));
} catch (error) {
  server.log.error(error);
  await close();
  process.exitCode = 1;
}
