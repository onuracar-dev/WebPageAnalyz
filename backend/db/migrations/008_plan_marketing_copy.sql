UPDATE wpa_plan_catalog
SET description = 'Automated desktop and mobile evidence for a small website or product portfolio.',
    features = '["25 page credits / month","3 projects and 1 seat","4 core analyzers on desktop + mobile","Runtime, SEO/GEO, responsive UX and backend-surface checks","TR/EN JSON + PDF/print reports","30-day report history"]'::jsonb,
    updated_at = now()
WHERE id = 'signal';

UPDATE wpa_plan_catalog
SET description = 'Whole-site quality control with deeper analyst-assisted evidence for teams.',
    features = '["150 page credits / month","15 projects and 5 seats","Everything in Signal + full-site crawl","Advanced SEO/GEO, Visual UX and Performance Plus review","Passive security + 1 source audit / month","Weekly monitoring, comparisons + white-label reports","90-day report history"]'::jsonb,
    updated_at = now()
WHERE id = 'studio';

UPDATE wpa_plan_catalog
SET description = 'Highest-volume coverage with source, journey and expert-reviewed delivery.',
    features = '["500 page credits / month","50 projects and 15 seats","Everything in Studio + 4 source audits / month","Journey tests + daily monitoring + API/webhooks","1 expert-reviewed audit / month, up to 25 critical pages","365-day report history + priority support"]'::jsonb,
    updated_at = now()
WHERE id = 'enterprise';
