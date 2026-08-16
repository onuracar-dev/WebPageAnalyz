-- Durable history for destructive workspace execution.  The history survives
-- the workspace cascade so an operator can prove what happened.
CREATE TABLE IF NOT EXISTS wpa_workspace_deletion_runs (
    id text PRIMARY KEY,
    request_id text NOT NULL UNIQUE,
    workspace_id text REFERENCES wpa_workspaces(id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('running','completed','failed')),
    attempts integer NOT NULL DEFAULT 0,
    actor_id text,
    deleted_reports integer NOT NULL DEFAULT 0,
    deleted_source_inputs integer NOT NULL DEFAULT 0,
    deleted_executions integer NOT NULL DEFAULT 0,
    failure_code text,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_workspace_deletion_runs_status_idx
    ON wpa_workspace_deletion_runs(status, started_at);

ALTER TABLE wpa_retention_runs
    ADD COLUMN IF NOT EXISTS deleted_source_inputs integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deleted_executions integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS artifact_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS wpa_source_inputs_retention_idx
    ON wpa_source_inputs(workspace_id, status, purge_at, created_at);
CREATE INDEX IF NOT EXISTS wpa_worker_execution_retention_idx
    ON wpa_worker_execution_results(workspace_id, status, completed_at, updated_at);
