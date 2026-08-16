CREATE TABLE IF NOT EXISTS wpa_webhook_outbox_history (
    id text PRIMARY KEY,
    outbox_id text NOT NULL REFERENCES wpa_webhook_outbox(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN ('enqueued','claimed','delivered','retrying','dead_letter','replayed')),
    actor_id text,
    from_status text,
    to_status text,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wpa_webhook_outbox_history_idx ON wpa_webhook_outbox_history(outbox_id, created_at DESC);
