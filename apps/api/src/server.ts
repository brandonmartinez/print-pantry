import type { HealthResponse, ReadinessResponse } from '@print-pantry/contracts';
import Fastify from 'fastify';
import { createAuth } from './auth.js';
import { registerCatalog, type CatalogOptions } from './catalog.js';
import { registerRequests } from './requests.js';

export function buildServer(
  pool: { query(sql: string): Promise<unknown> },
  catalog?: CatalogOptions & { secureCookie: boolean; publicOrigin?: string },
) {
  const server = Fastify({ logger: true });

  if (catalog?.publicOrigin) {
    const origin = catalog.publicOrigin;
    const host = new URL(origin).host;
    server.addHook('onRequest', async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
      if (request.headers.origin !== origin || request.headers.host !== host) {
        return reply.code(403).send({ error: 'Request origin or host is not allowed' });
      }
    });
  }

  server.get<{ Reply: HealthResponse }>('/health', async () => ({ status: 'ok' }));
  server.get<{ Reply: ReadinessResponse }>('/ready', async (_request, reply) => {
    try {
      await pool.query(catalog?.publicOrigin
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
    registerCatalog(server, catalog, auth);
    registerRequests(server, catalog.pool, auth, catalog.indexer);
  }

  return server;
}
