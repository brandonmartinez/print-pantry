import { useEffect, useRef, useState } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Status = { configured: boolean; scan: {
  state: string; lastError: string | null;
  errors: { relative_path: string | null; message: string }[];
} };

export function LegacyLibraryScan({ request, refresh, onIndexed }: {
  request: Request; refresh: number; onIndexed: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const wasRunning = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await request<Status>('/api/library/legacy-scan', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (wasRunning.current && next.scan.state !== 'running') onIndexed();
        wasRunning.current = next.scan.state === 'running';
        setStatus(next);
        setError('');
        if (next.scan.state === 'running') timer = setTimeout(() => void load(), 1500);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load legacy indexing status'); }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [request, refresh, reload, onIndexed]);
  async function start() {
    setBusy(true); setError('');
    try {
      await request('/api/library/legacy-scan', { method: 'POST' });
      wasRunning.current = true;
      setStatus((previous) => previous && { ...previous, scan: { ...previous.scan, state: 'running' } });
      setReload((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start legacy indexing'); }
    finally { setBusy(false); }
  }
  return <section className="queue-panel" aria-label="Legacy migration indexing">
    <h2>Index an old library for migration</h2>
    <p>Optional, read-only discovery for migration. Legacy files never appear in the normal library or serve downloads.
      Indexing is explicit, not automatic or scheduled. Managed imports do not need a legacy source.</p>
    {status && !status.configured && <p className="notice">No legacy source configured. Set LEGACY_LIBRARY_HOST_PATH in Compose,
      or LEGACY_LIBRARY_ROOT outside Docker, only when migrating an old library.</p>}
    {status?.configured && <><p role="status">Legacy indexing: {status.scan.state}</p>
      <button className="button button-outline" type="button" disabled={busy || status.scan.state === 'running'}
        onClick={() => void start()}>Index legacy library for migration</button>
      {status.scan.lastError && <p className="notice notice-error" role="alert">{status.scan.lastError}</p>}
      {status.scan.errors.length > 0 && <details><summary>Legacy indexing errors ({status.scan.errors.length})</summary>
        <ul>{status.scan.errors.map((item, index) => <li key={index}>{item.relative_path}: {item.message}</li>)}</ul></details>}</>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>;
}
