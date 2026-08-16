ALTER TABLE wpa_projects ADD COLUMN IF NOT EXISTS verification_token text;
UPDATE wpa_projects
SET verification_token = md5(random()::text || clock_timestamp()::text || id)
WHERE verification_token IS NULL;
ALTER TABLE wpa_projects ALTER COLUMN verification_token SET NOT NULL;
