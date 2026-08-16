-- At most one provider checkout intent may be open for a workspace. Historical
-- pre-hardening intents receive a bounded lifetime before the unique index is
-- created so abandoned rows do not block checkout forever.
UPDATE wpa_checkout_acceptances
SET expires_at = accepted_at + interval '30 minutes'
WHERE expires_at IS NULL AND status IN ('accepted','checkout_created');

UPDATE wpa_checkout_acceptances
SET status = 'expired'
WHERE status IN ('accepted','checkout_created') AND expires_at <= now();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM wpa_checkout_acceptances
        WHERE status IN ('accepted','checkout_created')
        GROUP BY workspace_id HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'WPA_DUPLICATE_OPEN_CHECKOUT_INTENTS_REQUIRE_RECONCILIATION';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS wpa_checkout_one_open_intent_idx
    ON wpa_checkout_acceptances(workspace_id)
    WHERE status IN ('accepted','checkout_created');
