import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryManagementResponse, LibraryReorganizationPlan } from '@print-pantry/contracts';
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
function setup(options: { initial?: string; data?: LibraryManagementResponse; saved?: LibraryReorganizationPlan; failPreview?: boolean; failLoad?: boolean } = {}) {
  let data = structuredClone(options.data ?? inventory);
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (options.failPreview) throw new Error('Wait for the library scan to finish');
      data = { ...data, plans: [{ id: plan.id, createdAt: plan.createdAt, projectCount: 1 }] };
      return plan;
    }
    if (path.includes('/reorganization-plans/')) return options.saved ?? plan;
    if (options.failLoad) throw new Error('Library database unavailable');
    const query = new URL(path, 'http://localhost').searchParams;
    return { ...data, page: Number(query.get('page') ?? 1) };
  });
  async function transport<T>(path: string, init?: RequestInit): Promise<T> { return await request(path, init) as T; }
  render(<MemoryRouter initialEntries={[options.initial ?? '/manage-library']}><LibraryManagement request={transport} /><Location /></MemoryRouter>);
  return request;
}
afterEach(cleanup);

it('lists storage kinds without scanning, auto-selecting projects, or permitting managed-project migration', async () => {
  const request = setup();
  await screen.findByText('1 legacy projects · 1 managed projects · 0 catalog projects marked missing');
  expect(screen.getByRole('button', { name: 'Preview reorganization (0)' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', { name: 'Select Legacy holder' })).toHaveProperty('checked', false);
  expect(screen.getByRole('checkbox', { name: 'Select Managed tray' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/No files are copied, renamed, deleted, or activated/)).toBeTruthy();
  expect(request.mock.calls.every(([path, init]) => path.startsWith('/api/library/management?') && !init?.method)).toBe(true);
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
  expect(screen.getByText('9,007,199,254,740,993 bytes')).toBeTruthy();
  expect(screen.getByText('9,223,372,036,854,775,807 bytes')).toBeTruthy();
  expect(screen.getByText('projects/9007199254740993-legacy_holder')).toBeTruthy();
  fireEvent.click(screen.getByText('File mappings (1)'));
  expect(screen.getByText(/Version version-1.*known-indexed-hash/)).toBeTruthy();
  expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /activate|copy files|migrate now/i })).toBeNull();
});

it('restores a bookmarked saved plan with explicit blockers and inspection completeness', async () => {
  setup({ initial: '/manage-library?plan=saved-plan', saved: {
    ...plan, projects: [{ ...plan.projects[0], inspectionComplete: false,
      issues: [{ severity: 'blocker', code: 'missing_file', relativePath: 'models/part.stl', message: 'Indexed file was not found.' }] }],
  } });
  await screen.findByRole('heading', { name: 'Saved reorganization preview' });
  expect(screen.getByText(/Directory inspection incomplete.*Blocked/)).toBeTruthy();
  expect(screen.getByText('Indexed file was not found.', { exact: false })).toBeTruthy();
  expect(screen.getByText(/Snapshot from.*it can become stale/)).toBeTruthy();
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
  await waitFor(() => expect(request.mock.calls).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Preview reorganization (0)' })).toBeNull();
});
