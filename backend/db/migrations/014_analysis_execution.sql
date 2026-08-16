CREATE TABLE IF NOT EXISTS wpa_scan_pages (
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    page_key text NOT NULL,
    url text NOT NULL,
    page_index integer NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','retrying','completed','incomplete','failed','unavailable','cancelled')),
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    lease_expires_at timestamptz,
    report jsonb,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scan_id, page_key)
);

CREATE INDEX IF NOT EXISTS wpa_scan_pages_claim_idx ON wpa_scan_pages(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS wpa_scan_events (
    id bigserial PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wpa_scan_events_replay_idx ON wpa_scan_events(workspace_id, scan_id, id);
