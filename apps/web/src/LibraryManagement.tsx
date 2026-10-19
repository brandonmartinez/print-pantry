import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LibraryManagementResponse, LibraryPlanIssue, LibraryReorganizationPlan, LibraryReorganizationProject } from '@print-pantry/contracts';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const byteLabel = (value: string | null) => value === null ? 'Unknown' : `${BigInt(value).toLocaleString()} bytes`;
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'Library management failed; retry shortly.';

function FileSize({ value }: { value: string | null }) {
  if (value === null) return <span className="library-readable-size">Unknown</span>;
  const bytes = BigInt(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let unit = 0;
  let divisor = 1n;
  while (bytes >= divisor * 1024n && unit < units.length - 1) { divisor *= 1024n; unit++; }
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  const label = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(tenths) / 10);
  return <span className="library-readable-size" title={byteLabel(value)}>{label} {units[unit]}</span>;
}

function Issues({ items }: { items: LibraryPlanIssue[] }) {
  return <div className="library-issue-groups">{(['blocker', 'warning'] as const).map((severity) => {
    const group = items.filter((item) => item.severity === severity);
    if (!group.length) return null;
    const label = `${severity === 'blocker' ? 'Blockers' : 'Notes'} (${group.length})`;
    return <section key={severity} aria-label={label} className={`library-issue-group library-issue-${severity}`}>
      <h4>{label}</h4><ul>{group.map((item, index) => <li key={index}>
        {item.relativePath && <code>{item.relativePath}</code>}<span>{item.message}</span>
      </li>)}</ul>
    </section>;
  })}</div>;
}

function ProjectPreview({ project, blockedByPlan }: { project: LibraryReorganizationProject; blockedByPlan: boolean }) {
  const blocked = blockedByPlan || project.issues.some((item) => item.severity === 'blocker');
  const status = blocked ? 'Blocked' : project.inspectionComplete ? 'Inspection complete' : 'Inspection incomplete';
  return <article className="library-plan-project" aria-label={`${project.name} preview`}>
    <header className="library-plan-project-heading">
      <h3><Link to={`/projects/${project.id}`}>{project.name}</Link></h3>
      <span className={`library-preview-status ${blocked ? 'is-blocked' : project.inspectionComplete ? 'is-complete' : 'is-incomplete'}`}>{status}</span>
    </header>
    <dl className="library-preview-facts">
      <div><dt>Files checked</dt><dd>{project.checkedFiles} of {project.fileCount}</dd></div>
      <div><dt>Category</dt><dd>{project.category ?? 'Uncategorized'}</dd></div>
      <div><dt>Approved sources</dt><dd>{project.sourceCount ? project.sourceCount : 'None'}
        {!project.sourceCount && <> · <Link to={`/projects/${project.id}`}>Review sources</Link></>}</dd></div>
    </dl>
    <dl className="library-folder-comparison">
      <div><dt>Current folder <span>Legacy storage</span></dt><dd><code>{project.relativePath}</code></dd></div>
      <div><dt>Proposed folder <span>Managed storage</span></dt><dd><code>{project.destinationPath}</code></dd></div>
    </dl>
    <p className="small-note quiet">Internal file layout is preserved. Project metadata and print-request references stay unchanged.</p>
    <Issues items={project.issues} />
    <details className="library-preview-files">
      <summary>Files ({project.files.length})</summary>
      <p className="small-note quiet">Paths below are relative to the project folders shown above. Sizes are rounded; expand technical details for exact bytes and indexed hashes.</p>
      <ul className="library-file-mappings">{project.files.map((file) => {
        const prefix = `${project.relativePath}/`;
        const currentPath = file.sourcePath.startsWith(prefix) ? file.sourcePath.slice(prefix.length) : file.sourcePath;
        const changed = currentPath !== file.destinationPath;
        return <li key={file.id}>
          <div className="library-file-overview">
            <div className="library-relative-path">
              {changed && <span className="small-note quiet">Current path</span>}
              <code>{currentPath}</code>
              {changed && <><span className="small-note quiet">Proposed path</span><code>{file.destinationPath}</code></>}
            </div>
            <FileSize value={file.sizeBytes} />
          </div>
          <details className="library-technical-details">
            <summary>Technical details</summary>
            <dl>
              <div><dt>Asset ID</dt><dd>{file.id}</dd></div>
              <div><dt>Version ID</dt><dd>{file.versionId ?? 'Missing'}</dd></div>
              <div><dt>Indexed SHA-256</dt><dd>{file.contentHash ?? 'Missing'}</dd></div>
              <div><dt>Exact size</dt><dd>{byteLabel(file.sizeBytes)}</dd></div>
              <div><dt>Full current path</dt><dd>{file.sourcePath}</dd></div>
              <div><dt>Full proposed path</dt><dd>{project.destinationPath}/{file.destinationPath}</dd></div>
            </dl>
          </details>
        </li>;
      })}</ul>
    </details>
    <details className="library-technical-details">
      <summary>Project technical details</summary>
      <dl><div><dt>Project ID</dt><dd>{project.id}</dd></div>
        <div><dt>Indexed file bytes</dt><dd>{byteLabel(project.sizeBytes)}</dd></div></dl>
    </details>
  </article>;
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
          <p className="small-note">{project.storageKind} · {project.fileCount} files · <FileSize value={project.sizeBytes} />
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
      <div className="library-plan-project-heading"><h2 id="dry-run-heading">Saved reorganization preview</h2>
        <span className="library-preview-status">Preview only · No files moved</span></div>
      <p className="small-note">Snapshot from {new Date(plan.createdAt).toLocaleString()}; it can become stale. Fresh verification is required before any future activation.</p>
      <dl className="library-preview-facts library-preview-totals">
        <div><dt>Projects in preview</dt><dd>{plan.projects.length}</dd></div>
        <div><dt>Additional copy space <span>Lower bound</span></dt><dd><FileSize value={plan.additionalBytes} /></dd></div>
        <div><dt>Available managed storage <span>At preview time</span></dt><dd><FileSize value={plan.availableBytes} /></dd></div>
      </dl>
      <p className="small-note">File contents have not been rehashed. This preview does not approve or enable migration.</p>
      <Issues items={plan.issues} />
      {plan.projects.map((project) => <ProjectPreview project={project} key={project.id}
        blockedByPlan={plan.issues.some((item) => item.severity === 'blocker')} />)}
      <details className="library-technical-details">
        <summary>Snapshot technical details</summary>
        <dl><div><dt>Snapshot ID</dt><dd>{plan.id}</dd></div>
          <div><dt>Catalog fingerprint</dt><dd>{plan.fingerprint}</dd></div>
          <div><dt>Additional copy bytes (lower bound)</dt><dd>{byteLabel(plan.additionalBytes)}</dd></div>
          <div><dt>Available storage bytes</dt><dd>{byteLabel(plan.availableBytes)}</dd></div></dl>
      </details>
    </section>}
  </main>;
}
