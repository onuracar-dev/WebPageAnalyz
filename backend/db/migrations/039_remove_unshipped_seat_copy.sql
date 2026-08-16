BEGIN;

-- The backend retains bounded seat limits for authorization, but the launch
-- portal does not yet ship a customer member/invitation workflow. Do not sell
-- that absent workflow in the customer-facing feature register.
UPDATE wpa_plan_catalog
SET features = jsonb_set(features, '{1}', to_jsonb(CASE id
    WHEN 'free' THEN '1 project'
    WHEN 'signal' THEN '3 projects'
    WHEN 'studio' THEN '15 projects'
    WHEN 'enterprise' THEN '50 projects'
END::text)),
    updated_at = now()
WHERE id IN ('free', 'signal', 'studio', 'enterprise')
  AND jsonb_typeof(features) = 'array'
  AND jsonb_array_length(features) > 1;

COMMIT;
