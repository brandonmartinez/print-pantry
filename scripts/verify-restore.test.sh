#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
container="print-pantry-restore-test-$$-$RANDOM"
backup_volume="${container}-archive"
fail() { printf 'Restore integration test failed: %s\n' "$1" >&2; exit 1; }
command -v docker >/dev/null || fail "Docker is required to run this isolated PostgreSQL integration test."

docker run -d --name "$container" --network=none \
  -e POSTGRES_PASSWORD=synthetic-only \
  -v "$script_dir:/scripts:ro" \
  -v "$script_dir/../packages/db/drizzle:/migrations:ro" \
  -v "$backup_volume:/backups" \
  postgres:17.6-bookworm >/dev/null ||
  fail "Could not start an isolated PostgreSQL 17 container."
trap 'docker stop "$container" >/dev/null || true; printf "Isolated fixture container retained: %s (archive volume: %s)\n" "$container" "$backup_volume"' EXIT

ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker exec "$container" pg_isready -q -U postgres -d postgres; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || fail "PostgreSQL fixture did not become ready."

docker exec "$container" createdb -U postgres print_pantry_restore_source_fixture ||
  fail "Could not create the isolated source database."
for migration in "$script_dir"/../packages/db/drizzle/[0-9]*.sql; do
  docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
    -d print_pantry_restore_source_fixture -f "/migrations/$(basename "$migration")" >/dev/null ||
    fail "Migration fixture failed: $(basename "$migration")."
done
docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
  -d print_pantry_restore_source_fixture -f /scripts/restore-fixture.sql >/dev/null ||
  fail "Synthetic fixture setup failed."

run_verify() {
  docker exec \
    -e SOURCE_PGHOST=localhost -e SOURCE_PGPORT=5432 -e SOURCE_PGUSER=postgres \
    -e SOURCE_PGPASSWORD=synthetic-only \
    -e SOURCE_PGDATABASE="${SOURCE_PGDATABASE:-print_pantry_restore_source_fixture}" \
    -e RESTORE_PGHOST=localhost -e RESTORE_PGPORT=5432 -e RESTORE_PGUSER=postgres \
    -e RESTORE_PGPASSWORD=synthetic-only -e RESTORE_PGDATABASE=postgres \
    -e RESTORE_DATABASE_NAME="${RESTORE_DATABASE_NAME:-print_pantry_restore_fixture}" \
    -e BACKUP_FILE="${BACKUP_FILE:-/backups/fixture.dump}" \
    "$container" bash /scripts/verify-restore.sh
}
reject() {
  local expected="$1" output
  if output="$(run_verify 2>&1)"; then fail "Unsafe invocation succeeded: $expected."; fi
  [[ "$output" == *"$expected"* ]] || fail "Expected refusal ($expected), got: $output"
}

RESTORE_DATABASE_NAME=print_pantry_restore_source_fixture reject "Restore target resolves to the live source"
RESTORE_DATABASE_NAME=postgres reject "must be a new"
docker exec "$container" createdb -U postgres print_pantry_restore_existing
RESTORE_DATABASE_NAME=print_pantry_restore_existing reject "already exists"
docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
  -d print_pantry_restore_existing -c 'CREATE SCHEMA must_remain' >/dev/null
SOURCE_PGDATABASE=postgres reject "missing public.app_metadata"
docker exec "$container" createdb -U postgres -T print_pantry_restore_source_fixture print_pantry_restore_other_schema
docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
  -d print_pantry_restore_other_schema -c 'CREATE SCHEMA unrelated_app' >/dev/null
SOURCE_PGDATABASE=print_pantry_restore_other_schema reject "unrelated schemas"

run_verify
docker exec "$container" test -s /backups/fixture.dump ||
  fail "The private backup archive is missing."
[[ "$(docker exec "$container" stat -c '%a' /backups/fixture.dump)" == 600 ]] ||
  fail "The backup archive is not private to its owner."
if ! docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres \
  -d print_pantry_restore_fixture >/dev/null <<'SQL'
DO $$
BEGIN
  IF (SELECT value FROM app_metadata WHERE key = 'library_fixture') IS DISTINCT FROM 'synthetic-catalog-v1'
    OR (SELECT name FROM categories WHERE id = '00000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'Gadgets'
    OR (SELECT notes FROM projects WHERE id = '00000000-0000-4000-8000-000000000002') IS DISTINCT FROM 'Keep this note'
    OR (SELECT tags FROM projects WHERE id = '00000000-0000-4000-8000-000000000002') IS DISTINCT FROM ARRAY['fixture', 'lamp']
    OR (SELECT kind FROM project_boundary_overrides WHERE relative_path = 'Synthetic/Gadgets/Lamp') IS DISTINCT FROM 'project'
    OR (SELECT count(*) FROM asset_versions) IS DISTINCT FROM 2
    OR (SELECT v.content_hash FROM assets a JOIN asset_versions v ON v.id = a.current_version_id) IS DISTINCT FROM 'fixture-hash-v2'
    OR (SELECT count(*) FROM users WHERE role IN ('operator', 'requester')) IS DISTINCT FROM 2
    OR (SELECT count(*) FROM sessions WHERE token_hash = 'not-a-real-session-token-hash') IS DISTINCT FROM 1
    OR (SELECT status FROM print_requests WHERE id = '00000000-0000-4000-8000-000000000009') IS DISTINCT FROM 'queued'
    OR (SELECT quantity FROM print_requests WHERE id = '00000000-0000-4000-8000-000000000009') IS DISTINCT FROM 2
    OR (SELECT f.content_hash FROM print_request_files f JOIN asset_versions v ON v.id = f.version_id
        WHERE f.request_id = '00000000-0000-4000-8000-000000000009' AND v.content_hash = 'fixture-hash-v1') IS DISTINCT FROM 'fixture-hash-v1'
    OR (SELECT string_agg(action, ',' ORDER BY id) FROM print_request_history) IS DISTINCT FROM 'submit,approve,select_next'
    OR (SELECT revision FROM request_queue_state WHERE id = 1) IS DISTINCT FROM 3
    OR (SELECT selected_next_id FROM request_queue_state WHERE id = 1) IS DISTINCT FROM '00000000-0000-4000-8000-000000000009'
    OR (SELECT hash FROM drizzle.__drizzle_migrations) IS DISTINCT FROM 'synthetic-migration'
  THEN RAISE EXCEPTION 'Restore did not preserve synthetic fixture values and references'; END IF;
END $$;
SQL
then
  fail "Restored synthetic metadata, accounts, versions, requests, history or queue state differ."
fi

BACKUP_FILE=/backups/another.dump reject "already exists"
BACKUP_FILE=/backups/fixture.dump RESTORE_DATABASE_NAME=print_pantry_restore_new reject "never overwritten"
[[ "$(docker exec "$container" psql -X -qAt -U postgres -d print_pantry_restore_existing \
  -c "SELECT count(*) FROM pg_namespace WHERE nspname = 'must_remain'")" == 1 ]] ||
  fail "An existing target was modified."
printf 'Isolated PostgreSQL 17 backup/restore and refusal checks passed; fixture data retained.\n'
