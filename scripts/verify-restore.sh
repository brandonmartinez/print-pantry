#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'Restore verification failed: %s\n' "$1" >&2
  exit 1
}

for name in SOURCE_PGHOST SOURCE_PGPORT SOURCE_PGUSER SOURCE_PGDATABASE \
  RESTORE_PGHOST RESTORE_PGPORT RESTORE_PGUSER RESTORE_PGDATABASE \
  RESTORE_DATABASE_NAME BACKUP_FILE; do
  [[ -n "${!name:-}" ]] || fail "set $name explicitly (passwords may use .pgpass or the corresponding *_PGPASSWORD)."
done
[[ "$SOURCE_PGDATABASE" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || fail "SOURCE_PGDATABASE must be a plain database name."
[[ "$RESTORE_PGDATABASE" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || fail "RESTORE_PGDATABASE must be a plain maintenance database name."
[[ "$RESTORE_DATABASE_NAME" =~ ^print_pantry_restore_[a-z0-9_]+$ ]] ||
  fail "RESTORE_DATABASE_NAME must be a new print_pantry_restore_<unique> database."
[[ "$RESTORE_DATABASE_NAME" != "$RESTORE_PGDATABASE" ]] || fail "The restore target cannot be the maintenance database."
[[ "$BACKUP_FILE" = /* && ! -e "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] ||
  fail "BACKUP_FILE must be an unused absolute path; existing archives are never overwritten."
[[ -d "$(dirname "$BACKUP_FILE")" ]] || fail "The BACKUP_FILE parent directory does not exist."

for tool in pg_dump pg_restore psql createdb sha256sum mktemp ln; do
  command -v "$tool" >/dev/null 2>&1 || fail "PostgreSQL 17 client tools, sha256sum, and core utilities are required (missing $tool)."
done
for tool in pg_dump pg_restore psql createdb; do
  [[ "$("$tool" --version)" == *" 17."* ]] ||
    fail "Use PostgreSQL 17 client tools ($tool is not version 17)."
done

source_db() (
  export PGHOST="$SOURCE_PGHOST" PGPORT="$SOURCE_PGPORT" PGUSER="$SOURCE_PGUSER"
  export PGDATABASE="$SOURCE_PGDATABASE"
  if [[ -v SOURCE_PGPASSWORD ]]; then export PGPASSWORD="$SOURCE_PGPASSWORD"; else unset PGPASSWORD; fi
  "${@}"
)
restore_db() (
  export PGHOST="$RESTORE_PGHOST" PGPORT="$RESTORE_PGPORT" PGUSER="$RESTORE_PGUSER"
  export PGDATABASE="$RESTORE_PGDATABASE"
  if [[ -v RESTORE_PGPASSWORD ]]; then export PGPASSWORD="$RESTORE_PGPASSWORD"; else unset PGPASSWORD; fi
  "${@}"
)
query_source() { source_db psql -X -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
query_admin() { restore_db psql -X -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
query_target() { restore_db psql -X -qAt -v ON_ERROR_STOP=1 -d "$RESTORE_DATABASE_NAME" -c "$1" 2>/dev/null; }

source_identity="$(query_source "SELECT coalesce(inet_server_addr()::text, 'local') || ':' || current_setting('port') || '/' || current_database()")" ||
  fail "Cannot connect to source; check SOURCE_PG* and read-only access."
admin_identity="$(query_admin "SELECT coalesce(inet_server_addr()::text, 'local') || ':' || current_setting('port') || '/' || current_database()")" ||
  fail "Cannot connect to restore maintenance database; check RESTORE_PG*."
[[ "${source_identity%/*}" != "${admin_identity%/*}" || "$SOURCE_PGDATABASE" != "$RESTORE_DATABASE_NAME" ]] ||
  fail "Restore target resolves to the live source database."
[[ "$(query_admin "SELECT count(*) FROM pg_database WHERE datname = '$RESTORE_DATABASE_NAME'")" == 0 ]] ||
  fail "Restore target already exists; choose a new name. Nothing was modified."

tables=(app_metadata categories projects project_boundary_overrides assets asset_versions
  scan_runs scan_errors users sessions print_requests print_request_files
  print_request_history request_queue_state)
for table in "${tables[@]}"; do
  [[ "$(query_source "SELECT to_regclass('public.$table') IS NOT NULL")" == t ]] ||
    fail "Source is missing public.$table; apply application migrations before backing up."
done
[[ "$(query_source "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema', 'drizzle') AND nspname NOT LIKE 'pg_%'")" == 0 ]] ||
  fail "Source has unrelated schemas; refuse to export another application's data."
printf -v quoted_tables "'%s'," "${tables[@]}"
quoted_tables="${quoted_tables%,}"
[[ "$(query_source "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ($quoted_tables)")" == 0 ]] ||
  fail "Source has unrelated public tables; refuse to export another application's data."
[[ "$(query_source "SELECT count(*) FROM pg_tables WHERE schemaname = 'drizzle' AND tablename <> '__drizzle_migrations'")" == 0 ]] ||
  fail "Source has unrelated migration-schema tables; refuse to export another application's data."
if [[ "$(query_source "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")" == t ]]; then
  tables+=(drizzle.__drizzle_migrations)
fi

# Compare canonical rowsets without displaying account hashes, session tokens, or user metadata.
fingerprint() {
  local database="$1" table="$2" result relation="$2"
  [[ "$relation" == *.* ]] || relation="public.$relation"
  if [[ "$database" == source ]]; then
    result="$(query_source "COPY (SELECT to_jsonb(t)::text FROM $relation t ORDER BY to_jsonb(t)::text) TO STDOUT" | sha256sum)" ||
      fail "Could not read source $table."
  else
    result="$(query_target "COPY (SELECT to_jsonb(t)::text FROM $relation t ORDER BY to_jsonb(t)::text) TO STDOUT" | sha256sum)" ||
      fail "Could not read restored $table."
  fi
  printf '%s' "${result%% *}"
}

declare -A before after
for table in "${tables[@]}"; do before["$table"]="$(fingerprint source "$table")"; done

temp_archive="$(mktemp "$(dirname "$BACKUP_FILE")/.print-pantry-restore.XXXXXXXX")" ||
  fail "Cannot create a private temporary archive in the backup directory."
trap 'rm -f -- "$temp_archive"' EXIT
source_db pg_dump --format=custom --serializable-deferrable --no-owner --no-privileges \
  --file="$temp_archive" 2>/dev/null ||
  fail "pg_dump failed; check source read access, free space, and PostgreSQL 17 compatibility."
for table in "${tables[@]}"; do
  after["$table"]="$(fingerprint source "$table")"
  [[ "${before[$table]}" == "${after[$table]}" ]] ||
    fail "Source changed during backup ($table); retry during a quiet window. No restore target was created."
done
ln -- "$temp_archive" "$BACKUP_FILE" ||
  fail "Cannot publish archive without overwriting an existing file."
rm -f -- "$temp_archive"
trap - EXIT

[[ "$(query_admin "SELECT count(*) FROM pg_database WHERE datname = '$RESTORE_DATABASE_NAME'")" == 0 ]] ||
  fail "Restore target appeared during backup; archive is preserved, no database was modified."
restore_db createdb --maintenance-db="$RESTORE_PGDATABASE" --template=template0 \
  "$RESTORE_DATABASE_NAME" 2>/dev/null ||
  fail "Could not create a fresh restore target; archive is preserved, no existing database was overwritten."
restore_db pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname="$RESTORE_DATABASE_NAME" "$BACKUP_FILE" 2>/dev/null ||
  fail "Restore failed; new target and archive are retained for inspection (nothing was dropped)."

for table in "${tables[@]}"; do
  [[ "${after[$table]}" == "$(fingerprint target "$table")" ]] ||
    fail "Restored $table differs from source; target and archive are retained for inspection."
done
printf 'Verified PostgreSQL backup and fresh restore: %s table rowsets, including catalog, accounts, versions, requests, history and queue state.\n' "${#tables[@]}"
printf 'Archive and restored database were retained; library file contents require a separate filesystem backup.\n'
