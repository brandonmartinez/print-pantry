import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceDiscoveryPreview } from '@print-pantry/contracts';
import { SourceDiscovery } from './SourceDiscovery.js';

const preview: SourceDiscoveryPreview = {
  id: 'preview-1', projectId: '42', projectName: 'Existing holder', createdAt: '2026-10-19T00:00:00Z',
  appliedAt: null, approvedCandidateIds: [],
  candidates: [{
    id: 'candidate-1', source: {
      url: 'https://makerworld.com/en/models/123#profileId-456', canonicalUrl: 'https://makerworld.com/en/models/123',
      key: 'makerworld:model:123', provider: 'makerworld', modelId: '123', profileId: '456',
    }, alreadyAssociated: false, conflicting: true,
    evidence: [{ relativePath: 'Legacy/Holder/variants/model.webloc', url: 'https://makerworld.com/en/models/123#profileId-456', profileId: '456', hash: 'hash' }],
  }, {
    id: 'candidate-2', source: {
      url: 'https://makerworld.com/en/models/789', canonicalUrl: 'https://makerworld.com/en/models/789',
      key: 'makerworld:model:789', provider: 'makerworld', modelId: '789', profileId: null,
    }, alreadyAssociated: false, conflicting: true,
    evidence: [{ relativePath: null, url: 'https://makerworld.com/en/models/789', profileId: null, hash: null }],
  }],
  issues: [{ relativePath: 'Legacy/Holder/broken.webloc', message: 'Malformed XML webloc' }],
};

function setup(options: { persisted?: SourceDiscoveryPreview; failApproval?: boolean } = {}) {
  let latest: SourceDiscoveryPreview | null = options.persisted ?? null;
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (!init?.method) return { preview: latest };
    if (path.endsWith('/apply')) {
      if (options.failApproval) throw new Error('Source evidence changed after discovery; discover again before approving');
      latest = { ...latest!, appliedAt: '2026-10-19T01:00:00Z', approvedCandidateIds: JSON.parse(String(init.body)).candidateIds };
    } else latest = structuredClone(preview);
    return latest;
  });
  async function transport<T>(path: string, init?: RequestInit): Promise<T> {
    return await request(path, init) as T;
  }
  render(<SourceDiscovery projectId="42" request={transport} />);
  return request;
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Manage sources' }));
  await waitFor(() => expect(screen.queryByText('Working on source discovery…')).toBeNull());
}
afterEach(cleanup);

it('loads a persisted preview only on operator interaction and discovers without applying automatically', async () => {
  const request = setup();
  expect(request).not.toHaveBeenCalled();
  await open();
  expect(request).toHaveBeenCalledWith('/api/catalog/projects/42/source-discovery', undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Discover existing sources' }));
  await screen.findByRole('button', { name: 'Discover again' });
  expect(screen.getByRole('button', { name: 'Approve selected associations (0)' })).toHaveProperty('disabled', true);
  expect(screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
  expect(screen.getByText(/broken.webloc: Malformed XML/)).toBeTruthy();
  expect(screen.getAllByText(/Conflicting model identities/)).toHaveLength(2);
  expect(screen.getByText(/variants\/model.webloc.*profile 456/)).toBeTruthy();
  expect(request.mock.calls.some(([path]) => path.endsWith('/apply'))).toBe(false);
});

it('approves only explicitly selected candidates and locks the completed preview', async () => {
  const request = setup({ persisted: preview });
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: 'https://makerworld.com/en/models/123' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected associations (1)' }));
  await screen.findByText('Approved source associations saved. Existing display metadata was not changed.');
  expect(request).toHaveBeenLastCalledWith('/api/catalog/projects/42/source-discovery/preview-1/apply', {
    method: 'POST', body: JSON.stringify({ candidateIds: ['candidate-1'] }),
  });
  expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull();
  expect(screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled)).toBe(true);
});

it('restores prior approvals and indicates associations already present without offering destructive removal', async () => {
  setup({ persisted: {
    ...preview, appliedAt: '2026-10-19T01:00:00Z', approvedCandidateIds: ['candidate-1'],
    candidates: preview.candidates.map((candidate) => ({ ...candidate, alreadyAssociated: true })),
  } });
  await open();
  const region = within(screen.getByRole('region', { name: 'Project source recovery' }));
  expect(region.getAllByText(/Already associated/)).toHaveLength(2);
  expect(region.queryByRole('button', { name: /Approve selected/ })).toBeNull();
  expect(region.getByRole('checkbox', { name: 'https://makerworld.com/en/models/123' })).toHaveProperty('checked', true);
});

it('surfaces stale evidence and requires rediscovery before retrying approval', async () => {
  const request = setup({ persisted: preview, failApproval: true });
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: 'https://makerworld.com/en/models/123' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected associations (1)' }));
  expect((await screen.findByRole('alert')).textContent).toContain('discover again before approving');
  expect(request.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Discover again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByRole('button', { name: 'Approve selected associations (0)' })).toHaveProperty('disabled', true);
});
