import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, File, Folder, FolderOpen, ListChecks, RefreshCw, RotateCcw, Save, Search, Sparkles } from 'lucide-react';
import type { LegacyImportEntry, LegacyImportProject, LegacyImportSession, LegacyImportSessions } from '@print-pantry/contracts';
import { LibraryFileSize } from './LibraryFileSize.js';
import { AiOrganization } from './AiOrganization.js';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type AiProject = NonNullable<LegacyImportSession['aiProposal']>['projects'][number];
type AiChoices = { requestId: string; fileIds: string[]; metadataKeys: string[] };
type ChooseAi = (kind: 'fileIds' | 'metadataKeys', key: string, selected: boolean) => void;
const contains = (parent: string, path: string) => !parent || parent === path || path.startsWith(`${parent}/`);
const flatten = (tree: LegacyImportEntry[]): LegacyImportEntry[] => tree.flatMap((entry) => [entry, ...flatten(entry.children)]);
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Import failed. Try again.';
const labels = { selecting: 'Choose projects', planned: 'Organize', organizing: 'Preparing files', organized: 'Files organized', failed: 'Needs attention' };

function SourceTree({ tree, roots, issues, busy, search, choose }: {
  tree: LegacyImportEntry[]; roots: string[]; issues: LegacyImportSession['issues']; busy: boolean;
  search: string; choose: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>(['']);
  function branch(entry: LegacyImportEntry): React.ReactNode {
    const matches = !search || flatten([entry]).some((item) => item.path.toLowerCase().includes(search));
    if (!matches) return null;
    const directory = entry.kind === 'directory';
    const open = Boolean(search) || expanded.includes(entry.path);
    const checked = roots.includes(entry.path);
    const included = roots.some((root) => root !== entry.path && contains(root, entry.path));
    const unsafe = issues.some((issue) => contains(entry.path, issue.path));
    return <li key={entry.path}>
      <div className={`legacy-tree-row ${checked || included ? 'is-selected' : ''}`}>
        {directory ? <button type="button" className="legacy-icon-button" title={`${open ? 'Collapse' : 'Expand'} ${entry.path || 'library'}`}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.path || 'library'}`} aria-expanded={open}
          onClick={() => setExpanded((current) => open ? current.filter((path) => path !== entry.path) : [...current, entry.path])}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button> : <span className="legacy-tree-spacer" />}
        {directory && <input type="checkbox" aria-label={`Import ${entry.path || 'entire legacy library'}`}
          checked={checked || included} disabled={busy || included || unsafe || !entry.fileCount} onChange={() => choose(entry.path)} />}
        {directory ? open ? <FolderOpen size={18} /> : <Folder size={18} /> : <File size={16} />}
        <span className="legacy-tree-name" title={entry.path}>{entry.name || 'Legacy library'}</span>
        {directory && <span className="legacy-tree-count">{entry.fileCount} files</span>}
        {entry.suggested && <span className="legacy-suggestion">Suggested</span>}
      </div>
      {directory && open && entry.children.length > 0 && <ul>{entry.children.map(branch)}</ul>}
    </li>;
  }
  return <ul className="legacy-tree" aria-label="Legacy folders">{tree.map(branch)}</ul>;
}

function ProjectOrganization({ project, busy, readOnly, onSave, onDirty, aiProject, aiChoices, aiDisabled, onAiChoice }: {
  project: LegacyImportProject; busy: boolean; readOnly: boolean;
  onSave: (project: LegacyImportProject, name: string, category: string, paths: { id: string; path: string }[]) => Promise<void>;
  onDirty: (key: string, dirty: boolean) => void;
  aiProject?: AiProject; aiChoices: AiChoices; aiDisabled: boolean; onAiChoice: ChooseAi;
}) {
  const [name, setName] = useState(project.name);
  const [category, setCategory] = useState(project.category ?? '');
  const [paths, setPaths] = useState(project.files.map(({ id, path }) => ({ id, path })));
  const dirty = name !== project.name || category !== (project.category ?? '') || paths.some((file, index) => file.path !== project.files[index]?.path);
  const metadataChanged = aiProject && (aiProject.name !== project.name || aiProject.category !== project.category);
  useEffect(() => { onDirty(project.key, dirty); }, [project.key, dirty, onDirty]);
  async function save() { await onSave(project, name, category, paths); }
  return <article className="legacy-project" aria-label={`${project.sourcePath || 'Library'} organization`}>
    <header><h3>{project.name}</h3>{project.status === 'organized' && <CheckCircle2 size={20} aria-label="Organized" />}</header>
    <p className="small-note quiet legacy-path">{project.sourcePath || 'Entire legacy library'}</p>
    <div className="legacy-metadata">
      <label>Project name<input aria-label={`Project name for ${project.sourcePath}`} value={name} maxLength={256}
        disabled={busy || readOnly} onChange={(event) => setName(event.target.value)} /></label>
      <label>Category<input aria-label={`Category for ${project.sourcePath}`} value={category} maxLength={512}
        disabled={busy || readOnly} onChange={(event) => setCategory(event.target.value)} /></label>
    </div>
    {metadataChanged && <label className="ai-metadata-choice"><input type="checkbox" checked={aiChoices.metadataKeys.includes(project.key)} disabled={aiDisabled}
      aria-label={`Use AI project details for ${project.sourcePath}`} onChange={(event) => onAiChoice('metadataKeys', project.key, event.target.checked)} />
      <span><Sparkles size={14} /> {aiProject.category || 'Uncategorized'} / {aiProject.name}</span></label>}
    {project.warnings.map((warning) => <p className="small-note" key={warning}>{warning}</p>)}
    {project.blockers.map((blocker) => <p className="notice notice-error" role="alert" key={blocker}>{blocker}</p>)}
    <details className="legacy-files" open={Boolean(aiProject) || undefined}><summary>Files ({project.files.length})</summary>
      <table className="legacy-file-table"><thead><tr><th scope="col">Source file</th><th scope="col">Current destination</th>{aiProject && <th scope="col">AI alternative</th>}</tr></thead>
        <tbody>{project.files.map((file, index) => {
          const proposedPath = aiProject?.paths.find((item) => item.id === file.id)?.path;
          const changed = proposedPath !== undefined && proposedPath !== file.path;
          const useAi = changed && aiChoices.fileIds.includes(file.id);
          const label = `${file.originalPath} in ${project.sourcePath}`;
          return <tr key={file.id}><td data-label="Source file"><span className="legacy-path">{file.originalPath}</span></td>
            <td data-label="Current destination" className={changed && !useAi ? 'is-chosen' : undefined}>
              {changed && <label className="ai-destination-choice"><input type="radio" name={`destination-${project.key}-${file.id}`} checked={!useAi} disabled={aiDisabled}
                aria-label={`Keep current destination for ${label}`} onChange={() => onAiChoice('fileIds', file.id, false)} /><span>Current</span></label>}
              <textarea rows={1} aria-label={`Destination for ${label}`} value={paths[index]?.path ?? file.path}
                disabled={busy || readOnly || project.linked} onChange={(event) => setPaths((current) => current.map((item) => item.id === file.id ? { ...item, path: event.target.value } : item))} />
            </td>
            {aiProject && <td data-label="AI alternative" className={useAi ? 'is-chosen' : undefined}>{changed && <label className="ai-destination-choice">
              <input type="radio" name={`destination-${project.key}-${file.id}`} checked={useAi} disabled={aiDisabled}
                aria-label={`Use AI destination for ${label}`} onChange={() => onAiChoice('fileIds', file.id, true)} /><span className="legacy-path">{proposedPath}</span>
            </label>}</td>}
          </tr>;
        })}</tbody>
      </table>
    </details>
    {dirty && !readOnly && <button type="button" className="button button-outline" disabled={busy || !name.trim()} onClick={() => void save()}><Save size={16} /> Save changes</button>}
  </article>;
}

export function LibraryImport({ request }: { request: Request }) {
  const [params, setParams] = useSearchParams();
  const id = params.get('session');
  const [session, setSession] = useState<LegacyImportSession | null>(null);
  const [recent, setRecent] = useState<LegacyImportSessions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadRevision, setLoadRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [replacement, setReplacement] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [creationId, setCreationId] = useState(() => crypto.randomUUID());
  const [selectedAi, setSelectedAi] = useState<AiChoices>({ requestId: '', fileIds: [], metadataKeys: [] });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setSession(null); setDirtyKeys(new Set());
    const path = id ? `/api/library/imports/${encodeURIComponent(id)}` : '/api/library/imports';
    request<LegacyImportSession | LegacyImportSessions>(path, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if ('sessions' in result) setRecent(result); else setSession(result);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, request, loadRevision]);
  useEffect(() => {
    if (!session || session.state !== 'organizing') return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      request<LegacyImportSession>(`/api/library/imports/${session.id}`, { signal: controller.signal })
        .then((next) => { if (!controller.signal.aborted) setSession((current) => current && next.revision >= current.revision ? next : current); })
        .catch((reason: unknown) => { if (!controller.signal.aborted) setError(message(reason)); });
    }, 700);
    return () => { clearInterval(timer); controller.abort(); };
  }, [session?.id, session?.state, request]);
  async function start() {
    setBusy(true); setError('');
    try {
      const next = await request<LegacyImportSession>('/api/library/imports', { method: 'POST', body: JSON.stringify({ id: creationId }) });
      setParams({ session: next.id });
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function command(action: string, body: Record<string, unknown> = {}) {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const next = await request<LegacyImportSession>(`/api/library/imports/${session.id}/${action}`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: session.revision, ...body }),
      });
      setSession(next); setReplacement(null);
      if (action !== 'edit') setDirtyKeys(new Set());
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  function markDirty(key: string, dirty: boolean) {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current); if (dirty) next.add(key); else next.delete(key); return next;
    });
  }
  function choose(path: string) {
    if (!session) return;
    if (!session.selectedRoots.includes(path) && session.selectedRoots.some((root) => contains(path, root))) { setReplacement(path); return; }
    void command('selection', { roots: session.selectedRoots.includes(path) ? session.selectedRoots.filter((root) => root !== path) : [...session.selectedRoots, path], layout: session.layout });
  }
  async function save(project: LegacyImportProject, name: string, category: string, paths: { id: string; path: string }[]) {
    await command('edit', { key: project.key, name, category: category.trim() || null, paths });
  }
  const selecting = session?.state === 'selecting';
  const organized = session?.state === 'organized';
  const preparing = session?.state === 'organizing';
  const selected = session ? flatten([session.tree]).filter((entry) => session.selectedRoots.includes(entry.path)) : [];
  const selectedFiles = selected.reduce((total, entry) => total + entry.fileCount, 0);
  const blocked = session?.projects.some((project) => project.blockers.length > 0);
  const proposal = session?.state === 'planned' && session.aiProposal?.status === 'ready' ? session.aiProposal : null;
  const aiChoices: AiChoices = proposal && selectedAi.requestId === proposal.requestId ? selectedAi : { requestId: proposal?.requestId ?? '', fileIds: [], metadataKeys: [] };
  const aiDifferences = proposal?.projects.map((proposed) => ({ proposed, current: session!.projects.find((project) => project.key === proposed.key)! }));
  const changedFiles = aiDifferences?.flatMap(({ proposed, current }) => proposed.paths.filter((file) => file.path !== current.files.find((item) => item.id === file.id)?.path).map((file) => file.id)) ?? [];
  const changedMetadata = aiDifferences?.filter(({ proposed, current }) => proposed.name !== current.name || proposed.category !== current.category).map(({ proposed }) => proposed.key) ?? [];
  const selectedCount = aiChoices.fileIds.length + aiChoices.metadataKeys.length;
  const aiDisabled = busy || aiBusy || dirtyKeys.size > 0;
  const chooseAi: ChooseAi = (kind, key, selected) => setSelectedAi((current) => {
    const choices = current.requestId === proposal?.requestId ? current : aiChoices;
    return { ...choices, [kind]: selected ? [...new Set([...choices[kind], key])] : choices[kind].filter((item) => item !== key) };
  });
  return <section className="legacy-import" aria-labelledby="legacy-import-title">
    <Link className="back-link" to="/manage-library"><ArrowLeft size={16} /> Manage library</Link>
    <header className="legacy-heading"><div><h1 id="legacy-import-title">Import library</h1><p className="quiet">{session ? labels[session.state] : 'Legacy folders'}</p></div>
      {session && <button type="button" className="legacy-icon-button" title="Refresh import" aria-label="Refresh import" disabled={busy || aiBusy || dirtyKeys.size > 0}
        onClick={() => { setBusy(true); void request<LegacyImportSession>(`/api/library/imports/${session.id}`).then(setSession).catch((reason: unknown) => setError(message(reason))).finally(() => setBusy(false)); }}><RefreshCw size={18} /></button>}
    </header>
    <ol className="legacy-steps" aria-label="Import progress">{['Choose projects', 'Organize', 'Review'].map((label, index) => <li key={label}
      aria-current={(selecting || !session ? 0 : organized ? 2 : 1) === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading import…</p> : !session && id ? <button type="button" className="button button-outline" onClick={() => setLoadRevision((value) => value + 1)}><RefreshCw size={16} /> Retry loading import</button> : !session ? <>
      <div className="legacy-start"><FolderOpen size={36} /><h2>Choose from your legacy folders</h2>
        <button className="button button-primary" type="button" disabled={busy || recent?.configured === false} onClick={() => void start()}><FolderOpen size={18} /> {busy ? 'Reading folders…' : 'Browse folders'}</button>
        <p className="small-note quiet">Original files stay unchanged.</p>
        {recent?.configured === false && <p role="status">Legacy library storage is not configured.</p>}
      </div>
      {Boolean(recent?.sessions.length) && <section className="legacy-recent"><h2>Recent imports</h2><ul>{recent?.sessions.map((item) => <li key={item.id}><Link to={`?session=${item.id}`}>{new Date(item.updatedAt).toLocaleString()}</Link><span>{labels[item.state]} · {item.projectCount} projects</span></li>)}</ul></section>}
    </> : selecting ? <>
      <div className="legacy-selection"><div className="legacy-browser"><div className="legacy-tree-toolbar">
        <label className="legacy-search"><Search size={18} /><input type="search" aria-label="Find folders or files" placeholder="Find folders or files" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <button type="button" className="legacy-icon-button" title="Select suggested projects" aria-label="Select suggested projects" disabled={busy}
            onClick={() => void command('selection', { roots: flatten([session.tree]).filter((entry) => entry.suggested && !session.issues.some((issue) => contains(entry.path, issue.path))).map((entry) => entry.path), layout: session.layout })}><ListChecks size={20} /></button>
          </div><SourceTree tree={[session.tree]} roots={session.selectedRoots} issues={session.issues} busy={busy} search={deferredSearch} choose={choose} /></div>
      <aside className="legacy-selection-summary"><h2>{session.selectedRoots.length} {session.selectedRoots.length === 1 ? 'project' : 'projects'} selected</h2>
        <p>{selectedFiles} files · <LibraryFileSize value={String(selected.reduce((total, entry) => total + entry.sizeBytes, 0))} /></p>
        <p className="small-note quiet">{session.tree.fileCount - selectedFiles} files unselected</p>
        <ul>{session.selectedRoots.map((root) => <li className="legacy-path" key={root}>{root || 'Entire legacy library'}</li>)}</ul>
        <fieldset className="legacy-layout"><legend>File organization</legend>{(['standardize', 'preserve'] as const).map((layout) => <label key={layout}><input type="radio" name="layout" checked={session.layout === layout} disabled={busy} onChange={() => void command('selection', { roots: session.selectedRoots, layout })} />{layout === 'standardize' ? 'Standardize' : 'Keep layout'}</label>)}</fieldset>
        <button className="button button-primary" type="button" disabled={busy || !session.selectedRoots.length} onClick={() => void command('plan')}>Review organization <ArrowRight size={16} /></button>
        <p className="small-note quiet">Original library stays unchanged.</p>
      </aside></div>
      {replacement !== null && <div className="notice" role="alertdialog" aria-label="Replace selected child folders"><p>Select {replacement || 'the entire library'} instead of its selected child folders?</p>
        <div className="library-management-actions"><button type="button" className="button button-primary" disabled={busy} onClick={() => void command('selection', { roots: [...session.selectedRoots.filter((root) => !contains(replacement, root)), replacement], layout: session.layout })}>Select parent instead</button>
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => setReplacement(null)}>Cancel</button></div></div>}
      {Boolean(session.issues.length) && <details><summary>Unavailable entries ({session.issues.length})</summary><ul>{session.issues.map((issue) => <li key={issue.path}>{issue.path}: {issue.message}</li>)}</ul></details>}
    </> : <>
      <div className="legacy-organization-heading"><div><h2>{organized ? 'Files organized' : `${session.projects.length} ${session.projects.length === 1 ? 'project' : 'projects'}`}</h2>
        <p className="quiet">{organized ? 'Recovery copies verified. Files are staged; the live library is unchanged.' : preparing ? `${session.projects.filter((project) => project.status === 'organized').length} of ${session.projects.length} prepared` : 'Recovery copies will be verified before organization.'}</p></div>
        {!organized && !preparing && <button type="button" className="button button-primary" disabled={busy || aiBusy || blocked || dirtyKeys.size > 0 || selectedCount > 0} onClick={() => void command('organize')}>{session.state === 'failed' ? 'Retry preparation' : 'Prepare files'} <ArrowRight size={16} /></button>}
      </div>
      {session.lastError && <p className="notice notice-error" role="alert">{session.lastError}</p>}
      {preparing && <p role="status">Preparing files…</p>}
      {dirtyKeys.size > 0 && <p className="small-note" role="status">Save project changes before preparing files.</p>}
      {session.state === 'planned' && <AiOrganization key={session.id} session={session} request={request} disabled={busy || dirtyKeys.size > 0} onSession={setSession} onBusyChange={setAiBusy} />}
      {proposal && <div className="ai-review-toolbar" aria-label="AI change selection">
        <p className="small-note" role="status">{changedFiles.length + changedMetadata.length === 0 ? 'No AI changes.' : `${changedFiles.length} file alternatives, ${changedMetadata.length} project detail changes. ${selectedCount} selected.`}</p>
        <div className="library-management-actions">
          <button className="button button-outline" type="button" disabled={aiDisabled || !changedFiles.length && !changedMetadata.length} onClick={() => setSelectedAi({ requestId: proposal.requestId, fileIds: changedFiles, metadataKeys: changedMetadata })}><ListChecks size={16} /> Select all AI changes</button>
          <button className="button button-quiet" type="button" disabled={aiDisabled || !selectedCount} onClick={() => setSelectedAi({ requestId: proposal.requestId, fileIds: [], metadataKeys: [] })}><RotateCcw size={16} /> Keep all current</button>
          <button className="button button-primary" type="button" disabled={aiDisabled || !selectedCount} onClick={() => void command('ai/apply', { requestId: proposal.requestId, selection: { fileIds: aiChoices.fileIds, metadataKeys: aiChoices.metadataKeys } })}><Check size={16} /> Apply selected changes</button>
        </div>
      </div>}
      {session.projects.map((project) => <ProjectOrganization key={JSON.stringify([session.id, project.key, project.name, project.category, project.files.map((file) => file.path)])} project={project} busy={busy || aiBusy} readOnly={session.state !== 'planned'} onSave={save} onDirty={markDirty}
        aiProject={proposal?.projects.find((item) => item.key === project.key)} aiChoices={aiChoices} aiDisabled={aiDisabled} onAiChoice={chooseAi} />)}
      <div className="library-management-actions">{session.state === 'planned' && <button type="button" className="button button-quiet" disabled={busy || aiBusy || dirtyKeys.size > 0} onClick={() => void command('selection', { roots: session.selectedRoots, layout: session.layout })}><ArrowLeft size={16} /> Choose projects</button>}
        {organized && <Link className="button button-outline" to="/import-library" onClick={() => setCreationId(crypto.randomUUID())}>Another import</Link>}</div>
    </>}
  </section>;
}