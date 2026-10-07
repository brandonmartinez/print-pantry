# Production operations

This guide applies to the Phase 4 production deployment. It is deliberately
separate from `compose.dev.yml`: development's localhost ports, disposable
database, and dev-container SSH service are not a production topology.

Production uses `compose.prod.yml` with `api`, `web`, and `db` services.
`compose.external.yml` is the explicit external-database override: it removes
the default internal database profile and requires `DATABASE_URL`. Do not
substitute development commands into a NAS. The deployment provides:

- a multi-stage Node 24.13.1 API image and an nginx image that serves the
  static frontend, proxies `/api` to Fastify after stripping that prefix, and
  falls back to the SPA only for non-`/api` paths;
- an internal PostgreSQL 17 service with persistent storage by default;
- an explicitly selected external-database override or profile when
  `DATABASE_URL` is intentionally supplied, never an accidental connection to
  a host-local database;
- a read-only library mount at `LIBRARY_ROOT`, persistent database storage,
  internal-only database networking, and application readiness checks;
- a mandatory BuildKit npm configuration secret sourced from the existing
  host npm configuration. The build must fail when that configured registry is
  unavailable, rather than retrying against a public registry.

Keep the deployment environment file and password-file secret outside Git with
owner-only permissions. Do not place registry credentials, database passwords,
NAS paths, model data, or private certificates in image layers, build
arguments, command history, or this repository. A custom npm CA, if needed,
must likewise be secret-mounted only for the dependency-install layer.

## Initial deployment

Before building, use the deployment's documented preflight to verify the
production environment has all required secret-file paths, an existing npm
configuration file, an empty or intentionally provisioned database volume, and
the intended **read-only** library path. Confirm the library path in the
environment is the container path and `CLIENT_MOUNT_PREFIX`, when set, is the
separate client-visible path; do not expose a container-only path to browser
operators.

Set production configuration in an ignored environment file, including the
exact HTTPS `PUBLIC_ORIGIN`, `COOKIE_SECURE=true`, the read-only
`LIBRARY_ROOT`, and any optional client mount prefix. Export the needed
variables from that file without printing them. Docker Compose v5 cannot grant
BuildKit filesystem access to the host npm configuration through `docker
compose build`; build the two images with Bake instead:

```sh
docker buildx bake -f compose.prod.yml \
  --allow=fs.read=/absolute/path/to/npmrc \
  --allow=fs.read=/absolute/path/to/secret-directory \
  --load \
  --set api.tags=<composeproject>-api:latest \
  --set web.tags=<composeproject>-web:latest \
  api web
```

The first allowed path is the `HOST_NPM_CONFIG_FILE` value. The secret
directory covers required runtime password and optional npm CA/proxy secret
files. Compose passes the npm configuration as the required `npmrc` BuildKit
secret and can also secret-mount `npm_ca` and `npm_proxy`. The build must fail
if the configured registry cannot be reached; do not switch to a public
registry.

For a deliberately external database, set `DATABASE_URL` in the ignored
environment file, do not provide an internal database password file, and use
the external override consistently:

```sh
docker compose -p <composeproject> -f compose.prod.yml -f compose.external.yml \
  run --rm --no-deps api \
  node packages/db/dist/migrate.js
docker compose -p <composeproject> -f compose.prod.yml -f compose.external.yml \
  up -d --wait
```

This override starts only `web` and `api`; it never silently starts a local
database. Ensure the selected database is reachable before the migration step.

For the default internal database, wait for `db` to be healthy, apply
migrations, then start the application services:

```sh
docker compose -p <composeproject> -f compose.prod.yml up -d --wait db
docker compose -p <composeproject> -f compose.prod.yml run --rm --no-deps api \
  node packages/db/dist/migrate.js
docker compose -p <composeproject> -f compose.prod.yml up -d --wait api web
```

The frontend origin is intended for a private HTTPS reverse proxy, not direct
public internet exposure. At that boundary:

1. Terminate HTTPS at the private reverse proxy and forward the original
   scheme/host as configured by the deployment.
2. Use an origin allowed by the application; do not relax CORS merely to make a
   new proxy work.
3. Set `COOKIE_SECURE=true` behind HTTPS and make `PUBLIC_ORIGIN` exactly
   match the private HTTPS origin. Preserve the application's HttpOnly,
   SameSite session-cookie protections and its API CSRF/origin boundary; do
   not rewrite cookie attributes at the proxy.
4. Do not publish PostgreSQL. Restrict the application itself to the intended
   private network.

Local HTTP is only for intentional localhost operation: bind locally and set
`ALLOW_INSECURE_HTTP=true`. Never use that setting for a reverse-proxied or
network-accessible deployment.

Migrations are not run by HTTP requests. After the API is running, create the
first household account interactively:

```sh
docker compose -p <composeproject> -f compose.prod.yml exec -it api \
  node apps/api/dist/provision.js operator operator
```

This command prompts for a password on a TTY and never accepts it as an
argument. The first account must be an operator. Replace the final role with
`requester` for later requester accounts. Do not paste passwords into shell
history, Compose environment files, or automation.

Finally, sign in through the private HTTPS origin, confirm API readiness, and
perform an operator rescan. A healthy empty library is only authoritative when
`LIBRARY_ALLOW_EMPTY=true` is intentionally set. Otherwise an empty,
unavailable, or partial mount must not mark an existing catalog as missing.

## Routine operations and upgrades

Keep the production Compose revision, environment file, password-file secret,
library mount configuration, and database volume together as one deployment
record. Before an upgrade, record the currently running image/revision and
take a verified backup. Build the new image through the secret-based path,
run the explicit migration step exactly once, replace the application services,
and wait for readiness before switching proxy traffic. When using an external
database, include `-f compose.external.yml` consistently in each Compose
command. Never point a migration or test command at an unrelated external
schema.

Rescans are read-only. Operators may trigger them from the catalog UI/API, and
the scheduler uses `SCAN_INTERVAL_MINUTES`. Configure ignored directories only
by directory name with `LIBRARY_IGNORED_DIRS`; do not use path fragments or
assume underscore-prefixed collections are disposable. Investigate a failed,
partial, or offline scan before retrying. Do not repair it by deleting catalog
rows or moving library files.

Production does not provide the development container's SSH service. Use the
NAS or container platform's separately approved administrative access path for
operations. Do not expose dev SSH ports, reuse development SSH keys, or claim
that live NAS, external-database, or reverse-proxy behavior was verified by
this repository.

## Backup and restore verification

The database and the real library are separate recovery domains. Back up both:

| Domain | Include | Consistency requirement |
| --- | --- | --- |
| PostgreSQL | Catalog, accounts, sessions, requests, queue state, selected versions, and action history | Quiesce writes or use a PostgreSQL-consistent backup method. |
| Library | Model files, assets, sidecars, source metadata, and archive roots | Use storage-consistent snapshots/copies and retain the source-to-backup mapping. |
| Deployment secrets/configuration | Environment values, password-file location, library/client mount mapping, and reverse-proxy configuration | Store separately with access controls; never commit secrets. |

Verify every backup non-destructively before relying on it:

The `scripts/verify-restore.sh` worker requires Bash and PostgreSQL 17 client
tools. Supply connection settings through the environment, keeping credentials
in approved external authentication mechanisms rather than command history:

```sh
SOURCE_PGHOST=<source-host> \
SOURCE_PGPORT=<source-port> \
SOURCE_PGUSER=<source-user> \
SOURCE_PGDATABASE=<source-database> \
RESTORE_PGHOST=<isolated-host> \
RESTORE_PGPORT=<isolated-port> \
RESTORE_PGUSER=<isolated-user> \
RESTORE_PGDATABASE=<isolated-admin-database> \
RESTORE_DATABASE_NAME=print_pantry_restore_<unique> \
BACKUP_FILE=/absolute/path/to/backup \
scripts/verify-restore.sh
```

The script reads the source dump only, requires a fresh isolated restore
target, and checks the restored rowsets. It refuses an unsafe restore target;
do not bypass that refusal. Use a unique
`print_pantry_restore_<unique>` database name and never point `RESTORE_*` at
the production service. Also verify an isolated, read-only library fixture or
copy: compare project, asset, and version counts; sample metadata; verify
representative request, queue, selected-file, and action-history records; and
exercise authenticated catalog access. Record the backup identifier, software
revision, verification date, and result. Treat a failed verification as an
unusable backup.

Refuse a restore target unless it is positively identified as the disposable
verification instance. Do not automate broad deletes, volume removal, or a
restore that cannot demonstrate that isolation.

## Troubleshooting

| Symptom | Safe response |
| --- | --- |
| Image build cannot download packages | Verify the required host npm configuration secret and optional CA secret are mounted for the build. Do not change to a public registry. |
| API is not ready | Check the application and database logs, connectivity, migration result, and required `DATABASE_URL`; do not reset a production volume. |
| Login fails only behind HTTPS | Verify the proxy forwards the correct scheme/host and that `COOKIE_SECURE=true` is set only for HTTPS. Do not weaken cookie or origin protections. |
| Library appears empty or files become unavailable | Verify the read-only mount and scan status first. Keep `LIBRARY_ALLOW_EMPTY=false` unless an intentionally empty healthy library is being cataloged. |
| Client copy-path is unusable | Correct `CLIENT_MOUNT_PREFIX` to the operator's mounted path; it must not be a container path. |
| Upgrade fails during migration | Keep the old deployment stopped or isolated as appropriate, restore only to a verified target if needed, and investigate the migration error before retrying. |

## Retiring the generated catalog

The old generated HTML/SQLite catalog remains owned by the separate
`automation-scripts` repository. This repository does **not** change that
repository or move/delete real files. Coordinate its handoff as a separate,
reviewed change covering:

1. Inventory current generation and import behavior in
   `organization/3d-print-catalog-functions.sh`,
   `organization/manage-3d-print-catalog.sh`, and
   `organization/organize-3d-imports.sh`.
2. Preserve import organization, safe renaming rules, and source metadata in
   the replacement workflow. Configure the archive root explicitly; never
   infer a personal NAS path.
3. Replace generated-catalog duplicate checks with a reviewed equivalent.
   Compare duplicate decisions on representative synthetic/import fixtures
   before changing behavior.
4. Copy the real library and independently verify backup coverage before any
   generated-catalog retirement. Verify imports, project discovery, source
   metadata, archive-root behavior, and duplicate handling against the copy.
5. Cut over only after the new catalog is usable and recovery has been
   rehearsed. Archive or remove generated HTML/SQLite only under the external
   repository's approved plan; do not keep two authoritative catalogs.

No real library, NAS, or automation-scripts behavior is verified by this
guide. Record that verification with the owner when the separate handoff is
performed.
