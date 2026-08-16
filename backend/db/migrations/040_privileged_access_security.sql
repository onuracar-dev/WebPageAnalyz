BEGIN;

-- Preserve the existing operator accounts while moving the public role model
-- to the canonical moderator name.
ALTER TABLE wpa_admin_accounts DROP CONSTRAINT IF EXISTS wpa_admin_accounts_role_check;
UPDATE wpa_admin_accounts SET role='moderator',updated_at=now() WHERE role='operator';
ALTER TABLE wpa_admin_accounts
    ADD CONSTRAINT wpa_admin_accounts_role_check
    CHECK (role IN ('super_admin','admin','moderator','support'));
ALTER TABLE wpa_admin_accounts
    ADD COLUMN IF NOT EXISTS security_version bigint NOT NULL DEFAULT 1;

-- Official @better-auth/passkey model. Public keys and counters are verifier
-- material, never private credential secrets.
CREATE TABLE IF NOT EXISTS passkey (
    id text PRIMARY KEY,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "credentialID" text NOT NULL,
    counter integer NOT NULL DEFAULT 0 CHECK (counter >= 0),
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL DEFAULT false,
    transports text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    aaguid text,
    "lastUsedAt" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS passkey_credential_id_unique ON passkey ("credentialID");
CREATE INDEX IF NOT EXISTS passkey_user_id_idx ON passkey ("userId");

ALTER TABLE wpa_admin_reauth_markers
    ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'password_totp',
    ADD COLUMN IF NOT EXISTS security_version bigint NOT NULL DEFAULT 1;
ALTER TABLE wpa_admin_reauth_markers DROP CONSTRAINT IF EXISTS wpa_admin_reauth_method_check;
ALTER TABLE wpa_admin_reauth_markers
    ADD CONSTRAINT wpa_admin_reauth_method_check CHECK (method IN ('password_totp','webauthn'));

-- A verified WebAuthn assertion is briefly staged by the official plugin and
-- bound to the exact newly-created Better Auth session before it may become a
-- privileged step-up marker.
CREATE TABLE IF NOT EXISTS wpa_admin_webauthn_assertions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    credential_id text NOT NULL REFERENCES passkey("credentialID") ON DELETE CASCADE,
    ip_hash text NOT NULL,
    user_agent_hash text NOT NULL,
    session_id_hash text,
    verified_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (expires_at > verified_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS wpa_admin_webauthn_assertion_session_unique
    ON wpa_admin_webauthn_assertions(session_id_hash)
    WHERE session_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS wpa_admin_webauthn_assertion_pending_idx
    ON wpa_admin_webauthn_assertions(user_id,ip_hash,user_agent_hash,verified_at DESC)
    WHERE session_id_hash IS NULL AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS wpa_admin_recovery_codes (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    batch_id text NOT NULL,
    code_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at timestamptz
);
CREATE INDEX IF NOT EXISTS wpa_admin_recovery_codes_user_idx
    ON wpa_admin_recovery_codes(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS wpa_admin_recovery_sessions (
    session_id_hash text NOT NULL,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (session_id_hash,user_id),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS wpa_admin_recovery_sessions_expiry_idx
    ON wpa_admin_recovery_sessions(expires_at);

-- Direct SQL and cascading user deletion receive a second line of defence.
-- Runtime role changes additionally lock the full privileged set, which closes
-- the concurrent two-downgrade race under READ COMMITTED.
CREATE OR REPLACE FUNCTION wpa_preserve_last_super_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.active AND OLD.role='super_admin' THEN
        IF TG_OP='DELETE' THEN
            IF NOT EXISTS (
                SELECT 1 FROM wpa_admin_accounts
                WHERE user_id <> OLD.user_id AND active AND role='super_admin'
            ) THEN
                RAISE EXCEPTION 'LAST_SUPER_ADMIN_REQUIRED' USING ERRCODE='23514';
            END IF;
        ELSIF (NOT NEW.active OR NEW.role <> 'super_admin')
          AND NOT EXISTS (
              SELECT 1 FROM wpa_admin_accounts
              WHERE user_id <> OLD.user_id AND active AND role='super_admin'
          ) THEN
            RAISE EXCEPTION 'LAST_SUPER_ADMIN_REQUIRED' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS wpa_preserve_last_super_admin ON wpa_admin_accounts;
CREATE TRIGGER wpa_preserve_last_super_admin
BEFORE UPDATE OF role,active OR DELETE ON wpa_admin_accounts
FOR EACH ROW EXECUTE FUNCTION wpa_preserve_last_super_admin();

COMMIT;
