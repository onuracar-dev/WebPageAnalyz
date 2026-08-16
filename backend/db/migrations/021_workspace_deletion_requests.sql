CREATE TABLE IF NOT EXISTS wpa_workspace_deletion_requests (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    requested_by text NOT NULL,
    status text NOT NULL CHECK (status IN ('requested','processing','completed','cancelled')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (workspace_id)
);
