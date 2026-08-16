#!/usr/bin/env sh
set -eu

umask 077

backup_path=${1:?Usage: restore-check-postgres.sh <backup.dump|backup.dump.age>}
timestamp=$(date -u +%Y%m%d%H%M%S)
restore_db="wpa_restore_check_${timestamp}"
temporary_dump=""

case "${restore_db}" in
  wpa_restore_check_*) ;;
  *) echo "Refusing an unsafe restore database name." >&2; exit 1 ;;
esac

cleanup() {
  docker compose exec -T postgres dropdb --username=postgres --if-exists "${restore_db}" >/dev/null 2>&1 || true
  if [ -n "${temporary_dump}" ]; then rm -f -- "${temporary_dump}"; fi
}
trap cleanup EXIT HUP INT TERM

test -f "${backup_path}"
if [ -f "${backup_path}.sha256" ]; then
  sha256sum --check "${backup_path}.sha256"
fi

restore_source="${backup_path}"
case "${backup_path}" in
  *.age)
    command -v age >/dev/null 2>&1 || {
      echo "age is required to restore an encrypted backup." >&2
      exit 1
    }
    temporary_dump=$(mktemp "${TMPDIR:-/tmp}/wpa-restore-check.XXXXXX.dump")
    age --decrypt --output "${temporary_dump}" "${backup_path}"
    restore_source="${temporary_dump}"
    ;;
esac

docker compose exec -T postgres pg_restore --list < "${restore_source}" >/dev/null
docker compose exec -T postgres createdb --username=postgres "${restore_db}"
docker compose exec -T postgres \
  pg_restore --username=postgres --dbname="${restore_db}" \
  --no-owner --no-acl --exit-on-error < "${restore_source}"

docker compose exec -T postgres psql --username=postgres --dbname="${restore_db}" \
  --set=ON_ERROR_STOP=1 --tuples-only --command \
  "SELECT 'migrations=' || count(*) FROM wpa_schema_migrations; SELECT 'workspaces=' || count(*) FROM wpa_workspaces; SELECT 'reports=' || count(*) FROM wpa_reports;"

echo "Restore check passed in disposable database ${restore_db}; it will now be removed."
