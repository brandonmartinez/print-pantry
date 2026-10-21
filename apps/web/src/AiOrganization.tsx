import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, Settings, Sparkles, X } from 'lucide-react';
import type { LegacyImportSession, SiteAiSettings } from '@print-pantry/contracts';
import type { MeshGeometry } from './MeshViewer.js';

const InteractiveMesh = lazy(() => import('./MeshViewer.js'));
type Request = <Result>(path: string, init?: RequestInit) => Promise<Result>;
type Render = { fileId: string; data: string; name: string };

export function AiOrganization({ session, request, disabled, onSession, onBusyChange }: {
  session: LegacyImportSession; request: Request; disabled: boolean; onSession: (next: LegacyImportSession) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SiteAiSettings | null>(null);
  const [providerId, setProviderId] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [fileId, setFileId] = useState('');
  const [geometry, setGeometry] = useState<MeshGeometry | null>(null);
  const [renders, setRenders] = useState<Render[]>([]);
  const requestId = useRef<string | null>(null);
  const settingsPath = `/settings/ai?returnTo=${encodeURIComponent(`/import-library?session=${session.id}`)}`;
  const files = session.projects.flatMap((project) => project.files.filter((file) => /\.(stl|3mf)$/i.test(file.originalPath)).map((file) => ({ ...file, projectKey: project.key, label: `${project.name} / ${file.originalPath}` })));
  const profile = settings?.providers.find((provider) => provider.id === providerId);
  const proposal = session.aiProposal;
  const locked = disabled || busy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function configure() {
    setBusy(true); setError('');
    try {
      const next = await request<SiteAiSettings>('/api/admin/ai');
      if (!next.defaultProviderId) { navigate(settingsPath); return; }
      setSettings(next); setProviderId(next.defaultProviderId); setConsent(false); setRenders([]); setOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load AI settings'); } finally { setBusy(false); }
  }
  async function generate() {
    if (!consent || !profile?.model) return;
    setBusy(true); setError('');
    requestId.current ??= crypto.randomUUID();
    try {
      const next = await request<LegacyImportSession>(`/api/library/imports/${session.id}/ai`, { method: 'POST', body: JSON.stringify({
        expectedRevision: session.revision, requestId: requestId.current, providerId: profile.id,
        images: renders.map(({ fileId, data }) => ({ fileId, data: data.split(',')[1] })),
      }) });
      onSession(next); requestId.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'AI request failed. Refresh before retrying.'); } finally { setBusy(false); }
  }
  async function preview() {
    if (!fileId) return;
    setBusy(true); setError(''); setGeometry(null);
    try { setGeometry(await request<MeshGeometry>(`/api/library/imports/${session.id}/files/${fileId}/geometry`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Preview unavailable'); } finally { setBusy(false); }
  }
  return <section className="ai-organization" aria-label="AI organization">
    <div className="library-management-actions"><button className="button button-outline" type="button" disabled={locked} onClick={() => void configure()}><Sparkles size={16} /> AI organization</button><Link className="legacy-icon-button" aria-label="AI settings" title="AI settings" to={settingsPath}><Settings size={18} /></Link></div>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {busy && <p role="status">Contacting provider or loading preview...</p>}
    <details className="legacy-files"><summary>Preview selected models</summary>
      <div className="library-management-actions"><label>Model file<select aria-label="Preview file" value={fileId} disabled={locked} onChange={(event) => { setFileId(event.target.value); setGeometry(null); }}><option value="">Select a model</option>{files.map((file) => <option value={file.id} key={`${file.projectKey}:${file.id}`}>{file.label}</option>)}</select></label><button className="button button-outline" type="button" disabled={locked || !fileId} onClick={() => void preview()}><Eye size={16} /> Preview</button></div>
      {geometry && <Suspense fallback={<p role="status">Loading viewer...</p>}><InteractiveMesh fileName={files.find((file) => file.id === fileId)?.originalPath ?? 'Model'} geometry={geometry}
        onSnapshot={open && profile?.allowImages && profile.supportsImages ? (data) => {
          if (data.length > 1_400_000) { setError('This render is too large. Resize the preview and try again.'); return; }
          setRenders((current) => [...current.filter((render) => render.fileId !== fileId), { fileId, data, name: files.find((file) => file.id === fileId)?.label ?? 'Render' }].slice(-3));
        } : undefined} /></Suspense>}
    </details>
    {open && <div className="ai-consent">
      <label>Proposal provider<select aria-label="Proposal provider" value={providerId} disabled={locked} onChange={(event) => {
        setProviderId(event.target.value); setConsent(false); setRenders([]); requestId.current = null;
      }}>{settings?.providers.filter((provider) => provider.hasCredential && provider.model).map((provider) => <option key={provider.id} value={provider.id}>
        {provider.name} / {provider.model}{provider.id === settings.defaultProviderId ? ' (site default)' : ''}
      </option>)}</select></label>
      <p className="small-note">Send selected folder names, file names, sizes, and the current organization to this provider. No source files or document contents are sent. Provider charges and retention policies apply.</p>
      {profile?.allowImages && profile.supportsImages && <p className="small-note">Optional renders: {renders.length} of 3 attached. Images can increase token usage.</p>}
      <div className="ai-renders">{renders.map((render) => <figure key={render.fileId}><img src={render.data} alt={render.name} /><figcaption>{render.name}</figcaption><button className="legacy-icon-button" type="button" title="Remove render" aria-label={`Remove ${render.name}`} disabled={locked} onClick={() => setRenders((current) => current.filter((item) => item.fileId !== render.fileId))}><X size={16} /></button></figure>)}</div>
      <label className="ai-check"><input type="checkbox" checked={consent} disabled={locked} onChange={(event) => setConsent(event.target.checked)} /> I approve sending this inventory and attached renders.</label>
      <button className="button button-primary" type="button" disabled={locked || !consent || !profile?.model} onClick={() => void generate()}><Sparkles size={16} /> {busy ? 'Requesting proposal...' : 'Generate proposal'}</button>
    </div>}
    {proposal && <section className="ai-proposal" aria-label="AI proposal">
      <h3>AI proposal</h3><p className="small-note quiet">{proposal.provider} / {proposal.model} · {proposal.status}</p>
      {proposal.status === 'pending' && <p role="status">Request submitted. Refresh to check completion. A pending request is never automatically resubmitted.</p>}
      {proposal.error && <p className="notice notice-error" role="alert">{proposal.error}</p>}
    </section>}
  </section>;
}