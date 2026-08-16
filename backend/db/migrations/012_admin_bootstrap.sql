CREATE TABLE IF NOT EXISTS wpa_admin_bootstrap (
    id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
    token_hash text NOT NULL,
    consumed_at timestamptz,
    consumed_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
