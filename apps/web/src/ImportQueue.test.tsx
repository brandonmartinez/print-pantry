import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ImportMatch, ImportRequest } from '@print-pantry/contracts';
import { ImportQueue } from './ImportQueue.js';

const source = {
  url: 'https://makerworld.com/en/models/123?profile=456',
  canonicalUrl: 'https://makerworld.com/en/models/123',
  key: 'makerworld:123',
  provider: 'makerworld' as const,
  modelId: '123',
  profileId: '456',
};
const user = { id: 'user-1', username: 'maker', role: 'requester' as const };
const initial: ImportRequest = {
  id: 'import-1',
  source,
  title: 'Desk tray',
  status: 'submitted',
  revision: 1,
  projectId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  submissions: [{
    id: 'submission-1', requester: user, sourceUrl: source.url, title: 'Desk tray',
    notes: 'Please use the small profile.', createdAt: '2026-10-01T10:00:00.000Z',
  }],
  history: [{ id: 'event-1', actor: user, status: 'submitted', note: null, createdAt: '2026-10-01T10:00:00.000Z' }],
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function setup(options: {
  operator?: boolean;
  match?: Partial<ImportMatch>;
  failSubmit?: boolean;
  conflict?: boolean;
  total?: number;
  failList?: boolean;
  items?: ImportRequest[];
} = {}) {
  let current = structuredClone(initial);
  let failed = false;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method, body });
    if (path.startsWith('/api/imports?')) {
      if (options.failList && !failed) { failed = true; return response({ error: 'Import service unavailable' }, 503); }
      const page = Number(new URL(path, 'http://localhost').searchParams.get('page'));
      return response({ items: options.items ?? [current], page, pageSize: 12, total: options.total ?? 1 });
    }
    if (path === '/api/imports/check') return response({ source, projects: [], pending: null, ...options.match });
    if (path === '/api/imports' && method === 'POST') {
      if (options.failSubmit && !failed) { failed = true; throw new TypeError('Network unavailable'); }
      return response({ request: current, joined: Boolean(options.match?.pending) }, 201);
    }
    if (path === '/api/imports/import-1' && method === 'PATCH') {
      if (options.conflict && !failed) {
        failed = true;
        current = { ...current, revision: 2, status: 'awaiting_files' };
        return response({ error: 'Revision conflict' }, 409);
      }
      current = {
        ...current,
        status: body?.action === 'accept' ? 'awaiting_files' : body?.action === 'decline' ? 'declined' : 'canceled',
        revision: current.revision + 1,
      };
      return response({ request: current });
    }
    if (path === '/api/imports/import-1') return response({ request: current });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/imports']}><ImportQueue user={{ role: options.operator ? 'operator' : 'requester' }} /></MemoryRouter>);
  return { calls, fetchMock };
}

async function checkSource() {
  fireEvent.change(screen.getByLabelText('Source URL'), { target: { value: source.url } });
  fireEvent.click(screen.getByRole('button', { name: 'Check source' }));
  await screen.findByRole('heading', { name: 'Source checked' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('checks explicitly, then submits a source and optional details without uploading', async () => {
  const { calls } = setup({ items: [] });
  await screen.findByText('No imports yet. Add a model link above to get started.');
  expect(screen.getByText(/Imports use manual uploads/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Title (optional)'), { target: { value: 'A new tray' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Small profile please' } });
  await checkSource();
  expect(calls.filter((call) => call.path === '/api/imports').length).toBe(0);
  expect(screen.getByText(/Model ID: 123/).textContent).toContain('Profile ID: 456');
  fireEvent.click(screen.getByRole('button', { name: 'Submit import' }));
  await screen.findByText('Import submitted for operator review.');
  const submit = calls.find((call) => call.path === '/api/imports')!;
  expect(submit.body).toMatchObject({ url: source.url, title: 'A new tray', notes: 'Small profile please' });
  expect(submit.body?.submissionKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(calls.every((call) => !call.path.includes('upload'))).toBe(true);
});

it('requires explicit override for an existing project and explains joining a pending import', async () => {
  const { calls } = setup({
    items: [],
    match: { projects: [{ id: '9007199254740993', name: 'Library tray', available: false }], pending: { id: 'import-1', status: 'awaiting_files' } },
  });
  await checkSource();
  expect(screen.getByRole('link', { name: 'View Library tray' }).getAttribute('href')).toBe('/projects/9007199254740993');
  expect(screen.getByText(/Submitting will join that shared import/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Join existing import' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.filter((call) => call.path === '/api/imports')).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: /Submit anyway/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Join existing import' }));
  await screen.findByText('You are following the existing import. Your source link and notes were saved.');
});

it('preserves the submission key for a network retry and changes it for changed payloads', async () => {
  const { calls } = setup({ failSubmit: true, items: [] });
  await checkSource();
  fireEvent.click(screen.getByRole('button', { name: 'Submit import' }));
  await screen.findByText('Network unavailable');
  const first = calls.find((call) => call.path === '/api/imports')!.body!.submissionKey;
  fireEvent.click(screen.getByRole('button', { name: 'Submit import' }));
  await screen.findByText('Import submitted for operator review.');
  expect(calls.filter((call) => call.path === '/api/imports').map((call) => call.body!.submissionKey)).toEqual([first, first]);
  await checkSource();
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'A different request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit import' }));
  await waitFor(() => expect(calls.filter((call) => call.path === '/api/imports')).toHaveLength(3));
  expect(calls.filter((call) => call.path === '/api/imports')[2].body!.submissionKey).not.toBe(first);
});

it('invalidates a source check when its URL changes', async () => {
  const { calls } = setup({ items: [] });
  await checkSource();
  fireEvent.change(screen.getByLabelText('Source URL'), { target: { value: 'https://example.test/other' } });
  expect(screen.queryByRole('button', { name: 'Submit import' })).toBeNull();
  expect(calls.filter((call) => call.path === '/api/imports/check')).toHaveLength(1);
});

it('shows requester submissions and source links but no operator controls', async () => {
  setup();
  const card = await screen.findByRole('article', { name: 'Desk tray' });
  expect(within(card).queryByRole('button', { name: /Accept/ })).toBeNull();
  expect(within(card).queryByRole('button', { name: /Cancel/ })).toBeNull();
  fireEvent.click(within(card).getByText('Your submissions and import history'));
  expect(within(card).getByText('Please use the small profile.')).toBeTruthy();
  for (const link of within(card).getAllByRole('link', { name: /Open website/ })) {
    expect(link.getAttribute('href')).toBe(source.url);
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  }
});

it('accepts into Awaiting files without implying any files were acquired', async () => {
  const { calls } = setup({ operator: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Accept — Awaiting files' }));
  await screen.findByText('Awaiting files');
  expect(screen.getByText(/Accepted for manual file intake/)).toBeTruthy();
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ action: 'accept', expectedRevision: 1 });
  expect(screen.getAllByRole('link', { name: /Open website/ }).length).toBeGreaterThan(0);
});

it.each(['decline', 'cancel'] as const)('requires a note to %s a shared import', async (action) => {
  const { calls } = setup({ operator: true });
  const name = action === 'decline' ? 'Decline import' : 'Cancel import for everyone';
  fireEvent.click(await screen.findByRole('button', { name }));
  await screen.findByText('A note is required to decline or cancel an import.');
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  fireEvent.change(screen.getByLabelText('Decision note (required for decline or cancel)'), { target: { value: 'Not suitable for our printer' } });
  fireEvent.click(screen.getByRole('button', { name }));
  await screen.findByText(action === 'decline' ? 'Declined' : 'Canceled');
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ action, expectedRevision: 1, note: 'Not suitable for our printer' });
});

it('refreshes stale revisions, retains the warning, and uses the latest revision on retry', async () => {
  const { calls } = setup({ operator: true, conflict: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Accept — Awaiting files' }));
  await screen.findByText('Awaiting files');
  await screen.findByText(/This import changed. Refreshing its latest state/);
  expect(calls.some((call) => call.path === '/api/imports/import-1' && call.method === 'GET')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Accept — Awaiting files' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Decision note (required for decline or cancel)'), { target: { value: 'Cancel shared request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import for everyone' }));
  await screen.findByText('Canceled');
  expect(calls.filter((call) => call.method === 'PATCH')[1].body?.expectedRevision).toBe(2);
});

it('paginates imports and can retry a failed list request', async () => {
  const { calls } = setup({ total: 13, failList: true });
  await screen.findByText('Import service unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh imports' }));
  await screen.findByRole('article', { name: 'Desk tray' });
  fireEvent.click(screen.getByRole('button', { name: 'Next imports' }));
  await screen.findByText('Page 2');
  await waitFor(() => expect(calls.some((call) => call.path === '/api/imports?page=2&pageSize=12')).toBe(true));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next imports' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Previous imports' }));
  await screen.findByText('Page 1');
});

it.each(['awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported'] as const)('exposes a lazy operator workspace for %s with appropriate decision controls', async (status) => {
  const { calls } = setup({ operator: true, items: [{ ...initial, status }] });
  await screen.findByRole('button', { name: 'Open import workspace' });
  expect(calls.some((call) => call.path.endsWith('/intake'))).toBe(false);
  const mutable = ['awaiting_files', 'ready_for_review'].includes(status);
  expect(Boolean(screen.queryByRole('button', { name: 'Decline import' }))).toBe(mutable);
  expect(Boolean(screen.queryByRole('button', { name: 'Cancel import for everyone' }))).toBe(mutable);
});

it('never exposes intake or decision controls to a requester viewing a review-ready import', async () => {
  const { calls } = setup({ items: [{ ...initial, status: 'ready_for_review' }] });
  await screen.findByText('Ready for review');
  expect(screen.queryByRole('button', { name: 'Open import workspace' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Decline import' })).toBeNull();
  expect(calls.some((call) => call.path.endsWith('/intake'))).toBe(false);
});
