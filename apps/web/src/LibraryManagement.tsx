import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LibraryManagementResponse, LibraryPlanIssue, LibraryReorganizationPlan } from '@print-pantry/contracts';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const byteLabel = (value: string | null) => value === null ? 'Unknown' : `${BigInt(value).toLocaleString()} bytes`;
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'Library management failed; retry shortly.';

function Issues({ items }: { items: LibraryPlanIssue[] }) {
  if (!items.length) return null;
  return <ul className="library-plan-issues">{items.map((item, index) => <li key={index}
    className={item.severity === 'blocker' ? 'notice notice-error' : 'notice'}>
    <strong>{item.severity === 'blocker' ? 'Blocked' : 'Note'}:</strong> {item.relativePath && <code>{item.relativePath}: </code>}{item.message}
  </li>)}</ul>;
}

export function LibraryManagement({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams();
  const planId = params.get('plan');
  const [data, setData] = useState<LibraryManagementResponse | null>(null);
  const [plan, setPlan] = useState<LibraryReorganizationPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [planLoading, setPlanLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [planError, setPlanError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ q: search, page: String(page) });
    request<LibraryManagementResponse>(`/api/library/management?${query}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, search, refresh, request]);
  useEffect(() => {
    const controller = new AbortController();
    setPlan(null);
    setPlanError('');
    if (!planId) { setPlanLoading(false); return; }
    setPlanLoading(true);
    request<LibraryReorganizationPlan>(`/api/library/reorganization-plans/${encodeURIComponent(planId)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPlan(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setPlanError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setPlanLoading(false); });
    return () => controller.abort();
  }, [planId, request, refresh]);
  async function preview() {
    setBusy(true);
    setPlanError('');
    try {
      const next = await request<LibraryReorganizationPlan>('/api/library/reorganization-plans', {
        method: 'POST', body: JSON.stringify({ projectIds: selected }),
      });
      setParams({ plan: next.id });
      setRefresh((value) => value + 1);
    } catch (reason) { setPlanError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <main className="content-wrap library-management">
    <section className="requests-heading">
      <div><p className="eyebrow">Operator workspace</p><h1>Manage library</h1>
        <p>Review catalog storage and preview adoption into ID-based managed folders. Categories and display metadata stay in the database.</p></div>
      <button className="button button-outline" type="button" disabled={busy || loading || planLoading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
    </section>
    <p className="notice">Read-only checkpoint: generating a dry run saves a database snapshot only. No files are copied, renamed, deleted, or activated. Copy/verify/activate migration comes in a later phase.</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {loading && <p role="status">Loading library inventory...</p>}
    {data && <>
      <p className="library-management-summary">{data.summary.legacy} legacy projects · {data.summary.managed} managed projects · {data.summary.missing} catalog projects marked missing</p>
      <section className="queue-panel" aria-labelledby="library-selection-heading">
        <h2 id="library-selection-heading">Reorganization dry run</h2>
        <p className="small-note">Select up to 25 legacy projects and 1,000 indexed files. Inspections are bounded to 2,000 filesystem entries and 12 relative-path components. Internal names/layout are preserved, not automatically reorganized by file type.</p>
        <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchText.trim()); }}>
          <label className="search-field"><span className="sr-only">Search library management</span>
            <input aria-label="Search library management" value={searchText} maxLength={200} placeholder="Search titles or storage paths"
              onChange={(event) => setSearchText(event.target.value)} /></label>
          <button className="button button-outline" type="submit" disabled={loading || busy}>Search</button>
        </form>
        <div className="library-management-actions">
          <button className="button button-primary" disabled={busy || loading || Boolean(error) || !selected.length} type="button" onClick={() => void preview()}>
            {busy ? 'Inspecting selected projects...' : `Preview reorganization (${selected.length})`}
          </button>
          <button className="button button-quiet" disabled={busy || !selected.length} type="button" onClick={() => setSelected([])}>Clear selection</button>
        </div>
        <ul className="library-management-projects" aria-label="Catalog storage inventory">{data.items.map((project) => <li key={project.id}>
          <label className="source-candidate-choice"><input type="checkbox" aria-label={`Select ${project.name}`}
            checked={selected.includes(project.id)} disabled={busy || loading || project.storageKind === 'managed' || (!selected.includes(project.id) && selected.length >= 25)}
            onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, project.id] : previous.filter((id) => id !== project.id))} />
            <strong>{project.name}</strong></label>
          <p className="small-note">{project.storageKind} · {project.fileCount} files · {byteLabel(project.sizeBytes)}
            {project.category && ` · ${project.category}`}{!project.available && ' · Marked missing'}</p>
          <code className="library-storage-path">{project.relativePath}</code>
          <Link to={`/projects/${project.id}`}>Open project / manage sources</Link>
        </li>)}</ul>
        {!data.items.length && <p>No projects match this search.</p>}
        <div className="library-management-actions" aria-label="Management pagination">
          <button className="button button-outline" disabled={loading || busy || page === 1} type="button" onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))} · {data.total} projects</span>
          <button className="button button-outline" disabled={loading || busy || data.page * data.pageSize >= data.total} type="button" onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      </section>
      {data.plans.length > 0 && <section className="queue-panel" aria-labelledby="saved-plans-heading">
        <h2 id="saved-plans-heading">Recent saved dry runs</h2><ul>{data.plans.map((item) => <li key={item.id}>
          <Link to={`?plan=${encodeURIComponent(item.id)}`}>Dry run {new Date(item.createdAt).toLocaleString()} · {item.projectCount} projects</Link>
        </li>)}</ul>
      </section>}
    </>}
    {planError && <p className="notice notice-error" role="alert">{planError}</p>}
    {planLoading && <p role="status">Loading saved dry run...</p>}
    {plan && <section className="queue-panel" aria-labelledby="dry-run-heading">
      <h2 id="dry-run-heading">Saved reorganization preview</h2>
      <p className="small-note">Snapshot from {new Date(plan.createdAt).toLocaleString()}; it can become stale. Fresh verification is required before any future activation.</p>
      <p>Additional file-copy bytes (lower bound): <strong>{byteLabel(plan.additionalBytes)}</strong><br />
        Available managed storage at preview time: <strong>{byteLabel(plan.availableBytes)}</strong></p>
      <Issues items={plan.issues} />
      {plan.projects.map((project) => <article className="library-plan-project" key={project.id}>
        <h3><Link to={`/projects/${project.id}`}>{project.name}</Link> <span className="small-note">ID {project.id}</span></h3>
        <p>Legacy: <code className="library-storage-path">{project.relativePath}</code>
          Proposed managed: <code className="library-storage-path">{project.destinationPath}</code></p>
        <p className="small-note">{project.fileCount} indexed files · {project.checkedFiles} files checked · {project.inspectionComplete ? 'Directory inspection complete' : 'Directory inspection incomplete'}
          {project.issues.some((item) => item.severity === 'blocker') || plan.issues.some((item) => item.severity === 'blocker') ? ' · Blocked' : ' · Preview only; not approved for migration'}</p>
        <p className="small-note">Category: {project.category ?? 'Uncategorized'} · {project.sourceCount} approved sources. Project, asset, version, and print-request references are unchanged.</p>
        <Issues items={project.issues} />
        <details><summary>File mappings ({project.files.length})</summary>
          <ul className="library-file-mappings">{project.files.map((file) => <li key={file.id}>
            <code>{file.sourcePath}</code><span> to </span><code>{project.destinationPath}/{file.destinationPath}</code>
            <small>Asset {file.id} · Version {file.versionId ?? 'Missing'} · Indexed SHA-256 {file.contentHash ?? 'Missing'} · {byteLabel(file.sizeBytes)}</small>
          </li>)}</ul>
        </details>
      </article>)}
    </section>}
  </main>;
}
