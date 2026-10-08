import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import type { MeshGeometry, Point3D, Triangle } from './MeshViewer.js';

type User = { id: string; username: string; role: 'operator' | 'member' | string };
type Scan = {
  state: string;
  lastSuccessfulAt?: string | null;
  lastError?: string | null;
};
type RequestStatus = 'requested' | 'queued' | 'printing' | 'completed' | 'declined' | 'canceled' | string;
type RequestSelection = {
  assetId: string;
  versionId: string | null;
  name?: string | null;
  relativePath?: string | null;
  variant?: string | null;
  available?: boolean;
  unavailableReason?: string | null;
  downloadUrl?: string | null;
};
type RequestHistoryEntry = {
  action?: string;
  status?: RequestStatus;
  toStatus?: RequestStatus | null;
  fromPosition?: number | null;
  toPosition?: number | null;
  note?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actor?: { username?: string | null } | null;
};
type PrintRequest = {
  id: string;
  projectId: string;
  projectName?: string | null;
  requester?: { username?: string | null } | null;
  status: RequestStatus;
  selected: RequestSelection[];
  quantity: number;
  material?: string | null;
  color?: string | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  sourceUnavailable?: boolean;
  history?: RequestHistoryEntry[];
};
type RequestsResponse = { items: PrintRequest[] };
type RequestResponse = { request: PrintRequest };
type QueueResponse = { items: PrintRequest[]; revision: number; selectedNextId?: string | null };
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
  versionId: string | null;
  name: string;
  relativePath: string;
  variant?: string | null;
  fileType: string;
  extension: string;
  size: number;
  available: boolean;
  clientPath?: string | null;
  downloadUrl?: string | null;
  previewUrl?: string | null;
  geometryUrl?: string | null;
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
const InteractiveMesh = lazy(() => import('./MeshViewer.js'));
const requestableFileTypes = new Set(['mesh', 'source', 'print']);

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

  const body = await response.json() as { error?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(body?.error || body?.message || `Request failed (${response.status})`, response.status);
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

function requestStatusLabel(status: RequestStatus): string {
  const labels: Record<string, string> = {
    requested: 'Requested',
    queued: 'Queued',
    printing: 'Printing',
    completed: 'Completed',
    declined: 'Declined',
    canceled: 'Canceled',
  };
  return labels[status] || status;
}

function requestHistoryLabel(entry: RequestHistoryEntry): string {
  if (entry.action === 'reorder') {
    return entry.fromPosition != null && entry.toPosition != null
      ? `Moved in queue from ${entry.fromPosition} to ${entry.toPosition}`
      : 'Queue order changed';
  }
  if (entry.action === 'select_next') return 'Next print selection changed';
  return requestStatusLabel(entry.toStatus || entry.status || entry.action || 'Updated');
}

function unavailableSourceMessage(reason?: string | null): string {
  const messages: Record<string, string> = {
    project_missing: 'The project source is no longer available.',
    asset_missing: 'The selected source file is no longer available.',
    version_missing: 'The selected file version is no longer available.',
    version_not_current: 'The selected file version is no longer current or available.',
    library_offline: 'Library storage is offline; the source cannot be checked right now.',
  };
  return messages[reason ?? ''] ?? 'One or more requested source files are no longer available.';
}

function isPoint3D(value: unknown): value is Point3D {
  return Array.isArray(value)
    && value.length === 3
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}

function parseMeshGeometry(value: unknown): MeshGeometry {
  if (!value || typeof value !== 'object') throw new Error('The preview response was invalid.');
  const response = value as { triangles?: unknown; sampled?: unknown };
  if (!Array.isArray(response.triangles) || response.triangles.length === 0 || response.triangles.length > 75_000) {
    throw new Error('No supported mesh geometry was returned.');
  }
  const triangles: Triangle[] = [];
  for (const triangle of response.triangles) {
    if (!Array.isArray(triangle) || triangle.length !== 3 || !triangle.every(isPoint3D)) {
      throw new Error('The preview contained invalid mesh geometry.');
    }
    triangles.push([triangle[0], triangle[1], triangle[2]]);
  }
  return { triangles, sampled: response.sampled === true };
}

function MeshPreview({ file }: { file: ProjectFile }) {
  const geometryUrl = safeSameOriginUrl(file.geometryUrl);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [geometry, setGeometry] = useState<MeshGeometry | null>(null);
  const [error, setError] = useState('');

  async function loadGeometry() {
    if (!geometryUrl) return;
    setLoading(true);
    setError('');
    try {
      const separator = geometryUrl.includes('?') ? '&' : '?';
      const response = await apiRequest<unknown>(`${geometryUrl}${separator}quality=interactive-v3`);
      setGeometry(parseMeshGeometry(response));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  function togglePreview() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!geometry) void loadGeometry();
  }

  if (file.fileType.toLowerCase() !== 'mesh' || !['.stl', '.3mf'].includes(file.extension.toLowerCase())) return null;
  if (!geometryUrl) {
    return <span className="mesh-unavailable" role="status">3D preview unavailable</span>;
  }

  return (
    <div className={`mesh-preview-control ${open ? 'mesh-preview-open' : ''}`}>
      <button
        aria-label={`${open ? 'Hide' : 'Explore'} 3D preview for ${file.name}`}
        className="button button-small button-outline"
        disabled={loading}
        onClick={togglePreview}
        type="button"
      >
        {loading ? 'Loading 3D…' : open ? 'Hide 3D' : 'Explore 3D'}
      </button>
      {open && loading && <p className="mesh-state" role="status">Loading 3D preview…</p>}
      {open && error && (
        <div className="mesh-error">
          <p role="alert">3D preview could not be loaded: {error}</p>
          <button className="button button-small button-quiet" onClick={() => void loadGeometry()} type="button">Retry preview</button>
        </div>
      )}
      {open && geometry && (
        <Suspense fallback={<p className="mesh-state" role="status">Starting 3D viewer…</p>}>
          <InteractiveMesh fileName={file.name} geometry={geometry} />
        </Suspense>
      )}
    </div>
  );
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
  const label = state === 'idle' || state === 'ready' || state === 'complete' || state === 'succeeded'
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

function RequestForm({ project }: { project: ProjectResponse['project'] }) {
  const printFiles = project.files
    .filter((file) => requestableFileTypes.has(file.fileType.toLowerCase()))
    .sort((left, right) => naturalCompare.compare(left.relativePath || left.name, right.relativePath || right.name));
  const selectableFiles = printFiles.filter((file) => file.available && file.versionId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quantity, setQuantity] = useState('1');
  const [material, setMaterial] = useState('');
  const [color, setColor] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleFile(fileId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedQuantity = Number(quantity);
    if (selectedIds.size === 0) {
      setError('Select at least one available file and version for this print.');
      return;
    }
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 100) {
      setError('Quantity must be a whole number from 1 to 100.');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const selected = selectableFiles
        .filter((file) => selectedIds.has(file.id))
        .map((file) => ({ assetId: file.id, versionId: file.versionId! }));
      const result = await apiRequest<RequestResponse>('/api/requests', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          selected,
          quantity: parsedQuantity,
          ...(material.trim() ? { material: material.trim() } : {}),
          ...(color.trim() ? { color: color.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      setMessage(`Request ${result.request.id} submitted. You can follow it in Requests.`);
      setSelectedIds(new Set());
      setQuantity('1');
      setMaterial('');
      setColor('');
      setNotes('');
    } catch (reason) {
      setError(`Could not submit this request: ${errorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="request-form-card" aria-labelledby="request-heading">
      <div>
        <p className="eyebrow">Ready when you are</p>
        <h2 id="request-heading">Request this print</h2>
        <p className="quiet">Choose the specific 3D files or prepared print files you need.</p>
      </div>
      {printFiles.length === 0 ? (
        <p className="notice notice-error" role="status">No requestable 3D or prepared print files were found.</p>
      ) : (
        <form className="request-form" onSubmit={submit}>
          <fieldset>
            <legend>3D files and variants <span aria-hidden="true">*</span></legend>
            <p className="field-hint">Select one or more files. Preview and download controls refer to that exact file.</p>
            <div className="request-file-options">
              {printFiles.map((file) => {
                const selectable = file.available && Boolean(file.versionId);
                const selectionLabel = `${file.name}${file.variant ? ` (${file.variant})` : ''}`;
                const downloadUrl = safeSameOriginUrl(file.downloadUrl);
                const inputId = `request-file-${file.id}`;
                return (
                  <div className={`request-file-option ${selectable ? '' : 'request-file-option-disabled'}`} key={file.id}>
                    <div className="request-file-summary">
                      <input
                        checked={selectedIds.has(file.id)}
                        disabled={!selectable || busy}
                        id={inputId}
                        onChange={() => toggleFile(file.id)}
                        type="checkbox"
                      />
                      <div className="file-icon" aria-hidden="true">{file.fileType.toUpperCase().slice(0, 4)}</div>
                      <label htmlFor={inputId}>
                        <strong>{selectionLabel}</strong>
                        <small>{file.relativePath}</small>
                        <small>{file.fileType.toUpperCase()} · {formatSize(file.size)} · {selectable ? 'Current version' : file.available ? 'No requestable version' : 'Source unavailable'}</small>
                      </label>
                      {file.available && (
                        <div className="request-file-actions">
                          <LocalPathControl label="file" path={file.clientPath} />
                          {downloadUrl
                            ? <a className="button button-small button-primary" href={downloadUrl} download>Download</a>
                            : <span className="quiet file-no-download">Download unavailable</span>}
                        </div>
                      )}
                    </div>
                    {file.available && <MeshPreview file={file} />}
                  </div>
                );
              })}
            </div>
          </fieldset>
          {selectableFiles.length === 0 && (
            <p className="notice notice-error" role="status">No current file versions can be requested right now.</p>
          )}
          <div className="request-fields">
            <label>Quantity <input aria-describedby="quantity-hint" inputMode="numeric" max={100} min={1} onChange={(event) => setQuantity(event.target.value)} required step={1} type="number" value={quantity} /></label>
            <p className="field-hint" id="quantity-hint">Whole number from 1 to 100.</p>
            <label>Material <input maxLength={100} onChange={(event) => setMaterial(event.target.value)} placeholder="Optional, e.g. PLA" value={material} /></label>
            <label>Color <input maxLength={100} onChange={(event) => setColor(event.target.value)} placeholder="Optional, e.g. sage green" value={color} /></label>
            <label className="request-notes">Notes <textarea maxLength={2000} onChange={(event) => setNotes(event.target.value)} placeholder="Optional fit, finish, or timing details" rows={3} value={notes} /></label>
          </div>
          {(error || message) && <p className={`notice ${error ? 'notice-error' : 'notice-success'}`} role={error ? 'alert' : 'status'}>{error || message}</p>}
          <button className="button button-primary" disabled={busy || selectableFiles.length === 0} type="submit">{busy ? 'Submitting…' : 'Submit print request'}</button>
        </form>
      )}
    </section>
  );
}

function RequestCard({
  request,
  isOperator,
  selectedNextId,
  onAction,
  onSelectNext,
}: {
  request: PrintRequest;
  isOperator: boolean;
  selectedNextId?: string | null;
  onAction: (request: PrintRequest, action: 'approve' | 'decline' | 'cancel' | 'start' | 'complete', note?: string) => Promise<boolean>;
  onSelectNext: (requestId: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRequest, setHistoryRequest] = useState<PrintRequest | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const status = request.status.toLowerCase();
  const canCancel = !isOperator && (status === 'requested' || status === 'queued');
  const canReview = isOperator && status === 'requested';
  const canStart = isOperator && status === 'queued' && selectedNextId === request.id;
  const canComplete = isOperator && status === 'printing';
  const requestDate = formatDate(request.createdAt || request.updatedAt);
  const history = historyRequest?.history ?? request.history ?? [];

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await apiRequest<RequestResponse>(`/api/requests/${encodeURIComponent(request.id)}`);
      setHistoryRequest(result.request);
    } catch (reason) {
      setHistoryError(`Could not load request history: ${errorMessage(reason)}`);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function act(action: 'approve' | 'decline' | 'cancel' | 'start' | 'complete') {
    setBusy(true);
    try {
      if (await onAction(request, action, note.trim() || undefined)) {
        setNote('');
        setHistoryRequest(null);
        if (historyOpen) await loadHistory();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="request-card">
      <div className="request-card-header">
        <div>
          <p className="eyebrow">{request.projectName || 'Project request'}</p>
          <h3>Request {request.id}</h3>
          {requestDate && <p className="quiet request-date">Submitted {requestDate}</p>}
        </div>
        <span className={`request-status status-${status}`}>{requestStatusLabel(request.status)}</span>
      </div>
      <dl className="request-summary">
        <div><dt>Files</dt><dd>{request.selected.length === 0 ? 'No source snapshot available' : request.selected.map((selection) => selection.relativePath || selection.name || selection.assetId).join(', ')}</dd></div>
        <div><dt>Quantity</dt><dd>{request.quantity}</dd></div>
        {request.material && <div><dt>Material</dt><dd>{request.material}</dd></div>}
        {request.color && <div><dt>Color</dt><dd>{request.color}</dd></div>}
        {request.notes && <div><dt>Notes</dt><dd className="notes-text">{request.notes}</dd></div>}
      </dl>
      {request.selected.length > 0 && <ul className="request-source-list" aria-label="Requested source snapshots">
        {request.selected.map((selection) => {
          const downloadUrl = safeSameOriginUrl(selection.downloadUrl);
          return <li key={`${selection.assetId}-${selection.versionId}`}>
            <span>{selection.name || selection.relativePath || selection.assetId}{selection.variant ? ` · ${selection.variant}` : ''}</span>
            {downloadUrl ? <a href={downloadUrl} download>Download version</a> : <small>Exact version unavailable</small>}
          </li>;
        })}
      </ul>}
      {(request.sourceUnavailable || request.selected.some((selection) => selection.available === false)) && (
        <p className="source-warning" role="status">{unavailableSourceMessage(request.selected.find((selection) => selection.unavailableReason)?.unavailableReason)}</p>
      )}
      {isOperator && (canReview || status === 'queued' || status === 'printing') && (
        <label className="operator-note">Operator note
          <input disabled={busy} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Optional note for this request" value={note} />
        </label>
      )}
      <div className="request-actions">
        {canCancel && <button className="button button-outline" disabled={busy} onClick={() => void act('cancel')} type="button">Cancel request</button>}
        {canReview && <>
          <button className="button button-primary" disabled={busy} onClick={() => void act('approve')} type="button">Approve and queue</button>
          <button className="button button-outline" disabled={busy} onClick={() => void act('decline')} type="button">Decline</button>
        </>}
        {isOperator && status === 'queued' && selectedNextId !== request.id && <button className="button button-outline" disabled={busy} onClick={() => void onSelectNext(request.id)} type="button">Choose next</button>}
        {canStart && <button className="button button-primary" disabled={busy} onClick={() => void act('start')} type="button">Mark printing</button>}
        {canComplete && <button className="button button-primary" disabled={busy} onClick={() => void act('complete')} type="button">Mark completed</button>}
      </div>
      <details className="request-history" onToggle={(event) => {
        const open = event.currentTarget.open;
        setHistoryOpen(open);
        if (open && !historyRequest && !historyLoading) void loadHistory();
      }}>
          <summary>Request history</summary>
          {historyLoading && <p role="status">Loading request history…</p>}
          {historyError && <p role="alert">{historyError} <button className="text-button" onClick={() => void loadHistory()} type="button">Retry history</button></p>}
          {!historyLoading && !historyError && history && history.length > 0 && <ol>
            {history.map((entry, index) => <li key={`${entry.createdAt || entry.updatedAt || index}-${entry.action || entry.status || ''}`}>
              <strong>{requestHistoryLabel(entry)}</strong>
              {(entry.actorName || entry.actorUsername || entry.actor?.username) && <span> by {entry.actorName || entry.actorUsername || entry.actor?.username}</span>}
              {(formatDate(entry.createdAt || entry.updatedAt)) && <time> · {formatDate(entry.createdAt || entry.updatedAt)}</time>}
              {entry.note && <p>{entry.note}</p>}
            </li>)}
          </ol>}
          {!historyLoading && !historyError && history.length === 0 && <p>No history has been recorded yet.</p>}
        </details>
    </article>
  );
}

function RequestsPage({ user }: { user: User }) {
  const isOperator = user.role === 'operator';
  const [requests, setRequests] = useState<PrintRequest[]>([]);
  const [queue, setQueue] = useState<PrintRequest[]>([]);
  const [revision, setRevision] = useState<number>();
  const [selectedNextId, setSelectedNextId] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [queueDirty, setQueueDirty] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const requestsResult = await apiRequest<RequestsResponse>('/api/requests');
      setRequests(requestsResult.items);
      if (isOperator) {
        const queueResult = await apiRequest<QueueResponse>('/api/requests/queue');
        setQueue(queueResult.items);
        setRevision(queueResult.revision);
        setSelectedNextId(queueResult.selectedNextId ?? null);
        setQueueDirty(false);
      }
    } catch (reason) {
      setError(`Could not load requests: ${errorMessage(reason)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [isOperator, refresh]);

  async function refreshAfterConflict() {
    setMessage('The queue changed elsewhere, so the latest queue has been loaded.');
    setRefresh((value) => value + 1);
  }

  async function performAction(request: PrintRequest, action: 'approve' | 'decline' | 'cancel' | 'start' | 'complete', note?: string) {
    setError('');
    setMessage('');
    if (isOperator && queueDirty) {
      setError('Save queue order before updating requests.');
      return false;
    }
    if (queueBusy) {
      setError('Wait for the queue update before changing a request.');
      return false;
    }
    try {
      await apiRequest<RequestResponse>(`/api/requests/${encodeURIComponent(request.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action,
          ...(note ? { note } : {}),
          ...(revision !== undefined && action !== 'cancel' ? { expectedRevision: revision } : {}),
        }),
      });
      const outcome = {
        approve: 'approved and queued', decline: 'declined', cancel: 'canceled',
        start: 'started printing', complete: 'completed',
      }[action];
      setMessage(`Request ${request.id} ${outcome}.`);
      setRefresh((value) => value + 1);
      return true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        await refreshAfterConflict();
        return false;
      }
      setError(`Could not update request: ${errorMessage(reason)}`);
      return false;
    }
  }

  async function chooseNext(requestId: string) {
    if (revision === undefined) return;
    if (queueDirty) {
      setError('Save queue order before choosing the next print.');
      return;
    }
    if (queueBusy) return;
    setQueueBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await apiRequest<QueueResponse>('/api/requests/queue/next', {
        method: 'POST',
        body: JSON.stringify({ requestId, expectedRevision: revision }),
      });
      setQueue(result.items);
      setRevision(result.revision);
      setSelectedNextId(result.selectedNextId ?? requestId);
      setMessage('Next print updated.');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) await refreshAfterConflict();
      else setError(`Could not choose the next print: ${errorMessage(reason)}`);
    } finally {
      setQueueBusy(false);
    }
  }

  function moveQueueItem(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= queue.length) return;
    setQueue((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    setQueueDirty(true);
  }

  async function saveQueueOrder() {
    if (revision === undefined) return;
    setQueueBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await apiRequest<QueueResponse>('/api/requests/queue', {
        method: 'PUT',
        body: JSON.stringify({ orderedIds: queue.map((request) => request.id), expectedRevision: revision }),
      });
      setQueue(result.items);
      setRevision(result.revision);
      setSelectedNextId(result.selectedNextId ?? null);
      setQueueDirty(false);
      setMessage('Queue order saved.');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) await refreshAfterConflict();
      else setError(`Could not reorder the queue: ${errorMessage(reason)}`);
    } finally {
      setQueueBusy(false);
    }
  }

  if (loading) return <section className="requests-state" aria-live="polite"><span className="spinner" />Loading requests…</section>;
  if (error && requests.length === 0) return <section className="requests-state"><p className="notice notice-error" role="alert">{error}</p><button className="button button-outline" onClick={() => setRefresh((value) => value + 1)} type="button">Try again</button></section>;

  return (
    <main className="content-wrap requests-page">
      <section className="requests-heading">
        <div><p className="eyebrow">{isOperator ? 'Operator workspace' : 'Your print plans'}</p><h1>{isOperator ? 'Print queue' : 'Your requests'}</h1><p>{isOperator ? 'Review requests, set the queue order, and record each print’s progress.' : 'Follow your print requests from submission through completion.'}</p></div>
        <button className="button button-outline" disabled={queueBusy} onClick={() => setRefresh((value) => value + 1)} type="button">Refresh</button>
      </section>
      {(error || message) && <p className={`notice ${error ? 'notice-error' : 'notice-success'}`} role={error ? 'alert' : 'status'}>{error || message}</p>}
      {isOperator && <section className="queue-panel" aria-labelledby="queue-heading">
        <div className="section-heading"><div><p className="eyebrow">Current work</p><h2 id="queue-heading">Queue order</h2></div>{queueDirty && <button className="button button-primary" disabled={queueBusy} onClick={() => void saveQueueOrder()} type="button">Save queue order</button>}</div>
        {queue.length === 0 ? <p className="empty-note">No approved prints are waiting in the queue.</p> : <ol className="queue-list">
          {queue.map((request, index) => <li key={request.id}>
            <span className="queue-position">{index + 1}</span>
            <span className="queue-title"><strong>{request.projectName || request.id}</strong><small>Request {request.id.slice(0, 8)} · {request.requester?.username || 'Household member'} · {request.quantity} · {request.selected.map((selection) => selection.name || selection.relativePath || selection.assetId).join(', ')}</small></span>
            {selectedNextId === request.id && <span className="next-badge">Next</span>}
            <span className="queue-controls"><button aria-label={`Move ${request.id} earlier`} className="button button-small button-quiet" disabled={queueBusy || index === 0} onClick={() => moveQueueItem(index, -1)} type="button">↑</button><button aria-label={`Move ${request.id} later`} className="button button-small button-quiet" disabled={queueBusy || index === queue.length - 1} onClick={() => moveQueueItem(index, 1)} type="button">↓</button></span>
          </li>)}
        </ol>}
      </section>}
      <section className="request-list-section" aria-labelledby="all-requests-heading">
        <div className="section-heading"><div><p className="eyebrow">{isOperator ? 'Household requests' : 'Request history'}</p><h2 id="all-requests-heading">{requests.length} {requests.length === 1 ? 'request' : 'requests'}</h2></div></div>
        {requests.length === 0 ? <p className="empty-note">{isOperator ? 'New requests will appear here for review.' : 'When you request a print, its progress will appear here.'}</p> : <div className="request-list">{requests.map((request) => <RequestCard key={request.id} isOperator={isOperator} onAction={performAction} onSelectNext={chooseNext} request={request} selectedNextId={selectedNextId} />)}</div>}
      </section>
    </main>
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
  const otherFiles = files.filter((file) => !requestableFileTypes.has(file.fileType.toLowerCase()));
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
          <RequestForm project={project} />
          {otherFiles.length > 0 && <section className="files-section" aria-labelledby="files-heading">
            <div className="section-heading">
              <div><p className="eyebrow">Reference material</p><h2 id="files-heading">Other Files</h2></div>
              <span className="quiet">{otherFiles.length} {otherFiles.length === 1 ? 'file' : 'files'}</span>
            </div>
            <ul className="file-list">
                {otherFiles.map((file) => {
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
              </ul>
          </section>}
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

function RoutedApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const projectMatch = matchPath('/projects/:projectId', location.pathname);
  const selectedProjectId = projectMatch?.params.projectId ?? null;
  const activeView = location.pathname === '/requests' || location.pathname === '/queue' ? 'requests' : 'library';
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
  const [scan, setScan] = useState<Scan>();
  const [rescanBusy, setRescanBusy] = useState(false);
  const [rescanError, setRescanError] = useState('');
  const [rescanMessage, setRescanMessage] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const catalogEndRef = useRef<HTMLDivElement>(null);

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
    const knownPath = location.pathname === '/' || location.pathname === '/requests' || location.pathname === '/queue'
      || Boolean(projectMatch);
    if (!knownPath) navigate('/', { replace: true });
  }, [location.pathname, navigate, projectMatch]);

  useEffect(() => {
    if (!user || selectedProjectId || activeView !== 'library') return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: searchTerm,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (category) params.set('category', category);
    if (fileType) params.set('fileType', fileType);
    setCatalogLoading(true);
    setCatalogError('');
    apiRequest<CatalogResponse>(`/api/catalog/projects?${params}`, { signal: controller.signal })
      .then((result) => {
        setCatalog((current) => {
          if (page === 1 || !current) return result;
          const existingIds = new Set(current.items.map((project) => project.id));
          return {
            ...result,
            items: [...current.items, ...result.items.filter((project) => !existingIds.has(project.id))],
          };
        });
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
  }, [user, selectedProjectId, activeView, searchTerm, category, fileType, page, catalogRefresh]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((catalog?.total || 0) / pageSize)),
    [catalog?.total],
  );

  useEffect(() => {
    const target = catalogEndRef.current;
    if (!target || !user || selectedProjectId || activeView !== 'library' || catalogLoading
      || page >= totalPages || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        setPage((current) => Math.min(totalPages, current + 1));
      }
    }, { rootMargin: '500px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeView, catalogLoading, page, selectedProjectId, totalPages, user]);

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
      navigate('/');
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
      setPage(1);
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
        <Link className="brand" to="/" aria-label="Print Pantry home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span>Print Pantry</span>
        </Link>
        <nav className="topbar-nav" aria-label="Main navigation">
          <Link className={activeView === 'library' ? 'nav-link active' : 'nav-link'} to="/">Library</Link>
          <Link className={activeView === 'requests' ? 'nav-link active' : 'nav-link'} to={user.role === 'operator' ? '/queue' : '/requests'}>{user.role === 'operator' ? 'Queue' : 'Requests'}</Link>
        </nav>
        <div className="account-menu">
          <span className="user-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.username}<small>{user.role}</small></span>
          <button className="button button-quiet signout-button" disabled={authBusy} onClick={() => void logout()} type="button">Sign out</button>
        </div>
      </header>

      {authError && <div className="global-notice notice-error" role="alert">{authError}</div>}
      {connectionError && <div className="global-notice notice-error" role="alert">{connectionError}</div>}

      {activeView === 'requests'
        ? <RequestsPage user={user} />
        : selectedProjectId
        ? <main className="content-wrap">
          <ProjectDetail
            projectId={selectedProjectId}
            user={user}
            scan={scan}
            onBack={() => navigate('/')}
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
            {catalogLoading && !catalogError && !catalog && (
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
            {!catalogError && catalog && catalog.items.length > 0 && (
              <>
                <div className="project-grid">
                  {catalog.items.map((project) => (
                    <ProjectCard key={project.id} project={project} onOpen={() => navigate(`/projects/${project.id}`)} />
                  ))}
                </div>
                <div className="catalog-load-more" ref={catalogEndRef}>
                  {catalogLoading
                    ? <><span className="spinner" /><span role="status">Loading more projects…</span></>
                    : page < totalPages
                    ? <button className="button button-outline" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">Load more</button>
                    : <span>All {catalog.total} projects loaded</span>}
                  <small>{catalog.items.length} of {catalog.total}</small>
                </div>
              </>
            )}
          </section>
          <footer className="app-footer"><span>Print Pantry</span><span>Made with care for makers.</span></footer>
        </main>}
    </div>
  );
}

function App() {
  return <BrowserRouter><RoutedApp /></BrowserRouter>;
}

export { App };
