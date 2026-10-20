import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LegacyLibraryScan } from './LegacyLibraryScan.js';

afterEach(cleanup);
function setup(configured: boolean, fail = false) {
  const calls = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (fail) throw new Error('A migration run is holding the library lock');
      return { scan: { state: 'running' } };
    }
    return { configured, scan: { state: 'never', lastError: null, errors: [] } };
  });
  async function request<T>(path: string, init?: RequestInit): Promise<T> { return await calls(path, init) as T; }
  const onIndexed = vi.fn();
  render(<LegacyLibraryScan request={request} refresh={0} onIndexed={onIndexed} />);
  return { calls, onIndexed };
}
it('makes legacy migration optional without starting any indexing automatically', async () => {
  const { calls } = setup(false);
  await screen.findByText(/No legacy source configured/);
  expect(screen.queryByRole('button', { name: 'Index legacy library for migration' })).toBeNull();
  expect(calls.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('indexes only after an explicit operator action and refreshes migration inventory afterwards', async () => {
  const { calls, onIndexed } = setup(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Index legacy library for migration' }));
  await waitFor(() => expect(onIndexed).toHaveBeenCalledTimes(1));
  expect(calls.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('surfaces failed indexing instead of pretending it succeeded', async () => {
  const { onIndexed } = setup(true, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Index legacy library for migration' }));
  expect((await screen.findByRole('alert')).textContent).toContain('holding the library lock');
  expect(onIndexed).not.toHaveBeenCalled();
});
