-- Keep the durable public catalog identical to the executable plan contract.
-- Monitoring, white-label output and Expert Review are not base-plan promises;
-- Expert Review remains available only through an explicit entitlement grant.
UPDATE wpa_plan_catalog AS catalog
SET name = source.name,
    price_usd = source.price_usd,
    description = source.description,
    limits = source.limits,
    features = source.features,
    entitlements = source.entitlements,
    published = source.published,
    sales_mode = source.sales_mode,
    updated_at = now()
FROM (VALUES
    (
        'free','Free',0,
        'A bounded workspace for evaluating the core audit and remediation workflow.',
        '{"pageCredits":5,"projects":1,"seats":1,"retentionDays":7,"sourceAudits":0,"aiRemediations":5}'::jsonb,
        '["5 page credits / month","1 project and 1 seat","Core browser, SEO/GEO, design and backend-surface evidence","5 AI remediation generations / month","7-day report history"]'::jsonb,
        '{"core_audit":{"executionMode":"automated","limit":null},"runtime":{"executionMode":"automated","limit":"basic"},"seo":{"executionMode":"automated","limit":"basic"},"geo":{"executionMode":"automated","limit":"basic"},"design":{"executionMode":"automated","limit":"basic"},"backend_surface":{"executionMode":"automated","limit":"basic"},"ai_remediation":{"executionMode":"automated","limit":5}}'::jsonb,
        false,'internal'
    ),
    (
        'signal','Signal',29,
        'Automated desktop and mobile evidence for a small website or product portfolio.',
        '{"pageCredits":25,"projects":3,"seats":1,"retentionDays":30,"sourceAudits":0,"aiRemediations":100}'::jsonb,
        '["25 page credits / month","3 projects and 1 seat","Lighthouse, Axe, YellowLab + WPA core inspection","Runtime, SEO/GEO, responsive UX and backend-surface checks","TR/EN JSON + PDF/print reports","30-day report history"]'::jsonb,
        '{"core_audit":{"executionMode":"automated","limit":null},"runtime":{"executionMode":"automated","limit":null},"seo":{"executionMode":"automated","limit":null},"geo":{"executionMode":"automated","limit":"basic"},"design":{"executionMode":"automated","limit":"basic"},"backend_surface":{"executionMode":"automated","limit":"basic"},"ai_remediation":{"executionMode":"automated","limit":100}}'::jsonb,
        true,'self_serve'
    ),
    (
        'studio','Studio',99,
        'Automated whole-site quality, advanced browser evidence and passive security for teams.',
        '{"pageCredits":150,"projects":15,"seats":5,"retentionDays":90,"sourceAudits":1,"aiRemediations":1000}'::jsonb,
        '["150 page credits / month","15 projects and 5 seats","Everything in Signal + full-site crawl","Advanced SEO/GEO, Visual UX and Performance Plus review","Passive security + 1 source audit / month","Report comparisons + shareable read-only reports","90-day report history"]'::jsonb,
        '{"core_audit":{"executionMode":"automated","limit":null},"runtime":{"executionMode":"automated","limit":null},"seo":{"executionMode":"automated","limit":null},"geo":{"executionMode":"automated","limit":"advanced"},"design":{"executionMode":"automated","limit":"advanced"},"backend_surface":{"executionMode":"automated","limit":"advanced"},"full_site_crawl":{"executionMode":"automated","limit":null},"performance_plus":{"executionMode":"automated","limit":null},"passive_security":{"executionMode":"automated","limit":null},"source_audit":{"executionMode":"automated","limit":1},"ai_remediation":{"executionMode":"automated","limit":1000}}'::jsonb,
        true,'self_serve'
    ),
    (
        'enterprise','Enterprise / Expert',349,
        'Highest-volume coverage with source, journey and signed report-webhook delivery.',
        '{"pageCredits":500,"projects":50,"seats":15,"retentionDays":365,"sourceAudits":4,"aiRemediations":5000}'::jsonb,
        '["500 page credits / month","50 projects and 15 seats","Everything in Studio + 4 source audits / month","Read-only journey tests + signed report webhooks","365-day report history + workspace support tickets"]'::jsonb,
        '{"core_audit":{"executionMode":"automated","limit":null},"runtime":{"executionMode":"automated","limit":null},"seo":{"executionMode":"automated","limit":null},"geo":{"executionMode":"automated","limit":null},"design":{"executionMode":"automated","limit":null},"backend_surface":{"executionMode":"automated","limit":null},"full_site_crawl":{"executionMode":"automated","limit":null},"performance_plus":{"executionMode":"automated","limit":null},"passive_security":{"executionMode":"automated","limit":null},"source_audit":{"executionMode":"automated","limit":null},"journey_test":{"executionMode":"automated","limit":null},"api_webhooks":{"executionMode":"automated","limit":null},"ai_remediation":{"executionMode":"automated","limit":5000}}'::jsonb,
        true,'contact'
    )
) AS source(id,name,price_usd,description,limits,features,entitlements,published,sales_mode)
WHERE catalog.id = source.id;
