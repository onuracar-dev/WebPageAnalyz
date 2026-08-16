CREATE TABLE IF NOT EXISTS wpa_billing_events (
    event_id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    event_created bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('received','applied','ignored','failed')),
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_billing_events_workspace_idx ON wpa_billing_events(workspace_id, event_created);
