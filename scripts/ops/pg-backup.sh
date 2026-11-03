#!/usr/bin/env sh
# Logical backup of the Anvaya database: a pg_dump custom-format archive plus a SHA-256 manifest.
#
# Usage: pg-backup.sh <output-dir>
# Connection comes from libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or
# DATABASE_URL. On AWS, RDS automated backups and point-in-time recovery are the primary
# mechanism; this archive is the portable, restorable-anywhere copy (docs/runbooks/backup-and-restore.md).
set -eu

[ "$#" -eq 1 ] || { echo "usage: $0 <output-dir>" >&2; exit 2; }
out="$1"
mkdir -p "$out"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$out/anvaya-$stamp.dump"
conn="${DATABASE_URL:-}"

# --no-owner/--no-acl: restorable into a database owned by a different role.
if [ -n "$conn" ]; then
  pg_dump --format=custom --no-owner --no-acl --file="$file" "$conn"
else
  pg_dump --format=custom --no-owner --no-acl --file="$file"
fi

# The manifest records what a restore must reproduce: per-table row counts and the archive hash.
query="select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint
       from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
if [ -n "$conn" ]; then
  psql -X -At -F ' ' -c "$query" "$conn" > "$file.rows"
else
  psql -X -At -F ' ' -c "$query" > "$file.rows"
fi
( cd "$out" && sha256sum "$(basename "$file")" "$(basename "$file").rows" > "$(basename "$file").sha256" )
echo "$file"
