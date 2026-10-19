# Manual imports: testing checkpoint

Household users submit URLs; operators acquire files manually and publish
reviewed projects into separate managed storage. No site credentials or AI
key are required. There is no automatic MakerWorld download or automatic
printing. The existing library remains read-only and is not reorganized.

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
13. Browse an existing legacy project and exercise its preview/download and
    normal print-request flow. Its files and physical layout must be unchanged.

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

## Storage and organization

Development defaults to the ignored `.pantry-data/intake` and
`.pantry-data/library` directories in the repository. Set both
`IMPORT_STORAGE_ROOT` and `MANAGED_LIBRARY_ROOT` to override them. Production
requires both explicitly; the production Compose configuration supplies
independent persistent volumes. All three roots, including `LIBRARY_ROOT`,
must be separate, non-nested, and have no symlink components.

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
Printables URL variations. Discovering URLs in `.webloc`, `.url`, and legacy
organizer files is still a subsequent phase; this release does not claim that
unprocessed legacy shortcuts participate in duplicate detection.

## Subsequent checkpoints

1. Legacy source discovery/approval and periodic managed-root reconciliation.
2. Optional OpenAI-assisted suggestions with explicit privacy/budget controls;
   deterministic organization continues to work without a provider.
3. Library management and copy/verify/activate migration. Test a small synthetic
   library before approving any real-library reorganization.

Automatic site acquisition remains a separate adapter capability; this
checkpoint supports manual intake from any website.
