CREATE TABLE IF NOT EXISTS wpa_plan_catalog (
    id text PRIMARY KEY,
    name text NOT NULL,
    price_usd integer NOT NULL CHECK (price_usd >= 0),
    description text NOT NULL,
    limits jsonb NOT NULL,
    features jsonb NOT NULL,
    entitlements jsonb NOT NULL,
    published boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wpa_plan_catalog (id,name,price_usd,description,limits,features,entitlements) VALUES
('signal','Signal',29,'Automated desktop and mobile evidence for a small website or product portfolio.',
 '{"pageCredits":25,"projects":3,"seats":1,"retentionDays":30,"sourceAudits":0}',
 '["25 page credits / month","3 projects and 1 seat","4 core analyzers on desktop + mobile","Runtime, SEO/GEO, responsive UX and backend-surface checks","TR/EN JSON + PDF/print reports","30-day report history"]',
 '{"core_audit":{"executionMode":"automated"},"runtime":{"executionMode":"automated"},"seo":{"executionMode":"automated"},"geo":{"executionMode":"automated","limit":"basic"},"design":{"executionMode":"automated","limit":"basic"},"backend_surface":{"executionMode":"automated","limit":"basic"}}'),
('studio','Studio',99,'Whole-site quality control with deeper analyst-assisted evidence for teams.',
 '{"pageCredits":150,"projects":15,"seats":5,"retentionDays":90,"sourceAudits":1}',
 '["150 page credits / month","15 projects and 5 seats","Everything in Signal + full-site crawl","Advanced SEO/GEO, Visual UX and Performance Plus review","Passive security + 1 source audit / month","Weekly monitoring, comparisons + white-label reports","90-day report history"]',
 '{"core_audit":{"executionMode":"automated"},"runtime":{"executionMode":"automated"},"seo":{"executionMode":"automated"},"geo":{"executionMode":"operator_assisted","limit":"advanced"},"design":{"executionMode":"operator_assisted","limit":"advanced"},"backend_surface":{"executionMode":"automated","limit":"advanced"},"full_site_crawl":{"executionMode":"automated"},"performance_plus":{"executionMode":"operator_assisted"},"passive_security":{"executionMode":"operator_assisted"},"source_audit":{"executionMode":"operator_assisted","limit":1},"monitoring":{"executionMode":"automated","limit":"weekly"},"white_label":{"executionMode":"automated"}}'),
('enterprise','Enterprise / Expert',349,'Highest-volume coverage with source, journey and expert-reviewed delivery.',
 '{"pageCredits":500,"projects":50,"seats":15,"retentionDays":365,"sourceAudits":4,"expertReviews":1,"expertPages":25}',
 '["500 page credits / month","50 projects and 15 seats","Everything in Studio + 4 source audits / month","Journey tests + daily monitoring + API/webhooks","1 expert-reviewed audit / month, up to 25 critical pages","365-day report history + priority support"]',
 '{"core_audit":{"executionMode":"automated"},"runtime":{"executionMode":"automated"},"seo":{"executionMode":"automated"},"geo":{"executionMode":"operator_assisted"},"design":{"executionMode":"operator_assisted"},"backend_surface":{"executionMode":"automated"},"full_site_crawl":{"executionMode":"automated"},"performance_plus":{"executionMode":"operator_assisted"},"passive_security":{"executionMode":"operator_assisted"},"source_audit":{"executionMode":"operator_assisted"},"monitoring":{"executionMode":"automated","limit":"daily"},"white_label":{"executionMode":"automated"},"journey_test":{"executionMode":"operator_assisted"},"expert_review":{"executionMode":"operator_assisted"},"api_webhooks":{"executionMode":"automated"}}')
ON CONFLICT (id) DO NOTHING;
