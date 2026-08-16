CREATE TABLE IF NOT EXISTS wpa_workspaces (
    id text PRIMARY KEY,
    name text NOT NULL,
    plan_id text NOT NULL DEFAULT 'signal',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_memberships (
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS wpa_projects (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    origin text NOT NULL,
    verified_at timestamptz,
    verification_method text,
    locale text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, origin)
);

CREATE TABLE IF NOT EXISTS wpa_scans (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES wpa_projects(id) ON DELETE CASCADE,
    status text NOT NULL,
    manifest jsonb NOT NULL,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_credit_entries (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    credit_key text NOT NULL,
    period_start date NOT NULL,
    state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
    amount integer NOT NULL DEFAULT 1 CHECK (amount > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scan_id, credit_key)
);

CREATE INDEX IF NOT EXISTS wpa_credit_usage_idx
    ON wpa_credit_entries (workspace_id, period_start, state);

CREATE TABLE IF NOT EXISTS wpa_analyzer_runs (
    id text PRIMARY KEY,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    analyzer_id text NOT NULL,
    analyzer_version text NOT NULL,
    status text NOT NULL,
    execution_mode text NOT NULL,
    error_code text,
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (scan_id, analyzer_id)
);

CREATE TABLE IF NOT EXISTS wpa_reports (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL,
    locale text NOT NULL,
    payload jsonb NOT NULL,
    share_token_hash text,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scan_id, version)
);

CREATE TABLE IF NOT EXISTS wpa_operator_tasks (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    scan_id text NOT NULL REFERENCES wpa_scans(id) ON DELETE CASCADE,
    module_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    due_at timestamptz,
    notes text NOT NULL DEFAULT '',
    completed_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (scan_id, module_id)
);

CREATE TABLE IF NOT EXISTS wpa_source_inputs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES wpa_projects(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('github', 'gitlab', 'bitbucket', 'zip')),
    status text NOT NULL,
    encrypted_reference text,
    purge_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_plan_overrides (
    workspace_id text NOT NULL REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    module_id text NOT NULL,
    execution_mode text NOT NULL CHECK (execution_mode IN ('automated', 'operator_assisted', 'disabled')),
    limit_value jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, module_id)
);

CREATE TABLE IF NOT EXISTS wpa_subscriptions (
    workspace_id text PRIMARY KEY REFERENCES wpa_workspaces(id) ON DELETE CASCADE,
    stripe_customer_id text UNIQUE,
    stripe_subscription_id text UNIQUE,
    stripe_price_id text,
    status text NOT NULL DEFAULT 'manual',
    current_period_end timestamptz,
    last_event_id text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpa_audit_log (
    id text PRIMARY KEY,
    workspace_id text REFERENCES wpa_workspaces(id) ON DELETE SET NULL,
    actor_id text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
