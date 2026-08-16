-- Wave 2 durable runtime primitives. This migration is applied by the
-- release migration job; the API process must not run DDL at startup.
ALTER TABLE wpa_scan_pages ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE wpa_scan_pages ADD COLUMN IF NOT EXISTS lease_token text;
CREATE INDEX IF NOT EXISTS wpa_scan_pages_lease_idx
    ON wpa_scan_pages (status, lease_expires_at)
    WHERE status IN ('queued', 'retrying', 'running');
