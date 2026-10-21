import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { AiProviderProfile, AiProviderUpdate, SiteAiSettings } from '@print-pantry/contracts';

type Request = <Result>(path: string, init?: RequestInit) => Promise<Result>;
const defaults: AiProviderUpdate = { kind: 'openai', name: '', model: null, allowImages: false, supportsImages: false, maxInputChars: 40000, maxOutputTokens: 8000 };

function ProviderForm({ profile, busy, save, refresh, remove }: { profile?: AiProviderProfile; busy: boolean;
  save: (id: string, value: AiProviderUpdate) => Promise<void>; refresh: (id: string) => void; remove: (id: string) => void }) {
  const [id] = useState(() => profile?.id ?? crypto.randomUUID());
  const [value, setValue] = useState<AiProviderUpdate>(() => profile ? { kind: profile.kind, name: profile.name, model: profile.model,
    allowImages: profile.allowImages, supportsImages: profile.supportsImages, maxInputChars: profile.maxInputChars, maxOutputTokens: profile.maxOutputTokens } : { ...defaults });
  const [credential, setCredential] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = profile?.models.find((model) => model.id === value.model);
  return <form className="legacy-project ai-provider" onSubmit={(event) => {
    event.preventDefault();
    void save(id, { ...value, ...(credential ? { credential, model: null, allowImages: false } : {}) });
  }}>
    <h2>{profile?.name ?? 'Add provider'}</h2>
    <div className="legacy-metadata">
      <label>Name<input required maxLength={100} value={value.name} disabled={busy} onChange={(event) => setValue({ ...value, name: event.target.value })} /></label>
      <label>Provider<select value={value.kind} disabled={busy || Boolean(profile)} onChange={(event) => setValue({ ...value, kind: event.target.value as AiProviderUpdate['kind'] })}><option value="openai">OpenAI</option><option value="copilot">GitHub Copilot SDK</option></select></label>
      <label>{value.kind === 'openai' ? 'OpenAI API key' : 'GitHub token with Copilot access'}<input type="password" autoComplete="new-password" required={!profile} value={credential} disabled={busy} placeholder={profile?.hasCredential ? 'Stored securely; leave blank to keep' : ''} onChange={(event) => setCredential(event.target.value)} /></label>
      {profile && <label>Model<select value={value.model ?? ''} disabled={busy || Boolean(credential)} onChange={(event) => {
        const model = profile.models.find((item) => item.id === event.target.value);
        setValue({ ...value, model: model?.id ?? null, supportsImages: model?.vision ?? false, allowImages: false });
      }}><option value="">Select an account model</option>{profile.models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>}
      <label>Maximum input characters<input type="number" min={2000} max={100000} step={1000} value={value.maxInputChars} disabled={busy} onChange={(event) => setValue({ ...value, maxInputChars: Number(event.target.value) })} /></label>
      <label>Maximum output tokens<input type="number" min={1000} max={20000} step={1000} value={value.maxOutputTokens} disabled={busy} onChange={(event) => setValue({ ...value, maxOutputTokens: Number(event.target.value) })} /></label>
    </div>
    {value.model && selected?.vision === null && <label className="ai-check"><input type="checkbox" checked={value.supportsImages} disabled={busy} onChange={(event) => setValue({ ...value, supportsImages: event.target.checked, allowImages: false })} /> This model accepts images (confirm with provider)</label>}
    <label className="ai-check"><input type="checkbox" checked={value.allowImages} disabled={busy || !value.model || !value.supportsImages} onChange={(event) => setValue({ ...value, allowImages: event.target.checked })} /> Allow optional render sharing</label>
    <p className="small-note quiet">Images are off by default. Shared inventories and images leave this site and may incur provider charges. Limits are per request, not a spending cap.</p>
    {value.kind === 'copilot' && <p className="small-note quiet">Requires a separately authorized GitHub token and Copilot entitlement. The editor login is not used.</p>}
    <div className="library-management-actions">
      <button className="button button-primary" type="submit" disabled={busy}><Save size={16} /> Save provider</button>
      {profile && <button className="button button-outline" type="button" disabled={busy || Boolean(credential)} onClick={() => refresh(id)}><RefreshCw size={16} /> Refresh account models</button>}
      {profile && <button className="legacy-icon-button" type="button" title="Delete provider" aria-label={`Delete ${profile.name}`} disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={18} /></button>}
    </div>
    {confirmDelete && <div role="alertdialog" aria-label="Delete provider"><p>Delete {profile?.name} and its saved credential?</p><button type="button" className="button button-outline" disabled={busy} onClick={() => remove(id)}>Delete provider</button><button type="button" className="button button-quiet" onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
  </form>;
}

export function AiSettings({ request }: { request: Request }) {
  const [params] = useSearchParams();
  const returnValue = params.get('returnTo');
  const returnTo = returnValue && /^\/import-library(?:\?|$)/.test(returnValue) ? returnValue : '/manage-library';
  const [settings, setSettings] = useState<SiteAiSettings | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<SiteAiSettings>('/api/admin/ai', { signal: controller.signal }).then((next) => { if (!controller.signal.aborted) { setSettings(next); setError(''); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load AI settings'); });
    return () => controller.abort();
  }, [request, reload]);
  async function command(path: string, method: string, body: object = {}) {
    if (!settings) return;
    setBusy(true); setError('');
    try {
      const next = await request<SiteAiSettings>(`/api/admin/ai/${path}`, { method, body: JSON.stringify({ ...body, expectedRevision: settings.revision }) });
      setSettings(next); setAdding(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update AI settings'); } finally { setBusy(false); }
  }
  return <section className="legacy-import ai-settings" aria-labelledby="ai-settings-title">
    <Link className="back-link" to={returnTo}><ArrowLeft size={16} /> {returnTo.startsWith('/import-library') ? 'Return to import' : 'Manage library'}</Link>
    <header className="legacy-heading"><h1 id="ai-settings-title">AI settings</h1><button type="button" className="legacy-icon-button" title="Reload AI settings" aria-label="Reload AI settings" disabled={busy} onClick={() => setReload((value) => value + 1)}><RefreshCw size={18} /></button></header>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {!settings ? <p role="status">Loading AI settings...</p> : <>
      {!settings.encryptedStorageReady && <p className="notice notice-error" role="alert">Configure AI_SETTINGS_KEY_FILE on the server before saving credentials.</p>}
      <label>Default provider<select aria-label="Default provider" disabled={busy} value={settings.defaultProviderId ?? ''} onChange={(event) => void command('default', 'PUT', { providerId: event.target.value || null })}>
        <option value="">No default selected</option>{settings.providers.filter((provider) => provider.model).map((provider) => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}
      </select></label>
      {!settings.defaultProviderId && <p className="small-note">Save a provider, refresh its account models, save a model selection, then choose the default.</p>}
      {settings.providers.map((profile) => <ProviderForm key={`${profile.id}:${settings.revision}`} profile={profile} busy={busy || !settings.encryptedStorageReady}
        save={(id, value) => command(`providers/${id}`, 'PUT', value)} refresh={(id) => void command(`providers/${id}/models`, 'POST')} remove={(id) => void command(`providers/${id}`, 'DELETE')} />)}
      {adding ? <ProviderForm busy={busy || !settings.encryptedStorageReady} save={(id, value) => command(`providers/${id}`, 'PUT', value)} refresh={() => undefined} remove={() => undefined} /> : <button type="button" className="button button-outline" disabled={busy || !settings.encryptedStorageReady || settings.providers.length >= 8} onClick={() => setAdding(true)}><Plus size={16} /> Add provider</button>}
      {settings.defaultProviderId && returnTo.startsWith('/import-library') && <Link className="button button-primary" to={returnTo}>Return to import</Link>}
    </>}
  </section>;
}