import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LibraryAdoptionCommand, LibraryAdoptionItems, LibraryAdoptionItemStatus, LibraryAdoptionRun, LibraryAdoptionState } from '@print-pantry/contracts';
import { LibraryFileSize, libraryByteLabel as bytes } from './LibraryFileSize.js';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const working = ['planning', 'copying', 'activating', 'restoring', 'canceling'];
const terminal = ['completed', 'partial', 'canceled', 'restored'];
const labels: Record<LibraryAdoptionState, string> = {
  planning: 'Inspecting existing library', review: 'Ready for plan review', copying: 'Copying and verifying',
  awaiting_activation: 'Verified copies await activation approval', activating: 'Activating approved copies',
  restoring: 'Restoring legacy locations', canceling: 'Canceling remaining work', paused: 'Paused',
  completed: 'Adoption complete', partial: 'Partial result; review remaining projects', canceled: 'Remaining work canceled', restored: 'Legacy locations restored',
};
const itemLabels: Record<LibraryAdoptionItemStatus, string> = {
  pending: 'Not yet inspected', ready: 'Ready to copy', blocked: 'Blocked', copying: 'Copying / interrupted',
  copied: 'Awaiting activation', activated: 'Managed active', failed: 'Failed', restored: 'Legacy restored', canceled: 'Canceled',
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Library adoption request failed. Refresh before retrying.';

export function LibraryAdoption({ request, legacyCount, refresh, onStorageChanged }: {
  request: Request; legacyCount?: number; refresh: number; onStorageChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const id = params.get('adoption');
  const [runs, setRuns] = useState<LibraryAdoptionRun[]>([]);
  const [run, setRun] = useState<LibraryAdoptionRun | null>(null);
  const [items, setItems] = useState<LibraryAdoptionItems | null>(null);
  const [filter, setFilter] = useState('');
  const [cursors, setCursors] = useState<string[]>(['']);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [listError, setListError] = useState('');
  const [retained, setRetained] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [retryStage, setRetryStage] = useState('copy');
  const requestKey = useRef<string | null>(null);
  const previousStorage = useRef('');
  const cursor = cursors.at(-1) ?? '';
  useEffect(() => {
    const controller = new AbortController();
    setListError('');
    request<{ runs: LibraryAdoptionRun[] }>('/api/library/adoptions', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setRuns(result.runs); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setListError(errorMessage(reason)); });
    return () => controller.abort();
  }, [request, refresh, reload]);
  useEffect(() => {
    setRun(null); setItems(null); setCursors(['']); setFilter('');
    setRetained(false); setReviewed(false); setConfirmation(''); setError('');
    previousStorage.current = '';
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const runId = id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const query = new URLSearchParams();
      if (cursor) query.set('after', cursor);
      if (filter) query.set('status', filter);
      try {
        const [next, nextItems] = await Promise.all([
          request<LibraryAdoptionRun>(`/api/library/adoptions/${encodeURIComponent(runId)}`, { signal: controller.signal }),
          request<LibraryAdoptionItems>(`/api/library/adoptions/${encodeURIComponent(runId)}/items?${query}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setRun(next); setItems(nextItems); setLoadError('');
        const storage = `${next.id}:${next.counts.activated}:${next.counts.restored}`;
        if (previousStorage.current && previousStorage.current !== storage) onStorageChanged();
        previousStorage.current = storage;
        if (working.includes(next.state) || (next.state === 'paused' && next.counts.copying > 0)) timer = setTimeout(() => void load(), 1500);
      } catch (reason) { if (!controller.signal.aborted) setLoadError(errorMessage(reason)); }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, request, refresh, reload, filter, cursor, onStorageChanged]);

  async function plan() {
    setBusy(true); setError('');
    requestKey.current ??= crypto.randomUUID();
    try {
      const next = await request<LibraryAdoptionRun>('/api/library/adoptions', { method: 'POST', body: JSON.stringify({ requestKey: requestKey.current }) });
      requestKey.current = null;
      setParams({ adoption: next.id });
      setReload((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function command(action: LibraryAdoptionCommand) {
    if (!run) { setError('Select an adoption run before submitting a command.'); return; }
    setBusy(true); setError('');
    try {
      const next = await request<LibraryAdoptionRun>(`/api/library/adoptions/${encodeURIComponent(run.id)}/commands`, {
        method: 'POST', body: JSON.stringify({
          action, expectedRevision: run.revision, expectedFingerprint: run.fingerprint,
          ...(action === 'approve_copy' ? { confirmRetainedCopies: retained, acknowledgeWarnings: reviewed } : {}),
          ...(action === 'activate' ? { confirmActivation: true } : {}),
          ...(action === 'restore' ? { confirmRestoration: true } : {}),
          ...(action === 'cancel' ? { confirmCancellation: true } : {}),
          ...(action === 'retry' ? { stage: retryStage } : {}),
        }),
      });
      setRun(next); setConfirmation(''); setReload((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); setReload((value) => value + 1); }
    finally { setBusy(false); }
  }
  const active = Boolean(run && working.includes(run.state));
  return <section className="queue-panel library-adoption" aria-labelledby="bulk-adoption-heading">
    <div className="library-plan-project-heading"><h2 id="bulk-adoption-heading">Initialize or adopt an existing library</h2>
      <button type="button" className="button button-outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh adoption</button></div>
    <p>Plan all currently indexed legacy projects, then approve copying and activation in two batches. No individual project clicks are required.
      Index a new library first; confirm permanent managed storage and independent backups before copying.</p>
    <p className="small-note">Planning does not copy files. Legacy scans are deferred while a run is active or awaiting review.
      New projects are not silently added; blocked and failed projects remain explicitly listed.</p>
    <button type="button" className="button button-primary" disabled={busy || !legacyCount}
      onClick={() => void plan()}>Plan existing library ({legacyCount ?? 0})</button>
    {listError && <p className="notice notice-error" role="alert">{listError}</p>}
    {runs.length > 0 && <details className="library-adoption-history"><summary>Recent adoption runs ({runs.length})</summary>
      <ul>{runs.map((saved) => <li key={saved.id}><Link to={`?adoption=${encodeURIComponent(saved.id)}`}>
        {new Date(saved.createdAt).toLocaleString()} · {saved.total} projects · {labels[saved.state]}
      </Link></li>)}</ul></details>}
    {loadError && <p className="notice notice-error" role="alert">{loadError}</p>}
    {id && !run && !loadError && <p role="status">Loading adoption progress...</p>}
    {run && <>
      <h3>{labels[run.state]}</h3>
      <dl className="library-folder-comparison">
        <div><dt>Source library <span>Read-only originals</span></dt><dd><code>{run.legacyRoot}</code></dd></div>
        <div><dt>Managed destination <span>Copies go here</span></dt><dd><code>{run.managedRoot}</code></dd></div>
      </dl>
      <p className="small-note">Additional copy space (lower bound): <LibraryFileSize value={run.additionalBytes} />.
        Reported free space at planning/approval: <LibraryFileSize value={run.availableBytes} />. Manifests, filesystem overhead and retained copies require extra capacity.</p>
      {run.managedRoot.startsWith('/workspace/') && <p className="notice">This destination is under the development workspace.
        Confirm its backing mount and capacity, or configure permanent managed storage before copying your real library.</p>}
      <dl className="library-adoption-counts">
        <div><dt>Projects in run</dt><dd>{run.total}</dd></div>
        <div><dt>Ready to copy</dt><dd>{run.counts.ready}</dd></div>
        <div><dt>Awaiting activation</dt><dd>{run.counts.copied}</dd></div>
        <div><dt>Managed active</dt><dd>{run.counts.activated}</dd></div>
        <div><dt>Needs review</dt><dd>{run.counts.blocked} blocked / {run.counts.failed} failed</dd></div>
      </dl>
      <p className="small-note">{run.counts.pending} not yet inspected · {run.counts.copying} copying/interrupted · {run.counts.restored} restored · {run.counts.canceled} canceled</p>
      {(active || run.state === 'paused') && <p className="notice">Progress survives closing this page or restarting the server. Pause/cancel takes effect after the current project operation; it does not interrupt a file copy.</p>}
      {run.lastError && <p className="notice notice-error" role="alert">{run.lastError}</p>}
      {run.state === 'review' && <>
        <p>Review project outcomes below. Approval covers eligible projects only; blocked projects are left behind.
          Nothing is activated by copy approval.</p>
        <label className="source-candidate-choice"><input type="checkbox" checked={retained} disabled={busy}
          onChange={(event) => setRetained(event.target.checked)} />I have verified backups and will retain original folders.</label>
        <label className="source-candidate-choice"><input type="checkbox" checked={reviewed} disabled={busy}
          onChange={(event) => setReviewed(event.target.checked)} />I reviewed the plans, notes, storage estimates, and projects that will be left behind.</label>
        <div className="library-management-actions"><button type="button" className="button button-primary" disabled={busy || !retained || !reviewed || !run.counts.ready}
          onClick={() => void command('approve_copy')}>Approve batch copy and verification</button></div>
      </>}
      <div className="library-management-actions">
        {run.state === 'awaiting_activation' && <button type="button" className="button button-primary" disabled={busy || !run.counts.copied}
          onClick={() => setConfirmation('activate')}>Review batch activation</button>}
        {active && <button type="button" className="button button-outline" disabled={busy} onClick={() => void command('pause')}>Pause adoption</button>}
        {run.state === 'paused' && <button type="button" className="button button-primary" disabled={busy} onClick={() => void command('resume')}>Resume paused operation</button>}
        {run.state !== 'canceled' && run.state !== 'canceling' && <button type="button" className="button button-outline" disabled={busy}
          onClick={() => setConfirmation('cancel')}>Cancel unactivated work</button>}
        {terminal.includes(run.state) && run.counts.activated > 0 && <button type="button" className="button button-outline" disabled={busy}
          onClick={() => setConfirmation('restore')}>Restore activated projects</button>}
      </div>
      {confirmation && <div className="notice">
        <p>{confirmation === 'activate' ? `Activate ${run.counts.copied} verified projects? Downloads and requests will switch to managed copies. Originals are retained; blocked and failed projects are not activated.` :
          confirmation === 'restore' ? `Restore ${run.counts.activated} activated projects to their retained originals? Both copies must still verify. Managed copies and later display metadata are retained.` :
          'Cancel remaining unactivated work? Copies are retained and already activated projects stay managed.'}</p>
        <div className="library-management-actions"><button type="button" className="button button-primary" disabled={busy}
          onClick={() => void command(confirmation === 'activate' ? 'activate' : confirmation === 'restore' ? 'restore' : 'cancel')}>
          {confirmation === 'activate' ? 'Confirm batch activation' : confirmation === 'restore' ? 'Confirm batch restoration' : 'Confirm batch cancellation'}</button>
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => setConfirmation('')}>Back</button></div>
      </div>}
      {!active && run.counts.failed > 0 && <div className="library-management-actions">
        <label>Failed stage <select value={retryStage} onChange={(event) => setRetryStage(event.target.value)} disabled={busy}>
          <option value="copy">Copy</option><option value="activate">Activation</option><option value="restore">Restoration</option><option value="cancel">Cancellation</option>
        </select></label><button type="button" className="button button-outline" disabled={busy} onClick={() => void command('retry')}>Retry failed stage</button>
      </div>}
      <details className="library-technical-details"><summary>Adoption storage and technical details</summary><dl>
        <div><dt>Legacy root</dt><dd>{run.legacyRoot}</dd></div><div><dt>Managed root</dt><dd>{run.managedRoot}</dd></div>
        <div><dt>Copy file bytes (lower bound)</dt><dd>{bytes(run.additionalBytes)}</dd></div>
        <div><dt>Reported free bytes (at planning/approval)</dt><dd>{bytes(run.availableBytes)}</dd></div>
        <div><dt>Run ID</dt><dd>{run.id}</dd></div><div><dt>Revision</dt><dd>{run.revision}</dd></div><div><dt>Plan fingerprint</dt><dd>{run.fingerprint || 'Planning in progress'}</dd></div>
      </dl></details>
      <div className="library-management-actions"><label>Project outcomes <select value={filter} onChange={(event) => { setFilter(event.target.value); setCursors(['']); }}>
        <option value="">All projects</option>{Object.entries(itemLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label></div>
      <ul className="library-adoption-items">{items?.items.map((item) => <li key={item.projectId}>
        <div className="library-plan-project-heading"><Link to={`/projects/${item.projectId}`}>{item.name}</Link>
          <span className={`library-preview-status ${item.status === 'blocked' || item.status === 'failed' ? 'is-blocked' : ''}`}>{itemLabels[item.status]}</span></div>
        <p className="small-note">Project #{item.projectId} · {item.fileCount} files</p>
        {item.planId && <Link to={`?plan=${encodeURIComponent(item.planId)}`}>Review saved project plan</Link>}
        {item.lastError && <p className="notice notice-error">{item.lastError}</p>}
        {item.issues.length > 0 && <details><summary>Inspection notes ({item.issues.length})</summary><ul>{item.issues.map((issue, index) => <li key={index}>
          <strong>{issue.severity === 'blocker' ? 'Blocked: ' : 'Note: '}</strong>{issue.relativePath && <code>{issue.relativePath}: </code>}{issue.message}
        </li>)}</ul></details>}
      </li>)}</ul>
      {items && !items.items.length && <p>No projects match this outcome filter.</p>}
      <div className="library-management-actions" aria-label="Adoption project pagination">
        <button type="button" className="button button-outline" disabled={cursors.length === 1} onClick={() => setCursors((previous) => previous.slice(0, -1))}>Previous outcomes</button>
        <button type="button" className="button button-outline" disabled={!items?.nextCursor} onClick={() => {
          const next = items?.nextCursor;
          if (next) setCursors((previous) => [...previous, next]);
        }}>Next outcomes</button>
      </div>
    </>}
    {busy && <p role="status">Saving adoption command...</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>;
}
