import { useState } from 'react';
import type { SourceDiscoveryPreview } from '@print-pantry/contracts';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function SourceDiscovery({ projectId, request }: { projectId: string; request: Request }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SourceDiscoveryPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/catalog/projects/${encodeURIComponent(projectId)}/source-discovery`;
  function apply(next: SourceDiscoveryPreview | null) {
    setPreview(next);
    setSelected(next?.approvedCandidateIds ?? []);
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Source discovery failed. Retry or discover again.'); }
    finally { setBusy(false); }
  }
  return <section className="source-discovery" aria-label="Project source recovery">
    <button className="button button-outline" type="button" disabled={busy} aria-expanded={open} onClick={() => {
      setOpen(!open);
      if (!open) void run(async () => apply((await request<{ preview: SourceDiscoveryPreview | null }>(base)).preview));
    }}>{open ? 'Hide source discovery' : 'Manage sources'}</button>
    {open && <>
      <h3>Discover existing sources</h3>
      <p className="small-note">Read this project’s catalog URL and recognized shortcuts/metadata without fetching websites or changing files. Review and explicitly approve source associations for duplicate detection. Display metadata, project IDs, and print requests stay unchanged.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {busy && <p role="status">Working on source discovery…</p>}
      <button className="button button-outline" disabled={busy} type="button" onClick={() => void run(async () =>
        apply(await request<SourceDiscoveryPreview>(base, { method: 'POST' })))}>
        {preview ? 'Discover again' : 'Discover existing sources'}
      </button>
      {preview && <>
        {preview.appliedAt && <p className="notice notice-success" role="status">Approved source associations saved. Existing display metadata was not changed.</p>}
        {preview.issues.length > 0 && <div className="notice" role="status"><strong>Discovery issues ({preview.issues.length})</strong>
          <ul>{preview.issues.map((issue, index) => <li key={index}>
            {issue.relativePath ? `${issue.relativePath}: ` : ''}{issue.message}
          </li>)}</ul>
        </div>}
        {preview.candidates.length === 0 ? <p>No source candidates were found. Check the discovery issues and catalog indexing before retrying.</p> :
          <ul className="source-candidates">{preview.candidates.map((candidate) => <li key={candidate.id}>
            <label className="source-candidate-choice">
              <input type="checkbox" checked={candidate.alreadyAssociated || selected.includes(candidate.id)}
                disabled={busy || Boolean(preview.appliedAt) || candidate.alreadyAssociated}
                onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, candidate.id] : previous.filter((id) => id !== candidate.id))} />
              <span>{candidate.source.canonicalUrl}</span>
            </label>
            <p className="small-note"><a href={candidate.source.url} target="_blank" rel="noreferrer">Open source</a>
              {candidate.source.modelId && ` · ${candidate.source.provider} model ${candidate.source.modelId}`}
              {candidate.alreadyAssociated && ' · Already associated'}
            </p>
            {candidate.conflicting && <p className="notice notice-error">Conflicting model identities were found for this provider. Review this association carefully; nothing is merged automatically.</p>}
            <ul className="small-note quiet">{candidate.evidence.map((evidence, index) => <li key={index}>
              {evidence.relativePath ?? 'Existing catalog source URL'}{evidence.profileId && ` · profile ${evidence.profileId}`}
              <span className="source-evidence-url">{evidence.url}</span>
            </li>)}</ul>
          </li>)}</ul>}
        {!preview.appliedAt && preview.candidates.length > 0 && <button className="button button-primary" type="button"
          disabled={busy || selected.length === 0} onClick={() => void run(async () => apply(await request<SourceDiscoveryPreview>(
            `${base}/${encodeURIComponent(preview.id)}/apply`, { method: 'POST', body: JSON.stringify({ candidateIds: selected }) },
          )))}>
          Approve selected associations ({selected.length})
        </button>}
      </>}
    </>}
  </section>;
}
