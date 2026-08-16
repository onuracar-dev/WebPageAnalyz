ALTER TABLE wpa_source_inputs ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE wpa_source_inputs ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE wpa_source_inputs ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE wpa_plan_catalog
SET entitlements = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(entitlements, '{geo,executionMode}', '"automated"'),
          '{design,executionMode}', '"automated"'),
        '{performance_plus,executionMode}', '"automated"'),
      '{passive_security,executionMode}', '"automated"'),
    '{source_audit,executionMode}', '"automated"'),
    updated_at = now()
WHERE id IN ('studio', 'enterprise');

UPDATE wpa_plan_catalog
SET entitlements = jsonb_set(entitlements, '{journey_test,executionMode}', '"automated"'), updated_at = now()
WHERE id = 'enterprise';

UPDATE wpa_plan_catalog SET
  features='["25 page credits / month","3 projects and 1 seat","Lighthouse, Axe, YellowLab + WPA core inspection","Runtime, SEO/GEO, responsive UX and backend-surface checks","TR/EN JSON + PDF/print reports","30-day report history"]'::jsonb,
  updated_at=now()
WHERE id='signal';

UPDATE wpa_plan_catalog SET
  description='Automated whole-site quality, advanced browser evidence and passive security for teams.',
  features='["150 page credits / month","15 projects and 5 seats","Everything in Signal + full-site crawl","Automated advanced SEO/GEO, Visual UX and Performance Plus","Passive ZAP security + 1 OSV source audit / month","Weekly monitoring, comparisons + white-label reports","90-day report history"]'::jsonb,
  updated_at=now()
WHERE id='studio';

UPDATE wpa_plan_catalog SET
  features='["500 page credits / month","50 projects and 15 seats","Everything in Studio + 4 OSV source audits / month","Read-only Journey Tests + daily monitoring + API/webhooks","1 human Expert Review / month, up to 25 critical pages","365-day report history + priority support"]'::jsonb,
  updated_at=now()
WHERE id='enterprise';

CREATE TABLE IF NOT EXISTS wpa_expert_reviews (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    source_report_id text NOT NULL REFERENCES wpa_reports(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('requested','in_review','ready_to_publish','published','cancelled')),
    scope_page_urls jsonb NOT NULL,
    decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
    roadmap jsonb NOT NULL DEFAULT '[]'::jsonb,
    requested_by text NOT NULL,
    assigned_to text,
    due_at timestamptz NOT NULL,
    completed_at timestamptz,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(workspace_id,idempotency_key)
);
