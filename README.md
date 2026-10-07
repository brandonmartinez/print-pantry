# Print Pantry

A cozy home for 3D print files: browse a model library, pick a project, and
queue a print request.

The Phase 1 foundation includes a React/Vite shell, a Fastify API, typed shared
contracts, and PostgreSQL access through Drizzle. Later phases will add the
library catalog and print requests. Files will remain usable outside the app;
print requests will not automatically start a printer.

See [KICKOFF.md](KICKOFF.md) for the initial product and implementation brief.

## Workspace and commands

Use **Node 24.13.1** (see `.node-version`) and the npm registry already
configured for your environment. Do not change the registry to work around an
installation failure. The project `.npmrc` omits registry-specific tarball
URLs from the lockfile so each environment uses its own configured registry
without changing pinned versions or integrity checks. `npm ci` installs the checked-in lockfile. The workspace
contains `apps/web`, `apps/api`, `packages/contracts`, and `packages/db`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the web and API watchers together |
| `npm run build` | Build shared packages, API, then web |
| `npm run typecheck` | Type-check all workspaces |
| `npm run lint` | Lint workspace code |
| `npm test` | Run focused API, React, and database tests (requires isolated test DB) |
| `npm run db:generate` | Generate a reviewed SQL migration from schema changes |
| `npm run db:migrate` | Apply versioned migrations to `DATABASE_URL` (build first) |

Migrations live in `packages/db/drizzle/`, including Drizzle's version journal.
Commit generated SQL and journal together; inspect SQL before applying it. The
API does **not** migrate on request. The development container migrates at
startup; CI exercises migrations against `print_pantry_test`. For host-only
development, provide your own isolated PostgreSQL and set `DATABASE_URL` and
`TEST_DATABASE_URL` (the latter must point to `print_pantry_test`), then run
`npm run build && npm run db:migrate && npm test && npm run dev`. Never target
an external or production database with the test URL.

`GET /health` reports process liveness; `GET /ready` checks PostgreSQL
connectivity and returns HTTP 503 when it is unavailable. The frontend calls
`/api/ready` through the Vite development proxy. This is a foundation shell,
not a functional catalog or queue.

## Development container

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
docker compose -f compose.dev.yml exec app npm test
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
`/workspace` as the workspace and `node` as the remote user. The app service
starts dependencies, builds, migrates, and runs both watchers. For an SSH-based
agent workspace, use a client key matching the public key supplied above:

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
