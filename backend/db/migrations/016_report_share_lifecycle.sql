ALTER TABLE wpa_reports ADD COLUMN IF NOT EXISTS share_expires_at timestamptz;
ALTER TABLE wpa_reports ADD COLUMN IF NOT EXISTS share_revoked_at timestamptz;
ALTER TABLE wpa_reports ADD COLUMN IF NOT EXISTS share_created_at timestamptz;
CREATE INDEX IF NOT EXISTS wpa_reports_share_token_idx ON wpa_reports (share_token_hash) WHERE share_token_hash IS NOT NULL;
