import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const project = {
  id: 'desk-organizer',
  name: 'Desk Organizer',
  category: 'Home',
  subcategory: 'Office',
  description: 'A tidy tray for your desk.',
  tags: ['organizer', 'desk'],
  previewUrl: null,
  available: true,
  assetCount: 2,
  clientPath: '/print-library/Home/Desk Organizer',
};
const detail = {
  ...project,
  designer: 'Pantry Studio',
  sourceUrl: 'https://example.test/model',
  license: 'CC BY',
  notes: 'Print the feet in a flexible material.',
  isBoundary: false,
  files: [
    {
      id: 'asset-10',
      versionId: 'version-10',
      name: 'part-10.stl',
      relativePath: 'Parts/part-10.stl',
      variant: 'Large',
      fileType: 'mesh',
      extension: '.stl',
      size: 2048,
      available: true,
      clientPath: '/print-library/Home/Desk Organizer/Parts/part-10.stl',
      downloadUrl: '/api/catalog/assets/asset-10/download',
      previewUrl: null,
      geometryUrl: '/api/catalog/assets/asset-10/geometry',
    },
    {
      id: 'asset-2',
      versionId: 'version-2',
      name: 'part-2.stl',
      relativePath: 'Parts/part-2.stl',
      variant: 'Small',
      fileType: 'mesh',
      extension: '.stl',
      size: 1024,
      available: true,
      clientPath: '/print-library/Home/Desk Organizer/Parts/part-2.stl',
      downloadUrl: '/api/catalog/assets/asset-2/download',
      previewUrl: null,
      geometryUrl: '/api/catalog/assets/asset-2/geometry',
    },
    {
      id: 'asset-missing',
      versionId: 'version-missing',
      name: 'missing.stl',
      relativePath: 'Parts/missing.stl',
      variant: null,
      fileType: 'mesh',
      extension: '.stl',
      size: 0,
      available: false,
      clientPath: null,
      downloadUrl: null,
      previewUrl: null,
    },
    {
      id: 'asset-readme',
      versionId: 'version-readme',
      name: 'README.md',
      relativePath: 'README.md',
      variant: null,
      fileType: 'document',
      extension: '.md',
      size: 512,
      available: true,
      clientPath: '/print-library/Home/Desk Organizer/README.md',
      downloadUrl: '/api/catalog/assets/asset-readme/download',
      previewUrl: null,
    },
  ],
};
const scan = { state: 'idle', lastSuccessfulAt: '2026-10-01T10:00:00.000Z', lastError: null };
const printRequest = {
  id: 'request-1',
  projectId: 'desk-organizer',
  projectName: 'Desk Organizer',
  requester: { id: 'u-1', username: 'maker', role: 'requester' },
  status: 'requested',
  quantity: 2,
  material: 'PLA',
  color: 'sage green',
  notes: 'Matte finish please.',
  createdAt: '2026-10-02T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  selected: [{
    assetId: 'asset-2',
    versionId: 'version-2',
    name: 'part-2.stl',
    relativePath: 'Parts/part-2.stl',
    variant: 'Small',
    available: true,
    unavailableReason: null,
    downloadUrl: '/api/catalog/assets/asset-2/download',
  }],
};
const printRequestDetail = {
  ...printRequest,
  history: [{
    id: 'history-1',
    actor: { id: 'operator-1', username: 'operator', role: 'operator' },
    action: 'approve',
    fromStatus: 'requested',
    toStatus: 'queued',
    fromPosition: null,
    toPosition: 1,
    note: 'Ready for the next batch.',
    createdAt: '2026-10-03T10:00:00.000Z',
  }, {
    id: 'history-2',
    actor: { id: 'operator-1', username: 'operator', role: 'operator' },
    action: 'reorder',
    fromStatus: 'queued',
    toStatus: 'queued',
    fromPosition: 2,
    toPosition: 1,
    note: null,
    createdAt: '2026-10-03T11:00:00.000Z',
  }],
};
const queuedRequests = [
  { ...printRequest, id: 'queue-1', status: 'queued', projectName: 'Desk Organizer' },
  { ...printRequest, id: 'queue-2', status: 'queued', projectName: 'Reading Lamp' },
];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function listResponse(page = 1, items = [project], total = 1) {
  return { items, total, page, pageSize: 12, categories: ['Home', 'Toys'], fileTypes: ['mesh', 'source'], scan };
}

function mockApi(role: 'operator' | 'requester' = 'requester', options: { queueConflict?: boolean; sourceUnavailable?: boolean } = {}) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    const method = init?.method || 'GET';
    if (path === '/api/auth/me') return jsonResponse({ message: 'Sign in required' }, 401);
    if (path === '/api/auth/login') return jsonResponse({ user: { id: 'u-1', username: 'maker', role } });
    if (path === '/api/auth/logout') return jsonResponse(undefined, 204);
    if (path.startsWith('/api/catalog/projects?')) {
      const url = new URL(path, 'http://localhost');
      const requestedPage = Number(url.searchParams.get('page'));
      const query = url.searchParams.get('q');
      const selectedCategory = url.searchParams.get('category');
      const selectedFileType = url.searchParams.get('fileType');
      if (requestedPage > 1) {
        return jsonResponse(listResponse(requestedPage, [{ ...project, id: 'lamp', name: 'Reading Lamp' }], 13));
      }
      if (query) {
        return jsonResponse(listResponse(1, [{ ...project, name: 'Search result' }], 1));
      }
      if (selectedCategory || selectedFileType) return jsonResponse(listResponse(1, [project], 1));
      return jsonResponse(listResponse(1, [project, { ...project, id: 'vase', name: 'Ceramic Vase' }], 13));
    }
    if (path.startsWith('/api/catalog/assets/asset-2/geometry')) {
      return jsonResponse({
        triangles: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]],
        sampled: true,
      });
    }
    if (path === '/api/catalog/projects/desk-organizer') return jsonResponse({ project: detail });
    if (path === '/api/catalog/projects/desk-organizer' && method === 'PATCH') return jsonResponse({ project: detail });
    if (path === '/api/catalog/boundaries' && method === 'PUT') return jsonResponse({ project: detail });
    if (path === '/api/catalog/rescan' && method === 'POST') return jsonResponse({ scan: { state: 'scanning' } });
    if (path === '/api/requests' && method === 'POST') return jsonResponse({ request: printRequest, revision: 1 });
    if (path === '/api/requests') {
      const request = options.sourceUnavailable ? {
        ...printRequest,
        selected: [{ ...printRequest.selected[0], available: false, unavailableReason: 'asset_missing', downloadUrl: null }],
      } : printRequest;
      return jsonResponse({ items: role === 'operator' ? [request, ...queuedRequests] : [request] });
    }
    if (path === '/api/requests/queue') {
      if (method === 'PUT' && options.queueConflict) return jsonResponse({ message: 'Queue changed' }, 409);
      return jsonResponse({ items: queuedRequests, revision: 4, selectedNextId: 'queue-1' });
    }
    if (path === '/api/requests/queue/next' && method === 'POST') return jsonResponse({ items: queuedRequests, revision: 5, selectedNextId: 'queue-2' });
    if (path === '/api/requests/request-1' && method === 'GET') return jsonResponse({ request: printRequestDetail });
    if (path.startsWith('/api/requests/') && method === 'PATCH') return jsonResponse({ request: printRequest, revision: 5 });
    return jsonResponse({ message: `Unexpected API request: ${method} ${path}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function signIn(
  role: 'operator' | 'requester' = 'requester',
  options: { sourceUnavailable?: boolean } = {},
  landingHeading = 'Browse projects',
) {
  const api = mockApi(role, options);
  render(<App />);
  await screen.findByRole('heading', { name: 'Welcome to the pantry' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'maker' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pantry-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: landingHeading });
  return api;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('signs in and shows the authenticated image-first catalog', async () => {
  const { calls } = await signIn();
  expect(await screen.findByRole('button', { name: 'Open Desk Organizer' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Ceramic Vase' })).toBeTruthy();
  expect(screen.getByText('13 projects')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  const initialQuery = new URL(calls.find(({ path }) => path.startsWith('/api/catalog/projects?'))!.path, 'http://localhost').searchParams;
  expect(initialQuery.has('category')).toBe(false);
  expect(initialQuery.has('fileType')).toBe(false);
});

it('searches, filters, and appends more projects without replacing the grid', async () => {
  const { calls } = await signIn();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'basket' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByRole('button', { name: 'Open Search result' })).toBeTruthy();
  await waitFor(() => expect(calls.some(({ path }) => new URL(path, 'http://localhost').searchParams.get('q') === 'basket')).toBe(true));

  fireEvent.change(screen.getByRole('combobox', { name: 'Filter by category' }), { target: { value: 'Home' } });
  await waitFor(() => expect(calls.some(({ path }) => new URL(path, 'http://localhost').searchParams.get('category') === 'Home')).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter by file type' }), { target: { value: 'mesh' } });
  await waitFor(() => expect(calls.some(({ path }) => new URL(path, 'http://localhost').searchParams.get('fileType') === 'mesh')).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByRole('button', { name: 'Open Desk Organizer' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('button', { name: 'Open Reading Lamp' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Desk Organizer' })).toBeTruthy();
  expect(screen.getByText('All 13 projects loaded')).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Project pages' })).toBeNull();
  expect(calls.some(({ path }) => new URL(path, 'http://localhost').searchParams.get('page') === '2')).toBe(true);
});

it('shows a naturally ordered project detail with file paths and download actions', async () => {
  await signIn();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  expect(await screen.findByRole('heading', { name: 'Desk Organizer' })).toBeTruthy();
  const requestSection = screen.getByRole('region', { name: 'Request this print' });
  const fileTexts = within(requestSection).getAllByText(/^Parts\/part-/).map((element) => element.textContent);
  expect(fileTexts).toEqual(['Parts/part-2.stl', 'Parts/part-10.stl']);
  expect(within(requestSection).getAllByRole('link', { name: 'Download' })[0].getAttribute('href')).toBe('/api/catalog/assets/asset-2/download');
  const otherFilesSection = screen.getByRole('region', { name: 'Other Files' });
  expect(within(otherFilesSection).getAllByText('README.md')).toHaveLength(2);
  expect(screen.queryByRole('checkbox', { name: /README\.md/ })).toBeNull();
  expect(within(requestSection).getByText(/Source unavailable/)).toBeTruthy();
  expect(screen.getByText('Pantry Studio')).toBeTruthy();
});

it('supports direct project links and browser history navigation', async () => {
  window.history.replaceState({}, '', '/projects/desk-organizer');
  await signIn('requester', {}, 'Desk Organizer');
  expect(await screen.findByRole('heading', { name: 'Desk Organizer' })).toBeTruthy();
  expect(window.location.pathname).toBe('/projects/desk-organizer');

  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  expect(await screen.findByRole('heading', { name: 'Browse projects' })).toBeTruthy();
  expect(window.location.pathname).toBe('/');

  window.history.back();
  expect(await screen.findByRole('heading', { name: 'Desk Organizer' })).toBeTruthy();
});

it('loads mesh geometry only on demand and exposes interactive viewer controls', async () => {
  const { calls } = await signIn();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  await screen.findByRole('heading', { name: 'Desk Organizer' });
  expect(calls.filter(({ path }) => path.endsWith('/geometry'))).toHaveLength(0);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  const exploreButton = await screen.findByRole('button', { name: 'Explore 3D preview for part-2.stl' });
  fireEvent.click(exploreButton);
  const canvas = await screen.findByRole('img', { name: /Interactive 3D preview of part-2\.stl/ });
  expect(calls.filter(({ path }) => path.startsWith('/api/catalog/assets/asset-2/geometry'))).toHaveLength(1);
  expect(screen.getByText(/Drag to rotate. Scroll or pinch to zoom/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reset view' })).toBeTruthy();
  expect(canvas.getAttribute('width')).toBe('720');
});

it('copies project and file paths when clipboard access succeeds', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await signIn();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy project path' }));
  expect(await screen.findByText('project path copied.')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Copy file path' })[0]);
  expect(await screen.findByText('file path copied.')).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith('/print-library/Home/Desk Organizer');
  expect(writeText).toHaveBeenCalledWith('/print-library/Home/Desk Organizer/Parts/part-2.stl');
});

it('shows a selectable manual fallback when clipboard writing is rejected', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
  });
  await signIn();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy project path' }));
  expect((await screen.findByRole('status')).textContent).toContain('Clipboard access was blocked');
  expect((screen.getByRole('textbox', { name: 'Local path to copy manually' }) as HTMLInputElement).value)
    .toBe('/print-library/Home/Desk Organizer');
});

it('provides rescan and metadata/boundary editing only to operators', async () => {
  const { calls } = await signIn('operator');
  expect(screen.getByRole('button', { name: '↻ Rescan library' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '↻ Rescan library' }));
  expect(await screen.findByText('Library rescan started.')).toBeTruthy();
  await waitFor(() => expect(calls.some(({ path, init }) => path === '/api/catalog/rescan' && init?.method === 'POST')).toBe(true));

  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit metadata' }));
  fireEvent.change(screen.getByLabelText('Designer'), { target: { value: 'New Designer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save metadata' }));
  await waitFor(() => {
    const patch = calls.find(({ path, init }) => path === '/api/catalog/projects/desk-organizer' && init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({ designer: 'New Designer', tags: ['organizer', 'desk'] });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Set project boundary' }));
  await waitFor(() => {
    const boundary = calls.find(({ path, init }) => path === '/api/catalog/boundaries' && init?.method === 'PUT');
    expect(JSON.parse(String(boundary?.init?.body))).toEqual({ projectId: 'desk-organizer', isBoundary: true });
  });
});

it('does not expose operator actions to household members', async () => {
  await signIn('requester');
  expect(screen.queryByRole('button', { name: '↻ Rescan library' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  expect(await screen.findByRole('heading', { name: 'Desk Organizer' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit metadata' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Set project boundary' })).toBeNull();
});

it('requires explicit file-version selection and submits a bounded print request', async () => {
  const { calls } = await signIn('requester');
  fireEvent.click(await screen.findByRole('button', { name: 'Open Desk Organizer' }));
  await screen.findByRole('heading', { name: 'Request this print' });
  fireEvent.click(screen.getByRole('checkbox', { name: /part-2\.stl.*Small/i }));
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'PETG' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit print request' }));
  expect(await screen.findByText(/Request request-1 submitted/)).toBeTruthy();
  const submit = calls.find(({ path, init }) => path === '/api/requests' && init?.method === 'POST');
  expect(JSON.parse(String(submit?.init?.body))).toEqual({
    projectId: 'desk-organizer',
    selected: [{ assetId: 'asset-2', versionId: 'version-2' }],
    quantity: 3,
    material: 'PETG',
  });
});

it('shows requester history and permits cancellation before printing', async () => {
  const { calls } = await signIn('requester');
  fireEvent.click(screen.getByRole('link', { name: 'Requests' }));
  expect(await screen.findByRole('heading', { name: 'Your requests' })).toBeTruthy();
  expect(screen.getByText('Parts/part-2.stl')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  await waitFor(() => {
    const cancellation = calls.find(({ path, init }) => path === '/api/requests/request-1' && init?.method === 'PATCH');
    expect(JSON.parse(String(cancellation?.init?.body))).toEqual({ action: 'cancel' });
  });
});

it('explains unavailable selected sources without exposing internal reason codes', async () => {
  await signIn('requester', { sourceUnavailable: true });
  fireEvent.click(screen.getByRole('link', { name: 'Requests' }));
  expect(await screen.findByText('The selected source file is no longer available.')).toBeTruthy();
  expect(screen.getByText('Exact version unavailable')).toBeTruthy();
  expect(screen.queryByText('asset_missing')).toBeNull();
});

it('loads detail-only request history when its disclosure opens', async () => {
  const { calls } = await signIn('requester');
  fireEvent.click(screen.getByRole('link', { name: 'Requests' }));
  await screen.findByRole('heading', { name: 'Your requests' });
  fireEvent.click(screen.getByText('Request history', { selector: 'summary' }));
  expect(await screen.findAllByText('by operator')).toHaveLength(2);
  expect(screen.getByText('Ready for the next batch.')).toBeTruthy();
  expect(screen.getByText('Moved in queue from 2 to 1')).toBeTruthy();
  expect(calls.some(({ path, init }) => path === '/api/requests/request-1' && (init?.method || 'GET') === 'GET')).toBe(true);
});

it('preserves an unsaved queue draft until it is saved', async () => {
  const api = mockApi('operator');
  render(<App />);
  await screen.findByRole('heading', { name: 'Welcome to the pantry' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'maker' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pantry-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Browse projects' });
  fireEvent.click(screen.getByRole('link', { name: 'Queue' }));
  await screen.findByRole('heading', { name: 'Print queue' });
  fireEvent.click(screen.getByRole('button', { name: 'Move queue-2 earlier' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose next' }));
  expect(await screen.findByText('Save queue order before choosing the next print.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save queue order' })).toBeTruthy();
  expect(api.calls.some(({ path }) => path === '/api/requests/queue/next')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Approve and queue' }));
  expect(await screen.findByText('Save queue order before updating requests.')).toBeTruthy();
  expect(api.calls.some(({ path, init }) => path === '/api/requests/request-1' && init?.method === 'PATCH')).toBe(false);
});

it('refreshes an operator queue after a stale reorder conflict', async () => {
  const api = mockApi('operator', { queueConflict: true });
  render(<App />);
  await screen.findByRole('heading', { name: 'Welcome to the pantry' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'maker' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pantry-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Browse projects' });
  fireEvent.click(screen.getByRole('link', { name: 'Queue' }));
  expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move queue-2 earlier' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save queue order' }));
  expect(await screen.findByText('The queue changed elsewhere, so the latest queue has been loaded.')).toBeTruthy();
  const reorder = api.calls.find(({ path, init }) => path === '/api/requests/queue' && init?.method === 'PUT');
  expect(JSON.parse(String(reorder?.init?.body))).toEqual({ orderedIds: ['queue-2', 'queue-1'], expectedRevision: 4 });
});

it('logs out through the household session endpoint', async () => {
  const { calls } = await signIn();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Welcome to the pantry' })).toBeTruthy();
  expect(calls.some(({ path, init }) => path === '/api/auth/logout' && init?.method === 'POST')).toBe(true);
});

it('shows an explicit unavailable state when the catalog service is offline', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/auth/me') return jsonResponse({ message: 'Sign in required' }, 401);
    if (path === '/api/auth/login') return jsonResponse({ user: { id: 'u-1', username: 'maker', role: 'requester' } });
    throw new Error('network offline');
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByRole('heading', { name: 'Welcome to the pantry' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'maker' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pantry-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('heading', { name: 'We couldn’t reach the library' })).toBeTruthy();
  expect(screen.getByText('Catalog service unavailable.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});
