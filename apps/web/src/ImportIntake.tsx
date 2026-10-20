import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ImportIntakeResult, ImportMetadata, ImportPlanFile, ImportRequest } from '@print-pantry/contracts';

class IntakeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function intakeRequest(path: string, init?: RequestInit): Promise<ImportIntakeResult> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new IntakeError(`Import request failed (HTTP ${response.status}): the server returned a non-JSON response. Check the API/proxy logs and upload limits.`, response.status);
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object'
      ? 'message' in body && typeof body.message === 'string' ? body.message
        : 'error' in body && typeof body.error === 'string' ? body.error : null
      : null;
    throw new IntakeError(detail || `Request failed (${response.status})`, response.status);
  }
  return body as ImportIntakeResult;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function ImportFileSections({ files, onFileChange }: {
  files: ImportPlanFile[];
  onFileChange?: (id: string, change: { include: boolean } | { path: string }) => void;
}) {
  return <div className="import-plan-groups">
    {[true, false].map((include) => {
      const group = files.filter((file) => file.include === include);
      const label = include ? 'Included' : 'Excluded';
      return <section className="import-file-section" aria-label={`${label} files`} key={label}>
        <h5>{label} ({group.length})</h5>
        {!include && group.length > 0 && <p className="small-note quiet">Retained in original uploads; not published to the library.</p>}
        {group.length === 0 ? <p className="small-note quiet">No {label.toLowerCase()} files.</p> :
          <ul className="import-plan-files">{group.map((file) => <li className="import-plan-file" key={file.id}>
            {onFileChange ? <>
              <label className="import-include"><input type="checkbox" checked={file.include} onChange={(event) => onFileChange(file.id, { include: event.target.checked })} />Include {file.originalPath}</label>
              <span className="small-note quiet">{file.kind} · {file.size} bytes</span>
              {include && <label>Proposed path for {file.originalPath}<input required value={file.path} onChange={(event) => onFileChange(file.id, { path: event.target.value })} /></label>}
            </> : <>
              <span className="import-source">{file.originalPath}</span>
              {include && <span className="small-note quiet import-source">→ {file.path}</span>}
            </>}
          </li>)}</ul>}
      </section>;
    })}
  </div>;
}

export function ImportIntake({ item, onChanged }: { item: ImportRequest; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ImportIntakeResult | null>(null);
  const current = useRef<ImportIntakeResult | null>(null);
  const [metadata, setMetadata] = useState<ImportMetadata>({
    name: item.title || '', category: null, description: null, designer: null, license: null, notes: null, tags: [],
  });
  const [tags, setTags] = useState('');
  const [files, setFiles] = useState<ImportPlanFile[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const uploadKeys = useRef(new Map<string, string>());
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/imports/${encodeURIComponent(item.id)}`;
  const locked = ['publishing', 'catalog_pending', 'imported'].includes(item.status) || Boolean(result?.intake.publishedPath);
  const recovering = ['publishing', 'catalog_pending'].includes(item.status);

  function apply(next: ImportIntakeResult) {
    current.current = next;
    setResult(next);
    setFiles(next.intake.plan?.files || []);
    if (next.intake.plan) {
      setMetadata(next.intake.plan.metadata);
      setTags(next.intake.plan.metadata.tags.join(', '));
    }
    setDirty(false);
    setConfirmed(false);
  }

  useEffect(() => {
    if (!open || current.current?.revision === item.revision) return;
    let canceled = false;
    setBusy(true);
    intakeRequest(`${base}/intake`).then((next) => {
      if (!canceled) apply(next);
    }).catch((reason: unknown) => {
      if (!canceled) setError(errorMessage(reason));
    }).finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; };
  }, [open, item.revision, base]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      let detail = errorMessage(reason);
      if (reason instanceof IntakeError && reason.status === 409) {
        detail += ' This import changed. Latest intake and request state refreshed; review before retrying.';
        try { apply(await intakeRequest(`${base}/intake`)); }
        catch (refreshError) { detail += ` Intake refresh failed: ${errorMessage(refreshError)}`; }
      }
      onChanged();
      setError(detail);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(endpoint: string, payload: object = {}, method = 'POST') {
    const next = await intakeRequest(`${base}/${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, expectedRevision: current.current?.revision ?? item.revision }),
    });
    apply(next);
    onChanged();
  }

  async function upload() {
    for (const file of pending) {
      const name = file.webkitRelativePath || file.name;
      const identity = JSON.stringify([name, file.size, file.lastModified, file.type]);
      let key = uploadKeys.current.get(identity);
      if (!key) { key = crypto.randomUUID(); uploadKeys.current.set(identity, key); }
      const query = new URLSearchParams({ name, uploadKey: key, expectedRevision: String(current.current?.revision ?? item.revision) });
      const next = await intakeRequest(`${base}/files?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      apply(next);
      setPending((remaining) => remaining.filter((candidate) => candidate !== file));
    }
    onChanged();
  }

  function edited() { setDirty(true); setConfirmed(false); }
  function updateFile(id: string, change: { include: boolean } | { path: string }) {
    setFiles((previous) => previous.map((file) => file.id === id ? { ...file, ...change } : file));
    edited();
  }
  function field(key: keyof Omit<ImportMetadata, 'tags'>, value: string) {
    setMetadata((previous) => ({ ...previous, [key]: key === 'name' ? value : value || null }));
    edited();
  }
  const plan = result?.intake.plan;
  const canEdit = !busy && !locked && Boolean(result?.intake.configured && result.intake.prepared);
  const projectId = result?.projectId || item.projectId;

  return <section className="import-intake" aria-label="Manual import intake">
    <button className="button button-outline" type="button" disabled={busy} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? 'Hide import workspace' : 'Open import workspace'}
    </button>
    {open && <>
      <h4>Manual import workspace</h4>
      <p className="small-note">Prepare import → upload files or ZIP → process and review → publish. Originals are retained for recovery; publication copies reviewed files to the separate managed library root. No automatic website fetching or AI processing.</p>
      {busy && <p role="status">Working on import…</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {!result && !busy && <button className="button button-outline" type="button" onClick={() => void run(async () => apply(await intakeRequest(`${base}/intake`)))}>Retry loading intake</button>}
      {result && <>
        {result.intake.lastError && result.intake.lastError !== error && <p className="notice notice-error" role="alert">{result.intake.lastError}</p>}
        {!result.intake.configured && <p className="notice notice-error">Manual import storage is not configured. Set IMPORT_STORAGE_ROOT and MANAGED_LIBRARY_ROOT to separate writable roots, then restart the server. No files have been published by this action.</p>}
        {result.intake.configured && !result.intake.prepared && !locked && <button className="button button-primary" type="button" disabled={busy} onClick={() => void run(() => mutate('prepare'))}>Prepare import</button>}
        {result.intake.prepared && <>
          {!locked && <fieldset className="import-upload" disabled={!canEdit}>
            <legend>Upload original files</legend>
            <label>Files or ZIP archives<input type="file" multiple onChange={(event) => {
              setPending(Array.from(event.target.files || []));
              event.target.value = '';
            }} /></label>
            <p className="small-note quiet">Select multiple regular files and/or ZIP archives. ZIPs are expanded with server-enforced limits. Folder-relative paths are preserved when supplied by your browser. Uploading or removing files invalidates the saved plan.</p>
            {pending.length > 0 && <ul>{pending.map((file, index) => <li key={index}>{file.webkitRelativePath || file.name} ({file.size} bytes)</li>)}</ul>}
            <button className="button button-outline" type="button" disabled={!canEdit || pending.length === 0} onClick={() => void run(upload)}>Upload selected files</button>
            {pending.length > 0 && <button className="button button-quiet" type="button" onClick={() => setPending([])}>Clear selected files</button>}
          </fieldset>}
          <ul className="import-upload-list">{result.intake.uploads.map((entry) => <li key={entry.id}>
            <span>{entry.name} · {entry.fileCount} files · {entry.size} bytes</span>
            <a className="button button-outline button-small" href={`${base}/files/${encodeURIComponent(entry.id)}/original`} download aria-label={`Download original ${entry.name}`}>Download original</a>
            {!locked && <button className="button button-quiet button-small" type="button" disabled={!canEdit} onClick={() => void run(() => mutate(`files/${encodeURIComponent(entry.id)}`, {}, 'DELETE'))}>Remove {entry.name}</button>}
          </li>)}</ul>
          {!locked && <form className="import-form" onSubmit={(event) => {
            event.preventDefault();
            void run(() => mutate('plan', {
              metadata: { ...metadata, name: metadata.name.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) },
              ...(plan ? { files: files.map(({ id, path, include }) => ({ id, path, include })) } : {}),
            }));
          }}>
            <fieldset disabled={!canEdit}>
              <legend>Project metadata</legend>
              <label>Project title<input required maxLength={256} value={metadata.name} onChange={(event) => field('name', event.target.value)} /></label>
              <label>Category (optional)<input maxLength={256} value={metadata.category || ''} placeholder="Workshop/Organization" onChange={(event) => field('category', event.target.value)} /></label>
              <p className="small-note quiet">Use slash-separated categories for nested logical classification.</p>
              <label>Tags (comma-separated)<input value={tags} onChange={(event) => { setTags(event.target.value); edited(); }} /></label>
              <label>Designer (optional)<input maxLength={256} value={metadata.designer || ''} onChange={(event) => field('designer', event.target.value)} /></label>
              <label>License (optional)<input maxLength={256} value={metadata.license || ''} onChange={(event) => field('license', event.target.value)} /></label>
              <label>Description (optional)<textarea maxLength={2000} value={metadata.description || ''} onChange={(event) => field('description', event.target.value)} /></label>
              <label>Project notes (optional)<textarea maxLength={2000} value={metadata.notes || ''} onChange={(event) => field('notes', event.target.value)} /></label>
            </fieldset>
            {plan && <fieldset disabled={!canEdit}>
              <legend>Review file layout</legend>
              <p className="small-note">Suggested role folders: models/, images/, docs/, exports/. Keep dependencies together when editing paths. Include at least one printable file.</p>
              <p className="small-note quiet">Common OS metadata is excluded automatically when processing. Review inclusion below; original uploads stay intact.</p>
              <ImportFileSections files={files} onFileChange={updateFile} />
            </fieldset>}
            {dirty && plan && <p role="status">Unsaved changes. Save plan before publishing.</p>}
            {pending.length > 0 && <p className="small-note">Upload or clear selected files before processing or publishing.</p>}
            <button className="button button-primary" type="submit" disabled={!canEdit || !result.intake.uploads.length || pending.length > 0 || !metadata.name.trim()}>{plan ? 'Save plan' : 'Process files'}</button>
          </form>}
        </>}
        {plan && <>
          {locked && <section aria-label="Published plan">
            <h4>{plan.metadata.name}</h4>
            {plan.metadata.category && <p>Category: {plan.metadata.category}</p>}
            <ImportFileSections files={plan.files} />
          </section>}
          {plan.warnings.length > 0 && <div className="notice"><strong>Plan warnings</strong><ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          {plan.duplicates.length > 0 && <div className="notice">
            <strong>Possible library duplicates</strong>
            <ul>{plan.duplicates.map((duplicate) => <li key={duplicate.projectId}>{duplicate.storageKind === 'managed' ?
              <Link to={`/projects/${encodeURIComponent(duplicate.projectId)}`}>{duplicate.name}</Link> : duplicate.name}
              {duplicate.storageKind === 'legacy' && ' · legacy, migration required'} · {duplicate.matchingFiles} matching files</li>)}</ul>
            {!locked && <label className="import-existing"><input type="checkbox" checked={confirmed} disabled={busy || dirty} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the duplicates and confirm publishing another project.</label>}
          </div>}
          {!locked && <button className="button button-primary" type="button" disabled={!canEdit || dirty || pending.length > 0 || (plan.duplicates.length > 0 && !confirmed)} onClick={() => void run(() => mutate('publish', { confirmDuplicates: confirmed }))}>Publish to managed library</button>}
        </>}
        {recovering && <>
          <label className="import-existing"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I confirm creating a separate project if publication finds duplicates, including matches discovered since this plan was saved.</label>
          <button className="button button-primary" type="button" disabled={busy || !result.intake.configured} onClick={() => void run(() => mutate('publish', { confirmDuplicates: confirmed }))}>{item.status === 'catalog_pending' ? 'Finish catalog registration' : 'Retry publication'}</button>
        </>}
        {result.intake.publishedPath && <p className="small-note import-source">Published path: {result.intake.publishedPath}</p>}
        {projectId && !item.projectId && <p><Link to={`/projects/${encodeURIComponent(projectId)}`}>View library project</Link></p>}
      </>}
    </>}
  </section>;
}
