CREATE TABLE IF NOT EXISTS wpa_support_tickets (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    category text NOT NULL DEFAULT 'general' CHECK (char_length(category) BETWEEN 1 AND 40),
    subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','in_progress','resolved','closed')),
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    assigned_to text,
    created_by text NOT NULL,
    context text,
    target_url text,
    report_id text,
    idempotency_key text,
    notification_state jsonb NOT NULL DEFAULT '{"externalEmail":"not_configured"}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz,
    closed_at timestamptz,
    reopened_at timestamptz,
    UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS wpa_support_tickets_workspace_updated_idx
    ON wpa_support_tickets (workspace_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wpa_support_tickets_queue_idx
    ON wpa_support_tickets (status, priority, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wpa_support_messages (
    id text PRIMARY KEY,
    ticket_id text NOT NULL REFERENCES wpa_support_tickets(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    author_id text NOT NULL,
    author_type text NOT NULL CHECK (author_type IN ('customer','admin','system')),
    visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wpa_support_messages_ticket_created_idx
    ON wpa_support_messages (ticket_id, created_at, id);
CREATE INDEX IF NOT EXISTS wpa_support_messages_workspace_idx
    ON wpa_support_messages (workspace_id, created_at DESC);
