CREATE TABLE IF NOT EXISTS wpa_workspace_settings (
    workspace_id text PRIMARY KEY REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    default_locale text NOT NULL DEFAULT 'en' CHECK (default_locale IN ('tr','en')),
    notify_scan_complete boolean NOT NULL DEFAULT true,
    notify_high_priority boolean NOT NULL DEFAULT true,
    weekly_digest boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_integrations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('github','gitlab','bitbucket','webhook')),
    status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','configured','error')),
    display_name text NOT NULL,
    encrypted_credentials bytea,
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    connected_by text,
    last_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS wpa_oauth_states (
    state_hash text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('github','gitlab','bitbucket')),
    user_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wpa_oauth_states_expiry_idx ON wpa_oauth_states (expires_at);
