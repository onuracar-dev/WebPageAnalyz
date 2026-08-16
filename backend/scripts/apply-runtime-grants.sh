#!/bin/sh
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_ADMIN_USER:?POSTGRES_ADMIN_USER is required}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"

until PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_ADMIN_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; do
    sleep 1
done

export PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}"
exec psql \
    --host="${POSTGRES_HOST}" \
    --port="${POSTGRES_PORT:-5432}" \
    --username="${POSTGRES_ADMIN_USER}" \
    --dbname="${POSTGRES_DB}" \
    -f /bootstrap/apply-runtime-grants.sql
