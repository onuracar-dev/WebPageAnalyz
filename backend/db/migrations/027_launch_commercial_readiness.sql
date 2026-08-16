-- Launch commercial/data authority. Runtime wiring is intentionally kept in
-- application services; this migration is rerunnable under the migration job.

ALTER TABLE wpa_workspaces ALTER COLUMN plan_id SET DEFAULT 'free';
ALTER TABLE wpa_workspaces ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';
ALTER TABLE wpa_workspaces ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE wpa_workspaces ADD COLUMN IF NOT EXISTS suspended_by text;
ALTER TABLE wpa_workspaces ADD COLUMN IF NOT EXISTS suspension_reason text;
DO $$ BEGIN
    ALTER TABLE wpa_workspaces ADD CONSTRAINT wpa_workspaces_state_check CHECK (state IN ('active','suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "accountState" text NOT NULL DEFAULT 'active';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stateChangedAt" timestamptz;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stateChangedBy" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stateReason" text;
DO $$ BEGIN
    ALTER TABLE "user" ADD CONSTRAINT user_account_state_check CHECK ("accountState" IN ('active','banned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION wpa_reject_inactive_user_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "user" WHERE id=NEW."userId" AND "accountState" <> 'active') THEN
        RAISE EXCEPTION 'USER_ACCOUNT_INACTIVE' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wpa_session_active_user_only ON session;
CREATE TRIGGER wpa_session_active_user_only
BEFORE INSERT OR UPDATE OF "userId" ON session
FOR EACH ROW EXECUTE FUNCTION wpa_reject_inactive_user_session();

ALTER TABLE wpa_plan_catalog ADD COLUMN IF NOT EXISTS sales_mode text NOT NULL DEFAULT 'self_serve';
DO $$ BEGIN
    ALTER TABLE wpa_plan_catalog ADD CONSTRAINT wpa_plan_catalog_sales_mode_check CHECK (sales_mode IN ('internal','self_serve','contact','invite_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO wpa_plan_catalog(id,name,price_usd,description,limits,features,entitlements,published,sales_mode)
VALUES(
    'free','Free',0,
    'A bounded workspace for evaluating the core audit and remediation workflow.',
    '{"pageCredits":5,"projects":1,"seats":1,"retentionDays":7,"sourceAudits":0,"aiRemediations":5}'::jsonb,
    '["5 page credits / month","1 project and 1 seat","Core browser, SEO/GEO, design and backend-surface evidence","5 AI remediation generations / month","7-day report history"]'::jsonb,
    '{"core_audit":{"executionMode":"automated"},"runtime":{"executionMode":"automated","limit":"basic"},"seo":{"executionMode":"automated","limit":"basic"},"geo":{"executionMode":"automated","limit":"basic"},"design":{"executionMode":"automated","limit":"basic"},"backend_surface":{"executionMode":"automated","limit":"basic"},"ai_remediation":{"executionMode":"automated","limit":5}}'::jsonb,
    false,'internal'
)
ON CONFLICT(id) DO UPDATE SET
    name=EXCLUDED.name,price_usd=EXCLUDED.price_usd,description=EXCLUDED.description,
    limits=EXCLUDED.limits,features=EXCLUDED.features,entitlements=EXCLUDED.entitlements,
    published=EXCLUDED.published,sales_mode=EXCLUDED.sales_mode,updated_at=now();

UPDATE wpa_plan_catalog SET
    limits=limits || jsonb_build_object('aiRemediations', CASE id WHEN 'signal' THEN 100 WHEN 'studio' THEN 1000 WHEN 'enterprise' THEN 5000 END),
    entitlements=entitlements || jsonb_build_object('ai_remediation', jsonb_build_object('executionMode','automated','limit',CASE id WHEN 'signal' THEN 100 WHEN 'studio' THEN 1000 WHEN 'enterprise' THEN 5000 END)),
    sales_mode=CASE id WHEN 'enterprise' THEN 'contact' ELSE 'self_serve' END,
    published=true,
    updated_at=now()
WHERE id IN ('signal','studio','enterprise');

ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe';
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS external_customer_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS external_subscription_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS external_product_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS external_price_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS billing_plan_id text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS payment_status text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS refund_status text;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS access_state text NOT NULL DEFAULT 'free';
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS cancel_at timestamptz;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS scheduled_change jsonb;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE wpa_subscriptions ADD COLUMN IF NOT EXISTS last_event_occurred_at timestamptz;
DO $$ BEGIN
    ALTER TABLE wpa_subscriptions ADD CONSTRAINT wpa_subscriptions_access_state_check CHECK (access_state IN ('paid','grace','free'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE wpa_subscriptions SET
    external_customer_id=COALESCE(external_customer_id,stripe_customer_id),
    external_subscription_id=COALESCE(external_subscription_id,stripe_subscription_id),
    external_price_id=COALESCE(external_price_id,stripe_price_id)
WHERE provider='stripe';
CREATE UNIQUE INDEX IF NOT EXISTS wpa_subscriptions_provider_external_idx
    ON wpa_subscriptions(provider,external_subscription_id) WHERE external_subscription_id IS NOT NULL;

ALTER TABLE wpa_billing_events ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe';
ALTER TABLE wpa_billing_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE wpa_billing_events ADD COLUMN IF NOT EXISTS error_code text;
CREATE INDEX IF NOT EXISTS wpa_billing_events_provider_order_idx
    ON wpa_billing_events(provider,workspace_id,occurred_at,event_id);

CREATE TABLE IF NOT EXISTS wpa_checkout_acceptances (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    plan_id text NOT NULL,
    provider text NOT NULL,
    catalog_version text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
    terms_version text NOT NULL,
    refund_policy_version text NOT NULL,
    request_id text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','checkout_created','completed','expired','cancelled')),
    provider_checkout_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
    accepted_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS wpa_checkout_acceptances_workspace_idx ON wpa_checkout_acceptances(workspace_id,accepted_at DESC);

CREATE TABLE IF NOT EXISTS wpa_legal_acceptances (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    workspace_id text REFERENCES wpa_workspaces(id) ON DELETE SET NULL,
    document_type text NOT NULL CHECK (document_type IN ('terms','aup','refund','target_authorization')),
    document_version text NOT NULL,
    purpose text NOT NULL,
    request_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
    accepted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,workspace_id,document_type,document_version,purpose)
);

CREATE TABLE IF NOT EXISTS wpa_target_authorizations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    project_id text REFERENCES wpa_projects(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    origin text NOT NULL,
    attestation_version text NOT NULL,
    authorization_basis text NOT NULL,
    request_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
    accepted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_target_authorizations_project_idx ON wpa_target_authorizations(workspace_id,project_id,accepted_at DESC);

CREATE TABLE IF NOT EXISTS wpa_redeem_codes (
    id text PRIMARY KEY,
    code_hash bytea NOT NULL,
    code_salt bytea NOT NULL,
    code_hint text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    starts_at timestamptz,
    expires_at timestamptz,
    max_global_redemptions integer CHECK (max_global_redemptions IS NULL OR max_global_redemptions > 0),
    max_per_workspace integer NOT NULL DEFAULT 1 CHECK (max_per_workspace > 0),
    temporary_plan_id text,
    duration_days integer CHECK (duration_days IS NULL OR duration_days > 0),
    bonus_page_credits integer NOT NULL DEFAULT 0 CHECK (bonus_page_credits >= 0),
    bonus_ai_credits integer NOT NULL DEFAULT 0 CHECK (bonus_ai_credits >= 0),
    entitlement_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlement_overrides)='object'),
    admin_note text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz,
    disabled_by text,
    revoked_at timestamptz,
    revoked_by text
);
CREATE INDEX IF NOT EXISTS wpa_redeem_codes_verify_idx ON wpa_redeem_codes(active,code_hint);

CREATE TABLE IF NOT EXISTS wpa_entitlement_grants (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source IN ('redeem','admin','system')),
    source_id text,
    temporary_plan_id text,
    entitlement_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlement_overrides)='object'),
    bonus_page_credits integer NOT NULL DEFAULT 0,
    bonus_ai_credits integer NOT NULL DEFAULT 0,
    reason text NOT NULL,
    created_by text NOT NULL,
    starts_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text
);
CREATE INDEX IF NOT EXISTS wpa_entitlement_grants_active_idx ON wpa_entitlement_grants(workspace_id,starts_at,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS wpa_redeem_redemptions (
    id text PRIMARY KEY,
    code_id text NOT NULL REFERENCES wpa_redeem_codes(id),
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    grant_id text NOT NULL REFERENCES wpa_entitlement_grants(id) ON DELETE RESTRICT,
    request_id text,
    redeemed_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text
);
CREATE INDEX IF NOT EXISTS wpa_redeem_redemptions_code_idx ON wpa_redeem_redemptions(code_id,redeemed_at);
CREATE INDEX IF NOT EXISTS wpa_redeem_redemptions_workspace_idx ON wpa_redeem_redemptions(workspace_id,code_id,redeemed_at);

CREATE TABLE IF NOT EXISTS wpa_credit_adjustments (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    credit_type text NOT NULL CHECK (credit_type IN ('page','ai')),
    amount integer NOT NULL CHECK (amount <> 0),
    reason text NOT NULL,
    created_by text NOT NULL,
    request_id text,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text
);
CREATE INDEX IF NOT EXISTS wpa_credit_adjustments_active_idx ON wpa_credit_adjustments(workspace_id,credit_type,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS wpa_ai_usage (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    finding_fingerprint text NOT NULL,
    requested_model text NOT NULL,
    actual_model text,
    provider text NOT NULL,
    prompt_version text NOT NULL,
    evidence_version text NOT NULL,
    idempotency_key text NOT NULL,
    usage_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage_metadata)='object'),
    cost_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cost_metadata)='object'),
    status text NOT NULL CHECK (status IN ('reserved','completed','failed','cache_hit')),
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS wpa_ai_usage_quota_idx ON wpa_ai_usage(workspace_id,created_at) WHERE status IN ('reserved','completed','cache_hit');

CREATE TABLE IF NOT EXISTS wpa_ai_cache (
    cache_key text NOT NULL,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    finding_fingerprint text NOT NULL,
    prompt_version text NOT NULL,
    model_version text NOT NULL,
    evidence_version text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    PRIMARY KEY(workspace_id,cache_key)
);
CREATE INDEX IF NOT EXISTS wpa_ai_cache_workspace_idx ON wpa_ai_cache(workspace_id,finding_fingerprint);

ALTER TABLE wpa_audit_log ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE wpa_audit_log ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE wpa_audit_log ADD COLUMN IF NOT EXISTS before_state jsonb;
ALTER TABLE wpa_audit_log ADD COLUMN IF NOT EXISTS after_state jsonb;
DO $$ BEGIN
    ALTER TABLE wpa_audit_log ADD CONSTRAINT wpa_audit_metadata_object_check CHECK (jsonb_typeof(metadata)='object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wpa_audit_log_action_created_idx ON wpa_audit_log(action,created_at DESC);
CREATE INDEX IF NOT EXISTS wpa_audit_log_request_idx ON wpa_audit_log(request_id) WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION wpa_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Preserve historical audit rows when workspace deletion invokes the
    -- existing ON DELETE SET NULL foreign-key action. No other mutation is allowed.
    IF TG_OP='UPDATE' AND OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS NULL
       AND ROW(OLD.id,OLD.actor_id,OLD.action,OLD.entity_type,OLD.entity_id,OLD.metadata,OLD.created_at,OLD.reason,OLD.request_id,OLD.before_state,OLD.after_state)
           IS NOT DISTINCT FROM
           ROW(NEW.id,NEW.actor_id,NEW.action,NEW.entity_type,NEW.entity_id,NEW.metadata,NEW.created_at,NEW.reason,NEW.request_id,NEW.before_state,NEW.after_state) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'WPA_AUDIT_LOG_IMMUTABLE' USING ERRCODE='42501';
END $$;
DROP TRIGGER IF EXISTS wpa_audit_log_immutable ON wpa_audit_log;
CREATE TRIGGER wpa_audit_log_immutable BEFORE UPDATE OR DELETE ON wpa_audit_log
FOR EACH ROW EXECUTE FUNCTION wpa_audit_immutable();

ALTER TABLE wpa_rate_limit_buckets ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'legacy';
DO $$ BEGIN
    ALTER TABLE wpa_rate_limit_buckets DROP CONSTRAINT wpa_rate_limit_buckets_pkey;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE wpa_rate_limit_buckets ADD CONSTRAINT wpa_rate_limit_buckets_pkey PRIMARY KEY(namespace,key);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wpa_rate_limit_buckets_namespace_updated_idx ON wpa_rate_limit_buckets(namespace,updated_at);
