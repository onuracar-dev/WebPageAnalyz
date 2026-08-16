\set ON_ERROR_STOP on

-- This file is intentionally run by the one-shot bootstrap service with the
-- PostgreSQL administrator credential. The application and worker roles never
-- receive that credential.
\set owner_role 'wpa_owner'
\set runtime_role 'wpa_runtime'
\set migrator_role 'wpa_migrator'
\set worker_role 'wpa_worker'
\set maintenance_role 'wpa_maintenance'
\set queue_role 'wpa_queue'

SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT', :'owner_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role');
\gexec

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'runtime_role', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role');
\gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'migrator_role', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_role');
\gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'worker_role', :'worker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_role');
\gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'maintenance_role', :'maintenance_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'maintenance_role');
\gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'queue_role', :'queue_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'queue_role');
\gexec

ALTER ROLE :"runtime_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'runtime_password';
ALTER ROLE :"migrator_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'migrator_password';
ALTER ROLE :"worker_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'worker_password';
ALTER ROLE :"maintenance_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'maintenance_password';
ALTER ROLE :"queue_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'queue_password';
ALTER ROLE :"owner_role" NOLOGIN NOINHERIT;

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I, %I, %I', current_database(), :'runtime_role', :'migrator_role', :'worker_role', :'maintenance_role', :'queue_role');
\gexec
-- Numbered migrations may use transaction-local staging tables for
-- deterministic backfills. TEMPORARY is database-scoped and does not grant
-- access to permanent application objects.
SELECT format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), :'migrator_role');
\gexec
-- pg-boss's explicit migration checks/creates its schema. This temporary
-- CREATE privilege is revoked by apply-runtime-grants.sql before services run.
SELECT format('GRANT CREATE ON DATABASE %I TO %I', current_database(), :'queue_role');
\gexec

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"runtime_role", :"migrator_role", :"worker_role", :"maintenance_role";
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_role";

CREATE SCHEMA IF NOT EXISTS wpa_queue AUTHORIZATION :"queue_role";
ALTER SCHEMA wpa_queue OWNER TO :"queue_role";
REVOKE ALL ON SCHEMA wpa_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA wpa_queue TO :"queue_role", :"runtime_role", :"worker_role";
GRANT USAGE, CREATE ON SCHEMA wpa_queue TO :"queue_role";

-- Numbered application migrations are run as wpa_migrator. These defaults
-- make the API able to use new application tables without granting it DDL.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_role";

-- pg-boss migrations are run explicitly as wpa_queue. Runtime queue workers
-- may use rows, but cannot create or alter the queue schema.
ALTER DEFAULT PRIVILEGES FOR ROLE :"queue_role" IN SCHEMA wpa_queue
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role", :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"queue_role" IN SCHEMA wpa_queue
    GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_role", :"worker_role";
