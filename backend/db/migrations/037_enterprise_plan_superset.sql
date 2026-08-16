-- The public contract says Enterprise includes everything in Studio. Keep the
-- durable catalog aligned with the executable plan and preserve Studio's
-- advanced browser-analysis depth while adding Enterprise-only capabilities.
UPDATE wpa_plan_catalog
SET entitlements = '{
  "core_audit":{"executionMode":"automated","limit":null},
  "runtime":{"executionMode":"automated","limit":null},
  "seo":{"executionMode":"automated","limit":null},
  "geo":{"executionMode":"automated","limit":"advanced"},
  "design":{"executionMode":"automated","limit":"advanced"},
  "backend_surface":{"executionMode":"automated","limit":"advanced"},
  "full_site_crawl":{"executionMode":"automated","limit":null},
  "performance_plus":{"executionMode":"automated","limit":null},
  "passive_security":{"executionMode":"automated","limit":null},
  "source_audit":{"executionMode":"automated","limit":4},
  "journey_test":{"executionMode":"automated","limit":null},
  "api_webhooks":{"executionMode":"automated","limit":null},
  "ai_remediation":{"executionMode":"automated","limit":5000}
}'::jsonb,
updated_at = now()
WHERE id = 'enterprise';
