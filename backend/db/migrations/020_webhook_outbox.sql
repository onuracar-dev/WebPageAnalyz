CREATE TABLE IF NOT EXISTS wpa_webhook_outbox (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','processing','retrying','delivered','dead_letter')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_token text,
    lease_expires_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS wpa_webhook_outbox_ready_idx ON wpa_webhook_outbox(status, next_attempt_at);
