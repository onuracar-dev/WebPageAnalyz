CREATE TABLE IF NOT EXISTS wpa_admin_reauth_markers (
    session_id_hash text NOT NULL,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    verified_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (session_id_hash, user_id),
    CHECK (expires_at > verified_at)
);

CREATE INDEX IF NOT EXISTS wpa_admin_reauth_expiry_idx
    ON wpa_admin_reauth_markers (expires_at);
