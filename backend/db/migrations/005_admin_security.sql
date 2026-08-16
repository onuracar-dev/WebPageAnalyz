CREATE TABLE IF NOT EXISTS wpa_admin_accounts (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    email text NOT NULL UNIQUE,
    role text NOT NULL CHECK (role IN ('super_admin', 'admin', 'operator')),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_access_at timestamptz
);

CREATE INDEX IF NOT EXISTS wpa_audit_log_created_idx ON wpa_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS wpa_scans_created_idx ON wpa_scans (created_at DESC);
