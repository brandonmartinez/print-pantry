import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { LibraryAdoptionItems, LibraryAdoptionRun, HouseholdUser } from '@print-pantry/contracts';

const help = `Print Pantry library adoption utility

Uses the running API and its durable migration engine; never moves files itself.
Build first: npm run build

npm run library -- <command> [run-id] --username <operator> --password-stdin [options]

Commands:
  plan                 Freeze and inspect all indexed legacy projects (no copying)
  list                 List recent runs
  status <run-id>      Read progress, fingerprint, roots and counts
  items <run-id>       Read a page of project outcomes
  copy <run-id>        Approve batch copy/verification; does NOT activate
  activate <run-id>    Separately approve verified batch activation
  pause <run-id>       Stop after the current project operation
  resume <run-id>      Continue the previously paused operation
  retry <run-id>       Retry failed work in --stage copy|activate|restore|cancel
  cancel <run-id>      Cancel unactivated work; retain copies
  restore <run-id>     Restore activated projects; retain managed copies
  wait <run-id>        Wait for the current stage, not for future approval

Options:
  --url <base>         API base URL (default http://127.0.0.1:3000).
                      For the web proxy use https://your-host/api.
  --json              Machine-readable output
  --wait              Wait for planning or the submitted operation to settle
  --fingerprint <sha>  Reviewed plan fingerprint; required for copy/activate
  --revision <n>       Require a specific revision (otherwise read current state)
  --confirm-retained-copies --acknowledge-warnings  Required for copy
  --confirm-activation / --confirm-cancellation / --confirm-restoration
  --stage <stage>      Required for retry
  --status <outcome>   Filter items; --cursor <project-id> reads the next page

Password is read only from piped stdin and is never stored by this utility.
Non-loopback servers require HTTPS. Redirects are refused.
Closing the utility does not cancel server work. Pause/cancel is between projects.
Exit codes: 0 successful request/stage; 1 invalid input/API/transport failure;
2 wait finished with blocked/failed/canceled projects, a partial result or a pause.
`;
type IO = {
  fetch: typeof fetch; password: () => Promise<string>; sleep: () => Promise<void>;
  out: (value: string) => void; err: (value: string) => void;
};
async function stdinPassword() {
  if (process.stdin.isTTY) throw new Error('Pipe the operator password into --password-stdin; interactive echoed input is refused.');
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value) > 4096) throw new Error('Password input exceeds 4,096 bytes.');
  }
  const password = value.replace(/\r?\n$/, '');
  if (!password) throw new Error('Password input is empty.');
  return password;
}
const defaults: IO = {
  fetch: globalThis.fetch, password: stdinPassword,
  sleep: () => new Promise((resolve) => setTimeout(resolve, 1500)),
  out: (value) => console.log(value), err: (value) => console.error(value),
};
function describe(run: LibraryAdoptionRun) {
  return `Run ${run.id}\nState: ${run.state} (revision ${run.revision})\n` +
    `Projects: ${run.total}; ready ${run.counts.ready}; copying ${run.counts.copying}; awaiting activation ${run.counts.copied}; active ${run.counts.activated}\n` +
    `Blocked ${run.counts.blocked}; failed ${run.counts.failed}; restored ${run.counts.restored}; canceled ${run.counts.canceled}\n` +
    `Legacy: ${run.legacyRoot}\nManaged: ${run.managedRoot}\nCopy file bytes (lower bound): ${run.additionalBytes}\n` +
    `Plan fingerprint: ${run.fingerprint || 'planning'}${run.lastError ? `\nStopped: ${run.lastError}` : ''}`;
}
function incomplete(run: LibraryAdoptionRun) {
  return ['partial', 'paused', 'canceled'].includes(run.state) || run.counts.blocked + run.counts.failed + run.counts.canceled > 0;
}

export async function runLibraryCli(args: string[], overrides: Partial<IO> = {}) {
  const io = { ...defaults, ...overrides };
  let logout: (() => Promise<unknown>) | undefined;
  let requestedRunId: string | undefined;
  let exit = 0;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, url: { type: 'string' }, username: { type: 'string' },
      'password-stdin': { type: 'boolean' }, json: { type: 'boolean' }, wait: { type: 'boolean' },
      fingerprint: { type: 'string' }, revision: { type: 'string' }, stage: { type: 'string' },
      status: { type: 'string' }, cursor: { type: 'string' },
      'confirm-retained-copies': { type: 'boolean' }, 'acknowledge-warnings': { type: 'boolean' },
      'confirm-activation': { type: 'boolean' }, 'confirm-cancellation': { type: 'boolean' }, 'confirm-restoration': { type: 'boolean' },
    } });
    if (values.help || !positionals.length) { io.out(help); return 0; }
    const [command, id] = positionals;
    const commands = ['plan', 'list', 'status', 'items', 'copy', 'activate', 'pause', 'resume', 'retry', 'cancel', 'restore', 'wait'];
    if (!commands.includes(command) || positionals.length > 2) throw new Error('Unknown command or extra arguments; use --help.');
    if (['plan', 'list'].includes(command) ? Boolean(id) : !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Supply a UUID run ID for this command; plan/list do not take an ID.');
    if (!values.username || !values['password-stdin']) throw new Error('An operator --username and --password-stdin are required.');
    const base = new URL(values.url ?? 'http://127.0.0.1:3000');
    if (base.username || base.password || base.search || base.hash) throw new Error('API URLs must not contain credentials, query parameters, or fragments.');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Non-loopback API URLs require HTTPS.');
    }
    if (['copy', 'activate'].includes(command) && !/^[a-f0-9]{64}$/.test(values.fingerprint ?? '')) throw new Error('Supply the reviewed --fingerprint for copy or activation.');
    if (command === 'copy' && (!values['confirm-retained-copies'] || !values['acknowledge-warnings'])) throw new Error('Copy requires --confirm-retained-copies and --acknowledge-warnings.');
    if (command === 'activate' && !values['confirm-activation']) throw new Error('Activation requires --confirm-activation.');
    if (command === 'cancel' && !values['confirm-cancellation']) throw new Error('Cancellation requires --confirm-cancellation.');
    if (command === 'restore' && !values['confirm-restoration']) throw new Error('Restoration requires --confirm-restoration.');
    if (command === 'retry' && !['copy', 'activate', 'restore', 'cancel'].includes(values.stage ?? '')) throw new Error('Retry requires --stage copy|activate|restore|cancel.');
    const revision = values.revision === undefined ? undefined : Number(values.revision);
    if (revision !== undefined && (!/^\d+$/.test(values.revision!) || !Number.isSafeInteger(revision))) throw new Error('Revision must be a nonnegative safe integer.');
    const api = base.href.replace(/\/$/, '');
    let cookie = '';
    async function request<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await io.fetch(`${api}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), origin: base.origin, ...(cookie ? { cookie } : {}) } });
      const data: unknown = response.status === 204 ? undefined : await response.json();
      if (!response.ok) {
        const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
        throw new Error(detail);
      }
      if (path === '/auth/login') {
        const session = response.headers.getSetCookie().find((value) => value.startsWith('pantry_session='));
        if (!session) throw new Error('Login response did not include a session cookie.');
        cookie = session.split(';')[0];
      }
      return data as T;
    }
    const login = await request<{ user: HouseholdUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username: values.username, password: await io.password() }) });
    logout = () => request('/auth/logout', { method: 'POST' });
    if (login.user.role !== 'operator') throw new Error('An operator account is required.');
    const printRun = (run: LibraryAdoptionRun) => io.out(values.json ? JSON.stringify(run) : describe(run));
    async function wait(run: LibraryAdoptionRun) {
      let previous = '';
      while (['planning', 'copying', 'activating', 'restoring', 'canceling'].includes(run.state)) {
        if (!values.json && previous !== run.state) { io.out(`Waiting: ${run.state}. Closing this utility does not cancel server work.`); previous = run.state; }
        await io.sleep();
        run = await request<LibraryAdoptionRun>(`/library/adoptions/${run.id}`);
      }
      return run;
    }
    if (command === 'list') {
      const result = await request<{ runs: LibraryAdoptionRun[] }>('/library/adoptions');
      io.out(values.json ? JSON.stringify(result) : result.runs.map(describe).join('\n\n') || 'No adoption runs.');
    } else if (command === 'items') {
      const query = new URLSearchParams();
      if (values.status) query.set('status', values.status);
      if (values.cursor) query.set('after', values.cursor);
      const result = await request<LibraryAdoptionItems>(`/library/adoptions/${id}/items?${query}`);
      io.out(values.json ? JSON.stringify(result) : result.items.map((item) =>
        `${item.projectId} | ${item.status} | ${item.name}${item.lastError ? ` | ${item.lastError}` : ''}\n${item.issues.map((issue) => `  ${issue.severity}: ${issue.message}`).join('\n')}`
      ).join('\n') + (result.nextCursor ? `\nNext cursor: ${result.nextCursor}` : ''));
    } else {
      if (command === 'plan') requestedRunId = randomUUID();
      let run = command === 'plan' ? await request<LibraryAdoptionRun>('/library/adoptions', { method: 'POST', body: JSON.stringify({ requestKey: requestedRunId }) }) :
        await request<LibraryAdoptionRun>(`/library/adoptions/${id}`);
      if (!['plan', 'status', 'wait'].includes(command)) {
        const action = command === 'copy' ? 'approve_copy' : command;
        run = await request<LibraryAdoptionRun>(`/library/adoptions/${run.id}/commands`, { method: 'POST', body: JSON.stringify({
          action, expectedRevision: revision ?? run.revision,
          ...(values.fingerprint ? { expectedFingerprint: values.fingerprint } : {}),
          ...(command === 'copy' ? { confirmRetainedCopies: true, acknowledgeWarnings: true } : {}),
          ...(command === 'activate' ? { confirmActivation: true } : {}),
          ...(command === 'cancel' ? { confirmCancellation: true } : {}),
          ...(command === 'restore' ? { confirmRestoration: true } : {}),
          ...(command === 'retry' ? { stage: values.stage } : {}),
        }) });
      }
      if (command === 'wait' || values.wait) { run = await wait(run); if (incomplete(run)) exit = 2; }
      printRun(run);
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : 'Library utility failed.');
    if (requestedRunId) io.err(`Planning request ID: ${requestedRunId}. Check status/list before creating another run; the server may have saved it.`);
    exit = 1;
  } finally {
    if (logout) {
      try { await logout(); }
      catch (error) { io.err(`Session cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`); if (!exit) exit = 1; }
    }
  }
  return exit;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runLibraryCli(process.argv.slice(2));
}
