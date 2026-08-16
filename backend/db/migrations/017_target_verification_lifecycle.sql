ALTER TABLE wpa_projects ADD COLUMN IF NOT EXISTS verification_checked_at timestamptz;
ALTER TABLE wpa_projects ADD COLUMN IF NOT EXISTS verification_expires_at timestamptz;
ALTER TABLE wpa_projects ADD COLUMN IF NOT EXISTS verification_revoked_at timestamptz;
