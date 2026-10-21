import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { AiProviderProfile, LegacyImportSession, SiteAiSettings } from '@print-pantry/contracts';
import { AiSettings } from './AiSettings.js';
import { AiOrganization } from './AiOrganization.js';

afterEach(cleanup);
const profile: AiProviderProfile = { id: 'provider', kind: 'openai', name: 'Household', model: null, hasCredential: true,
  models: [{ id: 'account-model', name: 'Account model', vision: null }], modelsUpdatedAt: null, allowImages: false, supportsImages: false, maxInputChars: 40000, maxOutputTokens: 8000 };
const settings: SiteAiSettings = { revision: 2, encryptedStorageReady: true, providers: [profile], defaultProviderId: null };
const session: LegacyImportSession = { id: 'import-id', revision: 3, state: 'planned', createdAt: '', updatedAt: '',
  tree: { path: '', name: '', kind: 'directory', fileCount: 0, modelCount: 0, sizeBytes: 0, suggested: false, evidence: [], children: [] },
  selectedRoots: [], layout: 'standardize', projects: [], issues: [], lastError: null };

it('saves only editable provider fields, never retrieves or resends the saved credential', async () => {
  const calls = vi.fn(async (_path: string, init?: RequestInit) => init?.method ? { ...settings, revision: 3 } : settings);
  async function request<Result>(path: string, init?: RequestInit) { return await calls(path, init) as Result; }
  render(<MemoryRouter><AiSettings request={request} /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'account-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
  const body = JSON.parse(String(calls.mock.calls[1][1]?.body));
  expect(body.model).toBe('account-model');
  expect(body.credential).toBeUndefined();
  expect(body.hasCredential).toBeUndefined();
  expect(body.models).toBeUndefined();
  expect(body.allowImages).toBe(false);
});

it('does not save credentials when encrypted storage is unavailable', async () => {
  async function request<Result>() { return { ...settings, providers: [], encryptedStorageReady: false } as Result; }
  render(<MemoryRouter><AiSettings request={request} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Add provider' }) as HTMLButtonElement).disabled).toBe(true);
});

function Location() { const location = useLocation(); return <p>{location.pathname}{location.search}</p>; }
it('redirects an unconfigured import to settings while preserving the return session', async () => {
  async function request<Result>() { return settings as Result; }
  render(<MemoryRouter><Routes><Route path="/" element={<AiOrganization session={session} request={request} disabled={false} onSession={() => undefined} />} /><Route path="/settings/ai" element={<Location />} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'AI organization' }));
  expect(await screen.findByText('/settings/ai?returnTo=%2Fimport-library%3Fsession%3Dimport-id')).toBeTruthy();
});

it('requires explicit sharing consent and sends no images by default', async () => {
  const calls = vi.fn(async (path: string, init?: RequestInit) => !init?.method && path === '/api/admin/ai' ? { ...settings, defaultProviderId: profile.id, providers: [{ ...profile, model: 'account-model' }] } : session);
  async function request<Result>(path: string, init?: RequestInit) { return await calls(path, init) as Result; }
  render(<MemoryRouter><AiOrganization session={session} request={request} disabled={false} onSession={() => undefined} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'AI organization' }));
  const generate = await screen.findByRole('button', { name: 'Generate proposal' });
  expect((generate as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(generate);
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(calls.mock.calls[1][1]?.body)).images).toEqual([]);
  expect(JSON.parse(String(calls.mock.calls[1][1]?.body)).providerId).toBe(profile.id);
});

it('uses the chosen provider without changing site defaults and renews sharing consent when switching', async () => {
  const alternate = { ...profile, id: 'alternate', kind: 'copilot' as const, name: 'GitHub', model: 'copilot-model' };
  const calls = vi.fn(async (path: string, init?: RequestInit) => !init?.method && path === '/api/admin/ai' ? {
    ...settings, defaultProviderId: profile.id, providers: [{ ...profile, model: 'account-model' }, alternate],
  } : session);
  async function request<Result>(path: string, init?: RequestInit) { return await calls(path, init) as Result; }
  render(<MemoryRouter><AiOrganization session={session} request={request} disabled={false} onSession={() => undefined} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'AI organization' }));
  const provider = await screen.findByRole('combobox', { name: 'Proposal provider' });
  expect((provider as HTMLSelectElement).value).toBe(profile.id);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(provider, { target: { value: alternate.id } });
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: 'Generate proposal' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Generate proposal' }));
  await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(calls.mock.calls[1][1]?.body)).providerId).toBe(alternate.id);
  expect(calls.mock.calls[1][0]).toBe('/api/library/imports/import-id/ai');
});

it('shows saved proposal status without a duplicate tree or whole-proposal acceptance', async () => {
  const proposed: LegacyImportSession = { ...session, aiProposal: { requestId: 'request', provider: 'Household', model: 'account-model',
    createdAt: '', imageCount: 0, error: null, status: 'ready', projects: [{ key: 'project', name: 'Holder', category: 'Tools', paths: [{ id: 'file', path: 'models/Small/part.stl' }] }] } };
  const calls = vi.fn(async (_path: string, init?: RequestInit) => { expect(init?.method).toBe('POST'); return proposed; });
  async function request<Result>(path: string, init?: RequestInit) { return await calls(path, init) as Result; }
  const onSession = vi.fn();
  render(<MemoryRouter><AiOrganization session={proposed} request={request} disabled={false} onSession={onSession} /></MemoryRouter>);
  expect(screen.getByRole('region', { name: 'AI proposal' }).textContent).toContain('ready');
  expect(screen.queryByRole('list', { name: 'Proposed folder tree' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Accept proposal' })).toBeNull();
  expect(calls).not.toHaveBeenCalled();
});