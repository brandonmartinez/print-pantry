import { createPool } from '@print-pantry/db';
import { buildServer } from './server.js';

const pool = createPool(process.env.DATABASE_URL ?? '');
const server = buildServer(pool);
const port = Number(process.env.API_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');

const close = async () => {
  await server.close();
  await pool.end();
};
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });

try {
  await server.listen({ host: '0.0.0.0', port });
} catch (error) {
  server.log.error(error);
  await close();
  process.exitCode = 1;
}
