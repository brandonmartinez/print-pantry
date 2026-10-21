import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyImportEntry, LegacyImportSession } from '@print-pantry/contracts';
import { LibraryImport } from './LibraryImport.js';

function fixture(saved = false, multiple = false, failPlan = false, failLoad = false) {
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
    if (path.endsWith('/edit')) session = { ...session, projects: session.projects.map((project) => project.key === body.key ? { ...project, name: body.name.trim(), category: body.category, files: project.files.map((entry) => ({ ...entry, path: body.paths.find((item: { id: string }) => item.id === entry.id).path })) } : project) };
    if (path.endsWith('/organize')) session = { ...session, state: 'organized', projects: session.projects.map((project) => ({ ...project, status: 'organized' })) };
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

  it('filters the source tree without changing saved selections', async () => {
    const request = fixture(true);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find folders or files' }), { target: { value: 'part.STL' } });
    expect(await screen.findByText('part.STL')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Import Tools/Holder' }) as HTMLInputElement).checked).toBe(true);
    expect(request.mock.calls.some(([path]) => path.endsWith('/selection'))).toBe(false);
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