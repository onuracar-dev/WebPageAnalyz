-- Commercial authority belongs to a registered user. Workspaces remain the
-- tenant/provenance boundary and explicitly name the user whose commercial
-- profile sponsors their quota-bearing activity.

CREATE TABLE IF NOT EXISTS wpa_user_entitlement_profiles (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    plan_id text NOT NULL REFERENCES wpa_plan_catalog(id) ON DELETE RESTRICT,
    plan_source text NOT NULL DEFAULT 'system' CHECK(plan_source IN ('admin','provider','redeem','system','legacy')),
    source_id text,
    created_by text NOT NULL DEFAULT 'system:migration:036',
    updated_by text NOT NULL DEFAULT 'system:migration:036',
    reason text,
    request_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_user_plan_changes (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    before_plan_id text REFERENCES wpa_plan_catalog(id) ON DELETE RESTRICT,
    after_plan_id text NOT NULL REFERENCES wpa_plan_catalog(id) ON DELETE RESTRICT,
    source text NOT NULL DEFAULT 'admin' CHECK(source IN ('admin','provider','redeem','system','legacy')),
    source_id text,
    reason text NOT NULL,
    created_by text NOT NULL,
    request_id text,
    idempotency_key text NOT NULL,
    request_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,idempotency_key)
);

CREATE OR REPLACE FUNCTION wpa_user_plan_changes_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'WPA_USER_PLAN_CHANGES_APPEND_ONLY' USING ERRCODE='55000';
END $$;

DROP TRIGGER IF EXISTS wpa_user_plan_changes_immutable ON wpa_user_plan_changes;
CREATE TRIGGER wpa_user_plan_changes_immutable
BEFORE UPDATE OR DELETE ON wpa_user_plan_changes
FOR EACH ROW EXECUTE FUNCTION wpa_user_plan_changes_immutable();

CREATE TABLE IF NOT EXISTS wpa_commercial_ownership_migration_conflicts (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    conflict_code text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
    detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE(workspace_id,conflict_code)
);

ALTER TABLE wpa_workspaces ADD COLUMN IF NOT EXISTS entitlement_owner_user_id text;
ALTER TABLE wpa_entitlement_grants ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE wpa_credit_adjustments ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE wpa_billing_events ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE wpa_scans ADD COLUMN IF NOT EXISTS requested_by_user_id text;
ALTER TABLE wpa_scans ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_credit_entries ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_ai_usage ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_projects ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_source_inputs ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_expert_reviews ADD COLUMN IF NOT EXISTS entitlement_user_id text;
ALTER TABLE wpa_redeem_codes ADD COLUMN IF NOT EXISTS max_per_user integer;

-- A Better Auth organization owns its membership authority. Personal WPA
-- workspaces (which have no matching organization) use the mirrored owner row.
CREATE TEMP TABLE wpa_m036_owner_resolution ON COMMIT DROP AS
WITH owner_candidates AS (
    SELECT w.id AS workspace_id, m."userId" AS user_id
    FROM wpa_workspaces w
    JOIN organization o ON o.id=w.id
    JOIN member m ON m."organizationId"=w.id AND m.role='owner'
    JOIN "user" u ON u.id=m."userId"
    UNION
    SELECT w.id AS workspace_id, m.user_id
    FROM wpa_workspaces w
    JOIN wpa_memberships m ON m.workspace_id=w.id AND m.role='owner'
    JOIN "user" u ON u.id=m.user_id
    WHERE NOT EXISTS (SELECT 1 FROM organization o WHERE o.id=w.id)
), member_candidates AS (
    SELECT w.id AS workspace_id, m."userId" AS user_id
    FROM wpa_workspaces w
    JOIN organization o ON o.id=w.id
    JOIN member m ON m."organizationId"=w.id
    JOIN "user" u ON u.id=m."userId"
    UNION
    SELECT w.id AS workspace_id, m.user_id
    FROM wpa_workspaces w
    JOIN wpa_memberships m ON m.workspace_id=w.id
    JOIN "user" u ON u.id=m.user_id
    WHERE NOT EXISTS (SELECT 1 FROM organization o WHERE o.id=w.id)
), owner_resolution AS (
    SELECT w.id AS workspace_id,
           count(DISTINCT c.user_id)::integer AS owner_count,
           min(c.user_id) AS user_id
    FROM wpa_workspaces w
    LEFT JOIN owner_candidates c ON c.workspace_id=w.id
    GROUP BY w.id
), member_resolution AS (
    SELECT w.id AS workspace_id,
           count(DISTINCT c.user_id)::integer AS member_count,
           min(c.user_id) AS single_member_user_id
    FROM wpa_workspaces w
    LEFT JOIN member_candidates c ON c.workspace_id=w.id
    GROUP BY w.id
), resolved AS (
    SELECT o.workspace_id,o.owner_count,o.user_id,
           m.member_count,m.single_member_user_id
    FROM owner_resolution o
    JOIN member_resolution m ON m.workspace_id=o.workspace_id
), user_plan_counts AS (
    SELECT r.user_id,count(DISTINCT w.plan_id)::integer AS user_plan_count
    FROM resolved r
    JOIN wpa_workspaces w ON w.id=r.workspace_id
    WHERE r.owner_count=1
    GROUP BY r.user_id
)
SELECT r.workspace_id,r.owner_count,r.user_id,r.member_count,r.single_member_user_id,w.plan_id,
       COALESCE(pc.user_plan_count,0) AS user_plan_count
FROM resolved r
JOIN wpa_workspaces w ON w.id=r.workspace_id
LEFT JOIN user_plan_counts pc ON pc.user_id=r.user_id
WHERE r.owner_count<>1 OR r.user_id IS NOT NULL;

INSERT INTO wpa_commercial_ownership_migration_conflicts(id,workspace_id,conflict_code,details)
SELECT 'commercial_conflict_m036_' || md5(workspace_id || ':registered_owner'),
       workspace_id,
       CASE WHEN owner_count=0 THEN 'NO_REGISTERED_OWNER' ELSE 'MULTIPLE_REGISTERED_OWNERS' END,
       jsonb_build_object('registeredOwnerCount',owner_count)
FROM wpa_m036_owner_resolution
WHERE owner_count<>1
ON CONFLICT(workspace_id,conflict_code) DO NOTHING;

INSERT INTO wpa_commercial_ownership_migration_conflicts(id,workspace_id,conflict_code,details)
SELECT 'commercial_conflict_m036_' || md5(r.workspace_id || ':legacy_plans'),
       r.workspace_id,
       'USER_HAS_DIVERGENT_LEGACY_PLANS',
       jsonb_build_object('distinctPlanCount',r.user_plan_count)
FROM wpa_m036_owner_resolution r
WHERE r.owner_count=1 AND r.user_plan_count>1
ON CONFLICT(workspace_id,conflict_code) DO NOTHING;

INSERT INTO wpa_commercial_ownership_migration_conflicts(id,workspace_id,conflict_code,details)
SELECT 'commercial_conflict_m036_' || md5(r.workspace_id || ':unknown_plan'),
       r.workspace_id,
       'UNKNOWN_LEGACY_PLAN',
       jsonb_build_object('planId',r.plan_id)
FROM wpa_m036_owner_resolution r
LEFT JOIN wpa_plan_catalog p ON p.id=r.plan_id
WHERE r.owner_count=1 AND p.id IS NULL
ON CONFLICT(workspace_id,conflict_code) DO NOTHING;

UPDATE wpa_workspaces w
SET entitlement_owner_user_id=r.user_id
FROM wpa_m036_owner_resolution r
JOIN wpa_plan_catalog p ON p.id=r.plan_id
WHERE w.id=r.workspace_id
  AND w.entitlement_owner_user_id IS NULL
  AND r.owner_count=1
  AND r.user_plan_count=1;

INSERT INTO wpa_user_entitlement_profiles(user_id,plan_id,plan_source,reason)
SELECT DISTINCT w.entitlement_owner_user_id,w.plan_id,'legacy','Deterministic migration from legacy workspace commercial authority.'
FROM wpa_workspaces w
WHERE w.entitlement_owner_user_id IS NOT NULL
ON CONFLICT(user_id) DO NOTHING;

INSERT INTO wpa_user_plan_changes(
    id,user_id,before_plan_id,after_plan_id,source,source_id,reason,created_by,
    request_id,idempotency_key,request_fingerprint
)
SELECT 'plan_change_m036_' || md5(p.user_id),p.user_id,NULL,p.plan_id,'legacy',NULL,
       'Deterministic migration from legacy workspace commercial authority.',
       'system:migration:036','migration:036','migration:036:legacy-plan',
       md5(p.user_id || ':' || p.plan_id)
FROM wpa_user_entitlement_profiles p
ON CONFLICT(user_id,idempotency_key) DO NOTHING;

-- Redeemed grants belong to the redeemer. Other historical commercial rows
-- belong to the deterministic sponsor of their workspace.
UPDATE wpa_entitlement_grants g
SET user_id=r.user_id
FROM wpa_redeem_redemptions r
WHERE g.user_id IS NULL AND r.grant_id=g.id;

UPDATE wpa_entitlement_grants g
SET user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE g.user_id IS NULL AND g.workspace_id=w.id;

UPDATE wpa_credit_adjustments c
SET user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE c.user_id IS NULL AND c.workspace_id=w.id;

UPDATE wpa_subscriptions s
SET user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE s.user_id IS NULL AND s.workspace_id=w.id;

UPDATE wpa_billing_events e
SET user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE e.user_id IS NULL AND e.workspace_id=w.id;

UPDATE wpa_scans s
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE s.workspace_id=w.id AND s.entitlement_user_id IS NULL;

UPDATE wpa_scans s
SET requested_by_user_id=r.single_member_user_id
FROM wpa_m036_owner_resolution r
WHERE s.workspace_id=r.workspace_id
  AND s.requested_by_user_id IS NULL
  AND r.member_count=1;

UPDATE wpa_credit_entries c
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE c.entitlement_user_id IS NULL AND c.workspace_id=w.id;

UPDATE wpa_ai_usage a
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE a.entitlement_user_id IS NULL AND a.workspace_id=w.id;

UPDATE wpa_projects p
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE p.entitlement_user_id IS NULL AND p.workspace_id=w.id;

UPDATE wpa_source_inputs s
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE s.entitlement_user_id IS NULL AND s.workspace_id=w.id;

UPDATE wpa_expert_reviews e
SET entitlement_user_id=w.entitlement_owner_user_id
FROM wpa_workspaces w
WHERE e.entitlement_user_id IS NULL AND e.workspace_id=w.id;

UPDATE wpa_redeem_codes
SET max_per_user=max_per_workspace
WHERE max_per_user IS NULL;
ALTER TABLE wpa_redeem_codes ALTER COLUMN max_per_user SET DEFAULT 1;
ALTER TABLE wpa_redeem_codes ALTER COLUMN max_per_user SET NOT NULL;

DO $$
DECLARE
    unresolved_grants integer;
    unresolved_adjustments integer;
    unresolved_subscriptions integer;
    unresolved_billing_events integer;
    unresolved_pages integer;
    unresolved_scans integer;
    unresolved_ai integer;
    unresolved_projects integer;
    unresolved_sources integer;
    unresolved_reviews integer;
BEGIN
    SELECT count(*)::integer INTO unresolved_grants FROM wpa_entitlement_grants WHERE user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_adjustments FROM wpa_credit_adjustments WHERE user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_subscriptions FROM wpa_subscriptions WHERE user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_billing_events FROM wpa_billing_events WHERE user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_pages FROM wpa_credit_entries WHERE entitlement_user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_scans FROM wpa_scans WHERE entitlement_user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_ai FROM wpa_ai_usage WHERE entitlement_user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_projects FROM wpa_projects WHERE entitlement_user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_sources FROM wpa_source_inputs WHERE entitlement_user_id IS NULL;
    SELECT count(*)::integer INTO unresolved_reviews FROM wpa_expert_reviews WHERE entitlement_user_id IS NULL;
    IF unresolved_grants + unresolved_adjustments + unresolved_subscriptions + unresolved_billing_events + unresolved_pages
       + unresolved_scans + unresolved_ai + unresolved_projects + unresolved_sources
       + unresolved_reviews > 0 THEN
        RAISE EXCEPTION 'WPA_COMMERCIAL_OWNERSHIP_BACKFILL_UNRESOLVED grants=% adjustments=% subscriptions=% billing_events=% pages=% scans=% ai=% projects=% sources=% reviews=%',
            unresolved_grants,unresolved_adjustments,unresolved_subscriptions,unresolved_billing_events,unresolved_pages,
            unresolved_scans,unresolved_ai,unresolved_projects,unresolved_sources,unresolved_reviews;
    END IF;
END $$;

-- Foreign keys are added after deterministic backfill so legacy residue fails
-- before it can become accepted user authority.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_entitlement_grants_workspace_id_fkey') THEN
        ALTER TABLE wpa_entitlement_grants DROP CONSTRAINT wpa_entitlement_grants_workspace_id_fkey;
        ALTER TABLE wpa_entitlement_grants ADD CONSTRAINT wpa_entitlement_grants_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES wpa_workspaces(id) ON DELETE SET NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_credit_adjustments_workspace_id_fkey') THEN
        ALTER TABLE wpa_credit_adjustments DROP CONSTRAINT wpa_credit_adjustments_workspace_id_fkey;
        ALTER TABLE wpa_credit_adjustments ADD CONSTRAINT wpa_credit_adjustments_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES wpa_workspaces(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_workspaces_entitlement_owner_user_fk') THEN
        ALTER TABLE wpa_workspaces ADD CONSTRAINT wpa_workspaces_entitlement_owner_user_fk FOREIGN KEY(entitlement_owner_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_entitlement_grants_user_fk') THEN
        ALTER TABLE wpa_entitlement_grants ADD CONSTRAINT wpa_entitlement_grants_user_fk FOREIGN KEY(user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_credit_adjustments_user_fk') THEN
        ALTER TABLE wpa_credit_adjustments ADD CONSTRAINT wpa_credit_adjustments_user_fk FOREIGN KEY(user_id) REFERENCES "user"(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_subscriptions_user_fk') THEN
        ALTER TABLE wpa_subscriptions ADD CONSTRAINT wpa_subscriptions_user_fk FOREIGN KEY(user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_billing_events_user_fk') THEN
        ALTER TABLE wpa_billing_events ADD CONSTRAINT wpa_billing_events_user_fk FOREIGN KEY(user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_scans_requested_by_user_fk') THEN
        ALTER TABLE wpa_scans ADD CONSTRAINT wpa_scans_requested_by_user_fk FOREIGN KEY(requested_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_scans_entitlement_user_fk') THEN
        ALTER TABLE wpa_scans ADD CONSTRAINT wpa_scans_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_credit_entries_entitlement_user_fk') THEN
        ALTER TABLE wpa_credit_entries ADD CONSTRAINT wpa_credit_entries_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_ai_usage_entitlement_user_fk') THEN
        ALTER TABLE wpa_ai_usage ADD CONSTRAINT wpa_ai_usage_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_projects_entitlement_user_fk') THEN
        ALTER TABLE wpa_projects ADD CONSTRAINT wpa_projects_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_source_inputs_entitlement_user_fk') THEN
        ALTER TABLE wpa_source_inputs ADD CONSTRAINT wpa_source_inputs_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_expert_reviews_entitlement_user_fk') THEN
        ALTER TABLE wpa_expert_reviews ADD CONSTRAINT wpa_expert_reviews_entitlement_user_fk FOREIGN KEY(entitlement_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wpa_redeem_codes_max_per_user_check') THEN
        ALTER TABLE wpa_redeem_codes ADD CONSTRAINT wpa_redeem_codes_max_per_user_check CHECK(max_per_user>0);
    END IF;
END $$;

ALTER TABLE wpa_entitlement_grants ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE wpa_entitlement_grants ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE wpa_credit_adjustments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE wpa_credit_adjustments ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE wpa_subscriptions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE wpa_billing_events ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE wpa_scans ALTER COLUMN entitlement_user_id SET NOT NULL;
ALTER TABLE wpa_credit_entries ALTER COLUMN entitlement_user_id SET NOT NULL;
ALTER TABLE wpa_ai_usage ALTER COLUMN entitlement_user_id SET NOT NULL;
ALTER TABLE wpa_projects ALTER COLUMN entitlement_user_id SET NOT NULL;
ALTER TABLE wpa_source_inputs ALTER COLUMN entitlement_user_id SET NOT NULL;
ALTER TABLE wpa_expert_reviews ALTER COLUMN entitlement_user_id SET NOT NULL;

DROP INDEX IF EXISTS wpa_entitlement_grants_active_idx;
CREATE INDEX wpa_entitlement_grants_active_idx
    ON wpa_entitlement_grants(user_id,starts_at,expires_at)
    WHERE revoked_at IS NULL;
DROP INDEX IF EXISTS wpa_entitlement_grants_operation_idx;
CREATE UNIQUE INDEX wpa_entitlement_grants_operation_idx
    ON wpa_entitlement_grants(user_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS wpa_credit_adjustments_active_idx;
CREATE INDEX wpa_credit_adjustments_active_idx
    ON wpa_credit_adjustments(user_id,credit_type,expires_at)
    WHERE revoked_at IS NULL;
DROP INDEX IF EXISTS wpa_credit_adjustments_operation_idx;
CREATE UNIQUE INDEX wpa_credit_adjustments_operation_idx
    ON wpa_credit_adjustments(user_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS wpa_credit_usage_idx;
CREATE INDEX wpa_credit_usage_idx
    ON wpa_credit_entries(entitlement_user_id,period_start,state);

DROP INDEX IF EXISTS wpa_ai_usage_quota_idx;
CREATE INDEX wpa_ai_usage_quota_idx
    ON wpa_ai_usage(entitlement_user_id,created_at)
    WHERE status IN ('reserved','completed','cache_hit');
DO $$ BEGIN
    ALTER TABLE wpa_ai_usage DROP CONSTRAINT IF EXISTS wpa_ai_usage_workspace_id_idempotency_key_key;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wpa_ai_usage_operation_idx
    ON wpa_ai_usage(entitlement_user_id,idempotency_key);

DROP INDEX IF EXISTS wpa_redeem_redemptions_operation_idx;
CREATE UNIQUE INDEX wpa_redeem_redemptions_operation_idx
    ON wpa_redeem_redemptions(user_id,idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wpa_redeem_redemptions_user_idx
    ON wpa_redeem_redemptions(user_id,code_id,redeemed_at);

CREATE UNIQUE INDEX IF NOT EXISTS wpa_subscriptions_user_idx
    ON wpa_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS wpa_billing_events_user_order_idx
    ON wpa_billing_events(provider,user_id,occurred_at,event_id);
CREATE UNIQUE INDEX IF NOT EXISTS wpa_checkout_acceptances_user_operation_idx
    ON wpa_checkout_acceptances(user_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS wpa_checkout_one_open_user_intent_idx
    ON wpa_checkout_acceptances(user_id)
    WHERE status IN ('accepted','checkout_created');

CREATE INDEX IF NOT EXISTS wpa_projects_entitlement_quota_idx
    ON wpa_projects(entitlement_user_id,created_at);
CREATE INDEX IF NOT EXISTS wpa_scans_entitlement_user_idx
    ON wpa_scans(entitlement_user_id,created_at);
CREATE INDEX IF NOT EXISTS wpa_source_inputs_entitlement_quota_idx
    ON wpa_source_inputs(entitlement_user_id,created_at)
    WHERE status<>'failed';
CREATE INDEX IF NOT EXISTS wpa_expert_reviews_entitlement_quota_idx
    ON wpa_expert_reviews(entitlement_user_id,created_at)
    WHERE status<>'cancelled';

CREATE OR REPLACE FUNCTION wpa_enforce_member_seat_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    sponsor_user_id text;
    profile_plan text;
    effective_plan text;
    seat_limit integer;
    occupied integer;
BEGIN
    SELECT entitlement_owner_user_id INTO sponsor_user_id
    FROM wpa_workspaces WHERE id=NEW."organizationId";
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF sponsor_user_id IS NULL THEN
        RAISE EXCEPTION 'WORKSPACE_ENTITLEMENT_OWNER_REQUIRED' USING ERRCODE='P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('workspace-seat:' || NEW."organizationId"));
    SELECT plan_id INTO profile_plan
    FROM wpa_user_entitlement_profiles WHERE user_id=sponsor_user_id;
    IF profile_plan IS NULL THEN
        RAISE EXCEPTION 'USER_ENTITLEMENT_PROFILE_REQUIRED' USING ERRCODE='P0001';
    END IF;

    SELECT COALESCE((
        SELECT temporary_plan_id
        FROM wpa_entitlement_grants
        WHERE user_id=sponsor_user_id
          AND revoked_at IS NULL
          AND starts_at<=now()
          AND (expires_at IS NULL OR expires_at>now())
          AND temporary_plan_id IS NOT NULL
        ORDER BY CASE temporary_plan_id WHEN 'enterprise' THEN 3 WHEN 'studio' THEN 2 WHEN 'signal' THEN 1 ELSE 0 END DESC,
                 created_at DESC,id DESC
        LIMIT 1
    ),profile_plan) INTO effective_plan;

    SELECT NULLIF(limits->>'seats','')::integer INTO seat_limit
    FROM wpa_plan_catalog WHERE id=effective_plan;
    IF seat_limit IS NULL OR seat_limit<1 THEN
        RAISE EXCEPTION 'WORKSPACE_SEAT_LIMIT_UNAVAILABLE' USING ERRCODE='P0001';
    END IF;
    SELECT count(*)::integer INTO occupied
    FROM member
    WHERE "organizationId"=NEW."organizationId" AND id<>NEW.id;
    IF occupied>=seat_limit THEN
        RAISE EXCEPTION 'WORKSPACE_SEAT_LIMIT_REACHED' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
END $$;
