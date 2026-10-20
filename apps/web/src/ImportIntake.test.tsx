import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ImportIntakeResult, ImportPlan, ImportRequest } from '@print-pantry/contracts';
import { ImportIntake } from './ImportIntake.js';

const metadata = { name: 'Desk tray', category: null, description: null, designer: null, license: null, notes: null, tags: [] };
const plan: ImportPlan = {
  schemaVersion: 1, metadata,
  files: [{ id: 'file-1', versionId: 'version-1', originalPath: 'tray.stl', path: 'models/tray.stl', size: 10, hash: 'hash', kind: 'mesh', include: true }],
  warnings: ['Keep assembly dependencies together.'], duplicates: [],
};
const item: ImportRequest = {
  id: 'import-1', revision: 1, status: 'awaiting_files', title: null, projectId: null,
  source: { url: 'https://example.test/model', canonicalUrl: 'https://example.test/model', key: 'example', provider: 'other', modelId: null, profileId: null },
  createdAt: '', updatedAt: '', history: [], submissions: [],
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function setup(options: { prepared?: boolean; plan?: ImportPlan; configured?: boolean; status?: ImportRequest['status']; failUpload?: boolean; conflict?: boolean; lastError?: string } = {}) {
  let result: ImportIntakeResult = {
    revision: 1, intake: {
      configured: options.configured ?? true, prepared: options.prepared ?? false, plan: options.plan ?? null,
      uploads: options.plan ? [{ id: 'upload-1', name: 'tray.stl', size: 10, fileCount: 1 }] : [],
      lastError: options.lastError ?? null, publishedPath: null,
    },
  };
  let failed = false;
  const calls: Array<{ path: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.headers && (init.headers as Record<string, string>)['Content-Type'] === 'application/json'
      ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, init, body });
    if (!init?.method) return response(structuredClone(result));
    if (options.conflict && !failed) {
      failed = true;
      result = { ...result, revision: 7, intake: { ...result.intake, plan: structuredClone(plan), prepared: true, uploads: [{ id: 'upload-1', name: 'tray.stl', size: 10, fileCount: 1 }] } };
      return response({ error: 'Revision conflict from another operator' }, 409);
    }
    if (path.includes('/files?') && options.failUpload && !failed) {
      failed = true;
      throw new TypeError('Upload connection lost');
    }
    result = structuredClone(result);
    result.revision += 1;
    if (path.endsWith('/prepare')) result.intake.prepared = true;
    if (path.includes('/files?')) {
      const name = new URL(path, 'http://localhost').searchParams.get('name')!;
      result.intake.uploads.push({ id: `upload-${result.revision}`, name, size: 10, fileCount: name.endsWith('.zip') ? 2 : 1 });
      result.intake.plan = null;
    }
    if (init.method === 'DELETE') {
      result.intake.uploads = [];
      result.intake.plan = null;
    }
    if (path.endsWith('/plan')) result.intake.plan = {
      ...structuredClone(options.plan || plan), metadata: body!.metadata as typeof metadata,
      ...(body!.files ? { files: (body!.files as typeof plan.files).map((entry) => ({ ...(options.plan || plan).files.find((file) => file.id === entry.id)!, ...entry })) } : {}),
    };
    if (path.endsWith('/publish')) {
      result.projectId = '123';
      result.intake.publishedPath = 'managed/desk-tray';
    }
    return response(structuredClone(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(<MemoryRouter><ImportIntake item={{ ...item, status: options.status || item.status }} onChanged={onChanged} /></MemoryRouter>);
  return { calls, fetchMock, onChanged };
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Open import workspace' }));
  await waitFor(() => expect(screen.queryByText('Working on import…')).toBeNull());
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads lazily and truthfully blocks unconfigured storage', async () => {
  const { fetchMock } = setup({ configured: false });
  expect(fetchMock).not.toHaveBeenCalled();
  await open();
  expect(screen.getByText(/Set IMPORT_STORAGE_ROOT and MANAGED_LIBRARY_ROOT/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Prepare import' })).toBeNull();
});

it('prepares, uploads ZIP and regular files sequentially, then explicitly processes and publishes', async () => {
  const { calls } = setup();
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare import' }));
  await screen.findByLabelText('Files or ZIP archives');
  const archive = new File(['zip'], 'assembly.zip', { type: 'application/zip' });
  const mesh = new File(['mesh'], 'tray.stl');
  Object.defineProperty(mesh, 'webkitRelativePath', { value: 'parts/tray.stl' });
  fireEvent.change(screen.getByLabelText('Files or ZIP archives'), { target: { files: [archive, mesh] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  await screen.findByText('parts/tray.stl · 1 files · 10 bytes');
  const uploads = calls.filter((call) => call.path.includes('/files?'));
  expect(uploads.map((call) => new URL(call.path, 'http://localhost').searchParams.get('expectedRevision'))).toEqual(['2', '3']);
  expect(uploads[0].init?.body).toBe(archive);
  expect(uploads[1].init?.body).toBe(mesh);
  expect(uploads[0].init?.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
  expect(calls.some((call) => call.path.endsWith('/plan'))).toBe(false);
  expect((screen.getByRole('button', { name: 'Process files' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'My assembly' } });
  fireEvent.change(screen.getByLabelText('Category (optional)'), { target: { value: 'Workshop/Tools' } });
  fireEvent.change(screen.getByLabelText('Tags (comma-separated)'), { target: { value: 'useful, workshop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Process files' }));
  await screen.findByRole('button', { name: 'Save plan' });
  expect(calls.find((call) => call.path.endsWith('/plan'))?.body).toMatchObject({
    expectedRevision: 4, metadata: { name: 'My assembly', category: 'Workshop/Tools', tags: ['useful', 'workshop'] },
  });
  expect(screen.getByText('Keep assembly dependencies together.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Publish to managed library' }));
  expect((await screen.findByRole('link', { name: 'View library project' })).getAttribute('href')).toBe('/projects/123');
  expect(calls.find((call) => call.path.endsWith('/publish'))?.body).toEqual({ expectedRevision: 5, confirmDuplicates: false });
});

it('retains upload keys and remaining selections for a failed upload retry', async () => {
  const { calls } = setup({ prepared: true, failUpload: true });
  await open();
  fireEvent.change(screen.getByLabelText('Files or ZIP archives'), { target: { files: [new File(['mesh'], 'tray.stl')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  await screen.findByText('Upload connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  await screen.findByText('tray.stl · 1 files · 10 bytes');
  const uploads = calls.filter((call) => call.path.includes('/files?'));
  expect(uploads).toHaveLength(2);
  expect(uploads[0].path).toBe(uploads[1].path);
});

it.each([400, 413, 502])('reports the HTTP status instead of a browser JSON parsing error for a non-JSON upload response (%s)', async (status) => {
  const { fetchMock } = setup({ prepared: true });
  await open();
  fetchMock.mockImplementationOnce(async () => new Response('<html>Upload rejected by proxy</html>', {
    status, headers: { 'Content-Type': 'text/html' },
  }));
  fireEvent.change(screen.getByLabelText('Files or ZIP archives'), { target: { files: [new File(['zip'], 'Holder | Kobalt & More.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  expect((await screen.findByRole('alert')).textContent).toContain(`HTTP ${status}`);
  expect(screen.getByRole('alert').textContent).toContain('API/proxy logs and upload limits');
  expect(screen.getByText('Holder | Kobalt & More.zip (3 bytes)')).toBeTruthy();
});

it('shows the detailed API validation message for an upload rejection', async () => {
  const { fetchMock } = setup({ prepared: true });
  await open();
  fetchMock.mockImplementationOnce(async () => response({ error: 'Bad Request', message: 'The upload filename contains control characters' }, 400));
  fireEvent.change(screen.getByLabelText('Files or ZIP archives'), { target: { files: [new File(['zip'], 'holder.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  expect((await screen.findByRole('alert')).textContent).toBe('The upload filename contains control characters');
});

it('does not repeat an upload error already present in persisted intake state', async () => {
  const message = 'A source filename exceeds filename/depth limits';
  const { fetchMock } = setup({ prepared: true, lastError: message });
  await open();
  fetchMock.mockImplementationOnce(async () => response({ error: message }, 400));
  fireEvent.change(screen.getByLabelText('Files or ZIP archives'), { target: { files: [new File(['zip'], 'holder.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }));
  await waitFor(() => expect(screen.queryByText('Working on import…')).toBeNull());
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert').textContent).toBe(message);
});

it('requires saving every edit and explicitly confirming duplicates before publication', async () => {
  const { calls } = setup({ prepared: true, plan: { ...plan, duplicates: [{ projectId: '42', name: 'Other tray', matchingFiles: 1, storageKind: 'legacy' }] } });
  await open();
  expect(screen.queryByRole('link', { name: 'Other tray' })).toBeNull();
  expect(screen.getByText(/Other tray.*migration required/)).toBeTruthy();
  const publish = () => screen.getByRole('button', { name: 'Publish to managed library' }) as HTMLButtonElement;
  expect(publish().disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the duplicates/ }));
  expect(publish().disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Proposed path for tray.stl'), { target: { value: 'models/assembly/tray.stl' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include tray.stl' }));
  expect(publish().disabled).toBe(true);
  expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());
  expect(calls.find((call) => call.path.endsWith('/plan'))?.body?.files).toEqual([{ id: 'file-1', path: 'models/assembly/tray.stl', include: false }]);
  expect(publish().disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the duplicates/ }));
  fireEvent.click(publish());
  await screen.findByRole('link', { name: 'View library project' });
  expect(calls.find((call) => call.path.endsWith('/publish'))?.body).toEqual({ expectedRevision: 2, confirmDuplicates: true });
});

it('removes an active upload and invalidates its plan while explaining original retention', async () => {
  const { calls } = setup({ prepared: true, plan });
  await open();
  const original = screen.getByRole('link', { name: 'Download original tray.stl' });
  expect(original.getAttribute('href')).toBe('/api/imports/import-1/files/upload-1/original');
  expect(original.hasAttribute('download')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove tray.stl' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save plan' })).toBeNull());
  expect(calls.find((call) => call.init?.method === 'DELETE')?.body).toEqual({ expectedRevision: 1 });
  expect(screen.queryByRole('button', { name: 'Publish to managed library' })).toBeNull();
  expect(screen.getByText(/Originals are retained for recovery/)).toBeTruthy();
});

it('shows the server conflict, refreshes intake and parent request state, and retries at latest revision', async () => {
  const { calls, onChanged } = setup({ conflict: true });
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare import' }));
  await screen.findByText(/Revision conflict from another operator/);
  expect(onChanged).toHaveBeenCalled();
  expect(calls.filter((call) => call.path.endsWith('/intake'))).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await waitFor(() => expect(calls.some((call) => call.body?.expectedRevision === 7)).toBe(true));
});

it.each([['publishing', 'Retry publication'], ['catalog_pending', 'Finish catalog registration']] as const)('offers recovery for %s without mutable inputs', async (status, label) => {
  const { calls } = setup({ prepared: true, plan, status });
  await open();
  expect(screen.queryByLabelText('Files or ZIP archives')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save plan' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Download original tray.stl' }).getAttribute('href')).toBe('/api/imports/import-1/files/upload-1/original');
  fireEvent.click(screen.getByRole('button', { name: label }));
  await screen.findByRole('link', { name: 'View library project' });
  expect(calls.find((call) => call.path.endsWith('/publish'))?.body?.expectedRevision).toBe(1);
});

it.each([['publishing', 'Retry publication'], ['catalog_pending', 'Finish catalog registration']] as const)('allows acknowledging newly discovered duplicates during %s recovery with an empty saved duplicate list', async (status, label) => {
  const { calls } = setup({ prepared: true, plan: { ...plan, duplicates: [] }, status });
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm creating a separate project/ }));
  fireEvent.click(screen.getByRole('button', { name: label }));
  await screen.findByRole('link', { name: 'View library project' });
  expect(calls.find((call) => call.path.endsWith('/publish'))?.body).toEqual({ expectedRevision: 1, confirmDuplicates: true });
});

it('keeps destination-conflict plans editable and saves the corrected paths', async () => {
  const { calls } = setup({
    prepared: true,
    plan: { ...plan, warnings: ['Resolve destination conflicts before publishing: models/tray.stl'] },
  });
  await open();
  expect(screen.getByText('Resolve destination conflicts before publishing: models/tray.stl')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Proposed path for tray.stl'), { target: { value: 'models/renamed-tray.stl' } });
  expect((screen.getByRole('button', { name: 'Publish to managed library' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await waitFor(() => expect(calls.find((call) => call.path.endsWith('/plan'))?.body?.files).toEqual([{ id: 'file-1', path: 'models/renamed-tray.stl', include: true }]));
});

const groupedPlan: ImportPlan = {
  ...plan,
  files: [
    ...plan.files,
    { ...plan.files[0], id: 'os-file', originalPath: '__MACOSX/._tray.stl', path: 'models/__MACOSX/._tray.stl', include: false },
  ],
};

it('groups editable selections and moves files between sections without losing saved selection edits', async () => {
  const { calls } = setup({ prepared: true, plan: groupedPlan });
  await open();
  const included = () => screen.getByRole('region', { name: 'Included files' });
  const excluded = () => screen.getByRole('region', { name: 'Excluded files' });
  expect(within(included()).getByRole('heading', { name: 'Included (1)' })).toBeTruthy();
  expect(within(excluded()).getByRole('heading', { name: 'Excluded (1)' })).toBeTruthy();
  expect(within(excluded()).queryByLabelText('Proposed path for __MACOSX/._tray.stl')).toBeNull();
  fireEvent.click(within(excluded()).getByRole('checkbox', { name: 'Include __MACOSX/._tray.stl' }));
  expect(within(included()).getByRole('heading', { name: 'Included (2)' })).toBeTruthy();
  expect(within(included()).getByLabelText('Proposed path for __MACOSX/._tray.stl')).toBeTruthy();
  expect(within(excluded()).getByText('No excluded files.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await waitFor(() => expect(calls.find((call) => call.path.endsWith('/plan'))?.body?.files).toEqual([
    { id: 'file-1', path: 'models/tray.stl', include: true },
    { id: 'os-file', path: 'models/__MACOSX/._tray.stl', include: true },
  ]));
  fireEvent.click(within(included()).getByRole('checkbox', { name: 'Include __MACOSX/._tray.stl' }));
  expect(within(excluded()).getByRole('heading', { name: 'Excluded (1)' })).toBeTruthy();
  expect(within(excluded()).getByRole('checkbox', { name: 'Include __MACOSX/._tray.stl' })).toHaveProperty('checked', false);
  expect(screen.getByText('Unsaved changes. Save plan before publishing.')).toBeTruthy();
});

it('separates included and excluded files in the read-only published plan without per-file status descriptors', async () => {
  setup({ prepared: true, plan: groupedPlan, status: 'imported' });
  await open();
  const published = within(screen.getByRole('region', { name: 'Published plan' }));
  const included = within(published.getByRole('region', { name: 'Included files' }));
  const excluded = within(published.getByRole('region', { name: 'Excluded files' }));
  expect(included.getByText('tray.stl')).toBeTruthy();
  expect(included.getByText('→ models/tray.stl')).toBeTruthy();
  expect(excluded.getByText('__MACOSX/._tray.stl')).toBeTruthy();
  expect(excluded.queryByText(/→/)).toBeNull();
  expect(published.queryByText(/· Included|· Excluded/)).toBeNull();
  expect(published.queryByRole('checkbox')).toBeNull();
});
