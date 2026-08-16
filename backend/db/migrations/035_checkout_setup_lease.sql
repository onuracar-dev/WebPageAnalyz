-- Fence provider checkout setup without making an ambiguous provider outcome
-- permanently unretryable. The provider call uses its own stable idempotency
-- identity; this bounded lease prevents concurrent callers from invoking it at
-- the same time while allowing a later recovery attempt after failure/crash.

ALTER TABLE wpa_checkout_acceptances
    ADD COLUMN IF NOT EXISTS setup_lease_owner text,
    ADD COLUMN IF NOT EXISTS setup_lease_token text,
    ADD COLUMN IF NOT EXISTS setup_lease_expires_at timestamptz;
