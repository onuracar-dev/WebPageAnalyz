CREATE TABLE IF NOT EXISTS wpa_worker_heartbeats (
    kind text PRIMARY KEY CHECK (kind IN ('analysis','maintenance')),
    worker_id text NOT NULL,
    started_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS wpa_worker_heartbeats_freshness_idx
    ON wpa_worker_heartbeats (heartbeat_at DESC);
