import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

describe('service health', () => {
  it('reports liveness without consulting the database', async () => {
    const query = vi.fn();
    const server = buildServer({ query });
    const response = await server.inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
    await server.close();
  });

  it('reports readiness only when PostgreSQL responds', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const server = buildServer({ query });
    const response = await server.inject('/ready');
    expect(response.json()).toEqual({ status: 'ready' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    await server.close();
  });

  it('returns 503 when PostgreSQL is unavailable', async () => {
    const server = buildServer({ query: vi.fn().mockRejectedValue(new Error('offline')) });
    const response = await server.inject('/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await server.close();
  });

  it('rejects cross-origin and host-spoofed mutations before API handlers', async () => {
    const server = buildServer({ query: vi.fn() }, {
      pool: {} as never, root: '/mnt/library', indexer: {} as never,
      secureCookie: true, publicOrigin: 'https://pantry.example.test',
    });
    const readiness = await server.inject('/ready');
    expect(readiness.statusCode).toBe(200);
    for (const headers of [
      { host: 'pantry.example.test', origin: 'https://other.example.test' },
      { host: 'other.example.test', origin: 'https://pantry.example.test' },
      { host: 'pantry.example.test' },
    ]) {
      const response = await server.inject({ method: 'POST', url: '/auth/logout', headers });
      expect(response.statusCode).toBe(403);
    }
    const sameOrigin = await server.inject({
      method: 'POST', url: '/auth/logout',
      headers: { host: 'pantry.example.test', origin: 'https://pantry.example.test' },
    });
    expect(sameOrigin.statusCode).toBe(401);
    await server.close();
  });
});
