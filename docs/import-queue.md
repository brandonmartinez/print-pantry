# Manual imports: testing checkpoint

Household users submit URLs; operators acquire files manually and publish
reviewed projects into separate managed storage. No site credentials or AI
key are required. There is no automatic MakerWorld download or automatic
printing. The legacy library stays read-only; adopting existing projects into
managed storage is a separate, explicitly approved copy-first workflow.

## Try it

Start the app with `npm run dev`. Startup applies the versioned migrations.
Use the existing operator account, and create a requester with the documented
account-provisioning command if you do not already have one.

1. As a requester, choose **Add New Print**.
2. Enter a complete source URL, optional title, and notes.
3. Check the source, review existing-project or pending-import matches, then
   explicitly submit or join the existing import.
4. Open **Imports** and reload. The request and notes should remain.
5. As an operator, open **Imports**. Open the source website in a new tab.
6. Accept the request and confirm **Awaiting files**, then prepare its intake.
7. Download a small model from the website yourself. Upload its ZIP or individual
   files through the operator workspace. Start with synthetic/test files.
8. Enter the project title and metadata, then process the files. Inspect the
   proposed paths, warnings, and duplicate matches. Adjust paths or exclude
   files as needed and save the plan. At least one model/CAD/print file must
   remain selected. Files cannot change extension during organization.
9. Publish; explicitly acknowledge duplicates if present. Open the linked
   project, inspect its metadata and previews, download a model, and submit a
   normal print request. The two queues must remain distinct.
10. Reload during intake and confirm uploads, metadata, plan, history, and
    originals survive. Removed uploads stop participating in the plan but
    remain downloadable by operators as retained originals.
11. As a second requester, submit a different slug/locale/profile URL for the
   same MakerWorld model. It should join the same active import, retaining
   that person's source URL, selected profile, and notes.
12. Requesters should see only their own submissions and notes, not the operator
    upload workspace. Operators see
   all associated submissions. Operator decision notes are shared with the
   people following that import; private requester notes are not copied into
   published project metadata.
13. Verify legacy-only projects remain unavailable in the live catalog until
   separately activated. Legacy files and physical layout stay unchanged.

Useful example:

```text
https://makerworld.com/en/models/2747706-universal-drill-bit-holder-fits-kobalt-more?from=search#profileId-3048005
```

Known-site matching recognizes MakerWorld, Thingiverse, Printables, and common
Thangs model URLs. Recognition is offline; it does not promise metadata or
downloads from those sites. Unknown websites are accepted without an adapter.
Their query parameters and fragments are retained because they may identify
the model or desired variant.

If the source already belongs to a catalog project, open that project first.
The intake form permits an explicit additional-import submission when needed;
it never automatically merges or overwrites existing files.

Active imports are shared by normalized source identity. Concurrent posts
cannot create separate active imports for the same identity. Repeat network
submissions reuse a per-payload idempotency key, retaining notes only once.
An operator cancel/decline closes the shared import for everyone; requesters
cannot close another person's work by canceling a shared record.

## Guided legacy library import

Open **Manage library > Import library** (`/import-library`) as an operator.
Configure separate `LEGACY_LIBRARY_ROOT`, `IMPORT_STORAGE_ROOT`, and
`MANAGED_LIBRARY_ROOT` directories. No catalog scan is required. Opening the
page lists recent sessions; **Browse folders** explicitly starts discovery.

1. Expand/search the tree and select project roots. A checked folder is one
   project including all its descendants. Suggestions are optional. Roots cannot
   overlap; replacing selected children with a parent requires confirmation.
2. Choose **Standardize** or **Keep layout**, then **Review organization**.
   Ancestor folders propose editable categories without assuming fixed depth.
   Independent files get readable names and deterministic format folders.
   Linked model/texture and HTML resources retain relative names/layout together;
   unsafe linked names block preparation rather than breaking references.
3. Edit names, categories, and independent destination paths. Expand **Files**
   for original/proposed mappings. Save project edits before preparation.
4. Choose **Prepare files**. The worker retains and hash-verifies each project's
   originals and recovery manifest before creating its organized copy. Reload
   the saved `?session=...` URL to resume or observe progress.

**Files organized** is the stopping point: this flow does not create live
catalog entries or managed projects. AI, publication, and activation are not
implemented here. Advanced adoption remains separate and does not consume these
organized staging copies. No original files are changed or automatically purged.

Discovery limits: 20,000 entries, 10,000 files, 24 levels. Batch limits: 100
project roots, 20 GiB of selected bytes. Destination paths also obey intake
portability limits (12 components, 700 characters, 200 bytes per component).
Unselected files stay outside the batch. Symlinks/special entries are never
followed. OS metadata and `LEGACY_LIBRARY_IGNORED_DIRS` are excluded.

Recovery is outside the live library, under `IMPORT_STORAGE_ROOT`:

```text
legacy-imports/<session-id>/
  originals/<project-key>/<file-id>
  recovery/<project-key>.json
  organized/<project-key>/<reviewed-relative-path>
```

The versioned manifest records original relative names, directories (including
empty directories), proposed metadata/paths, sizes/hashes, source fingerprint,
and any matching legacy catalog project rows. Original bytes use opaque IDs;
reconstruct the original tree from this mapping, not organized filenames.
Keep-layout staging recreates empty directories too. Retained copies are not
an independent backup: back up intake and PostgreSQL together.

The worker processes one project per tick under a per-session database lock
and resumes persisted queued work after restart. Changed source/storage identity
blocks preparation; start a new session for a changed inventory. Correct a
retryable storage failure and choose **Retry preparation**. Existing files are
never overwritten; conflicting bytes stop the operation. Retain recovery/staging
data when investigating failures. There are no pause/cancel controls yet;
queued preparation continues server-side after navigation.

### Shared operator API

All routes require an authenticated operator cookie, including agent clients.
Browser calls use `/api`; direct Fastify calls omit that prefix. Bodies are
strict JSON objects; no endpoint accepts arbitrary host roots.

| Method and path | Body / result |
| --- | --- |
| `GET /api/library/imports` | Configuration status and latest 10 session summaries |
| `POST /api/library/imports` | `{id: UUID}`; idempotent discovery creation |
| `GET /api/library/imports/:id` | Saved tree, selection, projects, state, revision |
| `POST /api/library/imports/:id/selection` | `{expectedRevision, roots: string[], layout: "standardize" or "preserve"}` |
| `POST /api/library/imports/:id/plan` | `{expectedRevision}`; deterministic review plan |
| `POST /api/library/imports/:id/edit` | `{expectedRevision, key: UUID, name, category: string or null, paths: [{id: UUID, path}]}` |
| `POST /api/library/imports/:id/organize` | `{expectedRevision}`; queue verified recovery/organization |

Use each response's revision in the next command; stale updates return 409.
Root paths/file IDs must come from the saved discovery/plan. An empty root
string selects the entire configured source as one project, not a host path.
Changing selection clears the plan. Prepared sessions are immutable. Public
responses expose relative paths, not configured host-storage paths.

## Storage and organization

Development defaults to the ignored `.pantry-data/intake` and
`.pantry-data/library` directories in the repository. Outside Compose, set both
`IMPORT_STORAGE_ROOT` and `MANAGED_LIBRARY_ROOT` to override them. In Compose,
set `MANAGED_LIBRARY_HOST_PATH` to an existing, application-writable host/NAS
directory; Compose supplies the corresponding in-container managed root. Production
requires both explicitly; the production Compose configuration supplies
independent persistent volumes by default. All configured roots, including the
optional `LEGACY_LIBRARY_ROOT`, must be separate, non-nested, and have no symlink components.

Published projects use:

```text
projects/1042-universal_drill_bit_holder/
  project.json
  README.md
  LICENSE.txt
  models/
  images/
  docs/
  exports/
```

Only needed directories are created. Recognized text README/license/credits
and source shortcut files stay at the project root. Other supporting documents,
including PDF/HTML, go in `docs/`; printer output goes in `exports/`. HTML is
download-only, never active application-origin content. 3MF containers remain
intact. Meaningful variants, linked models/textures, and HTML resources retain
their relative layout conservatively; filenames are not aggressively renamed
or AI-translated. If linked models and HTML coexist, non-metadata files stay
together under `models/` with a warning rather than splitting shared resources.
The project directory slug is deterministic snake_case.
Categories and tags are metadata, not destination folders.

Common macOS, Windows, and Linux metadata is excluded by default when generating
a plan: `__MACOSX`, AppleDouble `._*` files, `.DS_Store`, Windows thumbnail
caches and `desktop.ini`, KDE `.directory` files, and recognized OS trash/index
folders. These files still count toward intake limits and remain in original
uploads; review can explicitly include one if needed. Ordinary hidden files,
source shortcuts, documentation, and model backups are not broadly discarded.
Included and Excluded sections show the current selection during review and
on published imports. Existing saved/published selections are not rewritten.

Every upload gets an isolated batch with the original bytes, hashes, receipt,
and recovery mappings. ZIP expansion uses opaque storage filenames while
retaining original paths in records. Originals remain outside the catalog,
including after an upload is removed. Rejected/uncommitted transient batches
are cleaned up; a successfully received batch can remain for recovery if
database registration fails. Retention is not an independent backup and there
is no automatic purge.

Limits are 256 MiB per raw upload, 512 MiB expanded per ZIP, 1 GiB each of
retained raw bytes and retained expanded/file bytes per import, 50 retained
uploads, and 1,000 retained files/ZIP entries. Removed inputs still count.
Paths have portable character, depth, and length limits; unsafe paths,
links/special entries, encrypted ZIPs, mismatched CRCs, excessive compression,
and conflicting archive paths are rejected. ZIP is the only extracted archive
format in this checkpoint. Review requests and generated manifests are bounded
to 8 MiB, including inventories with long Unicode paths.
Original upload names and ZIP entry paths are retained as metadata, not used
as extraction paths, so names containing characters such as `|` are accepted.
Traversal, absolute paths, backslashes, and control characters are still
rejected. Review proposes portable destinations: reserved characters and
trailing dots/spaces become underscores, and Windows device names get an
underscore prefix. Normalization collisions must be resolved by renaming or
excluding files; nothing is overwritten. Linked-file contents are not rewritten,
so normalization warnings require reviewing any internal references as well.

## Publication and recovery

States progress through **Submitted**, **Awaiting files**, **Ready for review**,
**Publishing**, **Catalog pending**, and **Imported**. Processing and publication
are request-driven, not background jobs. Revisions and database locks reject
overlapping changes instead of silently overwriting another operator's work.
Changing input invalidates the previous plan.

Publication reserves a bigint ID, copies verified files to private staging,
writes a manifest, and renames the complete directory into managed storage
before registering the catalog transactionally. The catalog cannot expose
a partially copied project. Duplicate source/hash matches require explicit
confirmation; no existing project is merged or overwritten automatically.

An interruption can leave **Publishing** or **Catalog pending**. Retry the
same import: the reserved identity/destination is reused and existing output
must match its manifest, ownership, hashes, and exact file inventory.
Unexpected/missing files are errors, not permission to overwrite them.
Originals remain downloadable to operators for recovery. Investigate errors
and restore expected storage rather than editing manifests to bypass checks.
If new duplicate matches appear, acknowledge them explicitly on retry.

Legacy scans do not touch managed projects. A periodic managed-root drift
reconciler is a later milestone, so keep managed storage application-owned:
do not manually rename, edit, or delete its files. Back up the database,
managed library, originals, and legacy library together as described in
[production operations](production-operations.md).

## Project IDs

Projects now use database-generated bigint IDs. API and TypeScript project IDs
are decimal strings, including values beyond JavaScript's safe-integer range.
Account, asset, version, job/import-request, and print-request IDs remain UUIDs.

The migration maps existing UUID projects and both existing foreign-key paths
to numeric IDs without deleting catalog contents or print requests. Asset and
version IDs remain unchanged. Previously bookmarked UUID project URLs must be
reopened from the catalog; no UUID route aliases are retained.

The existing project folders are not renamed by this migration. New managed
imports use `<project-id>-<semantic_snake_case_slug>` as specified in the
[implementation plan](import-plan.md).

## API

All endpoints require the existing session cookie and mutation-origin checks.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/imports/check` | Validate/recognize a URL and look up existing projects and an active import |
| `POST /api/imports` | Submit URL/title/notes with a UUID `submissionKey`; create or join an active import |
| `GET /api/imports?page=1&pageSize=20` | Paginated queue; requesters see their imports, operators see all |
| `GET /api/imports/:id` | Read an accessible import and its submissions/status history |
| `PATCH /api/imports/:id` | Operator `accept`, `decline`, or `cancel` with `expectedRevision` and optional `note` |
| `GET /api/imports/:id/intake` | Operator intake state, persisted plan, configuration, and errors |
| `POST /api/imports/:id/prepare` | Prepare isolated intake storage with `expectedRevision` |
| `POST /api/imports/:id/files?name=…&uploadKey=…&expectedRevision=…` | Stream an `application/octet-stream` file body with a stable UUID upload key |
| `DELETE /api/imports/:id/files/:uploadId` | Remove an upload from active inputs with `expectedRevision`; retain originals |
| `GET /api/imports/:id/files/:uploadId/original` | Operator-only attachment download, including removed uploads |
| `POST /api/imports/:id/plan` | Generate/save deterministic plan with `expectedRevision`, metadata, and optional complete file edits |
| `POST /api/imports/:id/publish` | Publish/recover using `expectedRevision` and `confirmDuplicates` |

Decline/cancel require a nonblank reason. A stale revision returns HTTP 409;
refresh before deciding again. Notes are limited to 2,000 characters, titles
to 256, URLs to 2,048, and pages to 50 imports. Responses include up to the
100 most recent visible submissions and 100 most recent status events per
import; older records remain stored.

Intake mutations use the returned revision for the next request. Retry an
uncertain upload with its original upload key, name, and identical bytes.
Changed payloads under the same key return conflict instead of duplicating
input. Publication retries are idempotent. Decline/cancel is unavailable once
publication starts.

Existing-source lookup covers structured source associations and legacy
`projects.sourceUrl` values, including recognized MakerWorld/Thingiverse/
Printables URL variations. Unprocessed shortcuts do not participate until an operator discovers and
approves their source associations as described below.

## Existing-project source recovery

As an operator, open a project and choose **Manage sources**, then **Discover
existing sources**. This inspects the existing catalog source URL and indexed
`.webloc`, `.url`, `project.json`, `metadata.json`, and `agentic-plan.json`
assets belonging to that project. Nested variants use catalog ownership, not
a guessed directory depth. Index new shortcuts before discovery.

XML and binary `.webloc` `URL`/`URLString` fields work without macOS tools.
Windows InternetShortcut files support UTF-8 and UTF-16. Recognized JSON source
fields include `sourceUrl`, `source_url`, managed `source.url`, and the legacy
organizer's `files[].sourceUrl`. Arbitrary README/HTML links are not treated
as sources. OS metadata/resource forks are skipped.

Nothing is fetched from websites and no library files are changed. Review
candidate URLs, model/profile evidence, malformed/unavailable sidecars, and
conflicting model identities. Profiles of the same model are grouped while
retaining their separate URLs and profile IDs in the evidence. Nothing is
selected automatically. Select only verified candidates and choose **Approve
selected associations**. Approved associations immediately participate in
new-import duplicate checks; projects are never automatically merged.

Discovery previews and approvals persist in PostgreSQL, including provenance
and evidence hashes. Reopening **Manage sources** restores the latest preview.
Approval rechecks catalog ownership and selected sidecar bytes; a stale preview
returns conflict and requires rediscovery. Repeating the same approval is
idempotent; changing an already-approved selection requires a new preview.
Already-associated sources are shown without overwriting their earlier
provenance. All scalar metadata, including a null display source URL, stays
unchanged. Use the existing metadata editor to choose a display URL explicitly.

The per-project checkpoint inspects at most the first 100 indexed sidecar
records, 128 KiB per file, 256 URL fields, and 128 distinct source candidates.
Truncation is reported as a partial preview, not a claim of complete coverage.
Binary parsing bounds the object table and reads only root URL strings;
XML nesting is bounded and entity declarations/internal DTDs are rejected.
Bulk-library discovery and automatic approval are not implemented.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/catalog/projects/:projectId/source-discovery` | Operator discovery and persisted preview |
| `GET /api/catalog/projects/:projectId/source-discovery` | Operator latest preview, including approval state |
| `GET /api/catalog/projects/:projectId/source-discovery/:previewId` | Operator persisted preview |
| `POST /api/catalog/projects/:projectId/source-discovery/:previewId/apply` | Operator explicit `candidateIds` approval, with evidence revalidation |

## Library management: read-only reorganization preview

Operators can open **Manage library** from the main navigation. The paginated
inventory distinguishes legacy and managed projects, shows catalog availability,
classification, file counts, and indexed bytes, and links to project metadata
and source recovery. Opening the screen does not scan the filesystem.

Select a small batch of legacy projects and choose **Preview reorganization**.
This saves a PostgreSQL snapshot, not a migration approval. The preview shows
legacy and proposed `projects/<existing-id>-<snake_case_title>` paths, exact
decimal-string byte estimates, available destination space, file/asset/version
mappings, and preserved metadata. Existing categories and source associations
remain in place; changing classification does not imply moving files. Internal
filenames, variants, linked resources, and empty directories retain their
relative layout rather than being reorganized by extension.

Each project has a clear inspection-status badge, file-check summary, and
separate **Current folder** / **Proposed folder** boxes. **Blockers** and advisory
**Notes** appear in separate groups. Under **Files**, paths are relative to those
folders; differing paths are shown explicitly. Sizes use readable units, with
exact byte counts available on hover and in collapsed technical details. Asset,
version, project, and snapshot IDs, full paths, and indexed hashes are kept in
technical details rather than repeated in the main review. An inspection-complete
badge is not content verification or migration approval.

Inspection is explicitly limited to 25 projects, 1,000 indexed files,
2,000 filesystem entries across the batch (including existing managed
destination directory entries), 12 relative-path components, and an 8 MiB saved
snapshot. Split a batch when limits are reported. No destination directories
are created. Current directory entries and descriptor-based file stats are
checked against indexed ownership, sizes, timestamps, and available inode/device
evidence. Hashes come from indexed versions: the preview does **not** rehash file
contents, copy files, or verify a new copy. Stat checks cannot detect every
content change, especially changes that preserve timestamps and sizes.

Blockers include unavailable storage, absent/inconsistent versions, missing or
changed files, unindexed non-OS files, unsafe/nonportable paths, reserved root
`project.json`, symlinks/special entries, case/Unicode collisions, overlapping
catalog boundaries, occupied destinations, and insufficient known free space.
Unknown files are not silently omitted. Unindexed OS metadata is ignored and
left in the retained legacy copy; already-indexed assets keep their mappings.
Missing approved sources produce a source-recovery warning. A running local
scan rejects planning; snapshots still require fresh verification before any
future activation.

Additional bytes are a **lower bound**, excluding manifest, staging, and
filesystem overhead. Originals remain in place and require extra storage;
retained copies are not independent backups. Project metadata, IDs, sources,
versions, and print-request snapshots are not modified.

The ten latest dry runs are listed for reopening after reload; a selected
snapshot is also bookmarkable through `/manage-library?plan=<id>`. Snapshots
are immutable historical previews, not live readiness guarantees. Generate a
new dry run after resolving blockers or changing files/metadata.

### Test this checkpoint

1. Use a small **synthetic** indexed legacy project first; approve its source
   through **Manage sources** if applicable.
2. Open **Manage library**, select it, and generate a preview.
3. Review old/new paths, metadata, file mappings, checked-file counts, blockers,
   and space estimates. Managed projects cannot be selected through the UI.
4. Reload or reopen the saved URL; the snapshot should persist.
5. Confirm files remain in their original location and existing downloads and
   print requests still work. Do not approve migration until you have reviewed
   the separate workflow below.

All routes below are operator-only:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/library/management?q=&page=1` | 50-project catalog page, summary counts, ten recent plans |
| `POST /api/library/reorganization-plans` | Save a dry run for explicit `projectIds` |
| `GET /api/library/reorganization-plans/:id` | Reopen the immutable dry run with current migration progress, if approved |

## Library adoption: copy, verify, activate, and restore

**Test a small synthetic legacy project first. Do not use the NAS as a test
fixture.** Obtain an independent, verified database/filesystem backup before
adopting real projects. Retaining originals is not a backup.

1. Generate and review an unblocked, complete dry run. Saved older previews are
   still historical evidence; generate a fresh one after any metadata, file,
   version, or storage change.
2. Under **Adopt into managed storage**, acknowledge the backup/retention
   requirement and review of notes and space estimates. Choose **Approve
   migration**. This creates a durable job only; no files are copied yet.
3. Choose **Copy and verify** for one project. Files and empty directories go
   into private managed staging, with an internal recovery manifest. The app
   freshly checks indexed hashes against source bytes, copied bytes, and source
   bytes again. Existing catalog rows do not switch. Legacy projects remain
   migration-only: they are hidden from normal browsing/downloads, and any
   historical print-request files remain `migration_required` until activation.
4. Choose **Activate managed copy**, then **Confirm activation**. Inventory,
   hashes, catalog evidence, root identity, and destination ownership are checked
   again. The verified directory is published at the proposed path and existing
   project/asset locations are updated transactionally. Project, asset, and
   version IDs, display metadata, sources, classifications, request history, and
   historical request-file snapshots are preserved. New paths resolve through
   those same IDs.
5. Reload the saved plan. Progress must persist without automatically repeating
   an operation. Open the project, inspect previews and metadata, download a file,
   and open an existing print request. Run a legacy rescan: the retained original
   must not become a duplicate project or replace the managed metadata.
6. To test recovery, choose **Restore legacy location**, then **Confirm
   restoration**. Both copies must still match the approved inventory and bytes,
   and current file identities/versions must be unchanged. The catalog switches
   back to migration-only legacy storage without editing either copy. The
   project disappears from the live library; historical requests remain with
   unavailable files until another approved activation. Later display-metadata changes are retained,
   including across subsequent legacy scans. The managed copy remains in place.

Each project has its own status and last error. The job uses optimistic revisions
and a shared database advisory lock with scans and import publication. Concurrent
storage operations return a conflict instead of running together. Per-project
controls use synchronous requests; large projects may outlast proxy
timeouts. Refresh to inspect durable state before retrying. Refreshing or closing
the browser does not cancel work already running on the server.

An interrupted copy remains `copying`; **Retry copy and verify** recreates only
that journal's private staging directory and verifies the source again. An
interrupted activation resumes using the exact manifest/inventory/hash-verified
destination rather than overwriting it or allocating new IDs. Failures keep
migration-only legacy storage unchanged unless catalog activation has already committed. Never edit
manifests to force acceptance.

**Cancel remaining migration** requires confirmation. It cancels only pending,
copying, or copied projects; activated projects stay managed and can still be
restored. Private staging is retained. A verified final directory left by an
interrupted activation is moved to a journal-specific retained location before
cancellation commits. Metadata changes do not prevent abandoning unactivated
work. Start again with a new reviewed preview; canceled jobs are not reused.
Copy cancellation is between requests, not an interrupt of a running copy.

Storage must retain the approved absolute roots and filesystem identities.
Unavailable roots, changed mount identities, unsafe paths/links, extra files,
changed versions or bytes, overlaps, occupied destinations, insufficient reported
space, and durability errors stop the operation. Repair/review the underlying
problem rather than bypassing verification. Copies preserve internal layout;
only the root becomes `projects/<existing-id>-<snake_case_title>`.

The migration-only `project.json` records journal identity, approved metadata,
layout, hashes, and original paths. It is internal recovery evidence, not an
additional catalog asset, so migration/restoration does not create/remove asset
IDs or alter historical version records. The database remains authoritative for
metadata and source associations. Back up journals and managed storage together.

There is no automatic purge. `projects/.migration-<journal-id>` staging,
`projects/.retained-<journal-id>` cancellation copies, original legacy folders,
and managed copies retained after restoration consume storage. A restored
project's managed directory still occupies its proposed destination; a new dry
run deliberately blocks rather than overwriting it. Cleanup or relocating
retained copies requires separate operator review and verified backups; it is
not implemented by this workflow.

All migration routes are operator-only:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/library/reorganization-plans/:id/migrate` | Approve with `expectedFingerprint`, `confirmRetainedCopies: true`, and `acknowledgeWarnings: true`; repeated approval returns the same job |
| `GET /api/library/migrations/:id` | Read durable per-project progress, revision, and errors |
| `POST /api/library/migrations/:id/projects/:projectId` | Explicit `copy`, `activate`, or `restore` with `expectedRevision` |
| `POST /api/library/migrations/:id/cancel` | Cancel unactivated work with `expectedRevision`; keep both copies |

## Bulk library initialization and CLI

The shared backend now supports library-wide initialization/adoption without
manually selecting 25-project batches. Index the existing library first: the
run freezes all currently registered legacy project IDs. Planning creates
individual, immutable previews in bounded work units; it does not copy files.
The initialization UI and CLI use this same service and durable runner. The API
must remain running; the utility is not an offline database/filesystem importer.

### First initialization / bulk workflow

1. Configure the final storage **before copying**. The development managed root
   defaults to `.pantry-data/library` under the mounted checkout, not the legacy
   mount or automatically the NAS. Production Compose uses a dedicated Docker
   volume by default. For host/NAS storage, supply separate, persistent bind
   mounts and matching `IMPORT_STORAGE_ROOT` / `MANAGED_LIBRARY_ROOT` settings.
   Neither root may be inside the read-only `LEGACY_LIBRARY_ROOT`.
2. Scan the existing read-only library. Its project boundaries, classifications,
   and app-generated IDs form the initial catalog; review uncertain boundaries
   and recover/approve sources where appropriate. This workflow does not guess
   new boundaries or automatically approve discovered URLs.
3. Open **Manage library → Initialize or adopt an existing library → Plan
   existing library**. No manual 25-project selection is required.
4. Review the source and destination boxes, space estimate, totals, blocked/failed
   filters, and saved per-project previews. The run URL is bookmarkable as
   `/manage-library?adoption=<id>`; recent runs can be reopened after reload.
5. Acknowledge verified backups, retention, notes, and projects left behind.
   Choose **Approve batch copy and verification**. Progress updates automatically.
6. Wait for **Verified copies await activation approval**. Projects remain
   hidden from the live library. Check results, then **Review batch activation → Confirm batch
   activation** once for the verified eligible projects.
7. Check downloads, previews, metadata and existing requests on a small
   synthetic library first. A partial result is not a completed migration:
   resolve/report remaining projects rather than treating them as imported.
8. Pause/resume and retry a failed stage as needed. Cancellation retains copies
   and does not undo activated projects. Stopped runs with active projects offer
   confirmed batch restoration. A restored managed directory still occupies
   its proposed destination until separately reviewed cleanup.

### Utility

Build with `npm run build`, keep the API running, then inspect:

```bash
npm run library -- --help
```

The utility authenticates an existing operator against the API, keeps its
session in memory, and logs out on completion. Passwords are accepted only from
piped stdin, never as a command-line argument or saved configuration. Use HTTPS
except for loopback development. API redirects are refused. The direct API
default is `http://127.0.0.1:3000`; for the web proxy pass
`--url https://your-pantry-host/api`.

Example in **Bash**, with an interactively read password rather than a literal
secret in shell history:

```bash
read -r -s -p 'Operator password: ' PANTRY_PASSWORD
printf '\n'
printf '%s\n' "$PANTRY_PASSWORD" | npm run library -- plan \
  --username operator --password-stdin --wait
unset PANTRY_PASSWORD
```

`plan --wait` stops at plan review. It **never copies or activates**. Inspect the
returned run ID and fingerprint, then supply the same credential flags/password
stdin for later commands. These are command shapes; replace the uppercase
placeholders with reviewed values:

```text
status RUN_ID
items RUN_ID --status blocked
copy RUN_ID --fingerprint PLAN_FINGERPRINT --confirm-retained-copies --acknowledge-warnings --wait
activate RUN_ID --fingerprint PLAN_FINGERPRINT --confirm-activation --wait
pause RUN_ID
resume RUN_ID --wait
retry RUN_ID --stage copy --wait
cancel RUN_ID --confirm-cancellation --wait
restore RUN_ID --confirm-restoration --wait
```

`items` returns 50 outcomes and a next cursor; use `--cursor PROJECT_ID` to
continue. IDs and byte totals retain exact decimal strings. For automation use
`--json` and suppress npm wrapper banners with `npm --silent run library -- ...`,
or invoke `node apps/api/dist/library-cli.js` directly. `--revision` optionally
pins the expected run revision; otherwise the utility reads it before submitting
the command. `--wait` waits only for the current stage and never grants the next
approval. If a planning request times out, the error includes its request/run
ID: use `status` or `list` before creating another run.

Exit 0 means a successful request/current stage; exit 1 means invalid arguments,
API/transport failure, or failed session cleanup. Waiting returns **exit 2** for
blocked/failed/canceled projects, a partial result, or a pause. Read-only
`status`/`items` still succeed when reporting problems. Closing the CLI does not
cancel server work. The same plan can be created in the UI and controlled by the
utility, or vice versa; refresh before acting in another client.

Runs require separate **copy/verify approval** and **batch activation approval**.
`MANAGED_LIBRARY_ROOT` is the live library; the optional `LEGACY_LIBRARY_ROOT`
is migration-only. In Compose, configure `MANAGED_LIBRARY_HOST_PATH` for a
writable host/NAS destination and `LEGACY_LIBRARY_HOST_PATH` only for an old
read-only source. Leave legacy unset for a new installation. Normal catalog
and file endpoints never serve legacy content.

Index a configured legacy source explicitly from **Manage library → Index
legacy library for migration** or the authenticated CLI command `index --wait`
before planning. Indexing does not run on startup or a timer. Its operator-only
status and trigger endpoint is `/api/library/legacy-scan`. Legacy boundary
overrides and source recovery live under each inventory row's **Show migration
tools**; after changing a boundary, index again before planning.
The runner continues eligible projects after independently blocked/failed
projects and explicitly reports partial results. Disk/root/database failures
pause the run instead. Pause/cancel takes effect between project operations;
closing a browser or restarting the API does not discard work. Existing
copy/verification, journal recovery, identity preservation, cancellation, and
restoration logic is shared with the per-project endpoints, not reimplemented.
Activation and restoration approvals cover only the currently eligible projects.
Retrying an earlier failed stage does not authorize newly verified copies or
newly activated projects; those require their own explicit batch approval.

Legacy scans are deferred while a bulk run is active or awaiting review so
routine scan timestamps cannot invalidate its reviewed evidence. New legacy
projects added after membership freezes are not silently included. Changed
files/metadata still fail verification and require a new reviewed plan.
Changed server storage configuration pauses existing work with an explicit
error. Finish or cancel the run before changing storage settings; do not move
approved roots underneath a running or paused adoption.

The library can exceed 25 projects or 1,000 total files; each individual project
still has the documented 1,000-file, 2,000-source-entry, 12-component and 8 MiB
preview limits. Oversized/ambiguous projects are explicitly blocked, not
silently truncated. Bulk destination checks stream directory entries without
imposing the small manual preview's aggregate managed-directory limit.
Source discovery/approval is not automatic; existing approved sources and
original shortcut files are preserved.

Operator API:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/library/adoptions` | Save membership with a UUID `requestKey`; repeated submissions reopen that run |
| `GET /api/library/adoptions` | List the latest 20 runs |
| `GET /api/library/adoptions/:id` | State, revision, fingerprint, totals, counts, storage roots and errors |
| `GET /api/library/adoptions/:id/items?after=&status=` | Keyset-paginated project outcomes, 50 at a time, optionally status-filtered |
| `POST /api/library/adoptions/:id/commands` | Revision-protected approval, pause/resume, retry, cancel and restore |

Commands use `action` and `expectedRevision`. `approve_copy` also requires the
reviewed `expectedFingerprint`, `confirmRetainedCopies: true` and
`acknowledgeWarnings: true`; `activate` requires that fingerprint and
`confirmActivation: true`. Cancellation/restoration require
`confirmCancellation: true` / `confirmRestoration: true`. `retry` specifies
`stage: copy|activate|restore|cancel` and never updates approved evidence.
Storage roots are configured on the server, not supplied by the utility.

The runner starts with the API and is claimed through a separate PostgreSQL
advisory lock; only one server executes bulk work at a time. Actual filesystem
operations still take the existing shared scan/publication/migration lock.
Back up both new adoption tables together with migration journals and files.

## Subsequent checkpoints

1. Bulk source discovery and periodic managed-root reconciliation.
2. Optional OpenAI-assisted suggestions with explicit privacy/budget controls;
   deterministic organization continues to work without a provider.
3. Collections and broader metadata management, plus separately approved cleanup
   of retained copies. Test a small synthetic library before approving any
   real-library adoption.

Automatic site acquisition remains a separate adapter capability; this
checkpoint supports manual intake from any website.
