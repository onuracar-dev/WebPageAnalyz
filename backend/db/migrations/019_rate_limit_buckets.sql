CREATE TABLE IF NOT EXISTS wpa_rate_limit_buckets (
    key text PRIMARY KEY,
    window_started_at timestamptz NOT NULL DEFAULT now(),
    hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wpa_rate_limit_buckets_updated_idx ON wpa_rate_limit_buckets(updated_at);
