\set ON_ERROR_STOP on

-- The one-shot grant step is deliberately separate from application startup.
-- It is the only place that grants broad API table access and the narrow
-- analysis-worker table set; neither runtime process can grant itself access.
\set runtime_role 'wpa_runtime'
\set worker_role 'wpa_worker'
\set maintenance_role 'wpa_maintenance'
\set queue_role 'wpa_queue'
\set owner_role 'wpa_owner'

SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'queue_role');
\gexec

-- Queue migrations run as wpa_queue, then ownership is handed to the
-- NOLOGIN owner role before any long-lived service starts. This prevents the
-- queue runtime role from retaining ALTER/DROP authority through ownership.
ALTER SCHEMA wpa_queue OWNER TO :"owner_role";
REVOKE CREATE ON SCHEMA wpa_queue FROM :"queue_role";
DO $$
DECLARE
    item record;
BEGIN
    FOR item IN
        SELECT c.relkind, n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'wpa_queue' AND r.rolname = 'wpa_queue'
          AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    LOOP
        IF item.relkind = 'S' THEN
            EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', item.nspname, item.relname, 'wpa_owner');
        ELSIF item.relkind = 'v' THEN
            EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', item.nspname, item.relname, 'wpa_owner');
        ELSIF item.relkind = 'm' THEN
            EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', item.nspname, item.relname, 'wpa_owner');
        ELSIF item.relkind = 'f' THEN
            EXECUTE format('ALTER FOREIGN TABLE %I.%I OWNER TO %I', item.nspname, item.relname, 'wpa_owner');
        ELSE
            EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', item.nspname, item.relname, 'wpa_owner');
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    item record;
BEGIN
    -- pg-boss installs helper functions alongside its tables. Transfer those
    -- owners too; otherwise the queue login could still ALTER/DROP a function
    -- after schema/table ownership is handed to wpa_owner.
    FOR item IN
        SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'wpa_queue' AND r.rolname = 'wpa_queue'
    LOOP
        EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', item.nspname, item.proname, item.identity_arguments, 'wpa_owner');
    END LOOP;
END $$;

DO $$
DECLARE
    item record;
BEGIN
    -- Queue migrations can also create enum/domain/composite types. Transfer
    -- those owners so the queue login cannot retain ALTER TYPE authority.
    FOR item IN
        SELECT n.nspname, t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_roles r ON r.oid = t.typowner
        WHERE n.nspname = 'wpa_queue' AND r.rolname = 'wpa_queue'
          AND t.typrelid = 0 AND t.typtype IN ('c', 'd', 'e')
    LOOP
        EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', item.nspname, item.typname, 'wpa_owner');
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO :"runtime_role", :"worker_role", :"maintenance_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"worker_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"worker_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"maintenance_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"maintenance_role";

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'wpa_workspaces', 'wpa_projects', 'wpa_plan_catalog', 'wpa_scans',
        'wpa_scan_pages', 'wpa_scan_events', 'wpa_credit_entries',
        'wpa_reports', 'wpa_operator_tasks', 'wpa_source_inputs',
        -- Durable hostile-job result ledger. Retention/deletion authority is
        -- intentionally absent from the analysis worker role.
        'wpa_worker_execution_results', 'wpa_worker_heartbeats'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', table_name, 'wpa_worker');
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'wpa_scans', 'wpa_scan_pages', 'wpa_source_inputs',
        'wpa_worker_execution_results', 'wpa_worker_heartbeats'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT UPDATE ON TABLE public.%I TO %I', table_name, 'wpa_worker');
        END IF;
    END LOOP;

    -- Engine Lab audit evidence is append-only from the hostile-job worker.
    -- Keep this explicit revoke so reapplying the one-shot grant script also
    -- repairs volumes that briefly received SELECT during rollout.
    IF to_regclass('public.wpa_audit_log') IS NOT NULL THEN
        REVOKE SELECT ON TABLE public.wpa_audit_log FROM wpa_worker;
    END IF;

    FOREACH table_name IN ARRAY ARRAY[
        'wpa_scan_pages', 'wpa_scan_events', 'wpa_credit_entries',
        'wpa_reports', 'wpa_operator_tasks',
        'wpa_worker_execution_results', 'wpa_worker_heartbeats', 'wpa_audit_log'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT INSERT ON TABLE public.%I TO %I', table_name, 'wpa_worker');
        END IF;
    END LOOP;

    IF to_regclass('public.wpa_credit_entries') IS NOT NULL THEN
        GRANT UPDATE ON TABLE wpa_credit_entries TO wpa_worker;
    END IF;
    -- The analysis worker never owns retention or account-deletion cleanup.
    -- It only appends/updates scan, source, report, and execution state; all
    -- destructive retention/deletion DML belongs to wpa_maintenance below.
    -- Scan-event retention is performed by a role that owns the table. The
    -- analysis worker only appends progress events; it has no event-history
    -- DELETE authority, including for another workspace.
    -- wpa_scan_events uses a generated bigint id; grant only its sequence,
    -- rather than re-opening all public sequences to the worker.
    IF to_regclass('public.wpa_scan_events_id_seq') IS NOT NULL THEN
        GRANT USAGE, SELECT ON SEQUENCE public.wpa_scan_events_id_seq TO wpa_worker;
    END IF;
END $$;

-- The maintenance role is the only application role allowed to execute
-- retention or confirmed workspace deletion. It has no queue privileges and
-- no broad API-table DML; the parent workspace DELETE is the one destructive
-- account-level authority and cascades only through declared FK relations.
DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'wpa_workspaces', 'wpa_plan_catalog', 'wpa_reports', 'wpa_source_inputs',
        'wpa_worker_execution_results', 'wpa_retention_runs',
        'wpa_workspace_deletion_requests', 'wpa_workspace_deletion_runs',
        -- logAudit uses INSERT ... RETURNING, which requires SELECT on the
        -- returned columns even though maintenance never lists audit rows.
        'wpa_audit_log'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', table_name, 'wpa_maintenance');
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'wpa_retention_runs', 'wpa_workspace_deletion_requests',
        'wpa_workspace_deletion_runs'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT UPDATE ON TABLE public.%I TO %I', table_name, 'wpa_maintenance');
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'wpa_retention_runs', 'wpa_workspace_deletion_runs', 'wpa_audit_log'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT INSERT ON TABLE public.%I TO %I', table_name, 'wpa_maintenance');
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'wpa_workspaces', 'wpa_reports', 'wpa_source_inputs',
        'wpa_worker_execution_results'
    ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT DELETE ON TABLE public.%I TO %I', table_name, 'wpa_maintenance');
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON SCHEMA wpa_queue FROM :"maintenance_role";

GRANT USAGE ON SCHEMA wpa_queue TO :"runtime_role", :"worker_role";
-- The one-shot db:bootstrap process reruns after this grant step on deploys.
-- Keep queue-role schema USAGE so it can idempotently register the canonical
-- queue rows, while CREATE/ownership remain revoked below.
GRANT USAGE ON SCHEMA wpa_queue TO :"queue_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wpa_queue TO :"runtime_role", :"worker_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wpa_queue TO :"runtime_role", :"worker_role";
-- Queue bootstrap is a separate one-shot release operation. It needs bounded
-- DML/function execution after ownership is transferred to wpa_owner, but no
-- schema CREATE/ALTER/DROP authority.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wpa_queue TO :"queue_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wpa_queue TO :"queue_role";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA wpa_queue TO :"queue_role";
