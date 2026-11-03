#!/usr/bin/env sh
# Restore a pg-backup.sh archive into an EMPTY database and verify it against the manifest.
#
# Usage: pg-restore.sh <archive.dump> <target-database-url>
# Refuses a target that already has tables, so a restore can never overwrite live data by mistake.
# Exits non-zero unless the archive checksum and every table's row count match.
set -eu

[ "$#" -eq 2 ] || { echo "usage: $0 <archive.dump> <target-database-url>" >&2; exit 2; }
dump="$1"
target="$2"
dir=$(dirname "$dump")
base=$(basename "$dump")

( cd "$dir" && sha256sum -c "$base.sha256" ) || { echo "checksum mismatch: refusing to restore" >&2; exit 1; }

existing=$(psql -X -At -c "select count(*) from information_schema.tables where table_schema = 'public'" "$target")
[ "$existing" = "0" ] || { echo "target database is not empty ($existing tables): refusing to restore" >&2; exit 1; }

# Extensions first (pgvector, pgcrypto), then the archive in one transaction.
psql -X -q -v ON_ERROR_STOP=1 -c 'create extension if not exists vector; create extension if not exists pgcrypto;' "$target"
pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname="$target" "$dump"

query="select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint
       from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
psql -X -At -F ' ' -c "$query" "$target" > "$dump.restored.rows"
if diff -u "$dump.rows" "$dump.restored.rows"; then
  echo "restore verified: $(wc -l < "$dump.rows") tables, row counts match"
else
  echo "restore verification FAILED: row counts differ" >&2
  exit 1
fi
