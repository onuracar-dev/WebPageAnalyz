ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS last_event_created bigint NOT NULL DEFAULT 0;
