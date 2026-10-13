#!/usr/bin/env bash
# Backup/restore drill (#29): dump a database, restore it into a fresh one,
# and prove every table round-trips (row count + content hash per table).
#
#   scripts/db/backup-restore-check.sh postgresql://user:pass@host:5432/vham
#
# PG_TOOLS optionally prefixes the PostgreSQL client tools, e.g.
#   PG_TOOLS="docker run --rm -i --network host postgres:16-alpine"
# MIN_ROWS_TABLES lists tables that must not be empty (default: the
# financial tables), so an empty database cannot pass the drill.
set -euo pipefail

SOURCE_URL="${1:?usage: backup-restore-check.sh <database-url> [restore-db-name]}"
RESTORE_DB="${2:-vham_restore_check}"
PG_TOOLS="${PG_TOOLS:-}"
MIN_ROWS_TABLES="${MIN_ROWS_TABLES:-campaigns submissions chain_events}"

if [[ ! "$RESTORE_DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "restore database name must be a simple identifier" >&2
  exit 2
fi

base="${SOURCE_URL%/*}"
admin_url="$base/postgres"
restore_url="$base/$RESTORE_DB"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

pg() { $PG_TOOLS "$@"; }

echo "1/4 dump"
pg pg_dump --format=custom --no-owner --no-privileges "$SOURCE_URL" > "$workdir/backup.dump"
echo "    $(wc -c < "$workdir/backup.dump") bytes"

echo "2/4 restore into $RESTORE_DB"
pg psql "$admin_url" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $RESTORE_DB" \
  -c "CREATE DATABASE $RESTORE_DB"
pg pg_restore --no-owner --no-privileges --exit-on-error -d "$restore_url" < "$workdir/backup.dump"

tables_sql="SELECT quote_ident(schemaname) || '.' || quote_ident(tablename)
  FROM pg_tables WHERE schemaname IN ('public', 'drizzle')
  ORDER BY schemaname, tablename"

fingerprint() {
  local url="$1"
  local tables
  tables="$(pg psql "$url" -At -v ON_ERROR_STOP=1 -c "$tables_sql")"
  for table in $tables; do
    pg psql "$url" -At -v ON_ERROR_STOP=1 -c \
      "SELECT '$table', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM $table x"
  done
}

echo "3/4 fingerprint"
fingerprint "$SOURCE_URL" > "$workdir/source.txt"
fingerprint "$restore_url" > "$workdir/restored.txt"
cat "$workdir/source.txt"

echo "4/4 compare"
if ! diff -u "$workdir/source.txt" "$workdir/restored.txt"; then
  echo "::error::restored database differs from the source" >&2
  exit 1
fi

for table in $MIN_ROWS_TABLES; do
  rows="$(awk -F'|' -v t="public.$table" '$1 == t { print $2 }' "$workdir/source.txt")"
  if [[ -z "$rows" || "$rows" -eq 0 ]]; then
    echo "::error::$table is empty; the drill needs representative data" >&2
    exit 1
  fi
done

pg psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE $RESTORE_DB"
echo "backup/restore drill passed: $(wc -l < "$workdir/source.txt") tables identical"
