import type { HealthResponse, ReadinessResponse } from '@print-pantry/contracts';
import Fastify from 'fastify';
import { createAuth } from './auth.js';
import { registerCatalog, type CatalogOptions } from './catalog.js';
import { registerRequests } from './requests.js';
import { registerImports } from './imports.js';
import { registerImportIntake } from './import-intake.js';
import type { ImportStorage } from './import-storage.js';
import { registerSourceDiscovery } from './source-discovery.js';
import { registerLibraryManagement } from './library-management.js';
import { libraryMigrationForPlan, registerLibraryMigrations } from './library-migrations.js';
import { registerLibraryAdoption } from './library-adoption.js';
import { registerLegacyImports } from './library-import.js';
import { createAiSettingsService, registerAiSettings, type AiSettingsOptions } from './ai-settings.js';
import { listAiModels } from './ai-providers.js';

export function buildServer(
  pool: { query(sql: string): Promise<unknown> },
  catalog?: CatalogOptions & { secureCookie: boolean; importStorage?: ImportStorage; ai?: Partial<AiSettingsOptions> },
  publicOrigin?: string,
) {
  const server = Fastify({ logger: true });

  if (publicOrigin) {
    const host = new URL(publicOrigin).host;
    server.addHook('onRequest', async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
      if (request.headers.origin !== publicOrigin || request.headers.host !== host) {
        return reply.code(403).send({ error: 'Request origin or host is not allowed' });
      }
    });
  }

  server.get<{ Reply: HealthResponse }>('/health', async () => ({ status: 'ok' }));
  server.get<{ Reply: ReadinessResponse }>('/ready', async (_request, reply) => {
    try {
      await pool.query(publicOrigin
        ? 'SELECT 1 FROM users, print_requests, request_queue_state LIMIT 1'
        : 'SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      server.log.error({ err: error }, 'Database readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  if (catalog) {
    const auth = createAuth(server, catalog.pool, catalog.secureCookie);
    const ai = createAiSettingsService(catalog.pool, { listModels: listAiModels, ...catalog.ai });
    registerAiSettings(server, ai, auth);
    registerCatalog(server, catalog, auth);
    registerRequests(server, catalog.pool, auth);
    registerImports(server, catalog.pool, auth);
    registerImportIntake(server, catalog.pool, auth, catalog.root, catalog.importStorage);
    registerSourceDiscovery(server, catalog.pool, auth, catalog);
    registerLibraryManagement(server, catalog.pool, auth, catalog, (id) => libraryMigrationForPlan(catalog.pool, id));
    registerLibraryMigrations(server, catalog.pool, auth, catalog);
    registerLibraryAdoption(server, catalog.pool, auth, catalog);
    registerLegacyImports(server, catalog.pool, auth, { root: catalog.root, importStorage: catalog.importStorage,
      ai, read3mfGeometry: catalog.read3mfGeometry,
      ignoredDirectories: (process.env.LEGACY_LIBRARY_IGNORED_DIRS ?? '').split(',').map((name) => name.trim()).filter(Boolean) });
  }

  return server;
}
