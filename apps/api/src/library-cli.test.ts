import { expect, it, vi } from 'vitest';
import type { LibraryAdoptionRun } from '@print-pantry/contracts';
import { runLibraryCli } from './library-cli.js';

const id = '12345678-1234-4234-8234-123456789abc';
const fingerprint = 'a'.repeat(64);
const run: LibraryAdoptionRun = {
  id, state: 'awaiting_activation', resumeState: null, revision: 7, fingerprint,
  legacyRoot: '/synthetic/source', managedRoot: '/synthetic/destination', additionalBytes: '9007199254740993',
  availableBytes: '9223372036854775807', total: 1, lastError: null, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  counts: { pending: 0, ready: 0, blocked: 0, copying: 0, copied: 1, activated: 0, failed: 0, restored: 0, canceled: 0 },
};
const credentials = ['--username', 'synthetic-operator', '--password-stdin'];
function transport(result = run) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ user: { id: 'synthetic-user', username: 'synthetic-operator', role: 'operator' } }),
      { headers: { 'set-cookie': 'pantry_session=synthetic-session; Path=/; HttpOnly' } });
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result));
  });
}
it('prints help without reading credentials or contacting a server', async () => {
  const fetcher = vi.fn<typeof fetch>(); const password = vi.fn(); const out = vi.fn();
  expect(await runLibraryCli(['--help'], { fetch: fetcher, password, out })).toBe(0);
  expect(out.mock.calls[0][0]).toContain('does NOT activate');
  expect(password).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  ['copy', id], ['activate', id], ['cancel', id], ['restore', id], ['retry', id],
  ['status', 'not-a-uuid'], ['unknown'], ['plan', id],
  ['status', id, '--url', 'http://example.test'], ['status', id, '--url', 'https://user:password@example.test'],
  ['status', id, '--revision', '9007199254740993'],
])('rejects invalid/unsafe or unapproved arguments before reading credentials: %j', async (...args) => {
  const fetcher = vi.fn<typeof fetch>(); const password = vi.fn(); const err = vi.fn();
  expect(await runLibraryCli([...args, ...credentials], { fetch: fetcher, password, err })).toBe(1);
  expect(err).toHaveBeenCalled();
  expect(password).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses the API base path, same-origin session authentication, and machine-readable exact byte values', async () => {
  const fetcher = transport(); const out = vi.fn(); const err = vi.fn();
  expect(await runLibraryCli(['status', id, ...credentials, '--url', 'https://pantry.example/api', '--json'],
    { fetch: fetcher, password: async () => 'Synthetic password input', out, err })).toBe(0);
  expect(JSON.parse(out.mock.calls[0][0])).toMatchObject({ additionalBytes: '9007199254740993', revision: 7 });
  expect(fetcher.mock.calls[0][0]).toBe('https://pantry.example/api/auth/login');
  expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'error', headers: { origin: 'https://pantry.example', cookie: 'pantry_session=synthetic-session' } });
  expect(fetcher.mock.calls.at(-1)![0]).toBe('https://pantry.example/api/auth/logout');
  expect(out.mock.calls.flat().join('')).not.toContain('Synthetic password input');
  expect(err).not.toHaveBeenCalled();
});
it('submits copy only with its fingerprint/retention flags and never sends an activation command', async () => {
  const fetcher = transport(); const out = vi.fn();
  expect(await runLibraryCli(['copy', id, ...credentials, '--fingerprint', fingerprint, '--confirm-retained-copies', '--acknowledge-warnings'],
    { fetch: fetcher, password: async () => 'Synthetic password input', out })).toBe(0);
  const body = JSON.parse(fetcher.mock.calls.find(([path]) => String(path).endsWith('/commands'))![1]!.body as string);
  expect(body).toEqual({ action: 'approve_copy', expectedRevision: 7, expectedFingerprint: fingerprint, confirmRetainedCopies: true, acknowledgeWarnings: true });
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/commands'))).toHaveLength(1);
});
it('wait reports partial/blocked outcomes with exit code 2 rather than claiming successful migration', async () => {
  const partial = { ...run, state: 'partial' as const, counts: { ...run.counts, blocked: 1 } };
  const out = vi.fn();
  expect(await runLibraryCli(['wait', id, ...credentials, '--json'], { fetch: transport(partial), password: async () => 'Synthetic password input', out })).toBe(2);
  expect(JSON.parse(out.mock.calls[0][0]).state).toBe('partial');
});
it('surfaces API failures and refuses redirected requests without exposing the supplied password', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'Synthetic authentication failure' }), { status: 401 }));
  const out = vi.fn(); const err = vi.fn();
  expect(await runLibraryCli(['status', id, ...credentials], { fetch: fetcher, password: async () => 'Do not log synthetic input', out, err })).toBe(1);
  expect(err.mock.calls[0][0]).toBe('Synthetic authentication failure');
  expect(out).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
});
