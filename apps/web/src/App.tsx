import { useEffect, useMemo, useState } from 'react';

type User = { id: string; username: string; role: 'operator' | 'member' | string };
type Scan = {
  state: string;
  lastSuccessfulAt?: string | null;
  lastError?: string | null;
};
type Project = {
  id: string;
  name: string;
  category?: string | null;
  subcategory?: string | null;
  description?: string | null;
  tags?: string[];
  previewUrl?: string | null;
  available: boolean;
  assetCount: number;
  clientPath?: string | null;
  designer?: string | null;
  sourceUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  isBoundary?: boolean;
};
type ProjectFile = {
  id: string;
  versionId: string;
  name: string;
  relativePath: string;
  variant?: string | null;
  fileType: string;
  size: number;
  available: boolean;
  clientPath?: string | null;
  downloadUrl?: string | null;
  previewUrl?: string | null;
};
type CatalogResponse = {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
  fileTypes: string[];
  scan: Scan;
};
type ProjectResponse = { project: Project & { files: ProjectFile[] } };
type ScanResponse = { scan: Scan };

const pageSize = 12;
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;

  const body = await response.json() as { message?: string };
  if (!response.ok) {
    throw new ApiError(body?.message || `Request failed (${response.status})`, response.status);
  }
  return body as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function safeSameOriginUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : undefined;
  } catch {
    return undefined;
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
}

function formatDate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function LoginForm({
  onLogin,
  busy,
  error,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
  busy: boolean;
  error: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onLogin(username.trim(), password);
  }

  return (
    <main className="login-shell">
      <a className="brand" href="/" aria-label="Print Pantry home">
        <span className="brand-mark" aria-hidden="true">P</span>
        <span>Print Pantry</span>
      </a>
      <section className="login-card" aria-labelledby="login-heading">
        <span className="eyebrow">A little room for big ideas</span>
        <h1 id="login-heading">Welcome to the pantry</h1>
        <p>Sign in to browse your household’s print projects.</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <form className="login-form" onSubmit={submit}>
          <label>
            Username
            <input
              autoComplete="username"
              name="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              name="password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="button button-primary button-wide" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="quiet login-note">Ask your household operator for an account if you need one.</p>
      </section>
      <footer className="login-footer">Made for keeping good projects close.</footer>
    </main>
  );
}

function ScanBadge({ scan }: { scan?: Scan }) {
  if (!scan) return <span className="scan-badge scan-unknown">Scan status unavailable</span>;
  const state = scan.state.toLowerCase();
  const className = state.includes('error') || state.includes('fail') || state.includes('offline')
    ? 'scan-error'
    : state.includes('scan') || state.includes('running')
      ? 'scan-running'
      : 'scan-ready';
  const date = formatDate(scan.lastSuccessfulAt);
  const label = state === 'idle' || state === 'ready' || state === 'complete'
    ? `Library ${date ? `checked ${date}` : 'ready'}`
    : scan.state;
  return (
    <span className={`scan-badge ${className}`} title={scan.lastError || undefined}>
      <span className="scan-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const previewUrl = safeSameOriginUrl(project.previewUrl);
  return (
    <article className="project-card">
      <button className="project-card-button" onClick={onOpen} type="button" aria-label={`Open ${project.name}`}>
        <span className="project-image">
          {previewUrl
            ? <img alt="" loading="lazy" decoding="async" src={previewUrl} />
            : <span className="image-placeholder" aria-hidden="true"><span>✳</span><small>Preview coming soon</small></span>}
          {!project.available && <span className="image-unavailable">Files unavailable</span>}
        </span>
        <span className="project-card-copy">
          <span className="project-category">{[project.category, project.subcategory].filter(Boolean).join(' / ') || 'Uncategorized'}</span>
          <span className="project-name">{project.name}</span>
          <span className="project-description">{project.description || 'A project from your household library.'}</span>
          <span className="project-card-foot">
            <span>{project.assetCount} {project.assetCount === 1 ? 'file' : 'files'}</span>
            {project.tags?.[0] && <span className="tag">{project.tags[0]}</span>}
          </span>
        </span>
      </button>
    </article>
  );
}

function LocalPathControl({ path, label }: { path?: string | null; label: string }) {
  const [message, setMessage] = useState('');
  const [showFallback, setShowFallback] = useState(false);
  const [copying, setCopying] = useState(false);

  async function copyPath() {
    if (!path) return;
    setCopying(true);
    setMessage('');
    setShowFallback(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(path);
      setMessage(`${label} path copied.`);
    } catch {
      setMessage('Clipboard access was blocked. Select the path below and copy it manually.');
      setShowFallback(true);
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="path-control">
      <button className="button button-quiet" disabled={!path || copying} onClick={() => void copyPath()} type="button">
        {copying ? 'Copying…' : `Copy ${label} path`}
      </button>
      {message && <span className="path-feedback" role="status">{message}</span>}
      {showFallback && path && (
        <label className="fallback-path">
          Local path — select and copy
          <input aria-label="Local path to copy manually" onFocus={(event) => event.currentTarget.select()} readOnly value={path} />
        </label>
      )}
    </div>
  );
}

function MetadataEditor({
  project,
  onSave,
  busy,
  onCancel,
}: {
  project: Project;
  onSave: (metadata: Pick<Project, 'description' | 'tags' | 'designer' | 'sourceUrl' | 'license' | 'notes'>) => Promise<void>;
  busy: boolean;
  onCancel: () => void;
}) {
  const [designer, setDesigner] = useState(project.designer || '');
  const [sourceUrl, setSourceUrl] = useState(project.sourceUrl || '');
  const [license, setLicense] = useState(project.license || '');
  const [notes, setNotes] = useState(project.notes || '');
  const [description, setDescription] = useState(project.description || '');
  const [tags, setTags] = useState((project.tags || []).join(', '));

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave({
      description,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      designer,
      sourceUrl,
      license,
      notes,
    });
  }

  return (
    <form className="metadata-form" onSubmit={submit}>
      <h3>Edit project metadata</h3>
      <label>Description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Tags <span className="quiet">(comma separated)</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <label>Designer<input value={designer} onChange={(event) => setDesigner(event.target.value)} /></label>
      <label>Source URL<input inputMode="url" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /></label>
      <label>License<input value={license} onChange={(event) => setLicense(event.target.value)} /></label>
      <label>Notes<textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <div className="form-actions">
        <button className="button button-primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save metadata'}</button>
        <button className="button button-quiet" onClick={onCancel} type="button">Cancel</button>
      </div>
    </form>
  );
}

function ProjectDetail({
  projectId,
  user,
  scan,
  onBack,
}: {
  projectId: string;
  user: User;
  scan?: Scan;
  onBack: () => void;
}) {
  const [project, setProject] = useState<ProjectResponse['project'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const isOperator = user.role === 'operator';

  async function loadProject(signal?: AbortSignal) {
    const result = await apiRequest<ProjectResponse>(`/api/catalog/projects/${encodeURIComponent(projectId)}`, { signal });
    setProject(result.project);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setProject(null);
    loadProject(controller.signal)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);

  async function saveMetadata(metadata: Pick<Project, 'description' | 'tags' | 'designer' | 'sourceUrl' | 'license' | 'notes'>) {
    setActionBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      await apiRequest(`/api/catalog/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify(metadata),
      });
      await loadProject();
      setEditing(false);
      setActionMessage('Project metadata saved.');
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionBusy(false);
    }
  }

  async function toggleBoundary() {
    if (!project) return;
    setActionBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      await apiRequest('/api/catalog/boundaries', {
        method: 'PUT',
        body: JSON.stringify({ projectId: project.id, isBoundary: !project.isBoundary }),
      });
      await loadProject();
      setActionMessage(project.isBoundary ? 'Project boundary override removed.' : 'Project marked as a boundary.');
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) {
    return <section className="detail-state" aria-live="polite"><span className="spinner" />Loading project…</section>;
  }
  if (error) {
    return (
      <section className="detail-state">
        <p className="notice notice-error" role="alert">Could not load this project: {error}</p>
        <button className="button button-quiet" onClick={onBack} type="button">Back to projects</button>
      </section>
    );
  }
  if (!project) return null;

  const previewUrl = safeSameOriginUrl(project.previewUrl);
  const files = [...(project.files || [])].sort((left, right) =>
    naturalCompare.compare(left.relativePath || left.name, right.relativePath || right.name));
  const sourceUrl = project.sourceUrl && /^https?:\/\//i.test(project.sourceUrl) ? project.sourceUrl : undefined;

  return (
    <section className="project-detail" aria-labelledby="detail-title">
      <button className="back-link" onClick={onBack} type="button"><span aria-hidden="true">←</span> All projects</button>
      <div className="detail-heading">
        <div>
          <p className="project-category">{[project.category, project.subcategory].filter(Boolean).join(' / ') || 'Uncategorized'}</p>
          <h1 id="detail-title">{project.name}</h1>
          <p className="detail-description">{project.description || 'No description has been added yet.'}</p>
        </div>
        {isOperator && (
          <div className="operator-actions">
            <button className="button button-quiet" disabled={actionBusy} onClick={() => setEditing((value) => !value)} type="button">
              {editing ? 'Close editor' : 'Edit metadata'}
            </button>
            <button className="button button-quiet" disabled={actionBusy} onClick={() => void toggleBoundary()} type="button">
              {project.isBoundary ? 'Remove boundary override' : 'Set project boundary'}
            </button>
          </div>
        )}
      </div>
      {(actionError || actionMessage) && (
        <p className={`notice ${actionError ? 'notice-error' : 'notice-success'}`} role={actionError ? 'alert' : 'status'}>
          {actionError || actionMessage}
        </p>
      )}
      {editing && isOperator && (
        <MetadataEditor project={project} onSave={saveMetadata} busy={actionBusy} onCancel={() => setEditing(false)} />
      )}

      <div className="detail-layout">
        <div className="detail-main">
          <div className="detail-preview">
            {previewUrl
              ? <img alt={`Preview of ${project.name}`} src={previewUrl} />
              : <div className="image-placeholder detail-placeholder"><span aria-hidden="true">✳</span><small>No preview image available</small></div>}
          </div>
          <section className="files-section" aria-labelledby="files-heading">
            <div className="section-heading">
              <div><p className="eyebrow">The project</p><h2 id="files-heading">Files &amp; variants</h2></div>
              <span className="quiet">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            </div>
            {files.length === 0
              ? <p className="empty-note">No associated files were found for this project.</p>
              : <ul className="file-list">
                {files.map((file) => {
                  const downloadUrl = safeSameOriginUrl(file.downloadUrl);
                  return (
                    <li className={`file-row ${file.available ? '' : 'file-row-unavailable'}`} key={file.id}>
                      <div className="file-icon" aria-hidden="true">{file.fileType.toUpperCase().slice(0, 4)}</div>
                      <div className="file-copy">
                        <strong>{file.name}</strong>
                        <span className="file-path">{file.relativePath}</span>
                        <span className="file-meta">{file.fileType.toUpperCase()} · {formatSize(file.size)}{file.variant ? ` · ${file.variant}` : ''}</span>
                      </div>
                      {file.available
                        ? <div className="file-actions">
                          <LocalPathControl label="file" path={file.clientPath} />
                          {downloadUrl
                            ? <a className="button button-small button-primary" href={downloadUrl} download>Download</a>
                            : <span className="quiet file-no-download">Download unavailable</span>}
                        </div>
                        : <span className="unavailable-label">Source unavailable</span>}
                    </li>
                  );
                })}
              </ul>}
          </section>
        </div>
        <aside className="detail-aside" aria-label="Project information">
          <section className="info-card">
            <div className="info-card-header"><h2>Project info</h2><span className={project.available ? 'availability available' : 'availability unavailable'}>{project.available ? 'Available' : 'Unavailable'}</span></div>
            <dl>
              <div><dt>Category</dt><dd>{[project.category, project.subcategory].filter(Boolean).join(' / ') || 'Uncategorized'}</dd></div>
              {project.designer && <div><dt>Designer</dt><dd>{project.designer}</dd></div>}
              {project.license && <div><dt>License</dt><dd>{project.license}</dd></div>}
              {sourceUrl && <div><dt>Source</dt><dd><a href={sourceUrl} rel="noreferrer" target="_blank">{sourceUrl}</a></dd></div>}
              {project.notes && <div><dt>Notes</dt><dd className="notes-text">{project.notes}</dd></div>}
            </dl>
            <LocalPathControl label="project" path={project.clientPath} />
            {project.available && files.length === 0 && <p className="quiet small-note">Files may not be available yet. Check the library scan status.</p>}
          </section>
          <section className="info-card scan-card">
            <h2>Library status</h2>
            <ScanBadge scan={scan} />
            {scan?.lastError && <p className="scan-error-copy">{scan.lastError}</p>}
          </section>
          {project.tags && project.tags.length > 0 && (
            <section className="info-card">
              <h2>Tags</h2>
              <div className="tag-list">{project.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [category, setCategory] = useState('');
  const [fileType, setFileType] = useState('');
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan>();
  const [rescanBusy, setRescanBusy] = useState(false);
  const [rescanError, setRescanError] = useState('');
  const [rescanMessage, setRescanMessage] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ user: User }>('/api/auth/me', { signal: controller.signal })
      .then((result) => setUser(result.user))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) {
          setUser(null);
          return;
        }
        setConnectionError(`Household service unavailable: ${errorMessage(reason)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAuthLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!user || selectedProjectId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: searchTerm,
      category,
      fileType,
      page: String(page),
      pageSize: String(pageSize),
    });
    setCatalogLoading(true);
    setCatalogError('');
    apiRequest<CatalogResponse>(`/api/catalog/projects?${params}`, { signal: controller.signal })
      .then((result) => {
        setCatalog(result);
        setScan(result.scan);
        setConnectionError('');
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogError(errorMessage(reason));
        setConnectionError('Catalog service unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [user, selectedProjectId, searchTerm, category, fileType, page, catalogRefresh]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((catalog?.total || 0) / pageSize)),
    [catalog?.total],
  );

  async function login(username: string, password: string) {
    setAuthBusy(true);
    setAuthError('');
    setConnectionError('');
    try {
      const result = await apiRequest<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setUser(result.user);
    } catch (reason) {
      setAuthError(errorMessage(reason));
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    setAuthBusy(true);
    setAuthError('');
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setCatalog(null);
      setSelectedProjectId(null);
    } catch (reason) {
      setAuthError(`Could not sign out: ${errorMessage(reason)}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function rescan() {
    setRescanBusy(true);
    setRescanError('');
    setRescanMessage('');
    try {
      const result = await apiRequest<ScanResponse>('/api/catalog/rescan', { method: 'POST' });
      setScan(result.scan);
      setRescanMessage('Library rescan started.');
      setCatalogRefresh((value) => value + 1);
    } catch (reason) {
      setRescanError(errorMessage(reason));
    } finally {
      setRescanBusy(false);
    }
  }

  if (authLoading) {
    return <main className="loading-shell" aria-live="polite"><span className="spinner" />Checking household session…</main>;
  }
  if (!user) {
    return (
      <LoginForm
        onLogin={login}
        busy={authBusy}
        error={authError || connectionError}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); setSelectedProjectId(null); }} aria-label="Print Pantry home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span>Print Pantry</span>
        </a>
        <nav className="topbar-nav" aria-label="Main navigation">
          <a className={!selectedProjectId ? 'nav-link active' : 'nav-link'} href="#projects" onClick={(event) => { event.preventDefault(); setSelectedProjectId(null); }}>Library</a>
          <span className="nav-link nav-muted" aria-disabled="true" title="Print requests are coming soon">Print requests <span className="soon-label">Soon</span></span>
        </nav>
        <div className="account-menu">
          <span className="user-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.username}<small>{user.role}</small></span>
          <button className="button button-quiet signout-button" disabled={authBusy} onClick={() => void logout()} type="button">Sign out</button>
        </div>
      </header>

      {authError && <div className="global-notice notice-error" role="alert">{authError}</div>}
      {connectionError && <div className="global-notice notice-error" role="alert">{connectionError}</div>}

      {selectedProjectId
        ? <main className="content-wrap">
          <ProjectDetail
            projectId={selectedProjectId}
            user={user}
            scan={scan}
            onBack={() => setSelectedProjectId(null)}
          />
        </main>
        : <main className="content-wrap" id="projects">
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">Your household’s print library</span>
              <h1>Find your next<br /><em>favorite project.</em></h1>
              <p>All the things you could make, gathered in one thoughtful little corner.</p>
            </div>
            <div className="hero-art" aria-hidden="true">
              <span className="orbit orbit-one" /><span className="orbit orbit-two" />
              <span className="art-shape art-shape-one">✳</span><span className="art-shape art-shape-two">◉</span>
              <span className="art-shape art-shape-three">⌂</span>
              <span className="hero-art-caption">made to be made</span>
            </div>
          </section>

          <section className="catalog-section" aria-labelledby="catalog-heading">
            <div className="catalog-title-row">
              <div>
                <p className="eyebrow">The collection</p>
                <h2 id="catalog-heading">Browse projects</h2>
              </div>
              <div className="catalog-actions">
                <ScanBadge scan={scan} />
                {user.role === 'operator' && (
                  <button className="button button-outline" disabled={rescanBusy} onClick={() => void rescan()} type="button">
                    {rescanBusy ? 'Scanning…' : '↻ Rescan library'}
                  </button>
                )}
              </div>
            </div>
            {(rescanError || rescanMessage) && (
              <p className={`notice ${rescanError ? 'notice-error' : 'notice-success'}`} role={rescanError ? 'alert' : 'status'}>
                {rescanError || rescanMessage}
              </p>
            )}

            <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearchTerm(searchText.trim()); }}>
              <label className="search-field">
                <span aria-hidden="true" className="search-icon">⌕</span>
                <input
                  aria-label="Search projects"
                  placeholder="Search projects, files, and tags…"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
                {searchText && <button aria-label="Clear search text" className="clear-search" onClick={() => { setSearchText(''); setSearchTerm(''); setPage(1); }} type="button">×</button>}
              </label>
              <label className="filter-select">
                <span className="sr-only">Filter by category</span>
                <select aria-label="Filter by category" onChange={(event) => { setCategory(event.target.value); setPage(1); }} value={category}>
                  <option value="">All categories</option>
                  {(catalog?.categories || []).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="filter-select">
                <span className="sr-only">Filter by file type</span>
                <select aria-label="Filter by file type" onChange={(event) => { setFileType(event.target.value); setPage(1); }} value={fileType}>
                  <option value="">All file types</option>
                  {(catalog?.fileTypes || []).map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
                </select>
              </label>
              <button className="button button-primary search-button" type="submit">Search</button>
            </form>

            <div className="result-line">
              <span>{catalog ? `${catalog.total} ${catalog.total === 1 ? 'project' : 'projects'}` : 'Projects'}</span>
              {(searchTerm || category || fileType) && (
                <button className="text-button" onClick={() => { setSearchText(''); setSearchTerm(''); setCategory(''); setFileType(''); setPage(1); }} type="button">
                  Clear filters
                </button>
              )}
            </div>

            {catalogError && (
              <div className="catalog-state state-error" role="alert">
                <span className="state-illustration" aria-hidden="true">!</span>
                <h3>We couldn’t reach the library</h3>
                <p>{catalogError}</p>
                <button className="button button-outline" onClick={() => setCatalogRefresh((value) => value + 1)} type="button">Try again</button>
              </div>
            )}
            {catalogLoading && !catalogError && (
              <div className="catalog-state" aria-live="polite"><span className="spinner" /><p>Gathering your projects…</p></div>
            )}
            {!catalogLoading && !catalogError && catalog && catalog.items.length === 0 && (
              <div className="catalog-state">
                <span className="state-illustration" aria-hidden="true">⌕</span>
                <h3>{searchTerm || category || fileType ? 'No projects match those filters' : 'Your library is ready for a first project'}</h3>
                <p>{searchTerm || category || fileType ? 'Try a different search or clear a filter.' : 'When projects are added and indexed, they’ll show up here.'}</p>
                {(searchTerm || category || fileType) && <button className="button button-outline" onClick={() => { setSearchText(''); setSearchTerm(''); setCategory(''); setFileType(''); setPage(1); }} type="button">Clear filters</button>}
              </div>
            )}
            {!catalogLoading && !catalogError && catalog && catalog.items.length > 0 && (
              <>
                <div className="project-grid">
                  {catalog.items.map((project) => (
                    <ProjectCard key={project.id} project={project} onOpen={() => setSelectedProjectId(project.id)} />
                  ))}
                </div>
                <nav className="pagination" aria-label="Project pages">
                  <button className="button button-quiet" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">← Previous</button>
                  <span>Page <strong>{catalog.page || page}</strong> of <strong>{totalPages}</strong></span>
                  <button className="button button-quiet" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">Next →</button>
                </nav>
              </>
            )}
          </section>
          <footer className="app-footer"><span>Print Pantry</span><span>Made with care for makers.</span></footer>
        </main>}
    </div>
  );
}

export { App };
