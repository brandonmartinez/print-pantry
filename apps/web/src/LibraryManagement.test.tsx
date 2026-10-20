import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryManagementResponse, LibraryMigrationJob, LibraryReorganizationPlan } from '@print-pantry/contracts';
import { LibraryManagement } from './LibraryManagement.js';

const inventory: LibraryManagementResponse = {
  items: [
    { id: '9007199254740993', name: 'Legacy holder', storageKind: 'legacy', relativePath: 'Tools/Holder',
      category: 'Tools', available: true, fileCount: 1, sizeBytes: '2048', sourceCount: 1 },
    { id: '42', name: 'Managed tray', storageKind: 'managed', relativePath: 'projects/42-managed_tray',
      category: null, available: true, fileCount: 2, sizeBytes: '4096', sourceCount: 0 },
  ], total: 2, page: 1, pageSize: 50, summary: { legacy: 1, managed: 1, missing: 0 }, plans: [],
};
const plan: LibraryReorganizationPlan = {
  id: 'saved-plan', createdAt: '2026-10-19T00:00:00Z', kind: 'dry_run', fingerprint: 'fingerprint',
  additionalBytes: '9007199254740993', availableBytes: '9223372036854775807',
  issues: [{ severity: 'warning', code: 'verification_required', relativePath: null, message: 'Indexed hashes require fresh verification.' }],
  projects: [{
    ...inventory.items[0], destinationPath: 'projects/9007199254740993-legacy_holder',
    metadata: { categoryId: null, description: 'Keep description', tags: ['keep'], designer: null, sourceUrl: null, license: null, notes: null },
    directories: ['models'], checkedFiles: 1, inspectionComplete: true, issues: [],
    files: [{ id: 'asset-1', versionId: 'version-1', sourcePath: 'Tools/Holder/models/part.stl',
      destinationPath: 'models/part.stl', contentHash: 'known-indexed-hash', sizeBytes: '2048' }],
  }],
};
function Location() { return <output data-testid="location">{useLocation().search}</output>; }
const initialJob: LibraryMigrationJob = {
  id: 'migration-job', planId: plan.id, status: 'active', revision: 0, createdAt: plan.createdAt, updatedAt: plan.createdAt,
  projects: [{ projectId: plan.projects[0].id, name: plan.projects[0].name, status: 'pending',
    legacyPath: plan.projects[0].relativePath, managedPath: plan.projects[0].destinationPath, lastError: null }],
};
function setup(options: { initial?: string; data?: LibraryManagementResponse; saved?: LibraryReorganizationPlan; failPreview?: boolean; failLoad?: boolean; failMigration?: boolean } = {}) {
  let data = structuredClone(options.data ?? inventory);
  let saved = structuredClone(options.saved ?? plan);
  let job = saved.migration ?? structuredClone(initialJob);
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/library/legacy-scan') return { configured: false, scan: { state: 'never', lastError: null, errors: [] } };
    if (path === '/api/library/adoptions') return { runs: [] };
    if (path.includes('/migrations/')) {
      if (init?.method === 'POST') {
        if (options.failMigration) {
          job = { ...job, revision: job.revision + 1, projects: job.projects.map((item) => ({ ...item, status: 'copying', lastError: 'Disk full; retry after freeing space' })) };
          throw new Error('Migration stopped: disk full');
        }
        const body = JSON.parse(init.body as string);
        job = { ...job, revision: job.revision + 1,
          status: path.endsWith('/cancel') ? 'canceled' : body.action === 'activate' || body.action === 'restore' ? 'completed' : 'active',
          projects: job.projects.map((item) => ({ ...item, lastError: null,
            status: path.endsWith('/cancel') ? 'canceled' : body.action === 'copy' ? 'copied' : body.action === 'activate' ? 'activated' : 'restored' })),
        };
      }
      saved = { ...saved, migration: job };
      return job;
    }
    if (path.endsWith('/migrate')) { saved = { ...saved, migration: job }; return job; }
    if (init?.method === 'POST') {
      if (options.failPreview) throw new Error('Wait for the library scan to finish');
      data = { ...data, plans: [{ id: plan.id, createdAt: plan.createdAt, projectCount: 1 }] };
      return plan;
    }
    if (path.includes('/reorganization-plans/')) return saved;
    if (options.failLoad) throw new Error('Library database unavailable');
    const query = new URL(path, 'http://localhost').searchParams;
    return { ...data, page: Number(query.get('page') ?? 1) };
  });
  async function transport<T>(path: string, init?: RequestInit): Promise<T> { return await request(path, init) as T; }
  render(<MemoryRouter initialEntries={[options.initial ?? '/manage-library']}><LibraryManagement request={transport} /><Location /></MemoryRouter>);
  return request;
}
afterEach(cleanup);
it('keeps source recovery and boundary actions in explicit legacy migration tools', async () => {
  const request = setup();
  await screen.findByText('Legacy holder');
  expect(screen.queryByRole('link', { name: 'Open project / manage sources' })?.getAttribute('href')).toBe('/projects/42');
  fireEvent.click(screen.getByRole('button', { name: 'Show migration tools' }));
  fireEvent.click(screen.getByRole('button', { name: 'Set project boundary' }));
  await screen.findByText(/Boundary saved/);
  expect(request).toHaveBeenCalledWith('/api/library/legacy-boundaries', {
    method: 'PUT', body: JSON.stringify({ projectId: '9007199254740993', isBoundary: true }),
  });
});

it('lists storage kinds without scanning, auto-selecting projects, or permitting managed-project migration', async () => {
  const request = setup();
  await screen.findByText('1 legacy projects · 1 managed projects · 0 catalog projects marked missing');
  expect(screen.getByRole('button', { name: 'Preview reorganization (0)' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', { name: 'Select Legacy holder' })).toHaveProperty('checked', false);
  expect(screen.getByRole('checkbox', { name: 'Select Managed tray' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/No files are copied, renamed, deleted, or activated/)).toBeTruthy();
  expect(request.mock.calls.every(([path, init]) => (path.startsWith('/api/library/management?') || path === '/api/library/adoptions' || path === '/api/library/legacy-scan') && !init?.method)).toBe(true);
});

it('previews only selected decimal-string IDs, persists the URL, and never calls an activation endpoint', async () => {
  const request = setup();
  await screen.findByRole('checkbox', { name: 'Select Legacy holder' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Legacy holder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview reorganization (1)' }));
  await screen.findByRole('heading', { name: 'Saved reorganization preview' });
  expect(request).toHaveBeenCalledWith('/api/library/reorganization-plans', {
    method: 'POST', body: JSON.stringify({ projectIds: ['9007199254740993'] }),
  });
  expect(screen.getByTestId('location').textContent).toBe('?plan=saved-plan');
  expect(screen.getByTitle('9,007,199,254,740,993 bytes').textContent).toBe('8 PB');
  expect(screen.getByTitle('9,223,372,036,854,775,807 bytes').textContent).toBe('8 EB');
  expect(screen.getByText('projects/9007199254740993-legacy_holder')).toBeTruthy();
  fireEvent.click(screen.getByText('Files (1)'));
  const technical = screen.getByText('Technical details').closest('details')!;
  expect(technical.open).toBe(false);
  fireEvent.click(within(technical).getByText('Technical details'));
  expect(technical.open).toBe(true);
  expect(within(technical).getByText('version-1')).toBeTruthy();
  expect(within(technical).getByText('known-indexed-hash')).toBeTruthy();
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /activate|copy files|migrate now/i })).toBeNull();
});

it('restores a bookmarked saved plan with explicit blockers and inspection completeness', async () => {
  setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, projects: [{ ...plan.projects[0], inspectionComplete: false,
      issues: [{ severity: 'blocker', code: 'missing_file', relativePath: 'models/part.stl', message: 'Indexed file was not found.' }] }],
  } });
  await screen.findByRole('heading', { name: 'Saved reorganization preview' });
  expect(within(screen.getByRole('article', { name: 'Legacy holder preview' })).getByText('Blocked')).toBeTruthy();
  expect(screen.getByText('Indexed file was not found.', { exact: false })).toBeTruthy();
  expect(screen.getByText(/Snapshot from.*it can become stale/)).toBeTruthy();
});

it('shows separate folder boxes, compact relative file paths, and closed technical details by default', async () => {
  setup({ initial: '/manage-library?plan=saved-plan' });
  const project = await screen.findByRole('article', { name: 'Legacy holder preview' });
  const view = within(project);
  expect(view.getByText('Current folder').parentElement?.textContent).toContain('Tools/Holder');
  expect(view.getByText('Proposed folder').parentElement?.textContent).toContain('projects/9007199254740993-legacy_holder');
  expect(view.getByText('1 of 1')).toBeTruthy();
  expect(view.getByText('Inspection complete')).toBeTruthy();
  expect(screen.getByText('Preview only · No files moved')).toBeTruthy();
  expect(screen.getByText(/File contents have not been rehashed/)).toBeTruthy();
  const files = view.getByText('Files (1)').closest('details')!;
  expect(files.open).toBe(false);
  fireEvent.click(view.getByText('Files (1)'));
  expect(files.open).toBe(true);
  const file = within(files).getByText('models/part.stl').closest('li')!;
  expect(within(file).getByTitle('2,048 bytes').textContent).toBe('2 KB');
  expect(file.querySelector('.library-file-overview')?.textContent).not.toContain('Tools/Holder');
  for (const value of ['asset-1', 'version-1', 'known-indexed-hash', 'Tools/Holder/models/part.stl']) {
    const detail = within(file).getByText(value).closest('details')!;
    expect(detail.open).toBe(false);
    expect(detail.className).toBe('library-technical-details');
  }
  const projectTechnical = view.getByText('Project technical details').closest('details')!;
  expect(projectTechnical.open).toBe(false);
  expect(within(projectTechnical).getByText('9007199254740993')).toBeTruthy();
  const snapshotTechnical = screen.getByText('Snapshot technical details').closest('details')!;
  expect(snapshotTechnical.open).toBe(false);
  expect(within(snapshotTechnical).getByText('9,007,199,254,740,993 bytes')).toBeTruthy();
});

it('displays differing relative paths without hiding a proposed file rename', async () => {
  setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, projects: [{ ...plan.projects[0], files: [{ ...plan.projects[0].files[0], destinationPath: 'models/renamed.stl' }] }],
  } });
  const project = await screen.findByRole('article', { name: 'Legacy holder preview' });
  fireEvent.click(within(project).getByText('Files (1)'));
  const file = within(project).getByText('models/renamed.stl').closest('li')!;
  expect(within(file).getByText('Current path')).toBeTruthy();
  expect(within(file).getByText('models/part.stl')).toBeTruthy();
  expect(within(file).getByText('Proposed path')).toBeTruthy();
});

it.each([
  { complete: true, status: 'Inspection complete' },
  { complete: false, status: 'Inspection incomplete' },
])('keeps advisory source notes separate from blockers when inspection is $complete', async ({ complete, status }) => {
  setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, availableBytes: null, projects: [{ ...plan.projects[0], sourceCount: 0, inspectionComplete: complete,
      issues: [{ severity: 'warning', code: 'source_recovery', relativePath: null, message: 'Review source associations before migration.' }] }],
  } });
  const project = await screen.findByRole('article', { name: 'Legacy holder preview' });
  const view = within(project);
  expect(view.getByText(status)).toBeTruthy();
  expect(view.getByRole('region', { name: 'Notes (1)' }).textContent).toContain('Review source associations');
  expect(view.queryByRole('region', { name: /Blockers/ })).toBeNull();
  expect(view.queryByText('Blocked')).toBeNull();
  expect(view.getByText(/Review sources using the inventory migration tools/)).toBeTruthy();
  expect(view.queryByRole('link', { name: 'Review sources' })).toBeNull();
  const available = screen.getByText('Available managed storage').parentElement!;
  expect(within(available).getByText('Unknown')).toBeTruthy();
});

it('makes batch-wide blockers visible on every affected project even when its file inspection completed', async () => {
  setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, issues: [...plan.issues, { severity: 'blocker', code: 'managed_unavailable', relativePath: null, message: 'Managed storage is offline.' }],
  } });
  const project = await screen.findByRole('article', { name: 'Legacy holder preview' });
  expect(within(project).getByText('Blocked')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Blockers (1)' }).textContent).toContain('Managed storage is offline');
  expect(screen.getByRole('region', { name: 'Notes (1)' }).textContent).toContain('indexed evidence');
});

it('formats zero, byte/unit boundaries, and large totals while retaining exact decimal byte evidence', async () => {
  const cases = [
    ['0', '0 B'], ['1023', '1,023 B'], ['1024', '1 KB'], ['13200', '12.9 KB'],
    ['1048576', '1 MB'], ['9007199254740993', '8 PB'],
  ];
  setup({ data: { ...inventory, items: cases.map(([size], index) => ({
    ...inventory.items[0], id: String(index + 1), name: `Size sample ${index}`, sizeBytes: size,
  })) } });
  await screen.findByRole('checkbox', { name: 'Select Size sample 0' });
  for (const [index, [size, label]] of cases.entries()) {
    const row = screen.getByRole('checkbox', { name: `Select Size sample ${index}` }).closest('li')!;
    expect(within(row).getByTitle(`${BigInt(size).toLocaleString()} bytes`).textContent).toBe(label);
  }
});

it('caps selection at exactly 25 projects and keeps selections across search and pagination', async () => {
  const many = { ...inventory, items: Array.from({ length: 26 }, (_, i) => ({
    ...inventory.items[0], id: String(i + 1), name: `Legacy ${i + 1}`,
  })), total: 51 };
  const request = setup({ data: many });
  await screen.findByRole('checkbox', { name: 'Select Legacy 1' });
  for (let i = 1; i <= 25; i++) fireEvent.click(screen.getByRole('checkbox', { name: `Select Legacy ${i}` }));
  expect(screen.getByRole('checkbox', { name: 'Select Legacy 26' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Preview reorganization (25)' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search library management' }), { target: { value: 'holder' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('q=holder'))).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Page 2 of 2 · 51 projects');
  expect(screen.getByRole('button', { name: 'Preview reorganization (25)' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(screen.getByRole('button', { name: 'Preview reorganization (0)' })).toHaveProperty('disabled', true);
});

it('surfaces failed previews without showing a successful or activated plan', async () => {
  setup({ failPreview: true });
  await screen.findByRole('checkbox', { name: 'Select Legacy holder' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Legacy holder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview reorganization (1)' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Wait for the library scan');
  expect(screen.queryByRole('heading', { name: 'Saved reorganization preview' })).toBeNull();
});

it('surfaces inventory load failures and provides an explicit refresh', async () => {
  const request = setup({ failLoad: true });
  expect((await screen.findByRole('alert')).textContent).toContain('Library database unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path.startsWith('/api/library/management?'))).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Preview reorganization (0)' })).toBeNull();
});

it('requires two unchecked acknowledgements, approves only, then copies and activates with confirmation', async () => {
  const request = setup({ initial: '/manage-library?plan=saved-plan' });
  const approve = await screen.findByRole('button', { name: 'Approve migration' });
  const retained = screen.getByRole('checkbox', { name: /current backup/ });
  const reviewed = screen.getByRole('checkbox', { name: /reviewed the preview/ });
  expect(retained).toHaveProperty('checked', false);
  expect(reviewed).toHaveProperty('checked', false);
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(retained);
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(reviewed);
  fireEvent.click(approve);
  await screen.findByText('Awaiting copy');
  expect(request).toHaveBeenCalledWith('/api/library/reorganization-plans/saved-plan/migrate', { method: 'POST', body: JSON.stringify({
    expectedFingerprint: plan.fingerprint, confirmRetainedCopies: true, acknowledgeWarnings: true,
  }) });
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify' }));
  await screen.findByText('Copy verified; awaiting activation');
  expect(request).toHaveBeenCalledWith(`/api/library/migrations/migration-job/projects/${plan.projects[0].id}`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: 0, action: 'copy' }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Activate managed copy' }));
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm activation' }));
  await screen.findByText('Managed copy active');
  expect(request).toHaveBeenCalledWith(`/api/library/migrations/migration-job/projects/${plan.projects[0].id}`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: 1, action: 'activate' }),
  });
  expect(screen.queryByText('Preview only · No files moved')).toBeNull();
});

it('never enables approval for blocked or incomplete saved previews', async () => {
  const request = setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, projects: [{ ...plan.projects[0], inspectionComplete: false }],
  } });
  expect(await screen.findByRole('button', { name: 'Approve migration' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', { name: /current backup/ })).toHaveProperty('disabled', true);
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('reloads saved progress without restarting work and retries using the refreshed revision after a failure', async () => {
  const request = setup({ initial: '/manage-library?plan=saved-plan', saved: { ...plan, migration: initialJob }, failMigration: true });
  await screen.findByText('Awaiting copy');
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify' }));
  await screen.findByText('Migration stopped: disk full');
  expect(await screen.findByText('Disk full; retry after freeing space')).toBeTruthy();
  expect(screen.getByText('Copy interrupted or in progress')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry copy and verify' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/api/library/migrations/migration-job/projects/${plan.projects[0].id}`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: 1, action: 'copy' }),
  }));
});

it('requires cancellation confirmation and does not resume canceled work', async () => {
  const request = setup({ initial: '/manage-library?plan=saved-plan', saved: { ...plan, migration: initialJob } });
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel remaining migration' }));
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
  await screen.findByText('Canceled; source retained');
  expect(screen.queryByRole('button', { name: 'Copy and verify' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve migration' })).toBeNull();
  expect(request).toHaveBeenCalledWith('/api/library/migrations/migration-job/cancel', { method: 'POST', body: '{"expectedRevision":0}' });
});

it('requires confirmation to restore an activated project even when remaining work was canceled', async () => {
  const job: LibraryMigrationJob = { ...initialJob, status: 'canceled', revision: 7,
    projects: initialJob.projects.map((item) => ({ ...item, status: 'activated' })) };
  const request = setup({ initial: '/manage-library?plan=saved-plan', saved: { ...plan, migration: job } });
  fireEvent.click(await screen.findByRole('button', { name: 'Restore legacy location' }));
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restoration' }));
  await screen.findByText('Legacy restored; hidden from live library');
  expect(request).toHaveBeenCalledWith(`/api/library/migrations/migration-job/projects/${plan.projects[0].id}`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: 7, action: 'restore' }),
  });
});
