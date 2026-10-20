import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryAdoptionItem, LibraryAdoptionRun } from '@print-pantry/contracts';
import { LibraryAdoption } from './LibraryAdoption.js';

const initial: LibraryAdoptionRun = {
  id: 'adoption-run', state: 'review', resumeState: null, revision: 4, fingerprint: 'a'.repeat(64),
  legacyRoot: '/synthetic/legacy', managedRoot: '/synthetic/managed', additionalBytes: '9007199254740993',
  availableBytes: '9223372036854775807', total: 2, lastError: null, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  counts: { pending: 0, ready: 1, blocked: 1, copying: 0, copied: 0, activated: 0, failed: 0, restored: 0, canceled: 0 },
};
const outcomes: LibraryAdoptionItem[] = [
  { projectId: '9007199254740993', name: 'Eligible holder', status: 'ready', planId: 'plan-good', migrationId: null,
    sizeBytes: '2048', fileCount: 1, issues: [{ severity: 'warning', code: 'source_recovery', relativePath: null, message: 'Review existing sources.' }], lastError: null },
  { projectId: '9007199254740994', name: 'Blocked tray', status: 'blocked', planId: 'plan-blocked', migrationId: null,
    sizeBytes: '4096', fileCount: 1, issues: [{ severity: 'blocker', code: 'missing_file', relativePath: 'part.stl', message: 'Model file is missing.' }], lastError: null },
];
function Location() { return <output data-testid="adoption-location">{useLocation().search}</output>; }
function setup(options: { noSelection?: boolean; run?: LibraryAdoptionRun; failCommand?: boolean; nextCursor?: string } = {}) {
  let run = structuredClone(options.run ?? initial);
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/library/adoptions') return init?.method === 'POST' ? run : { runs: [run] };
    if (path.endsWith('/commands')) {
      if (options.failCommand) {
        run = { ...run, state: 'paused', resumeState: 'copying', revision: run.revision + 1, lastError: 'Disk full; free managed storage first' };
        throw new Error('Storage request failed');
      }
      const body = JSON.parse(init!.body as string);
      run = { ...run, revision: run.revision + 1 };
      if (body.action === 'approve_copy' || body.action === 'resume') run = { ...run, state: 'awaiting_activation', counts: { ...run.counts, ready: 0, copied: 1 } };
      if (body.action === 'activate') run = { ...run, state: 'partial', counts: { ...run.counts, copied: 0, activated: 1 } };
      if (body.action === 'restore') run = { ...run, state: 'partial', counts: { ...run.counts, activated: 0, restored: 1 } };
      if (body.action === 'cancel') run = { ...run, state: 'canceled' };
      return run;
    }
    if (path.includes('/items?')) {
      const query = new URL(path, 'http://localhost').searchParams;
      return { items: outcomes.filter((item) => !query.get('status') || item.status === query.get('status')), nextCursor: options.nextCursor ?? null };
    }
    return run;
  });
  async function transport<T>(path: string, init?: RequestInit): Promise<T> { return await request(path, init) as T; }
  const onStorageChanged = vi.fn();
  render(<MemoryRouter initialEntries={[options.noSelection ? '/manage-library' : '/manage-library?adoption=adoption-run']}>
    <LibraryAdoption request={transport} legacyCount={2} refresh={0} onStorageChanged={onStorageChanged} /><Location />
  </MemoryRouter>);
  return { request, onStorageChanged };
}
afterEach(cleanup);

it('offers initialization planning without starting it automatically and bookmarks the created run', async () => {
  const { request } = setup({ noSelection: true });
  await screen.findByText('Recent adoption runs (1)');
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Plan existing library (2)' }));
  await screen.findByRole('heading', { name: 'Ready for plan review' });
  expect(screen.getByTestId('adoption-location').textContent).toBe('?adoption=adoption-run');
  const payload = request.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
  expect(JSON.parse(payload.body as string).requestKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
});

it('requires batch acknowledgements and a separate activation confirmation, with partial outcomes clearly reported', async () => {
  const { request, onStorageChanged } = setup();
  const approve = await screen.findByRole('button', { name: 'Approve batch copy and verification' });
  expect(screen.getAllByText(initial.legacyRoot).some((element) => !element.closest('details'))).toBe(true);
  expect(screen.getAllByText(initial.managedRoot).some((element) => !element.closest('details'))).toBe(true);
  expect(screen.getByTitle('9,007,199,254,740,993 bytes').textContent).toBe('8 PB');
  expect(screen.getByTitle('9,223,372,036,854,775,807 bytes').textContent).toBe('8 EB');
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('checkbox', { name: /verified backups/ }));
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('checkbox', { name: /projects that will be left behind/ }));
  fireEvent.click(approve);
  await screen.findByRole('button', { name: 'Review batch activation' });
  expect(request).toHaveBeenCalledWith('/api/library/adoptions/adoption-run/commands', {
    method: 'POST', body: JSON.stringify({ action: 'approve_copy', expectedRevision: 4, expectedFingerprint: initial.fingerprint,
      confirmRetainedCopies: true, acknowledgeWarnings: true }),
  });
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Review batch activation' }));
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm batch activation' }));
  await screen.findByRole('heading', { name: 'Partial result; review remaining projects' });
  expect(request).toHaveBeenCalledWith('/api/library/adoptions/adoption-run/commands', {
    method: 'POST', body: JSON.stringify({ action: 'activate', expectedRevision: 5, expectedFingerprint: initial.fingerprint, confirmActivation: true }),
  });
  await waitFor(() => expect(onStorageChanged).toHaveBeenCalled());
  expect(screen.getByText('1 blocked / 0 failed')).toBeTruthy();
});

it('restores bookmarked paused progress without automatically resuming or activating', async () => {
  const { request } = setup({ run: { ...initial, state: 'paused', resumeState: 'copying', lastError: 'Managed storage is unavailable.' } });
  await screen.findByRole('button', { name: 'Resume paused operation' });
  expect(screen.getByRole('alert').textContent).toContain('Managed storage');
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Resume paused operation' }));
  await screen.findByRole('button', { name: 'Review batch activation' });
  expect(request).toHaveBeenCalledWith('/api/library/adoptions/adoption-run/commands', {
    method: 'POST', body: JSON.stringify({ action: 'resume', expectedRevision: 4, expectedFingerprint: initial.fingerprint }),
  });
});

it('requires confirmation for batch cancellation and restoration', async () => {
  const { request } = setup({ run: { ...initial, state: 'partial', counts: { ...initial.counts, ready: 0, activated: 1 } } });
  fireEvent.click(await screen.findByRole('button', { name: 'Restore activated projects' }));
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm batch restoration' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore activated projects' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel unactivated work' }));
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm batch cancellation' }));
  await screen.findByRole('heading', { name: 'Remaining work canceled' });
});

it('refreshes durable revision and surfaces failed commands instead of showing success', async () => {
  const { request } = setup({ failCommand: true });
  await screen.findByRole('button', { name: 'Approve batch copy and verification' });
  fireEvent.click(screen.getByRole('checkbox', { name: /verified backups/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /projects that will be left behind/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve batch copy and verification' }));
  await screen.findByText('Storage request failed');
  await screen.findByText('Disk full; free managed storage first');
  fireEvent.click(screen.getByRole('button', { name: 'Resume paused operation' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/api/library/adoptions/adoption-run/commands', {
    method: 'POST', body: JSON.stringify({ action: 'resume', expectedRevision: 5, expectedFingerprint: initial.fingerprint }),
  }));
});

it('filters outcomes and paginates with exact decimal-string cursors, keeping evidence accessible', async () => {
  const { request } = setup({ nextCursor: '9007199254740993' });
  await screen.findByRole('link', { name: 'Eligible holder' });
  expect(screen.getAllByRole('link', { name: 'Review saved project plan' })).toHaveLength(2);
  expect(screen.getByText('Model file is missing.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next outcomes' }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('after=9007199254740993'))).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Project outcomes' }), { target: { value: 'blocked' } });
  await waitFor(() => expect(request.mock.calls.some(([path]) => path.endsWith('/items?status=blocked'))).toBe(true));
  expect(screen.getByRole('button', { name: 'Previous outcomes' })).toHaveProperty('disabled', true);
});
