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
});
