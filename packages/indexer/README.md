# Library indexer

`@print-pantry/indexer` reconciles a configured, read-only library root with
the PostgreSQL catalog. The filesystem owns file contents; Drizzle migrations
and tables in `@print-pantry/db` own IDs, versions, metadata, and scan history.

```ts
import { createLibraryIndexer } from '@print-pantry/indexer';

const indexer = createLibraryIndexer({
  db,
  root: process.env.LIBRARY_ROOT!,
  ignoredDirectoryNames: ['recovery', 'temp', 'private'],
  hashConcurrency: 4,
});
const initial = await indexer.rescan();
const schedule = indexer.start({ intervalMs: 15 * 60 * 1000 });
// indexer.getStatus() returns { running, lastScan }; schedule.stop() stops the timer.
```

`start` only schedules later scans; call `rescan` at startup and from a manual
rescan route. Concurrent calls throw `ScanInProgressError`. Every scan records
`scan_runs` and path-specific `scan_errors`; an unavailable root reports
`offline`. Read/stat/hash errors, malformed previews, symlinks, and uncertain
duplicate matches report `partial`. Only a successful, authoritative scan
marks unseen projects/assets and their selected versions missing; records are
never deleted. A previously populated root that is now empty is conservatively
partial by default; use `allowEmptyLibrary: true` only if the mount is verified
and intentionally empty.

Folders are recognized as category/subcategory/project trees, including
deeper collections and format/variant subfolders. For ambiguous layouts,
write `project_boundary_overrides` with a library-relative directory path and
`kind: 'project' | 'collection'`. `ignoredDirectoryNames` matches names
case-insensitively, not every underscore-prefixed name. Project sidecars
`project.json`, `metadata.json`, `source.url`, and `README.md` seed new
projects without overwriting user-authored metadata. Assets retain their
library-relative and project-relative paths; order by `assets.sortOrder` to
show natural part order. Unchanged size/mtime pairs reuse previous SHA-256
hashes; changes are streamed with bounded concurrency and pre/post stat checks.

For 3MF thumbnails, `read3mfThumbnail(filePath)` returns
`{ mimeType, bytes } | null` after bounded ZIP entry and image-header checks.
Callers must validate the requested file against their configured library root
and authorize the requester before invoking it. Mesh preview generation is
outside this package.

Run `npm run build -w @print-pantry/db -w @print-pantry/indexer` and
`npm run test -w @print-pantry/indexer` with **only** an isolated
`TEST_DATABASE_URL` whose database name is `print_pantry_test`. Tests create
temporary generated fixtures, never read a configured production library, and
never use `DATABASE_URL`.
