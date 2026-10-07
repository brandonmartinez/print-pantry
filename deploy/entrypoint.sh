#!/bin/sh
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  case "$DATABASE_URL" in
    postgresql://*|postgres://*) ;;
    *) echo 'DATABASE_URL must be a PostgreSQL URL' >&2; exit 1 ;;
  esac
else
  if [ ! -r "${DB_PASSWORD_FILE:-}" ]; then
    echo 'DB_PASSWORD_FILE must be a readable external secret for the internal database' >&2
    exit 1
  fi
  password="$(cat "$DB_PASSWORD_FILE")"
  if ! printf '%s' "$password" | grep -Eq '^[A-Za-z0-9_-]{24,}$'; then
    echo 'Internal database password must be at least 24 URI-safe characters' >&2
    exit 1
  fi
  export DATABASE_URL="postgresql://pantry:${password}@db:5432/print_pantry"
  unset password
fi

exec "$@"
