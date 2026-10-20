import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ImportMatch, ImportPage, ImportRequest, ImportSource, ImportStatus, SubmitImport } from '@print-pantry/contracts';
import { ImportIntake } from './ImportIntake.js';

class ImportApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new ImportApiError(body.error || body.message || `Request failed (${response.status})`, response.status);
  return body as T;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

const labels: Record<ImportStatus, string> = {
  submitted: 'Submitted',
  awaiting_files: 'Awaiting files',
  ready_for_review: 'Ready for review',
  publishing: 'Publishing',
  catalog_pending: 'Catalog registration pending',
  imported: 'Imported',
  declined: 'Declined',
  canceled: 'Canceled',
};

function WebsiteLink({ url }: { url: string }) {
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return <a className="button button-outline button-small" href={url} rel="noreferrer" target="_blank">Open website<span className="sr-only"> (opens in a new tab)</span></a>;
}

function SourceMetadata({ source }: { source: ImportSource }) {
  return <p className="quiet small-note import-source">
    {source.provider}
    {source.modelId && <> · Model ID: {source.modelId}</>}
    {source.profileId && <> · Profile ID: {source.profileId}</>}
  </p>;
}

function AddPrint({ onSubmitted }: { onSubmitted: (result: { request: ImportRequest; joined: boolean }) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [match, setMatch] = useState<ImportMatch | null>(null);
  const [allowExisting, setAllowExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef<{ payload: string; key: string } | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const payload = { url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };

  async function check() {
    setBusy(true);
    setError('');
    setMatch(null);
    setAllowExisting(false);
    try {
      setMatch(await request<ImportMatch>('/api/imports/check', { method: 'POST', body: JSON.stringify({ url: payload.url }) }));
      preview.current?.focus();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!match || (match.projects.length > 0 && !allowExisting)) return;
    setBusy(true);
    setError('');
    const serialized = JSON.stringify(payload);
    if (!submission.current || submission.current.payload !== serialized) {
      submission.current = { payload: serialized, key: crypto.randomUUID() };
    }
    const body: SubmitImport = { ...payload, submissionKey: submission.current.key };
    try {
      const result = await request<{ request: ImportRequest; joined: boolean }>('/api/imports', { method: 'POST', body: JSON.stringify(body) });
      setUrl('');
      setTitle('');
      setNotes('');
      setMatch(null);
      setAllowExisting(false);
      submission.current = null;
      onSubmitted(result);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="import-add info-card" aria-labelledby="add-print-heading">
    <h2 id="add-print-heading">Add New Print</h2>
    <p className="quiet small-note">Share a model’s website link for operator review. This does not download files or create a print request.</p>
    <form className="import-form" onSubmit={(event) => { event.preventDefault(); void check(); }}>
      <label>Source URL<input required type="url" value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value); setMatch(null); setAllowExisting(false); }} placeholder="https://…" /></label>
      <label>Title (optional)<input value={title} disabled={busy} maxLength={256} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Notes (optional)<textarea value={notes} disabled={busy} maxLength={2000} rows={3} onChange={(event) => setNotes(event.target.value)} /></label>
      <button className="button button-outline" disabled={busy} type="submit">{busy ? 'Please wait…' : 'Check source'}</button>
    </form>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    <div ref={preview} tabIndex={-1}>
      {match && <section className="import-match" aria-labelledby="source-check-heading">
        <h3 id="source-check-heading">Source checked</h3>
        <WebsiteLink url={match.source.url} />
        <SourceMetadata source={match.source} />
        {match.projects.length > 0 && <>
          <p>This source matches the library. View a project before requesting another import:</p>
          <ul>{match.projects.map((project) => <li key={project.id}>{project.storageKind === 'legacy' ?
            <>{project.name} — legacy, migration required</> : <><Link to={`/projects/${encodeURIComponent(project.id)}`}>View {project.name}</Link>{!project.available && ' — unavailable'}</>}</li>)}</ul>
          <label className="import-existing"><input type="checkbox" checked={allowExisting} disabled={busy} onChange={(event) => setAllowExisting(event.target.checked)} />Submit anyway: I need different or missing files.</label>
        </>}
        {match.pending && <p className="notice notice-success">An active import is already {labels[match.pending.status].toLowerCase()}. Submitting will join that shared import, preserving your source link and notes. An operator’s decision affects everyone following it.</p>}
        {!match.pending && match.projects.length === 0 && <p>No matching library project or active import found.</p>}
        <button className="button button-primary" type="button" disabled={busy || (match.projects.length > 0 && !allowExisting)} onClick={() => void submit()}>{match.pending ? 'Join existing import' : 'Submit import'}</button>
      </section>}
    </div>
  </section>;
}

function ImportCard({ item, operator, onChanged }: { item: ImportRequest; operator: boolean; onChanged: () => void }) {
  const [detail, setDetail] = useState(item);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = ['submitted', 'awaiting_files', 'ready_for_review'].includes(detail.status);
  useEffect(() => { setDetail(item); }, [item]);

  async function action(action: 'accept' | 'decline' | 'cancel') {
    if (action !== 'accept' && !note.trim()) {
      setError('A note is required to decline or cancel an import.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await request<{ request: ImportRequest }>(`/api/imports/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, expectedRevision: detail.revision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      setDetail(result.request);
      setNote('');
      onChanged();
    } catch (reason) {
      if (reason instanceof ImportApiError && reason.status === 409) {
        setError(`This import changed. Refreshing its latest state; review it before trying again. ${message(reason)}`);
        try {
          const latest = await request<{ request: ImportRequest }>(`/api/imports/${encodeURIComponent(detail.id)}`);
          setDetail(latest.request);
          onChanged();
        } catch {
          setError(`This import changed and could not be refreshed. Refresh imports before trying again. ${message(reason)}`);
        }
      } else {
        setError(message(reason));
      }
    } finally {
      setBusy(false);
    }
  }

  return <article className="request-card import-card" aria-label={detail.title || detail.source.canonicalUrl}>
    <header className="request-card-header">
      <h3>{detail.title || detail.source.canonicalUrl}</h3>
      <span className={`request-status status-${detail.status}`}>{labels[detail.status]}</span>
    </header>
    <WebsiteLink url={detail.source.url} />
    <SourceMetadata source={detail.source} />
    {detail.projectId && <p><Link to={`/projects/${encodeURIComponent(detail.projectId)}`}>View library project</Link></p>}
    <p className="quiet small-note">Submitted <time dateTime={detail.createdAt}>{new Date(detail.createdAt).toLocaleString()}</time></p>
    {detail.status === 'awaiting_files' && <p className="small-note">Accepted for manual file intake. An operator can upload files, then explicitly process and review them.</p>}
    {operator && ['awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported'].includes(detail.status) && <ImportIntake item={detail} onChanged={onChanged} />}
    <details className="request-history">
      <summary>{operator ? 'Household submissions and history' : 'Your submissions and import history'}</summary>
      <ul className="import-submissions">{detail.submissions.map((entry) => <li key={entry.id}>
        <strong>{entry.requester.username}</strong>{entry.title && <p>{entry.title}</p>}
        {entry.notes && <p className="import-notes">{entry.notes}</p>}
        <WebsiteLink url={entry.sourceUrl} />
      </li>)}</ul>
      <ol>{detail.history.map((entry) => <li key={entry.id}>{labels[entry.status]} · {entry.actor.username} · <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>{entry.note && <p className="import-notes">{entry.note}</p>}</li>)}</ol>
    </details>
    {operator && active && <>
      <label className="operator-note">Decision note (required for decline or cancel)<textarea value={note} disabled={busy} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} /></label>
      <p className="quiet small-note">Decisions apply to this shared import and everyone following it.</p>
      <div className="request-actions">
        {detail.status === 'submitted' && <button className="button button-primary" disabled={busy} type="button" onClick={() => void action('accept')}>Accept — Awaiting files</button>}
        <button className="button button-outline" disabled={busy} type="button" onClick={() => void action('decline')}>Decline import</button>
        <button className="button button-quiet" disabled={busy} type="button" onClick={() => void action('cancel')}>Cancel import for everyone</button>
      </div>
    </>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </article>;
}

export function ImportQueue({ user }: { user: { role: string } }) {
  const location = useLocation();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ImportPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const operator = user.role === 'operator';

  useEffect(() => {
    if (location.hash === '#add') heading.current?.focus();
  }, [location.hash]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    request<ImportPage>(`/api/imports?page=${page}&pageSize=12`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, refresh]);

  return <main className="content-wrap requests-page import-page">
    <div className="requests-heading">
      <div><p className="eyebrow">{operator ? 'Household sources' : 'Your shared discoveries'}</p><h1>Imports</h1><p>{operator ? 'Review model links, upload files, and publish reviewed projects to the managed library.' : 'Submit model links and follow your imports here.'}</p></div>
      <button className="button button-outline" disabled={loading} type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh imports</button>
    </div>
    <p className="notice notice-success">Imports use manual uploads: an operator prepares files or ZIP archives, reviews a deterministic plan, and publishes to a separate managed library root. Originals are retained. No files are downloaded automatically and no AI processing is used.</p>
    <div id="add"><h2 className="sr-only" ref={heading} tabIndex={-1}>Add a new print source</h2>
      <AddPrint onSubmitted={(result) => {
        setSuccess(result.joined ? 'You are following the existing import. Your source link and notes were saved.' : 'Import submitted for operator review.');
        setPage(1);
        setRefresh((value) => value + 1);
      }} />
    </div>
    {success && <p className="notice notice-success" role="status">{success}</p>}
    <section className="request-list-section" aria-labelledby="imports-list-heading" aria-busy={loading}>
      <div className="section-heading"><h2 id="imports-list-heading">{operator ? 'Household imports' : 'Your imports'}</h2>{data && <span className="quiet">{data.total} total</span>}</div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {loading && <p role="status">Loading imports…</p>}
      {!loading && !error && data?.items.length === 0 && <p className="empty-note">No imports yet. Add a model link above to get started.</p>}
      {!error && data?.page === page && <div className="request-list">{data.items.map((item) => <ImportCard key={item.id} item={item} operator={operator} onChanged={() => setRefresh((value) => value + 1)} />)}</div>}
      <nav className="import-pagination" aria-label="Import pages">
        <button className="button button-outline" disabled={loading || page === 1} type="button" onClick={() => setPage((value) => value - 1)}>Previous imports</button>
        <span>Page {page}</span>
        <button className="button button-outline" disabled={loading || !data || page * data.pageSize >= data.total} type="button" onClick={() => setPage((value) => value + 1)}>Next imports</button>
      </nav>
    </section>
  </main>;
}
