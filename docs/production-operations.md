# Production operations

This guide applies to the Phase 4 production deployment. It is deliberately
separate from `compose.dev.yml`: development's localhost ports, disposable
database, and dev-container SSH service are not a production topology.

Production uses `compose.prod.yml` with `api`, `web`, and `db` services.
`compose.external.yml` is the explicit external-database override: it places
the internal database behind an inactive profile and requires `DATABASE_URL`.
The default file deliberately clears an inherited `DATABASE_URL`; only the
override can point the API at an external database. Do not
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

Copy `deploy/production.env.example` into an ignored `.env`, fill its
placeholders, and restrict access to the file. Set `LIBRARY_HOST_PATH` to an
existing absolute host directory: Compose mounts it read-only at
`LIBRARY_ROOT=/mnt/library` in the container. `CLIENT_MOUNT_PREFIX`, when
set, is the separate client-visible path; do not expose a container-only path
to browser operators. For internal PostgreSQL, create an external password
file containing a unique 24+ character URI-safe password (for example,
`openssl rand -hex 24 > /private/path/db-password`), restrict it to its owner,
and set `DB_PASSWORD_FILE` to its absolute path. The tracked empty secret
placeholder cannot start the database.

Before building, confirm the library and secret paths exist and inspect the
Compose topology without printing its configuration (which can include
credentials). Export variables from the trusted, ignored `.env` for Bake;
Compose also reads that file from the repository root:

```sh
set -a
. ./.env
set +a
test -d "$LIBRARY_HOST_PATH" && test -s "$HOST_NPM_CONFIG_FILE"
test -n "${DATABASE_URL:-}" || test -s "$DB_PASSWORD_FILE"
docker compose -p <composeproject> -f compose.prod.yml config --quiet
```

Use a dedicated database and database role if choosing the external
override, and verify the intended endpoint separately before migrations.
Set exact private HTTPS `PUBLIC_ORIGIN` and `COOKIE_SECURE=true`. Docker
Compose v5 cannot grant
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

The first allowed path is the `HOST_NPM_CONFIG_FILE` value. The secret directory covers the internal database password file and optional
npm CA/proxy secret files. Compose passes the npm configuration as the
required `npmrc` BuildKit
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

1. Terminate HTTPS at the private reverse proxy and preserve its original
   `Host` header. The internal nginx-to-Fastify hop uses HTTP; Fastify does
   not trust forwarded headers to decide the public origin.
2. Use an origin allowed by the application; do not relax CORS merely to make a
   new proxy work.
3. Set `COOKIE_SECURE=true` behind HTTPS and make `PUBLIC_ORIGIN` exactly
   match the private HTTPS origin. Preserve the application's HttpOnly,
   SameSite session-cookie protections and its API CSRF/origin boundary; do
   not rewrite cookie attributes at the proxy.
4. Do not publish PostgreSQL. Restrict the application itself to the intended
   private network.

The Compose port defaults to host loopback for a reverse proxy on the Docker
host. A proxy in another network needs an explicitly scoped network/binding
and firewall policy; do not make the port publicly reachable simply to connect
it. These images are built for the builder's platform by default. Confirm the
NAS CPU architecture and build a matching image before transfer; the local
tests here do not establish NAS platform compatibility.

Local HTTP is only for intentionally isolated testing: set
`WEB_BIND_ADDRESS=127.0.0.1`, `PUBLIC_ORIGIN=http://127.0.0.1:<WEB_PORT>`,
`COOKIE_SECURE=false`, and `ALLOW_INSECURE_HTTP=true`. The application
refuses this exception when the host binding is non-loopback. Never use it
for a NAS or reverse-proxied deployment.

Migrations are not run by HTTP requests. After the API is running, create the
first household account interactively:

```sh
docker compose -p <composeproject> -f compose.prod.yml exec -it api \
  sh deploy/entrypoint.sh node apps/api/dist/provision.js operator operator
```

This command prompts for a password on a TTY and never accepts it as an
argument. The first account must be an operator. Replace the final role with
`requester` for later requester accounts. Do not paste passwords into shell
history, Compose environment files, or automation. The entrypoint loads the
secret-derived `DATABASE_URL` for the exec process; it is required for the
internal password-file mode and is safe to use as the shared command for the
external-database mode. The migration `run` commands already invoke this
entrypoint automatically.

Finally, sign in through the private HTTPS origin, confirm API readiness, and
perform an operator rescan. A healthy empty library is only authoritative when
`LIBRARY_ALLOW_EMPTY=true` is intentionally set. Otherwise an empty,
unavailable, or partial mount must not mark an existing catalog as missing.

## Routine operations and upgrades

Keep the production Compose revision, environment file, password-file secret,
library mount configuration, and database volume together as one deployment
record. Before an upgrade, record the currently running image/revision and
take a verified backup. Build the new image through the secret-based path,
stop `web` and `api` to quiesce application writes, run the explicit migration
with `run --rm --no-deps api node packages/db/dist/migrate.js`, then restart
with `up -d --wait api web`. Do not reset the database volume or replace a
failed migration with an empty database. When using an external database,
include `-f compose.external.yml` consistently in each Compose command.
Never point a migration or test command at an unrelated external schema.

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

Quiesce application and import/SMB writes while capturing a coordinated
database dump and library snapshot/copy. A PostgreSQL dump is internally
consistent, but it does not freeze a separately mounted library. Record both
capture times and reject a pair if file content changed between captures.
Retain backups and their restore evidence according to an owner-approved
retention policy on storage independent of the live database/library; keep
at least one previously verified recovery point across upgrades. The
verification script retains its archive and fresh target; never reuse them
as a live database or silently remove them.

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

The script reads the source only, requires a fresh isolated restore
target, and checks the restored rowsets. It refuses an unsafe restore target;
do not bypass that refusal. Use a unique
`print_pantry_restore_<unique>` database name and never point `RESTORE_*` at
the production service. Independently verify the library backup by restoring
a **copy** outside the live mount and comparing a complete file manifest
(relative paths, sizes, and SHA-256 digests), including models, images,
sidecars, and archive roots. Keep this verification copy read-only to Print
Pantry; use the restored database only with that copy or a separate generated
fixture, never with the live library. Check representative catalog metadata,
selected versions, request/history/queue records, and authenticated
download/preview from the isolated restored pair. Record the backup identifier,
software revision, verification date, and result. Treat a failed verification
as an unusable backup.

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
