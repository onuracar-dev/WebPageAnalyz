ALTER TABLE wpa_scan_pages
    ADD COLUMN IF NOT EXISTS discovery jsonb NOT NULL DEFAULT '{"sources":[]}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS wpa_scan_pages_url_unique
    ON wpa_scan_pages (scan_id, url);

CREATE UNIQUE INDEX IF NOT EXISTS wpa_scan_pages_index_unique
    ON wpa_scan_pages (scan_id, page_index);
