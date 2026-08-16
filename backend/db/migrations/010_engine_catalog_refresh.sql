UPDATE wpa_plan_catalog SET
  features='["25 page credits / month","3 projects and 1 seat","Lighthouse, Axe, YellowLab + WPA core inspection","Runtime, SEO/GEO, responsive UX and backend-surface checks","TR/EN JSON + PDF/print reports","30-day report history"]'::jsonb,
  updated_at=now()
WHERE id='signal';

UPDATE wpa_plan_catalog SET
  description='Automated whole-site quality, advanced browser evidence and passive security for teams.',
  entitlements=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(entitlements,
    '{geo,executionMode}','"automated"'),'{design,executionMode}','"automated"'),
    '{performance_plus,executionMode}','"automated"'),'{passive_security,executionMode}','"automated"'),
    '{source_audit,executionMode}','"automated"'),
  features='["150 page credits / month","15 projects and 5 seats","Everything in Signal + full-site crawl","Automated advanced SEO/GEO, Visual UX and Performance Plus","Passive ZAP security + 1 OSV source audit / month","Weekly monitoring, comparisons + white-label reports","90-day report history"]'::jsonb,
  updated_at=now()
WHERE id='studio';

UPDATE wpa_plan_catalog SET
  entitlements=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(entitlements,
    '{geo,executionMode}','"automated"'),'{design,executionMode}','"automated"'),
    '{performance_plus,executionMode}','"automated"'),'{passive_security,executionMode}','"automated"'),
    '{source_audit,executionMode}','"automated"'),'{journey_test,executionMode}','"automated"'),
  features='["500 page credits / month","50 projects and 15 seats","Everything in Studio + 4 OSV source audits / month","Read-only Journey Tests + daily monitoring + API/webhooks","1 human Expert Review / month, up to 25 critical pages","365-day report history + priority support"]'::jsonb,
  updated_at=now()
WHERE id='enterprise';
