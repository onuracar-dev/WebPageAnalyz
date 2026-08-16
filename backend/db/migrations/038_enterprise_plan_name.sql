BEGIN;

-- Expert Review is an explicit operator-assigned entitlement, not part of the
-- commercial plan name. Keep the durable catalog aligned with the executable
-- plan and the customer-facing pricing surface.
UPDATE wpa_plan_catalog
SET name = 'Enterprise', updated_at = now()
WHERE id = 'enterprise';

COMMIT;
