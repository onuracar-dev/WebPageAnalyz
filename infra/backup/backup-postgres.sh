#!/usr/bin/env sh
set -eu

umask 077

output_dir=${1:-./backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
base_name="webpage-analyzer-${timestamp}.dump"
partial_path="${output_dir}/.${base_name}.partial"
plain_path="${output_dir}/${base_name}"
encrypted_path="${plain_path}.age"

cleanup() {
  rm -f -- "${partial_path}"
}
trap cleanup EXIT HUP INT TERM

mkdir -p -- "${output_dir}"
chmod 700 -- "${output_dir}"

docker compose exec -T postgres \
  pg_dump --username=postgres --dbname=webpage_analyzer \
  --format=custom --compress=9 --no-owner --no-acl > "${partial_path}"

test -s "${partial_path}"
docker compose exec -T postgres pg_restore --list < "${partial_path}" >/dev/null
mv -- "${partial_path}" "${plain_path}"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || {
    echo "age is required when BACKUP_AGE_RECIPIENT is set." >&2
    exit 1
  }
  age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${encrypted_path}" "${plain_path}"
  test -s "${encrypted_path}"
  rm -f -- "${plain_path}"
  sha256sum "${encrypted_path}" > "${encrypted_path}.sha256"
  chmod 600 -- "${encrypted_path}" "${encrypted_path}.sha256"
  echo "Backup created: ${encrypted_path}"
else
  if [ "${BACKUP_REQUIRE_ENCRYPTION:-true}" = "true" ]; then
    rm -f -- "${plain_path}"
    echo "BACKUP_AGE_RECIPIENT is required when BACKUP_REQUIRE_ENCRYPTION=true." >&2
    exit 1
  fi
  sha256sum "${plain_path}" > "${plain_path}.sha256"
  chmod 600 -- "${plain_path}" "${plain_path}.sha256"
  echo "Unencrypted backup created by explicit policy: ${plain_path}"
fi
