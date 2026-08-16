ALTER TABLE wpa_workspace_deletion_requests
    ADD COLUMN IF NOT EXISTS grace_until timestamptz,
    ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS authorized_by text,
    ADD COLUMN IF NOT EXISTS authorized_at timestamptz,
    ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE wpa_reports ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS wpa_retention_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    retention_days integer NOT NULL CHECK (retention_days > 0),
    cutoff_at timestamptz NOT NULL,
    mode text NOT NULL CHECK (mode IN ('dry_run','execute')),
    deleted_count integer NOT NULL DEFAULT 0,
    status text NOT NULL CHECK (status IN ('started','completed','failed')),
    actor_id text,
    error_code text,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_retention_runs_workspace_idx ON wpa_retention_runs(workspace_id, started_at DESC);
