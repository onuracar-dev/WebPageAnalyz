-- Durable operation identities for retry-safe business mutations. Columns are
-- nullable so the migration is compatible with existing pre-hardening rows.

ALTER TABLE wpa_checkout_acceptances
    ADD COLUMN IF NOT EXISTS request_fingerprint text;

ALTER TABLE wpa_projects
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_projects_operation_idx
    ON wpa_projects(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_scans
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_scans_operation_idx
    ON wpa_scans(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_credit_adjustments
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_credit_adjustments_operation_idx
    ON wpa_credit_adjustments(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_entitlement_grants
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_entitlement_grants_operation_idx
    ON wpa_entitlement_grants(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_redeem_redemptions
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_redeem_redemptions_operation_idx
    ON wpa_redeem_redemptions(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_redeem_codes
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_redeem_codes_operation_idx
    ON wpa_redeem_codes(created_by,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_source_inputs
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_source_inputs_operation_idx
    ON wpa_source_inputs(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE wpa_support_messages
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_support_messages_operation_idx
    ON wpa_support_messages(workspace_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Better Auth's schema lacks this protection in the inherited baseline. The
-- constraint is compatible with existing rows only when no duplicates exist;
-- fail the migration rather than silently preserving ambiguous membership.
CREATE UNIQUE INDEX IF NOT EXISTS member_organization_user_idx
    ON member("organizationId","userId");

CREATE OR REPLACE FUNCTION wpa_enforce_member_seat_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    workspace_plan text;
    effective_plan text;
    seat_limit integer;
    occupied integer;
BEGIN
    -- Better Auth may create an organization before the corresponding WPA
    -- workspace exists. The application bootstrap owns that first owner row;
    -- quota enforcement begins as soon as the workspace authority exists.
    SELECT plan_id INTO workspace_plan FROM wpa_workspaces WHERE id=NEW."organizationId";
    IF workspace_plan IS NULL THEN RETURN NEW; END IF;

    PERFORM pg_advisory_xact_lock(hashtext('workspace-seat:' || NEW."organizationId"));
    SELECT COALESCE((
        SELECT temporary_plan_id
        FROM wpa_entitlement_grants
        WHERE workspace_id=NEW."organizationId"
          AND revoked_at IS NULL
          AND starts_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
          AND temporary_plan_id IS NOT NULL
        ORDER BY CASE temporary_plan_id WHEN 'enterprise' THEN 3 WHEN 'studio' THEN 2 WHEN 'signal' THEN 1 ELSE 0 END DESC,
                 created_at DESC,id DESC
        LIMIT 1
    ), workspace_plan) INTO effective_plan;
    SELECT NULLIF(limits->>'seats','')::integer INTO seat_limit
    FROM wpa_plan_catalog WHERE id=effective_plan;
    IF seat_limit IS NULL OR seat_limit < 1 THEN
        RAISE EXCEPTION 'WORKSPACE_SEAT_LIMIT_UNAVAILABLE' USING ERRCODE='P0001';
    END IF;
    SELECT count(*)::integer INTO occupied
    FROM member
    WHERE "organizationId"=NEW."organizationId" AND id<>NEW.id;
    IF occupied >= seat_limit THEN
        RAISE EXCEPTION 'WORKSPACE_SEAT_LIMIT_REACHED' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wpa_member_seat_limit ON member;
CREATE TRIGGER wpa_member_seat_limit
BEFORE INSERT OR UPDATE OF "organizationId" ON member
FOR EACH ROW EXECUTE FUNCTION wpa_enforce_member_seat_limit();
