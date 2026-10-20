# Import and library management plan

Status: approved direction; implementation in progress.

Implemented checkpoints include bigint project IDs, the household/operator URL
submission queue, manual file/ZIP intake, deterministic organization, editable
review, retained originals, and recoverable managed publication. See
[the checkpoint guide](import-queue.md) for testing, limits, and recovery.
Manual intake/publication operations are request-driven with persisted states
and database locks. Bulk adoption uses a durable API-side background runner.
Publication verifies its complete inventory; periodic
managed-root drift reconciliation is not implemented yet. Legacy shortcut
source recovery now supports per-project, operator-run discovery previews and
approved source-association backfill, including XML/binary macOS shortcuts.
The operator Manage library checkpoint now provides paginated storage inventory
and saved, read-only reorganization dry runs with proposed ID-based paths,
preserved internal layout, indexed hashes, space estimates, and filesystem
blockers. It does not authorize or execute migration. Bulk source discovery,
optional AI organization, collections, and managed reconciliation remain
subsequent phases. Separately approved migration jobs now support request-driven,
per-project copy, fresh hash verification, explicit activation, retry/cancellation,
and verified restoration. Durable journals preserve existing identities, request
references, and both copies; legacy scans exclude activated originals. No
existing library is migrated automatically.

The bulk-adoption checkpoint adds a durable runner using
the same preview/migration services. It freezes existing catalog membership,
plans projects incrementally, and supports separate batch-level copy and
activation approvals, explicit partial results, pause/resume, cancellation and
restoration. Initialization and CLI controls now use this backend rather than
independent file-moving scripts. Both require an existing catalog scan and
configured permanent storage; neither automatically adopts a real library.

## Recommendation

Treat library management and the print queue as primary product capabilities.
Separate the library's editable organization from its physical storage layout.
Categories, tags, collections, titles, and source associations belong in the
database; changing them should not move model files.

Add **Add New Print** for household URL-and-notes submissions to an import
queue. Operators acquire files manually, prepare an intake folder, upload
files/ZIP, then process and review the import. Accept any website from day one;
known-site identity extraction enhances intake without gating it.

The manual-import checkpoint provides deterministic organization first;
optional OpenAI-assisted suggestions remain a follow-up. Automatic site downloads are a
separate capability: neither blocked downloads nor missing AI credentials
should prevent importing files the operator already has.

Existing folders remain supported without mandatory conversion. Add an
explicit, previewable **Reorganize library** operation to adopt app-managed
storage safely. No automatic slicing or printing.

## What the current implementation and scripts tell us

- The application already has source metadata, stable project/asset/version
  identities, SHA-256 hashes, and a read-only filesystem indexer.
- The indexer seeds new projects from selected sidecars, but does not enrich
  existing projects from them. It does not currently parse macOS `.webloc`.
- The supplied organizer inventories files, detects duplicates, saves recovery
  copies, proposes renames, normalizes names and format folders, and chooses a
  `Category/Subcategory/Project` destination.
- Its `--skip-ai` path also skips normalization and file moves. The application
  needs a genuinely complete deterministic mode, not that reduced behavior.
- The supplied catalog script supports backfill from `agentic-plan.json` or a
  synthetic inventory. Reuse its useful data, not its SQLite/static HTML
  architecture; PostgreSQL remains the application's catalog.
- The scripts reference additional catalog and AI helpers that were not
  attached. Their matching and authentication details remain unverified.
- Fetching the supplied MakerWorld example returned HTTP 403 in this
  environment. This is evidence of an access constraint here, not proof that
  every supported retrieval method is unavailable.

## 1. User experience

Place **Add New Print** beside the catalog actions and provide a dedicated
import queue. Persist requests and work in progress across navigation/reloads.

1. **Submit:** any household user supplies a source URL and optional notes/title.
   No successful site fetch is required. Operators may also start with files.
2. **Check library:** show existing projects and pending imports before adding
   another request. Offer the existing project or follow an existing import;
   preserve each submitter's notes and interest without duplicate processing.
3. **Queue:** users see their own submissions; operators see and manage all.
   Record acceptance, decline/cancel reasons, and status history.
4. **Prepare import:** an operator opens the URL and creates a backend intake
   folder outside catalog visibility. Permit incremental uploads of files/ZIP
   and source shortcuts; processing starts explicitly after uploads are ready.
5. **Organize:** choose deterministic or AI-assisted suggestions for titles,
   categories/tags, and safe file organization. Logical categories do not
   determine the physical destination.
6. **Review:** show source/profile, attribution/license when known, selected
   files, proposed paths, metadata, duplicates, and warnings.
7. **Import:** publish to managed storage, confirm catalog registration, and link
   the completed submission to its project. Preserve notes and history.

Queue states: submitted, awaiting files, processing, ready for review, imported,
declined, and canceled. Show processing failures with their stage and retry
action. Internal worker phases may be more detailed than these user-facing states.

URL-only submissions are not printable catalog projects. Import requests and
file-backed print requests remain distinct: once imported, the requester can
select actual files, quantity, and preferences using the existing print flow.
Later adapters automate file acquisition without replacing this workflow.

Add an operator **Manage library** area for metadata editing, category/tag and
collection management, source/duplicate review, storage health, and migration
jobs. Metadata-only bulk edits must not trigger physical reorganization.

## 2. Site adapters and MakerWorld identity

Use a small adapter contract for URL recognition/normalization, metadata
resolution, artifact discovery, and retrieval. Advertise capabilities separately:
recognizing a URL does not imply that metadata or files can be fetched.

For the supplied example:

- Provider: `makerworld`.
- Model identity: `2747706`.
- Requested print profile: `3048005`.
- `from=search`, locale, and display slug do not define model identity.
- Preserve the submitted URL and profile selection separately from the
  normalized model identity. Do not claim that a requested profile has been
  verified until it has actually been resolved.

Default grouping: one library project for a MakerWorld model, with profiles
represented as associated files/variants and provenance, not automatically as
asset versions. A profile is not itself a content version.

An existing model match offers **Open existing** or **Review additional files**.
Deliberate separate projects require an explicit override and reason; legacy
duplicates must be representable rather than rejected by a migration.

All adapter HTTP traffic uses one bounded fetch helper with explicit allowed
hosts, public-address validation, per-redirect validation, timeouts, response
limits, and rate-limit handling. Remote text is untrusted and safely rendered.
Do not bypass site challenges, extract browser cookies, or require credentials
for the basic manual-upload path.

Start a small MakerWorld feasibility investigation early. Verify permitted,
maintainable access before promising automatic metadata or artifact downloads.
Do not build the feature around an undocumented endpoint being reliable.
Unknown sites still support queued manual intake. Preserve their query
parameters unless a known normalization rule proves they are non-identifying;
do not strip arbitrary queries in an attempt to deduplicate.

## 3. Source provenance and duplicate detection

Add normalized source records and project-source associations instead of
relying only on `projects.sourceUrl`. Retain that scalar field as the existing
editable display field for compatibility.

Store provider/model identity, submitted and canonical URLs, optional profile
identity, discovery evidence, and import/artifact provenance. One source can
associate with multiple legacy projects; one project can have multiple sources.
These are secondary source identities, never the primary project ID. Generate
Print Pantry's own database-generated bigint project ID for every newly added
project, regardless of where it originated. Use this single ID for internal
references, URLs, and folder prefixes; do not add a separate public project
number. Preserve the ID during subsequent filesystem reorganizations.

Check duplicates twice: at intake and again under a database lock at commit.

| Evidence | Behavior |
| --- | --- |
| Same provider/model | Existing-source match; offer existing project first |
| Same model, different profile | Offer additional-file review; not a new version automatically |
| Same hashes and relevant file inventory | Exact-content candidate; verify before reusing |
| Same source, different bytes | Possible update/variant; require review |
| Same bytes, different site | Cross-source match suggestion; no automatic merge |
| Same source already importing | Show active job; prevent duplicate default publication |

Use persistent job idempotency keys and serialized source/destination checks
for concurrent submissions. Hashes describe content, not project identity.
Do not silently delete duplicate uploads or merge projects.

For the initial release, additional files may be attached through an explicitly
reviewed additive operation only if the destination belongs to managed imports.
Never replace existing files. For legacy read-only projects, open the existing
project or create an explicitly separate managed import; do not imply that
arbitrary existing folders are writable.

## 4. Recover source URLs from existing imports

Provide an operator-run **Discover existing sources** operation:

- Read existing database source URLs and bounded, recognized sidecars:
  `.webloc` XML/binary plists, `.url`, `project.json`, `metadata.json`, and known
  URL fields in legacy `agentic-plan.json`.
- Support `.webloc` `URL` and `URLString`; do not depend on macOS utilities.
  Disable external entity resolution and bound parsing resources.
- Associate evidence using existing project boundaries, including nested
  variant folders. Do not guess project membership from a fixed folder depth.
- Treat arbitrary documentation links as candidates, not authoritative sources.
- Produce a preview of additions, malformed files, and ambiguous/conflicting
  model identities. Make no network calls and no filesystem changes.
- On operator approval, write source associations to PostgreSQL through an
  explicit backfill operation, not through the scanner's new-project seeding.
- Leave all existing scalar metadata unchanged, including null fields. Offer
  a separate explicit metadata edit to select a primary display URL.
- Make repeated discovery/apply idempotent and preserve provenance. Never
  auto-merge existing projects or overwrite operator-authored metadata.

This is read-only with respect to the library, not the database. Ordinary
rescans continue preserving existing metadata; future source discovery can
report new candidates without silently applying them.

## 5. Deterministic and AI-assisted organization

Both modes generate the same versioned, validated import-plan structure.
Immutable file IDs and hashes tie each proposal to the actual staged input.

### Deterministic mode: always available

Port the useful rules from the organizer into testable TypeScript:

- Normalize punctuation/spacing and extension case conservatively.
- Preserve part ordering, dimensions, units, established brands, and acronyms.
- Route files using the managed project layout below: `models` for meshes,
  CAD sources and 3MF, `images` for independent preview/reference images,
  `docs` for supporting documentation, and `exports` for machine-specific
  print exports. Keep recognized project-level metadata files at the root.
- Do not introduce STL/STEP/etc. format subfolders by default. File-type
  filtering belongs in the UI; preserve meaningful part/variant grouping
  rather than replacing it with a format hierarchy.
- Preserve meaningful variant subfolders and relative file dependencies.
  Do not flatten OBJ/MTL/textures, glTF resources, or CAD assemblies; preserve
  names/layout unless a supported transformation can maintain references.
- Reuse existing taxonomy and aliases; require operator selection or visible
  unclassified metadata when deterministic classification is uncertain.
- Detect case-insensitive and Unicode-normalization collisions for Mac/NAS
  interoperability. Resolve conflicts in the review plan, never by overwriting.

Do not rewrite model contents or rename files inside 3MF containers. File
normalization applies to incoming files; migration preserves existing project
internals by default. Reclassification only changes database metadata.

### AI-assisted mode: optional enrichment

Initially support a server-configured OpenAI API key. Keep credentials in
deployment secrets/environment, never in the browser, manifests, logs, or chat.
No key is needed to develop or use deterministic imports.

With explicit opt-in, send only approved, bounded, non-sensitive descriptive
metadata needed for suggestions; no model binaries or broad library contents.
Show the data-sharing scope and impose request/token/time limits.

AI may suggest translations, clearer names, categories, and tags. It must not
invent attribution, licensing, identities, or technical specifications.
Treat documentation as data, not instructions. Give the model no shell,
filesystem, or download tools. Validate all suggestions against the same
schema and path rules as deterministic proposals.

On timeout, quota errors, or invalid output, show a warning and offer the
deterministic proposal. Never silently replace an approved plan. Keep one
current plan revision per job; retries reuse persisted proposals rather than
re-running AI. A changed revision invalidates prior approval.

### GitHub Copilot

Copilot is technically an option: the official SDK can run through a separately
authenticated Copilot CLI runtime, with account/usage requirements. The
deployment cannot assume access to the editor's session or subscription.

Prefer direct OpenAI integration for the initial optional provider because
this task only needs constrained suggestions, not an agent runtime. Keep the
suggestion boundary small enough to add Copilot later after validating NAS
authentication, permitted account usage, lifecycle, and billing.

References:
[SDK overview](https://github.com/github/copilot-sdk),
[authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/README.md),
[official quickstart](https://docs.github.com/en/copilot/get-started/sdk-quickstart).

## 6. Storage, publication, and recovery

Importing introduces an intentional opt-in write capability. Keep legacy roots
read-only by default and use a distinct, configured managed storage root. Do not
switch the entire NAS library to read-write for routine imports. Legacy
locations and managed projects must coexist during gradual adoption.

- Add persistent intake/quarantine and recovery storage outside scanned paths.
  Keep original uploads immutable with hashes and a documented retention policy.
- Mount only designated managed storage writable for the importer. Restrict
  publication paths to that root. Existing legacy projects remain immutable
  except through separately approved migration/cleanup capabilities.
- Copy approved files into an explicitly ignored staging directory on the
  destination filesystem. Verify sizes/hashes there, then publish via a
  same-filesystem, no-overwrite rename. Never use cross-filesystem rename or a
  copy directly into the visible final directory as an atomicity substitute.
- Coordinate scans and publication with a shared database advisory lock held
  for the relevant scan/publication critical sections. Register explicit project
  boundaries before publication so partial grouping cannot create extra projects.
  The staging directory is always excluded, including after restarts.
- Persist the approved plan, expected inventory, import UUID, and destination
  before publication. Write a versioned `project.json` manifest with compatible
  display metadata, sources, and original-to-final paths/hashes.
- Imported user sidecars cannot supply trusted job IDs or override job state.
  Preserve their originals separately if they conflict with generated metadata.
- The filesystem and PostgreSQL are not one transaction. Recover by reconciling
  the owned manifest, destination, hashes, and persisted job state. A rename
  exposes a complete directory or none; crashes before/after it must both be
  recoverable without republishing or overwriting unrelated files.
- If publication succeeds but indexing fails, report **Files saved; catalog
  pending** and retry indexing only. Mark complete only when project and
  expected assets/versions are confirmed.
- Additive imports into managed projects require the same scan exclusion and
  recoverable per-file publication journal; defer this action if it cannot meet
  those guarantees in the first release.

Use separate import-submission records and processing jobs: household notes
and queue status must not depend on an active worker lease. Use PostgreSQL-backed
jobs and a bounded worker in the existing API deployment,
with claim/lease recovery on restart; no Redis initially. Persist phase,
attempts, warnings, and actionable errors. Distinguish waiting for files,
awaiting review, queued, processing, catalog pending, completed, failed, and
canceled. Cancellation after publication is not destructive rollback.

Expose typed authenticated submit/queue/upload/plan/commit/status endpoints.
Enforce submission ownership and operator-only upload, processing, publication,
and library-management permissions with existing origin/session protections.

Validate upload/archive contents: total bytes, extracted bytes, file count,
nesting, paths, symlinks, case collisions, and duplicate entries. Initially
support files and bounded ZIP extraction, not every archive format. Treat 3MF
as a model container, not an intake ZIP to recursively unpack. Never execute
uploaded content. Use synthetic storage during development, never the NAS.

## 7. Managed storage and automatic library reorganization

### Physical storage is not the browsing taxonomy

Use a Print Pantry-generated bigint project ID as the primary identity and prefix
of each managed project directory. Append a readable snake_case slug derived
from the approved project title: `<project-id>-<semantic_slug>`. External model
and profile IDs remain secondary source metadata, never the directory's
identity or a substitute for the internal ID.

A project can have several sources, a source can disappear, and classifications
or display titles can change without changing its identity or file locations.

Conceptual layout:

```text
managed-library/
  projects/
    1042-universal_drill_bit_holder/
      project.json
      README.md
      LICENSE.txt
      models/
      images/
      docs/
      exports/
```

### Contents of a managed project

Use a shallow, predictable layout, creating only directories needed by the
project:

| Location | Contents |
| --- | --- |
| Project root | Generated manifest; recognized README, LICENSE/COPYING, attribution/AUTHORS/CREDITS, and source shortcut files |
| `models/` | STL, OBJ, 3MF and other meshes, plus STEP and native/editable CAD sources |
| `images/` | Independent previews, photographs, diagrams and reference images |
| `docs/` | Supporting instructions, PDFs, HTML, and other standalone documentation |
| `exports/` | G-code and other machine/printer-specific output; never treated as automatically safe to execute |

Classify root metadata by recognized role/name, not extension alone. A
`README.txt` or `LICENSE.md` belongs at the root, while `assembly_notes.txt`
belongs in `docs/`. PDF/HTML instructions go in `docs/` even if named README.
Do not automatically concatenate or overwrite competing README/license files;
preserve them with distinct reviewed paths. Unrecognized files retain a
reviewable location rather than being discarded or assigned invented meaning.

HTML and associated resources remain together. Serve imported HTML as a
download, not active application-origin content. General supporting structured
data can live with its documentation; machine-readable dependencies stay with
the model or document that references them.

STL/STEP/etc. subfolders are not required by default. Preserve meaningful
variant and dependency folders inside `models/`: for example, keep an OBJ,
its MTL, and referenced textures together instead of moving those textures
into `images/`. Preserve native CAD assemblies and similar linked resources
as groups. Never unpack/reorganize the internal contents of 3MF files.

The new-import organizer targets this layout. Legacy migration adopts the
stable top-level project directory and manifest but preserves existing internal
layout by default. Offer internal standardization as a separately reviewable
plan using the same dependency/path validation, not an implicit migration step.

### Original source recovery

Retain original source material outside the active project and scanner roots,
associated with the import job and project ID. A ZIP upload is retained
byte-for-byte; for individual-file uploads, retain original bytes and supplied
relative paths. Preserve multiple acquisition batches separately.

Record checksums, acquisition/source metadata, and original-to-organized path
mapping in a versioned recovery manifest. Validate archive paths before
extraction, even when retaining the raw archive. Recovery storage is
authenticated and not directly browsable or executable through the app.

Reprocessing creates a new reviewable plan from retained originals; it never
silently replaces the active project or changes its identity. Distinguish
restoring original source layout from rolling back a published library change.
Both require explicit review and must preserve existing asset/version and
print-request references. If restoration cannot preserve them, block it and
report why rather than substituting files.

Original-retention status, size, and any configured expiry must be visible.
No originals are automatically purged in the initial release. Separately back
up both library/recovery storage and PostgreSQL; retained originals alone are
not an independent backup.

Generate the slug once at publication/migration using deterministic,
filesystem-safe rules; validate length and case/Unicode collisions. Persist
the actual directory path rather than reconstructing it from the current
display title. Metadata title edits do not automatically rename the directory.
The numeric ID, not the slug, identifies the project; neither slug changes nor source
metadata changes may create a new project or break existing references.

Files need not be flattened inside a project. Preserve multi-part sets,
variants, relative dependencies, and useful existing internal organization.
Independent incoming files use the role-based routing described above.
Export/download labels and the UI should use human-readable display names,
independent of the stored directory slug.

Start without speculative directory sharding. Measure expected library size,
directory listing costs, and target-filesystem limits before adding a
deterministic ID-prefix bucket. If needed, buckets are a storage implementation
detail, never user taxonomy; do not use mutable categories as buckets.

### Project ID schema transition

Because the application is pre-production and disposable development data can
be reset, adopt a PostgreSQL-generated bigint identity primary key for projects
rather than retaining UUIDs solely for compatibility. Do not introduce a second
project identifier. Generated IDs are positive, immutable, and never
intentionally reused; sequence gaps are expected.

Carry the change through project foreign keys, shared contracts, route
validation, frontend state, tests/fixtures, manifests, and registration/recovery.
Represent project IDs as decimal strings in JSON and TypeScript contracts;
never convert them to JavaScript numbers or emit raw bigint values in JSON.
Database comparisons and ordering use bigint semantics, not lexical ordering.
Sequential IDs do not replace authorization checks.

This decision concerns project IDs, not a blanket conversion of account,
session, asset, version, or job identities. Those can retain UUIDs unless a
separate requirement justifies changing them.

Use a coordinated schema transition that maps existing project UUIDs and their
foreign keys to numeric IDs without deleting records. The first checkpoint
implements this data-preserving migration, so a reset/reseed is unnecessary.
Any future reset would require a verified disposable target and explicit
execution approval; never reset an external/shared database or delete library
files. Filesystem migration after the schema transition preserves the new IDs.

Make storage roots and project locations explicit database concepts, distinct
from logical categories. Adapt existing unique path constraints, download and
preview resolution, copy-local-path, metadata editing, and scan reconciliation
to root-relative locations. Do not overload the existing category paths as
both physical paths and editable classification.

### Migration workflow

**Manage library -> Reorganize library** produces a dry-run plan first:

1. Inventory selected legacy projects using current catalog identities and
   hashes. Recover source associations and existing categories before layout
   changes remove folder-based classification evidence.
2. Identify uncertain boundaries, missing/changed files, unsupported
   dependencies, conflicts, required space, and unavailable roots. Block
   ambiguous items pending operator review; do not guess or merge them.
3. Preview old/new paths, project/file counts, preserved metadata, expected
   storage use, warnings, and recovery/retention implications.
4. After approval, copy each project into destination-local staging and verify
   bytes/hashes. Default to preserving internal names/layout, not renaming
   every file. Copy-first avoids requiring writes to the source library.
5. Register existing project/asset/version IDs at the verified managed location
   under scan/publication coordination. Persist old/new locations and a
   per-project migration journal for crash recovery. Do not create duplicate
   catalog projects when source and destination copies coexist.
6. Verify downloads, previews, metadata, file availability, source associations,
   and existing print-request version references. Historical path snapshots
   remain historical; file access resolves stable IDs to the current verified
   location rather than relying on a stale path string.
7. Report migrated, blocked, failed, and remaining projects. Permit resume,
   cancellation between projects, and journal-driven restoration of the prior
   location while retained originals remain verified and unchanged.

Migration is resumable per project, not one claimed transaction over the whole
library. Recheck source changes after preview and before activation. Coordinate
with import workers, scanners, and active file operations; keep the previous
location authoritative until the replacement is ready. Do not let a scan
reinterpret retained source copies as newly discovered projects or mark
in-flight relocations missing.

Retain originals by default. Removing old copies is a separate, explicitly
approved cleanup with verified backups, a fresh validation, and scoped source
write access; it is not a prerequisite for migration. Show that retaining
copies requires extra disk space. Do not present retained copies as a
substitute for independent backups.

### Simpler ongoing indexing

For managed projects, successful publication/migration explicitly registers
the known manifest and file inventory. The managed-root reconciler checks
explicit project boundaries and changed files; it does not infer categories
or project identity from arbitrary folder depth or directory basename.

Preserve project display names and database classification during scans:
current basename-derived names and physical-path-derived categories must not
overwrite managed metadata. Associate trusted, app-issued manifest identities
only through validated registration/recovery; arbitrary external JSON cannot
claim another project's identity.

Keep periodic reconciliation for SMB changes, missing/offline storage, and
manifest/file drift. Preserve legacy heuristic scanning for unmanaged folders
and explicit boundaries. Managed ingestion simplifies the common path; it does
not justify dropping support for existing libraries or external changes.

## 8. Delivery sequence

1. **Queue and storage foundation:** root/location and logical-classification
   design, source identities, any-site URL/notes submissions, known-site ID
   extraction, duplicate lookup, and household/operator queue interfaces.
   Start retrieval feasibility work without blocking manual intake.
2. **Legacy source recovery:** discovery preview and approved source-association
   backfill. This must land before claiming duplicate checks cover old imports.
3. **First usable import release:** operator intake folders and file/ZIP upload,
   deterministic organization,
   optional OpenAI suggestions, editable review, safe managed publication,
   recovery/status, and catalog reconciliation. Include deployment/backup docs.
   Ship with manual MakerWorld download/upload even if retrieval remains blocked.
4. **Library management and adoption:** metadata/collection management,
   reorganization dry-run, copy/verify/activate migration, recovery, and managed
   reconciliation. Validate on a small synthetic batch before wider adoption.
5. **Automatic retrieval:** enable only verified MakerWorld capabilities with
   the same review pipeline and manual fallback. Add other site adapters later;
   URL intake should not require building a universal scraper.

## 9. Verification and release gates

- Unit tests: URL locale/slug/tracking variants, model/profile distinction,
  malformed shortcuts, XML/binary plists, legacy-state parsing, ambiguous links.
- Golden organization fixtures: filenames, brand/unit preservation, taxonomy,
  ordered parts, variants, dependent assets, root metadata versus supporting
  documentation, HTML resource groups, role-based folder routing, no mandatory
  format subfolders, and case/Unicode conflicts.
- API/database tests: permissions, duplicate races, idempotent commits, explicit
  overrides, backfill preserving metadata, plan revisions, worker lease recovery.
- Filesystem tests: traversal/symlinks/ZIP bombs, unchanged originals, offline
  or read-only mounts, insufficient space, hash mismatches, destination conflicts,
  interrupted staging, crashes around publication, and index failures.
- Recovery tests: byte-identical raw archives, original upload paths/batches,
  hash-verified original-to-organized mapping, private recovery access, and
  reprocessing/restoration requiring review without breaking request references.
- Reconciliation tests: imported boundaries, expected file inventory, stable
  project/asset/version IDs, existing request snapshots preserved after rescans.
- Management/migration tests: internally generated bigint IDs remain primary across
  source changes; decimal-string round trips above JavaScript's safe-integer
  limit; route validation and project foreign keys; safe ID-plus-slug folder
  generation; metadata edits cause
  no file moves; folder names never replace display titles; root-relative path uniqueness; mixed
  legacy/managed storage; retained copies do not produce duplicate projects;
  disk-space failure, source drift, interrupted copy/activation, restart/resume,
  safe rollback before cleanup, and existing requests/downloads after migration.
- Provider tests: blocked/rate-limited/changed responses, host/redirect limits;
  missing AI key, timeout/quota/schema failures, untrusted documentation, and
  visible deterministic fallback. Mock remote providers; no live NAS tests.
- Browser tests: household submission/ownership, operator queue, follow-existing
  import, keyboard/mobile flow, existing-project match, manual fallback, upload
  progress, editable review, navigation/reload recovery, truthful status, and
  migration preview/progress.
- Run targeted suites plus type checking/linting for implementation changes.
  Use only the isolated test database and generated fixtures.

## Rubber-duck review incorporated

- Made discovery versus approved database backfill explicit; existing scalar
  metadata stays unchanged rather than treating null as permission to overwrite.
- Defined model-level grouping and profile-level provenance without conflating
  profiles with file versions or forbidding existing duplicate associations.
- Specified ignored destination-local staging, same-filesystem publication,
  shared scan coordination, and filesystem/database crash reconciliation.
- Made HTTP egress controls part of adapter architecture, not only test cases.
- Persisted one current plan revision per job; worker retries cannot repeatedly
  regenerate AI plans or invalidate approval without a visible review step.
- Included deterministic and optional OpenAI organization in one release gate.

## Recommended scope for approval

Approve steps 1-4 as the product direction, delivered in stages: household
submissions, operator import queue, any-site manual upload, known-site identity
recognition, legacy source recovery, complete deterministic organization,
optional OpenAI suggestions, and library management with opt-in migration.

Design managed storage and logical classification before implementing new
publication paths so the importer does not perpetuate category-driven storage.
Do not require existing-library migration to use the first manual import release.

Treat automatic site downloads and Copilot-backed suggestions as follow-on
work. Preserve originals; additive changes to an existing managed project may
follow if they need a separate recovery implementation. Permanent deletion and
automatic cleanup are not part of the initial migration scope.
