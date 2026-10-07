import type { HealthResponse, ReadinessResponse } from '@print-pantry/contracts';
import Fastify from 'fastify';

export function buildServer(pool: { query(sql: string): Promise<unknown> }) {
  const server = Fastify({ logger: true });

  server.get<{ Reply: HealthResponse }>('/health', async () => ({ status: 'ok' }));
  server.get<{ Reply: ReadinessResponse }>('/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      server.log.error({ err: error }, 'Database readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return server;
}
