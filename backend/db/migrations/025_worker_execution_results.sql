CREATE TABLE IF NOT EXISTS wpa_worker_execution_results (
    id text PRIMARY KEY,
    job_key text NOT NULL UNIQUE,
    workspace_id text REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('source','pdf','osv')),
    status text NOT NULL CHECK (status IN ('queued','running','completed','failed','unavailable')),
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    artifact_path text,
    content_type text,
    bytes bigint,
    failure_code text,
    attempts integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_worker_execution_workspace_idx ON wpa_worker_execution_results(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wpa_worker_execution_lease_idx ON wpa_worker_execution_results(status, lease_expires_at);
