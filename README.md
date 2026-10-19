# Print Pantry

A cozy home for 3D print files: browse a model library, pick a project, and
queue a print request.

The React/Vite catalog, Fastify API, typed shared contracts, and PostgreSQL
catalog and request queue use Drizzle migrations. Files remain usable outside
the app; no print is automatically started.

See [KICKOFF.md](KICKOFF.md) for the initial product and implementation brief.
For production deployment, routine operations, backup/restore verification, and
the generated-catalog retirement handoff, see
[docs/production-operations.md](docs/production-operations.md) for the
production Compose commands, prerequisites, and safeguards.

## Workspace and commands

Use **Node 24.13.1** (see `.node-version`) and the npm registry already
configured for your environment. Do not change the registry to work around an
installation failure. The project `.npmrc` omits registry-specific tarball
URLs from the lockfile so each environment uses its own configured registry
without changing pinned versions or integrity checks. `npm ci` installs the checked-in lockfile. The workspace
contains `apps/web`, `apps/api`, `packages/contracts`, `packages/db`,
and `packages/indexer`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared packages, migrate the database, then watch shared outputs and the API/web |
| `npm run build` | Build shared packages, API, then web |
| `npm run typecheck` | Build shared declarations first, then type-check all workspaces |
| `npm run lint` | Lint workspace code |
| `npm test` | Run focused API, React, and database tests (requires isolated test DB) |
| `npm run test:browser` | Run synthetic localhost desktop/mobile Edge/Chromium request journeys (see below) |
| `npm run db:generate` | Generate a reviewed SQL migration from schema changes |
| `npm run db:migrate` | Apply versioned migrations to `DATABASE_URL` (build first) |

Migrations live in `packages/db/drizzle/`, including Drizzle's version journal.
Commit generated SQL and journal together; inspect SQL before applying it. The
API does **not** migrate on request. `npm run dev` applies pending migrations
before starting the API and web processes; CI exercises migrations against
`print_pantry_test`. For host-only
development, provide your own isolated PostgreSQL, set `DATABASE_URL`,
`TEST_DATABASE_URL` (the latter must point to `print_pantry_test`), and
`LIBRARY_ROOT` to an **unrelated synthetic/test directory**, then run
`npm run build && npm test && npm run dev`. Never target
an external or production database with the test URL.

The shared packages export compiled `dist` files. Root `typecheck` deliberately
builds them first so it works immediately after `npm ci`; root `dev` does the
same before starting five coordinated watchers. Changes in contracts, DB, or indexer
source rebuild their outputs, and the API watcher restarts when shared outputs
change. Stop all watchers together with Ctrl+C; a failed initial shared build
prevents startup rather than serving stale output.

`GET /health` reports process liveness; `GET /ready` checks PostgreSQL
connectivity and returns HTTP 503 when it is unavailable. The frontend calls
`/api/*` through the Vite development proxy; it removes the `/api` prefix
before forwarding to Fastify.

## Library catalog and household access

Operators can use **Manage library** for paginated legacy/managed inventory and
saved reorganization dry runs. Previews preserve existing project IDs and
internal file layout, flag filesystem/storage blockers, and do not move or
activate files. See the [library preview testing checkpoint](docs/import-queue.md#library-management-read-only-reorganization-preview)
before proceeding with library adoption.

Mount the library **read-only** at `LIBRARY_ROOT` (the development container
uses `/mnt/library`). Point `LIBRARY_HOST_PATH` at a **test library only** while
developing; do not test against the NAS. `CLIENT_MOUNT_PREFIX` is a separate,
absolute POSIX path visible to the browser operator, for example a locally
mounted share. It is optional: without it, the UI shows relative paths but
does not claim to know a usable local path. Never put an internal container
path in this setting unless clients can actually access it. Copy-path uses
the browser clipboard and shows the path for manual copying if permission
is denied. Downloads are authenticated; local `file://` opening is not assumed.

Set `LIBRARY_IGNORED_DIRS` to comma-separated directory **names** to skip
for your library (for example `recovery,temp,private`). Only explicitly
configured names are ignored; underscore-prefixed collections remain eligible.
`SCAN_INTERVAL_MINUTES` defaults to 30. An initial scan runs when the API
starts, and operator-only `POST /api/catalog/rescan` starts a manual scan;
`GET /api/catalog/status` exposes scan failures and timestamps. Failed,
partial, or offline scans do not mark every file missing. The database retains
stable IDs, historical versions, and user-authored metadata when files change.
An unexpectedly empty previously populated mount is treated as non-authoritative,
including when placeholder directories remain. Set `LIBRARY_ALLOW_EMPTY=true`
**only** if the mount is known healthy and you intentionally want a completely
empty library to mark prior entries missing; the default is safer for a NAS.
Boundary overrides and metadata edits require the operator role; changing a
boundary takes effect on the next rescan. Scanning never moves, renames, or
deletes library files.

In the local Compose environment, `npm run dev` creates an initial operator
account only when the `print_pantry_dev` database has no users. Sign in with
`admin` / `print-pantry-dev`; change this password for any shared environment.
The seed is enabled only in `compose.dev.yml` and refuses non-local databases.

For other environments, run migrations first, then provision the first account
**interactively** from inside the running container:

```sh
docker compose -f compose.dev.yml exec app npm run account:create -w @print-pantry/api -- operator operator
```

The first account must be an operator; create requesters with the same command
and `requester` as the second argument. A password prompt requires an
interactive terminal and does not echo or accept passwords as command-line
arguments. There is no public registration or default account outside local
development. Sessions use
HttpOnly SameSite cookies and expire after 14 days. Set `COOKIE_SECURE=true`
when deploying behind private HTTPS (the development container uses HTTP).
Do not publish the app directly to the internet.

Authenticated `GET /api/catalog/projects` accepts `q`, `category`,
`fileType`, `page`, and `pageSize` (at most 50).
`GET /api/catalog/projects/:id` returns associated files, source metadata, and
stable asset/version IDs. File downloads use
`GET /api/catalog/assets/:id/download`; requesting an unavailable historical
version returns 410 rather than silently substituting a different file.
Operator metadata edits use `PATCH /api/catalog/projects/:id`; explicit
project-boundary overrides use `PUT /api/catalog/boundaries`. Authentication
uses `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`. Frontend and
external clients must forward the session cookie. Generated STL thumbnails,
validated images, embedded 3MF thumbnails, and the lazy, sampled interactive
STL geometry endpoint are served only through authenticated routes with
bounded processing; unsupported source files remain downloadable. The app
does not scrape external sites; operators can upload files through Imports.

The operator UI can mark a project folder as an explicit boundary. For a deeper
collection that the default grouping misclassifies, the same operator-only
boundary endpoint also accepts `{"relativePath":"Category/Collection","kind":"collection"}`
or `"kind":"project"`; `DELETE /api/catalog/boundaries` with the same
`relativePath` removes an override. These are library-relative directory
paths, not absolute host paths. Rescan after changing a boundary.

For backups, stop writes and back up the PostgreSQL database **as well as**
the legacy library, managed library, and retained import originals. Verify the database backup by restoring
into a separate disposable PostgreSQL instance, applying migrations there,
and checking project/asset/version counts and representative metadata without
pointing the restored instance at the real library. Never use a restore test
against an existing database or let it scan the real NAS. Include request,
selected-file, queue, and action-history records in restore verification.

## New-print submissions and import queue

Any signed-in household user can choose **Add New Print**, check a source URL,
and submit an optional title and notes to **Imports**. Operators can open the
source website, accept the submission into **Awaiting files**, or decline/cancel
it with a reason. Matching active imports are shared without exposing another
requester's private submission notes. This queue is separate from the existing
file-backed print queue.

Operators can now prepare intake storage, upload individual files or ZIPs,
review deterministic organization and metadata, and publish a new managed
project. Original uploads are retained separately; publishing does not write
to or reorganize the legacy library. Development defaults to ignored
`.pantry-data/intake` and `.pantry-data/library`; production uses separate
persistent volumes. No AI key is required. See
[the testing checkpoint and API guide](docs/import-queue.md) for the exact scope,
known-site matching, privacy rules, and hands-on checks, and
[the phased plan](docs/import-plan.md) for subsequent library-management work.
Project IDs are now database-generated bigint values represented as decimal
strings in APIs. Versioned migrations preserve catalog records and existing
print-request references; existing folders are not renamed.

Operators can also open **Manage sources** on a project, discover URLs from its
existing catalog value and indexed shortcuts/metadata, and approve selected
source associations for duplicate detection. Discovery is offline and read-only
for files. It does not change the project's display source URL or other metadata.
See [source recovery](docs/import-queue.md#existing-project-source-recovery) for
the approval workflow and limits.

## Print requests and operator queue

Sign in as a requester or operator, open a project, and explicitly select the
files to print. Multipart files and variants are never combined or chosen
automatically. Enter a whole-number quantity from 1 to 100, optional preferred
material and color, and optional notes. A request retains the exact selected
asset and version IDs, a source-file metadata snapshot, and its preferences
even when a scan renames a project, finds a new version, or marks an old file
missing. An unavailable version is labeled as such; opening its historical
download returns 410, never a different indexed version. Version-specific
downloads check the indexed SHA-256 before streaming and return 409 if source
bytes changed without a rescan, even when file size and modification time
appear unchanged. Offline or partial NAS scans
do not erase requests or history. Print Pantry tracks decisions only: opening
or downloading a file remains a separate, manual slicer workflow.

Requesters can view their own requests and cancel them while **requested** or
**queued**. Operators can view all requests and the queue. The server enforces
this transition graph (no transitions out of a terminal state):

| Current state | Action | Next state | Who |
| --- | --- | --- | --- |
| requested | approve | queued | operator |
| requested | decline | declined | operator |
| requested, queued | cancel | canceled | owning requester |
| queued, selected as next | start | printing | operator |
| printing | complete | completed | operator |

An operator can add action notes, reorder all queued requests, and choose a
queued request as next before marking it printing. The queue contains only
queued requests; printing and terminal requests are not reorderable. Status
changes, queue order, and the selected-next pointer are committed together.
Queue-changing API calls use a monotonically increasing `revision`; send the
revision returned by `GET /api/requests/queue` as `expectedRevision` when
reordering or choosing next. A stale revision, outdated status, or changed
queue membership returns 409; reload the queue before retrying rather than
silently overwriting another operator's decision. Action history records the
actor and timestamp for every meaningful request change.

The backend serves the following authenticated routes without `/api`; Vite
rewrites the browser's `/api` prefix. `POST /requests` accepts `projectId`,
`selected: [{assetId, versionId}]`, `quantity`, and optional `material`,
`color`, and `notes`. `GET /requests` lists only the signed-in requester's own
requests, or all requests for an operator; `GET /requests/:id` returns details
and history subject to the same ownership rule. `PATCH /requests/:id` performs
`approve`, `decline`, `cancel`, `start`, or `complete` with optional `note` and
`expectedRevision`. Operator-only `GET /requests/queue`,
`PUT /requests/queue` (`orderedIds` must exactly match queued membership), and
`POST /requests/queue/next` (`requestId`) manage ordering and selected-next.
Unauthorized operations are rejected by the API, not just hidden in the UI.

For a real browser run, start the development app with a **disposable** database,
a generated STL-only library, and synthetic operator/requester accounts. The
browser suite in `tests/browser/` fails closed unless
`PANTRY_E2E_SYNTHETIC=1`, `PANTRY_E2E_BASE_URL` points to
`http://127.0.0.1:<web-port>`, `PANTRY_E2E_BROWSER_PATH` names an already
installed Chromium-compatible browser, and `PANTRY_E2E_PASSWORD` is the
synthetic accounts' password. Set `PANTRY_E2E_SYNTHETIC_LIBRARY_ROOT` to the
host directory of the generated STL fixture, mounted read-only in the
container. It must live under a Copilot session-state directory or a
`print-pantry-e2e-*` temporary directory; the suite verifies the exact
generated STL content before temporarily moving it and restores it afterward.
The accounts are named `syntheticoperator` and `syntheticrequester`.
Run `npm run test:browser` on the host with Node 24.13.1
while the isolated app container is ready. The suite exercises desktop and
mobile browsing/search, clipboard and exact-file download, selection and
submission, cancellation/decline, approval/reorder/selected-next, printing
and completion, requester history, unavailable-version/410 behavior after a
synthetic rescan and subsequent recovery, and viewport overflow. It creates real
requests in the **disposable** database; never aim it at an existing
household database or actual library.

## Development container

The image uses Microsoft's Node/Bookworm dev-container base rather than the
minimal Node slim image. It includes Git, GitHub CLI (`gh`), curl/wget, jq,
ripgrep, OpenSSH, Bash/Zsh, Python 3, native build tools, and standard shell
utilities. Node **24.13.1** and its bundled npm are copied from the pinned
official Node image, so the broader development base does not change the
repository's runtime version.

Docker Engine with Compose is required. Copy `.env.example` to ignored `.env`
and set `HOST_NPM_CONFIG_FILE` to the absolute path of your existing npm user
configuration (find it with `npm config get userconfig`). Compose refuses to
start without this file; it must be nonempty and readable by the container's
`node` user. This file is mounted **read-only at runtime**, not copied into
the image or build context. If your
registry depends on additional proxy environment variables, set
`HOST_NPM_PROXY_ENV_FILE` to an external, untracked environment file with
`HTTPS_PROXY`, `HTTP_PROXY`, and/or `NO_PROXY`; never commit or paste its
contents into logs. If a custom CA is required, set `HOST_NPM_CA_FILE` to its
external PEM bundle; it is mounted read-only and used by npm and Node TLS.
Do not commit these files or replace your configured registry. Package
installation runs as the non-root `node` user after the container starts,
never during image build. Local `npm ci` uses your configured registry; the
lockfile has no registry-specific tarball URLs. GitHub-hosted CI uses the
runner's configured registry, not your machine's private config.

The host Git config defaults to `$HOME/.gitconfig`; set `HOST_GIT_CONFIG_FILE`
in `.env` if you use another location, such as `$HOME/.config/git/config`.
Compose requires an existing regular file and mounts it **read-only** at
`/run/pantry-host-gitconfig`. Git includes it through the container's system
config, so host identity and preferences are available to Dev Containers,
`docker compose exec`, and SSH sessions. The file is never copied into the
image. Container-global and repository-local settings can override these
defaults without modifying the host file. Only `/workspace` is trusted for
host/container bind-mount ownership differences; no wildcard trust is added.

Host-specific paths in Git config do not become portable automatically:
additional `include` files, global ignore files, signing programs, and macOS
credential-helper executables need container-compatible paths or explicit
read-only mounts. Do not mount your whole home directory or private keys.
VS Code Dev Containers provides its own host credential-helper and SSH-agent
forwarding; plain Compose/SSH sessions can use the opt-in SSH-agent forwarding
described below. GitHub CLI authentication is separate and is not copied from
the host.

The development Docker image only installs Debian packages. If a later
**production build** runs `npm ci` in a Dockerfile, supply the same external
config as a BuildKit secret and mount it only for that `RUN` step (for example,
`RUN --mount=type=secret,id=npmrc,target=/home/node/.npmrc,uid=1000,gid=1000
npm ci`), with a separate secret-mounted CA when needed. Do not use `ARG`,
`ENV`, or `COPY` to put npm credentials in image layers. A production build
must fail if the configured feed is unavailable; it must not retry via public
npm.

Supply `SSH_AUTHORIZED_KEYS_FILE` as the absolute path to an **untracked
host-side public** authorized-keys file (one public key per line). It must be
a regular readable file. No private key or personal SSH configuration belongs
in the repository or image. Without a key file, the container still starts but
accepts no SSH login. Example with your own public key only:

```sh
mkdir -p "$HOME/.config/print-pantry"
cp "$HOME/.ssh/id_ed25519.pub" "$HOME/.config/print-pantry/authorized_keys"
# Set the absolute path of that file in your ignored .env:
# SSH_AUTHORIZED_KEYS_FILE=/absolute/path/to/authorized_keys
docker compose -f compose.dev.yml up -d --build
docker compose -f compose.dev.yml ps
docker compose -f compose.dev.yml exec -u node app npm ci
docker compose -f compose.dev.yml exec -u node app npm run build
docker compose -f compose.dev.yml exec -u node app npm test
```

Open **http://127.0.0.1:5173** for the shell and
**http://127.0.0.1:3000/ready** for API readiness. The host binds web
(`WEB_BIND_ADDRESS:WEB_PORT`, default `127.0.0.1:5173`), API
(`API_BIND_ADDRESS:API_PORT`, default `127.0.0.1:3000`), and SSH
(`SSH_BIND_ADDRESS:SSH_PORT`, default `127.0.0.1:2222`). Change a port in
`.env` if already occupied; Compose reports a bind error rather than stopping
another process. PostgreSQL is reachable only inside the Compose network.
Development database data, SSH **host keys**, npm cache, and `node_modules`
have separate persistent Docker volumes. The optional `LIBRARY_HOST_PATH`
mounts a host directory at `/mnt/library` **read-only**; its default is an
empty synthetic directory. Do not use a real library for tests.

Open this repository using **Dev Containers: Reopen in Container**. The
`.devcontainer/devcontainer.json` joins the same Compose application with
`/workspace` as the workspace and `node` as the remote user. Container creation
runs `npm ci`; the app service stays available without starting watchers.
Run `npm run dev` in the container to build shared packages, migrate, seed the
local account, and start the API/web watchers. After image or mount changes,
use **Dev Containers: Rebuild Container**, or recreate the app with
`docker compose -f compose.dev.yml up -d --build app` and then restart
`npm run dev`. Rebuilding the app preserves the database and other named
volumes.

Dev Containers also loads `.devcontainer/compose.yml`. It declares the CLI's
generated feature directory under `${TMPDIR:-/tmp}/devcontainercli/container-features`
as an additional build context. Compose 5.6 / Buildx 0.37 require explicit
filesystem read access when VS Code generates `Dockerfile-with-features`
outside the repository; without this context, a rebuild (including **Rebuild
Container Without Cache**) fails with `additional privileges requested` and
`--allow=fs.read=.../Dockerfile-with-features`. This grants access only to the
generated feature directory, without disabling Bake's filesystem checks.
Plain Compose commands continue to use only `compose.dev.yml`; the extra
context is needed only for Dev Containers builds. On macOS/Linux, keep
`TMPDIR` consistent between VS Code and Compose (the default is sufficient).

For an SSH-based agent workspace, use a client key matching the public key
supplied above:

```sh
ssh -F /dev/null -p 2222 -i /path/to/private-key node@127.0.0.1
cd /workspace
npm run typecheck
```

SSH runs a real OpenSSH daemon. Only public-key login for `node` is enabled;
password, keyboard-interactive, and root login are disabled. Its host key is
generated at runtime in a Docker volume. Verify the fingerprint on first
connection by a trusted local channel rather than disabling host-key checks.
Forwarding an SSH agent is disabled by default. To opt in, set
`SSH_ALLOW_AGENT_FORWARDING=true` in `.env`, restart the app container, and
use `ssh -A`; never mount a private key into the container.

If startup fails, check `docker compose -f compose.dev.yml logs app db`. A
package-registry error usually means the host npm config was not mounted or
cannot be read by `node`; a 503 from `/ready` means PostgreSQL is unreachable.
If an old volume predates the test database initialization, create a **new
isolated** Compose project rather than deleting unrelated database data.
Do not run `docker compose down -v` on a project containing data you want to
keep.

This repository has no open-source license selected yet.
