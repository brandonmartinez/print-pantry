import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyImportEntry, LegacyImportSession } from '@print-pantry/contracts';
import { LibraryImport } from './LibraryImport.js';

function fixture(saved = false, multiple = false, failPlan = false, failLoad = false, proposalMode?: 'changed' | 'unchanged') {
  const file: LegacyImportEntry = { path: 'Tools/Holder/part.STL', name: 'part.STL', kind: 'file', fileCount: 1, modelCount: 1, sizeBytes: 12, suggested: false, evidence: [], children: [] };
  const holder: LegacyImportEntry = { ...file, path: 'Tools/Holder', name: 'Holder', kind: 'directory', suggested: true, children: [file] };
  const tools: LegacyImportEntry = { ...holder, path: 'Tools', name: 'Tools', suggested: false, children: [holder] };
  const tree = { ...tools, path: '', name: 'Legacy library', children: [tools] };
  let session: LegacyImportSession = { id: 'd9e0bd8a-3a04-4dcc-b6f9-8503b2b25f44', revision: 0, state: 'selecting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tree, selectedRoots: saved ? ['Tools/Holder'] : [], layout: 'standardize', projects: [], issues: [], lastError: null };
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (failLoad && path.endsWith(session.id)) { failLoad = false; throw new Error('Service unavailable'); }
    if (path === '/api/library/imports' && !init?.method) return { configured: true, sessions: [] };
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/plan') && failPlan) throw new Error('The source changed. Start another import.');
    if (path.endsWith('/selection')) session = { ...session, selectedRoots: body.roots, layout: body.layout, state: 'selecting', projects: [] };
    if (path.endsWith('/plan')) session = { ...session, state: 'planned', projects: [{ key: 'holder', sourcePath: 'Tools/Holder', name: 'Holder', category: 'Tools', linked: false, status: 'planned', directories: [], files: [{ id: 'part', originalPath: 'part.STL', path: 'models/part.stl', size: 12, hash: null }], warnings: [], blockers: [] }] };
    if (path.endsWith('/plan') && multiple) session.projects.push({ ...structuredClone(session.projects[0]), key: 'tray', sourcePath: 'Tools/Tray', name: 'Tray' });
    if (path.endsWith('/plan') && proposalMode) {
      session.projects = session.projects.map((project) => ({ ...project, files: [
        { ...project.files[0], id: `${project.key}-part` },
        { id: `${project.key}-readme`, originalPath: 'README.md', path: 'README.md', size: 10, hash: null },
      ] }));
      session.aiProposal = { requestId: 'proposal', provider: 'Test provider', model: 'test-model', createdAt: '', imageCount: 0, error: null, status: 'ready',
        projects: session.projects.map((project) => ({ key: project.key, name: proposalMode === 'changed' ? `AI ${project.name}` : project.name, category: project.category,
          paths: project.files.map(({ id, path }) => ({ id, path: proposalMode === 'changed' && path.endsWith('.stl') ? `models/AI ${project.name}.stl` : path })),
        })),
      };
    }
    if (path.endsWith('/edit')) session = { ...session, projects: session.projects.map((project) => project.key === body.key ? { ...project, name: body.name.trim(), category: body.category, files: project.files.map((entry) => ({ ...entry, path: body.paths.find((item: { id: string }) => item.id === entry.id).path })) } : project) };
    if (path.endsWith('/organize')) session = { ...session, state: 'organized', projects: session.projects.map((project) => ({ ...project, status: 'organized' })) };
    if (path.endsWith('/ai/apply') && session.aiProposal) {
      const proposal = session.aiProposal;
      session = { ...session, aiProposal: { ...proposal, status: 'applied' }, projects: session.projects.map((project) => {
        const proposed = proposal.projects.find((item) => item.key === project.key)!;
        return { ...project, ...(body.selection.metadataKeys.includes(project.key) ? { name: proposed.name, category: proposed.category } : {}),
          files: project.files.map((file) => body.selection.fileIds.includes(file.id) ? { ...file, path: proposed.paths.find((item) => item.id === file.id)!.path } : file) };
      }) };
    }
    if (init?.method === 'POST') session = { ...session, revision: session.revision + 1 };
    return structuredClone(session);
  });
  async function transport<T>(path: string, init?: RequestInit): Promise<T> { return await request(path, init) as T; }
  render(<MemoryRouter initialEntries={[saved ? `/import-library?session=${session.id}` : '/import-library']}><LibraryImport request={transport} /></MemoryRouter>);
  return request;
}

afterEach(cleanup);

describe('guided legacy library import', () => {
  it('discovers only on request and saves selected project roots before planning', async () => {
    const request = fixture();
    fireEvent.click(await screen.findByRole('button', { name: 'Browse folders' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Tools' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Tools/Holder' }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Import Tools/Holder' }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Review organization' }));
    expect((await screen.findByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false);
    expect(request.mock.calls.some(([path]) => path.endsWith('/organize'))).toBe(false);
  });

  it('requires confirmation before replacing selected children with their parent', async () => {
    const request = fixture(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Import Tools' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(request.mock.calls.some(([path]) => path.endsWith('/selection'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Select parent instead' }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Import Tools' }) as HTMLInputElement).checked).toBe(true));
  });

  it('saves editable organization before preparing staged files, without publishing', async () => {
    const request = fixture(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Project name for Tools/Holder' }), { target: { value: 'Desk holder' } });
    expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh import' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare files' }));
    expect(await screen.findByRole('heading', { name: 'Files organized' })).toBeTruthy();
    expect(screen.getByText(/live library is unchanged/)).toBeTruthy();
    expect(request.mock.calls.some(([path]) => /activate|publish|migrate/.test(path))).toBe(false);
  });

  it('locks preparation and manual edits while a provider request is pending', async () => {
    const request = fixture(true);
    const original = request.getMockImplementation()!;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    request.mockImplementation(async (path, init) => {
      if (path === '/api/admin/ai') return { revision: 1, encryptedStorageReady: true, defaultProviderId: 'provider', providers: [{ id: 'provider', name: 'Test provider', model: 'test-model', hasCredential: true }] } as unknown as LegacyImportSession;
      if (path.endsWith('/ai')) {
        await pending;
        return original(path.slice(0, -3));
      }
      return original(path, init);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    fireEvent.click(await screen.findByRole('button', { name: 'AI organization' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'I approve sending this inventory and attached renders.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate proposal' }));
    for (const name of ['Prepare files', 'Refresh import', 'Choose projects']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('textbox', { name: 'Project name for Tools/Holder' }) as HTMLInputElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('textbox', { name: 'Project name for Tools/Holder' }) as HTMLInputElement).disabled).toBe(false);
    expect(request.mock.calls.some(([path]) => path.endsWith('/organize'))).toBe(false);
  });

  it('filters the source tree without changing saved selections', async () => {
    const request = fixture(true);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find folders or files' }), { target: { value: 'part.STL' } });
    expect(await screen.findByText('part.STL')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Import Tools/Holder' }) as HTMLInputElement).checked).toBe(true);
    expect(request.mock.calls.some(([path]) => path.endsWith('/selection'))).toBe(false);
  });

  it('shows only differing AI alternatives beside current destinations and applies a per-file choice', async () => {
    const request = fixture(true, true, false, false, 'changed');
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    const alternative = await screen.findByRole('radio', { name: 'Use AI destination for part.STL in Tools/Holder' });
    expect(screen.getAllByRole('columnheader', { name: 'AI alternative' })).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /Use AI destination for README/ })).toBeNull();
    expect((alternative as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Apply selected changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(alternative);
    expect((screen.getByRole('textbox', { name: 'Destination for part.STL in Tools/Holder' }) as HTMLInputElement).value).toBe('models/part.stl');
    expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(true);
    expect(request.mock.calls.some(([path]) => path.endsWith('/ai/apply'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Destination for part.STL in Tools/Holder' }) as HTMLInputElement).value).toBe('models/AI Holder.stl'));
    expect((screen.getByRole('textbox', { name: 'Destination for part.STL in Tools/Tray' }) as HTMLInputElement).value).toBe('models/part.stl');
    expect((screen.getByRole('textbox', { name: 'Project name for Tools/Holder' }) as HTMLInputElement).value).toBe('Holder');
    const [, init] = request.mock.calls.find(([path]) => path.endsWith('/ai/apply'))!;
    expect(JSON.parse(String(init?.body)).selection).toEqual({ fileIds: ['holder-part'], metadataKeys: [] });
  });

  it('selects all AI changes, clears them, and allows individual overrides before applying', async () => {
    const request = fixture(true, true, false, false, 'changed');
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all AI changes' }));
    for (const input of screen.getAllByRole('radio', { name: /Use AI destination/ })) expect((input as HTMLInputElement).checked).toBe(true);
    for (const input of screen.getAllByRole('checkbox', { name: /Use AI project details/ })) expect((input as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep all current' }));
    expect((screen.getByRole('button', { name: 'Apply selected changes' }) as HTMLButtonElement).disabled).toBe(true);
    for (const input of screen.getAllByRole('radio', { name: /Keep current destination/ })) expect((input as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select all AI changes' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Keep current destination for part.STL in Tools/Tray' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Project name for Tools/Holder' }) as HTMLInputElement).value).toBe('AI Holder'));
    const [, init] = request.mock.calls.find(([path]) => path.endsWith('/ai/apply'))!;
    expect(JSON.parse(String(init?.body)).selection).toEqual({ fileIds: ['holder-part'], metadataKeys: ['holder', 'tray'] });
    expect((screen.getByRole('textbox', { name: 'Destination for part.STL in Tools/Tray' }) as HTMLInputElement).value).toBe('models/part.stl');
  });

  it('shows a no-changes state without selectable alternatives for an identical proposal', async () => {
    fixture(true, false, false, false, 'unchanged');
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    expect(await screen.findByText('No AI changes.')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Use AI project details/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Select all AI changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains current destinations and choices after a mixed-selection conflict', async () => {
    const request = fixture(true, false, false, false, 'changed');
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (path, init) => {
      if (path.endsWith('/ai/apply')) throw new Error('The AI proposal conflicts with the current organization.');
      return original(path, init);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Use AI destination for part.STL in Tools/Holder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('conflicts');
    expect((screen.getByRole('radio', { name: 'Use AI destination for part.STL in Tools/Holder' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Destination for part.STL in Tools/Holder' }) as HTMLInputElement).value).toBe('models/part.stl');
    fireEvent.click(screen.getByRole('button', { name: 'Keep all current' }));
    expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains other unsaved projects when one project is saved and normalizes saved metadata', async () => {
    fixture(true, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Project name for Tools/Holder' }), { target: { value: ' Desk holder ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name for Tools/Tray' }), { target: { value: 'Desk tray' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Project name for Tools/Holder' }) as HTMLInputElement).value).toBe('Desk holder'));
    expect((screen.getByRole('textbox', { name: 'Project name for Tools/Tray' }) as HTMLInputElement).value).toBe('Desk tray');
    expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare files' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('keeps selected roots when planning fails and never starts preparation', async () => {
    const request = fixture(true, false, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Review organization' }));
    expect((await screen.findByRole('alert')).textContent).toContain('source changed');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Tools' }));
    expect((screen.getByRole('checkbox', { name: 'Import Tools/Holder' }) as HTMLInputElement).checked).toBe(true);
    expect(request.mock.calls.some(([path]) => path.endsWith('/organize'))).toBe(false);
  });

  it('retries an unavailable saved import without creating another session', async () => {
    const request = fixture(true, false, false, true);
    expect((await screen.findByRole('alert')).textContent).toContain('Service unavailable');
    expect(screen.queryByRole('button', { name: 'Browse folders' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading import' }));
    expect(await screen.findByRole('heading', { name: '1 project selected' })).toBeTruthy();
    expect(screen.getByText('0 files unselected')).toBeTruthy();
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});