# Print Pantry - implementation kickoff

Build Print Pantry: a self-hosted 3D print file organizer, searchable visual
library, and household print-request queue.

This is a new public repository. Inspect the working tree before changing
anything, preserve existing edits, and keep implementation in this repository.
Start with a concise architecture and phased implementation plan, identifying
only decisions that genuinely need user input. Then implement the approved
scope end to end, including development tooling, deployment, documentation,
and appropriate automated coverage.

## Product direction

The library contains downloaded models and original designs, organized into
categories, subcategories, project folders, and occasionally deeper collections
or variant folders. Preserve meaningful filenames, part ordering, associated
assets, and the existing tree. Do not force the owner to reorganize the library
to use the app.

The main experience is:

1. Browse or search a visual catalog.
2. Open a project to see previews, variants, associated files, and source notes.
3. Request a print with quantity, preferred color/material, and optional notes.
4. The operator reviews requests, chooses their order, and decides when to print.
5. The operator opens or downloads the chosen files and prepares the print in
   their slicer. Print Pantry tracks the request, not printer execution.

Do not add automatic slicing, automatic print submission, a marketplace, or
public federation to the MVP.

## Stack

- TypeScript throughout, on a supported and pinned Node.js LTS release.
- React with Vite for the frontend.
- Node.js with Fastify for the API, unless an inspected repository constraint
  justifies another choice.
- PostgreSQL with explicit, versioned migrations and a typed data-access layer.
  Drizzle is a reasonable default.
- A straightforward npm-workspaces monorepo, with a lockfile and documented
  root commands for development, build, type checking, linting, and tests.
- NAS-hosted Docker Compose for production. Provide an independent PostgreSQL
  service by default, and support an external database through `DATABASE_URL`.
  An existing cluster PostgreSQL instance is an alternative, not a dependency.
  Never modify an external database server or unrelated schemas automatically.

Avoid extra infrastructure such as Redis unless a demonstrated requirement
needs it. Respect the user's configured package registries; do not replace them
or fall back to a different feed when installation fails.

## Library and indexing

The filesystem is the source of truth for file contents. PostgreSQL owns the
catalog, user-authored metadata, accounts, requests, queue, and history.

- Configure the library root; never hardcode a particular NAS, share, or user
  directory into source code.
- Scan the library read-only by default. Files added through Finder/SMB must
  become discoverable through a manual rescan and scheduled reconciliation.
  Filesystem notifications alone are not sufficient on network mounts.
- Handle category/subcategory/project trees, nested `files/` and format
  subfolders, variant folders, and larger collections. Allow explicit project
  boundary overrides rather than guessing irreversibly.
- Do not exclude every underscore-prefixed folder. Distinguish actual model
  collections from configured recovery, temporary, or private directories.
- Keep stable project, asset, and version identifiers across rescans and
  renames. Use hashes to recognize identical content, not as the sole identity
  of a project. A rescan must not erase requests, favorites, metadata, or history.
- Index incrementally and bound hashing/preview worker concurrency. Do not
  repeatedly hash the whole library or load every mesh into memory.
- Distinguish an unavailable NAS mount or failed scan from an empty library.
  Never mark the entire library missing because storage is offline.
- Surface malformed files and indexing failures with actionable status.
  Do not silently hide errors or delete/rename physical files during indexing.
- Recognize common mesh, 3MF, source CAD, image, documentation, and print-export
  formats. Unsupported CAD can still be associated and downloaded.
- Prefer existing preview images and embedded 3MF thumbnails. Generate
  thumbnails where useful and provide lazy-loaded, interactive previews for
  supported meshes. Validate contents instead of trusting file extensions.
- Preserve source URLs, designer/attribution, license information, notes, and
  existing descriptive sidecars where available. Do not scrape external sites
  or invent missing metadata.

Search should cover project names, categories, tags, descriptions, filenames,
and available creator/source metadata. Provide pagination and useful category
and file-type filters. Use PostgreSQL search capabilities before adding another
search service.

Show associated files with meaningful relative paths, file types, sizes,
variants, and natural ordering. Treat multi-part projects as projects, not an
unrelated grid card for every STL.

Web upload/intake can follow the filesystem-based MVP; do not make uploads the
only way to add models.

## Local file access

The operator must be able to get from a project or request to the correct files.

- Provide "Copy local path" for project folders and individual files.
- Store library-relative paths and support a configurable client-side mount
  prefix, separate from the container's library root. A path inside a container
  is not necessarily a path the user's Mac can open.
- Provide authenticated file download/open-in-slicer workflows where practical.
- Do not claim an ordinary browser can reliably open arbitrary local paths or
  `file://` links. Copy-path plus download is the required MVP; an optional native
  protocol helper can be considered later.
- Give clipboard failures a visible fallback. Never execute shell commands on
  the server to "open" a user-provided path.

## Request queue

Support a simple workflow such as requested -> queued -> printing -> completed,
with declined and canceled states. Define and enforce allowed transitions.

Requesters submit requests and see their status. An operator can approve or
decline, reorder the queue, record notes, select what to print next, and mark
progress or completion. Record who changed a request and when.

Requests must retain their selected asset/version, quantity, preferences, and
notes when the library changes. Make unavailable source files obvious. Queue
changes must remain consistent under concurrent users.

Keep household authentication simple, but enforce operator permissions on the
server. Do not rely on hiding buttons in React. There is no requirement for
public registration or a complex identity platform.

## Visual design

Create an original, clean, minimal design inspired by the useful browsing
patterns of Thangs: prominent search, image-first cards, restrained filters,
and a clear project-detail view. Do not copy Thangs branding, assets, or code.

Use the Print Pantry name with subtle warmth and a little personality, not a
heavy food theme. Favor generous whitespace, clear typography, consistent
spacing, and restrained color. Keep the request queue easy to reach without
crowding the catalog. Support desktop and mobile, keyboard navigation,
accessible labels, and clear loading, empty, error, and offline states.

## Printer camera and future status

Scrypted already runs on the target NAS. Prefer reusing a suitable supported
stream integration instead of deploying another video stack automatically.

- Keep camera streaming optional and behind configuration; the catalog and
  requests must work without a printer or camera.
- Investigate Scrypted's actual installed capabilities before choosing a
  browser playback mechanism. RTSP rebroadcast alone is not browser playback.
  Do not assume a generic MJPEG URL, public iframe, or WebRTC embed exists.
- Use a supported browser stream if available; otherwise propose a small
  relay adapter separately. Prefer compatible passthrough/remuxing over
  unnecessary continuous transcoding.
- Keep camera credentials server-side and out of URLs delivered to browsers
  or logs. Handle printer-off/unreachable states and show stale status clearly.
- Do not change Scrypted, NAS, camera, HomeKit, prebuffer, or printer settings
  without specific approval. Preserve existing camera integrations.
- Reserve an extension point for later read-only Bambu X1C status and AMS
  material/color telemetry. Do not require it for the MVP or send printer
  control commands. Verify firmware/mode implications before proposing changes.

## Dev container and SSH

Provide a working dev container for local testing and for an agent to work
directly inside it.

- Include `.devcontainer/devcontainer.json` and the Docker/Compose files needed
  to run the workspace and a development PostgreSQL service.
- Use a non-root development user, persist useful dependency caches, and expose
  the frontend/API through documented development ports.
- Provide a real SSH server in the dev container, with key-only authentication,
  password login disabled, and root login disabled.
- Publish SSH on a documented localhost-only host port by default, for example
  `127.0.0.1:2222`. Any LAN-accessible binding must be an explicit override.
- Accept public authorized keys from an untracked host-side file or equivalent
  external configuration. Never copy private keys, real credentials, or a
  personal SSH configuration into the image or repository.
- Generate SSH host keys at runtime and keep them outside tracked source.
- Document both Dev Containers access and `ssh` access, including how an agent
  uses the container's workspace. Agent forwarding is optional and opt-in.
- Verify that the container starts, PostgreSQL becomes ready, SSH key login
  works, and the app can run and be tested inside it.

## Production and public-repository safety

Provide reproducible, multi-stage production images and NAS Docker Compose
deployment, with persistent database storage, a library mount, health checks,
and documented configuration. Separate development and production behavior.
Keep production library access read-only until an explicit writable intake
feature is enabled.

Use placeholders in `.env.example`; actual `.env` files are ignored. Bind local
development services to localhost by default, keep database ports internal in
production, and document private HTTPS/reverse-proxy deployment.

The repository is public. Do not commit personal print libraries, downloaded
third-party models, real metadata exports, actual NAS paths or addresses,
camera streams, secrets, or credentials. Use small generated or clearly
redistributable fixtures for tests and screenshots. No open-source license has
been selected; ask before adding one.

Validate paths, reject traversal and symlink escapes outside the allowed
library root, sanitize rendered metadata, and enforce access control on files
and operator actions. Do not expose arbitrary filesystem browsing or execute
commands derived from requests.

Document setup, deployment, backup/restore, migrations, rescanning, path mapping,
SSH access, and troubleshooting. Preserve user-authored database state during
upgrades; verify backups through a non-destructive restore procedure.

## Retiring the previous generated catalog

The current generated HTML/SQLite catalog is owned by a separate
`automation-scripts` repository, notably:

- `organization/3d-print-catalog-functions.sh`
- `organization/manage-3d-print-catalog.sh`
- `organization/organize-3d-imports.sh`

The owner wants Print Pantry to replace that generated catalog, not maintain
two competing catalog systems. Preserve useful import organization, renaming,
source metadata, and duplicate detection as appropriate.

Do not modify that external repository or remove old generated files as an
implicit side effect of implementing this application. Produce a small,
explicit migration/handoff plan covering catalog-generation removal,
replacement duplicate checks where needed, archive-root configuration, and
verification that imports still work. Coordinate those changes separately.
Copy and verify the library and its backup coverage before retiring the old
location; do not move or delete real files during app development.

## Delivery and acceptance

Deliver in small, coherent phases: foundation and dev environment; reliable
indexing/search/previews; request queue and operator workflow; NAS deployment;
optional camera integration.

Add focused API, indexing, and React tests, plus a browser-level happy path:
browse/search -> project details -> copy/download file -> submit request ->
operator queues/reorders -> mark completed. Cover rescans preserving requests,
renamed and missing files, invalid 3MF content, traversal, authorization, and
NAS-offline handling.

Use the established commands once available and run the smallest relevant
coverage before wider checks. Verify actual browser behavior and container
startup, not just successful compilation. Keep tests isolated from the real
library, NAS, printer, and external databases.

Report what is implemented, what remains, and any genuine blockers. Do not
claim live NAS, Scrypted, printer, or external-database behavior was verified
unless it actually was. Do not create issues, commits, or pushes without the
user's authorization.
