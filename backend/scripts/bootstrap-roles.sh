#!/bin/sh
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_ADMIN_USER:?POSTGRES_ADMIN_USER is required}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"
: "${POSTGRES_RUNTIME_PASSWORD:?POSTGRES_RUNTIME_PASSWORD is required}"
: "${POSTGRES_MIGRATOR_PASSWORD:?POSTGRES_MIGRATOR_PASSWORD is required}"
: "${POSTGRES_WORKER_PASSWORD:?POSTGRES_WORKER_PASSWORD is required}"
: "${POSTGRES_MAINTENANCE_PASSWORD:?POSTGRES_MAINTENANCE_PASSWORD is required}"
: "${POSTGRES_QUEUE_PASSWORD:?POSTGRES_QUEUE_PASSWORD is required}"

until PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_ADMIN_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; do
    sleep 1
done

export PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}"
exec psql \
    --no-psqlrc \
    --set=ECHO=none \
    --host="${POSTGRES_HOST}" \
    --port="${POSTGRES_PORT:-5432}" \
    --username="${POSTGRES_ADMIN_USER}" \
    --dbname="${POSTGRES_DB}" \
    -v "runtime_password=${POSTGRES_RUNTIME_PASSWORD}" \
    -v "migrator_password=${POSTGRES_MIGRATOR_PASSWORD}" \
    -v "worker_password=${POSTGRES_WORKER_PASSWORD}" \
    -v "maintenance_password=${POSTGRES_MAINTENANCE_PASSWORD}" \
    -v "queue_password=${POSTGRES_QUEUE_PASSWORD}" \
    -f /bootstrap/bootstrap-roles.sql
