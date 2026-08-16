CREATE TABLE IF NOT EXISTS "user" (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false, image text, "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(), "twoFactorEnabled" boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "activeOrganizationId" text
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session ("userId");
CREATE TABLE IF NOT EXISTS account (
    id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "accessToken" text, "refreshToken" text,
    "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text,
    password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account ("userId");
CREATE TABLE IF NOT EXISTS verification (
    id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
    "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);
CREATE TABLE IF NOT EXISTS organization (
    id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
    logo text, "createdAt" timestamptz NOT NULL, metadata text
);
CREATE INDEX IF NOT EXISTS organization_slug_idx ON organization (slug);
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_active_organization_fk;
ALTER TABLE session ADD CONSTRAINT session_active_organization_fk FOREIGN KEY ("activeOrganizationId") REFERENCES organization(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS member (
    id text PRIMARY KEY, "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'member', "createdAt" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS member_organization_id_idx ON member ("organizationId");
CREATE INDEX IF NOT EXISTS member_user_id_idx ON member ("userId");
CREATE TABLE IF NOT EXISTS invitation (
    id text PRIMARY KEY, "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    email text NOT NULL, role text, status text NOT NULL DEFAULT 'pending', "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "inviterId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS invitation_organization_id_idx ON invitation ("organizationId");
CREATE INDEX IF NOT EXISTS invitation_email_idx ON invitation (email);
CREATE TABLE IF NOT EXISTS "twoFactor" (
    id text PRIMARY KEY, secret text NOT NULL, "backupCodes" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, verified boolean DEFAULT true,
    "failedVerificationCount" integer DEFAULT 0, "lockedUntil" timestamptz
);
CREATE INDEX IF NOT EXISTS two_factor_secret_idx ON "twoFactor" (secret);
CREATE INDEX IF NOT EXISTS two_factor_user_id_idx ON "twoFactor" ("userId");
