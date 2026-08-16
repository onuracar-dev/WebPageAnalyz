const crypto = require('node:crypto');
const { Pool } = require('pg');
const { AppError } = require('../lib/errors');
const { extractApiKey, keyMatches } = require('../middleware/auth');
const { createEmailTransport } = require('./email-transport');
const { databasePoolOptions } = require('../config');
const { SIGNUP_ACCEPTANCE } = require('../domain/legal');
const { observePostgresPool } = require('../lib/postgres-pool');

function stableWorkspaceId(userId) {
    return `ws_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
}

function exactOrigin(value) {
    try { return new URL(value).origin; } catch { return null; }
}

function authTrustedOrigins(config) {
    return [...new Set([
        ...(config.corsOrigins || []),
        exactOrigin(config.appUrl),
        exactOrigin(config.auth.baseUrl)
    ].filter(Boolean))];
}

const AUTH_ENDPOINTS = Object.freeze({
    requestPasswordReset: '/api/auth/request-password-reset',
    resetPasswordCallback: '/api/auth/reset-password/:token',
    resetPassword: '/api/auth/reset-password',
    sendVerificationEmail: '/api/auth/send-verification-email',
    verifyEmail: '/api/auth/verify-email'
});

const ORGANIZATION_READ_PATHS = new Set([
    '/organization/list',
    '/organization/get-full-organization',
    '/organization/get-active-member',
    '/organization/get-active-member-role',
    '/organization/list-members',
    '/organization/list-invitations',
    '/organization/list-user-invitations',
    '/organization/get-invitation',
    '/organization/list-teams',
    '/organization/list-user-teams',
    '/organization/list-team-members',
    '/organization/has-permission',
    '/organization/check-slug',
    '/organization/get-role',
    '/organization/list-roles'
]);

function isOrganizationMutationPath(path) {
    return typeof path === 'string' && path.startsWith('/organization/') && !ORGANIZATION_READ_PATHS.has(path);
}

function isSensitiveVerificationIdentifier(identifier) {
    return typeof identifier === 'string' && identifier.startsWith('reset-password:');
}

function createAuthService(config) {
    if (!config.databaseUrl || !config.auth.secret) {
        return {
            enabled: false,
            handler: null,
            async session() { return null; },
            async reauthenticate() { throw new AppError('Better Auth re-authentication is not configured.', { status: 503, code: 'ADMIN_REAUTH_UNAVAILABLE' }); },
            async close() {}
        };
    }
    const pool = observePostgresPool(
        new Pool(databasePoolOptions(config, { max: 5, applicationName: 'webpage-analyzer-auth' })),
        { component: 'auth' }
    );
    const emailTransport = createEmailTransport({ config });
    const ready = Promise.all([
        import('better-auth'),
        import('better-auth/node'),
        import('better-auth/plugins'),
        import('@better-auth/passkey')
    ]).then(([authModule, nodeModule, pluginModule, passkeyModule]) => {
        const apiError = (status, message, code) => authModule.APIError.from(status, { message, code });
        const hashBinding = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
        const requestIdFor = (context) => context?.headers?.get?.('x-request-id') || null;
        const adminAccount = async (userId) => {
            if (!userId) return null;
            const { rows } = await pool.query('SELECT user_id AS "userId",email,role,active,security_version AS "securityVersion" FROM wpa_admin_accounts WHERE user_id=$1', [userId]);
            return rows[0] || null;
        };
        const auditSecurity = async ({ actorId, action, entityType = 'admin_account', entityId = actorId, metadata = {}, requestId = null }) => {
            await pool.query(
                `INSERT INTO wpa_audit_log(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,request_id)
                 VALUES($1,NULL,$2,$3,$4,$5,$6::jsonb,$7)`,
                [`audit_${crypto.randomUUID()}`, actorId || null, action, entityType, entityId || null, JSON.stringify(metadata), requestId]
            );
        };
        const notifySecurity = async (userId, event, idempotencyKey) => {
            try {
                const { rows } = await pool.query('SELECT email FROM "user" WHERE id=$1', [userId]);
                if (!rows[0]?.email) return { accepted: false, reason: 'recipient_missing' };
                return await emailTransport.send({ kind: 'security', to: rows[0].email, data: { event }, idempotencyKey });
            } catch (error) {
                await auditSecurity({ actorId: userId, action: 'security.notification_failed', metadata: { event, code: error?.code || 'EMAIL_UNAVAILABLE' } }).catch(() => {});
                return { accepted: false, reason: error?.code || 'EMAIL_UNAVAILABLE' };
            }
        };
        const freshAdminMarker = async ({ userId, sessionId, methods }) => {
            if (!sessionId) return null;
            const binding = hashBinding(sessionId);
            const { rows } = await pool.query(
                `SELECT m.method,m.security_version AS "securityVersion"
                 FROM wpa_admin_reauth_markers m
                 JOIN wpa_admin_accounts a ON a.user_id=m.user_id AND a.active=true
                 WHERE m.user_id=$1 AND m.session_id_hash=$2 AND m.expires_at > now()
                   AND m.security_version=a.security_version AND m.method=ANY($3::text[])`,
                [userId, binding, methods]
            );
            return rows[0] || null;
        };
        const hasRecoveryWindow = async (userId, sessionId) => {
            if (!sessionId) return false;
            const { rows } = await pool.query('SELECT 1 FROM wpa_admin_recovery_sessions WHERE user_id=$1 AND session_id_hash=$2 AND expires_at > now()', [userId, hashBinding(sessionId)]);
            return Boolean(rows[0]);
        };
        const requirePasskeyManagementAuthorization = async ({ userId, sessionId, allowBootstrap }) => {
            const admin = await adminAccount(userId);
            if (!admin?.active) return;
            const count = Number((await pool.query('SELECT count(*)::int AS count FROM passkey WHERE "userId"=$1', [userId])).rows[0]?.count || 0);
            const recovery = await hasRecoveryWindow(userId, sessionId);
            if (recovery) return;
            const methods = allowBootstrap && count === 0 ? ['password_totp', 'webauthn'] : ['webauthn'];
            if (!(await freshAdminMarker({ userId, sessionId, methods }))) {
                throw apiError('FORBIDDEN', count === 0 ? 'Re-authenticate with password and TOTP before enrolling the first passkey.' : 'Verify an existing passkey before changing WebAuthn credentials.', count === 0 ? 'ADMIN_PASSKEY_BOOTSTRAP_REAUTH_REQUIRED' : 'ADMIN_WEBAUTHN_STEP_UP_REQUIRED');
            }
        };
        const accountState = async ({ userId, email } = {}) => {
            try {
                const query = userId
                    ? ['SELECT id AS "userId", email, "accountState" AS state FROM "user" WHERE id=$1', [userId]]
                    : ['SELECT id AS "userId", email, "accountState" AS state FROM "user" WHERE lower(email)=lower($1) LIMIT 1', [String(email || '').trim()]];
                const { rows } = await pool.query(query[0], query[1]);
                return rows[0] || null;
            } catch {
                // A missing/unavailable account-state read must never turn into
                // an allow decision for a reset, verification, or auth mutation.
                throw apiError('SERVICE_UNAVAILABLE', 'Account state is temporarily unavailable.', 'ACCOUNT_STATE_UNAVAILABLE');
            }
        };
        const assertActiveAccount = async ({ userId, email } = {}) => {
            const state = await accountState({ userId, email });
            if (!state && userId) throw apiError('FORBIDDEN', 'This account is no longer available.', 'ACCOUNT_INACTIVE');
            if (state && userIsBanned(state)) throw apiError('FORBIDDEN', 'This account is banned.', 'ACCOUNT_BANNED');
            return state;
        };
        const assertActiveWorkspace = async (organizationId) => {
            if (!organizationId) return;
            let rows;
            try {
                ({ rows } = await pool.query('SELECT id AS "workspaceId",state FROM wpa_workspaces WHERE id=$1', [organizationId]));
            } catch {
                throw apiError('SERVICE_UNAVAILABLE', 'Workspace state is temporarily unavailable.', 'WORKSPACE_STATE_UNAVAILABLE');
            }
            // Better Auth can host organizations that are not platform
            // workspaces. Only enforce the suspension boundary when the ID is
            // safely identifiable in the platform workspace table.
            if (rows[0] && workspaceIsSuspended(rows[0])) throw apiError('FORBIDDEN', 'This workspace is suspended.', 'WORKSPACE_SUSPENDED');
        };
        const organizationMutation = async (context) => {
            if (!isOrganizationMutationPath(context?.path)) return;
            const organizationId = context?.body?.organizationId
                || context?.body?.organization?.id
                || context?.context?.session?.session?.activeOrganizationId;
            await assertActiveWorkspace(organizationId);
        };
        const sensitiveVerificationDelete = async (verification) => {
            if (!isSensitiveVerificationIdentifier(verification?.identifier)) return;
            // Returning false makes Better Auth's atomic consume return an
            // invalid-token result without mutating the credential or creating
            // a session. It also fails closed when the user row disappeared.
            const state = await accountState({ userId: verification?.value });
            return accountStateAllowsSensitiveMutation(state);
        };
        const socialProviders = config.auth.googleClientId && config.auth.googleClientSecret ? {
            google: { clientId: config.auth.googleClientId, clientSecret: config.auth.googleClientSecret }
        } : undefined;
        const auth = authModule.betterAuth({
            database: pool,
            secret: config.auth.secret,
            baseURL: config.auth.baseUrl,
            emailAndPassword: {
                enabled: true,
                requireEmailVerification: true,
                // Password reset is a global session boundary. Better Auth
                // owns the deletion; enabling it here avoids leaving an old
                // browser/API session alive after a reset.
                revokeSessionsOnPasswordReset: true,
                sendResetPassword: async ({ user, url }) => {
                    await assertActiveAccount({ userId: user.id });
                    return emailTransport.send({ kind: 'reset', to: user.email, url });
                }
            },
            emailVerification: {
                sendOnSignUp: true,
                autoSignInAfterVerification: true,
                sendVerificationEmail: async ({ user, url }) => {
                    await assertActiveAccount({ userId: user.id });
                    return emailTransport.send({ kind: 'verification', to: user.email, url });
                },
                // This hook runs immediately before Better Auth marks the
                // email verified and (when enabled) creates a session.
                beforeEmailVerification: async (user) => { await assertActiveAccount({ userId: user.id }); }
            },
            databaseHooks: {
                verification: {
                    delete: { before: sensitiveVerificationDelete }
                },
                session: {
                    create: {
                        after: async (session, context) => {
                            const admin = await adminAccount(session.userId);
                            if (!admin?.active) return;
                            const assertionId = context?.context?.wpaWebAuthnAssertionId || null;
                            const sessionIdHash = hashBinding(session.id || session.token);
                            if (assertionId) {
                                await pool.query(
                                    `UPDATE wpa_admin_webauthn_assertions SET session_id_hash=$3
                                     WHERE id=$1 AND user_id=$2 AND session_id_hash IS NULL AND consumed_at IS NULL AND expires_at > now()`,
                                    [assertionId, session.userId, sessionIdHash]
                                );
                            }
                            await auditSecurity({
                                actorId: session.userId,
                                action: 'security.privileged_login',
                                entityType: 'admin_session',
                                entityId: sessionIdHash,
                                requestId: requestIdFor(context),
                                metadata: { method: assertionId ? 'webauthn' : 'password_totp', role: admin.role }
                            });
                            if (!assertionId) await notifySecurity(session.userId, 'Yeni bir ayrıcalıklı yönetici oturumu açıldı', `security:login:${session.id}`);
                        }
                    }
                }
            },
            hooks: {
                before: async (context) => {
                    const path = context?.path;
                    if (path === '/request-password-reset' || path === '/send-verification-email') {
                        const email = context?.body?.email;
                        if (typeof email === 'string' && email.trim()) await assertActiveAccount({ email });
                    }
                    if (path === '/reset-password') {
                        const token = context?.body?.token || context?.query?.token;
                        if (typeof token === 'string' && token) {
                            const verification = await context.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
                            if (verification?.value) {
                                await assertActiveAccount({ userId: verification.value });
                                context.context.wpaResetUserId = verification.value;
                            }
                        }
                    }
                    await organizationMutation(context);
                },
                after: async (context) => {
                    if (context?.path !== '/reset-password' || !context?.context?.wpaResetUserId) return {};
                    const userId = context.context.wpaResetUserId;
                    const admin = await adminAccount(userId);
                    if (!admin?.active) return {};
                    await pool.query('DELETE FROM wpa_admin_reauth_markers WHERE user_id=$1', [userId]);
                    await pool.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [userId]);
                    await pool.query('UPDATE wpa_admin_accounts SET security_version=security_version+1,updated_at=now() WHERE user_id=$1', [userId]);
                    await auditSecurity({ actorId: userId, action: 'security.password_reset', entityId: userId, requestId: requestIdFor(context), metadata: { sessionsRevoked: true } });
                    await notifySecurity(userId, 'Ayrıcalıklı hesabın parolası sıfırlandı ve mevcut oturumlar iptal edildi', `security:password-reset:${userId}:${Date.now()}`);
                    return {};
                }
            },
            socialProviders,
            // Better Auth validates redirectTo/callbackURL itself. Include the
            // exact deployed app and auth origins so reset and verification
            // links cannot fail merely because CORS and auth use different
            // environment variables. No wildcard or caller-provided origin is
            // added here.
            trustedOrigins: authTrustedOrigins(config),
            plugins: [pluginModule.organization({
                organizationHooks: {
                    beforeUpdateOrganization: async ({ organization, user, member }) => {
                        await assertActiveWorkspace(organization?.id || member?.organizationId || user?.activeOrganizationId);
                    },
                    beforeDeleteOrganization: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeAddMember: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeRemoveMember: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeUpdateMemberRole: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeCreateInvitation: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeAcceptInvitation: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeRejectInvitation: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeCancelInvitation: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeCreateTeam: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeUpdateTeam: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeDeleteTeam: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeAddTeamMember: async ({ organization }) => { await assertActiveWorkspace(organization?.id); },
                    beforeRemoveTeamMember: async ({ organization }) => { await assertActiveWorkspace(organization?.id); }
                }
            }), passkeyModule.passkey({
                rpID: config.adminSecurity.rpId,
                rpName: config.adminSecurity.rpName,
                origin: authTrustedOrigins(config),
                authenticatorSelection: {
                    residentKey: 'preferred',
                    userVerification: 'required'
                },
                registration: {
                    requireSession: true,
                    afterVerification: async ({ ctx, user }) => {
                        const sessionId = ctx.context.session?.session?.id || ctx.context.session?.session?.token;
                        await requirePasskeyManagementAuthorization({ userId: user.id, sessionId, allowBootstrap: true });
                    }
                },
                authentication: {
                    afterVerification: async ({ ctx, clientData }) => {
                        const credentialId = clientData?.id;
                        const credential = credentialId
                            ? (await pool.query(
                                `SELECT p."userId" AS "userId" FROM passkey p
                                 JOIN wpa_admin_accounts a ON a.user_id=p."userId" AND a.active=true
                                 WHERE p."credentialID"=$1`,
                                [credentialId]
                            )).rows[0]
                            : null;
                        if (!credential) return;
                        const assertionId = `assertion_${crypto.randomUUID()}`;
                        await pool.query(
                            `INSERT INTO wpa_admin_webauthn_assertions(id,user_id,credential_id,ip_hash,user_agent_hash,expires_at)
                             VALUES($1,$2,$3,$4,$5,$6::timestamptz)`,
                            [
                                assertionId,
                                credential.userId,
                                credentialId,
                                hashBinding(ctx.headers?.get?.('x-forwarded-for') || ctx.headers?.get?.('cf-connecting-ip') || ''),
                                hashBinding(ctx.headers?.get?.('user-agent') || ''),
                                new Date(Date.now() + config.adminSecurity.assertionTtlMs)
                            ]
                        );
                        await pool.query('UPDATE passkey SET "lastUsedAt"=now() WHERE "credentialID"=$1', [credentialId]);
                        ctx.context.wpaWebAuthnAssertionId = assertionId;
                    }
                }
            }), pluginModule.twoFactor()]
        });
        return { auth, nodeModule, handler: nodeModule.toNodeHandler(auth) };
    });
    return {
        enabled: true,
        async handler(request, response) { return (await ready).handler(request, response); },
        async session(request) {
            const { auth, nodeModule } = await ready;
            return auth.api.getSession({ headers: nodeModule.fromNodeHeaders(request.headers) });
        },
        async reauthenticate(request, { password, totpCode }) {
            const { auth, nodeModule } = await ready;
            const headers = nodeModule.fromNodeHeaders(request.headers);
            const passwordResult = await auth.api.verifyPassword({
                headers,
                body: { password }
            });
            const twoFactorResult = await auth.api.verifyTOTP({
                headers,
                body: { code: totpCode, trustDevice: false }
            });
            return { password: passwordResult, twoFactor: twoFactorResult, status: true };
        },
        async close() { await pool.end(); }
    };
}

function userIsBanned(state) {
    return state?.banned === true || state?.state === 'banned' || state?.status === 'banned';
}

function accountStateAllowsSensitiveMutation(state) {
    return Boolean(state) && !userIsBanned(state);
}

function workspaceIsSuspended(state) {
    return state?.suspended === true || state?.state === 'suspended' || state?.status === 'suspended';
}

function platformIdentity({ config, authService, store, requireVerifiedEmail = true, requireLegalAcceptance = true }) {
    return async (request, _response, next) => {
        try {
            const session = await authService.session(request);
            if (session?.user?.id) {
                const userState = await store.getUserState?.(session.user.id);
                if (userIsBanned(userState)) throw new AppError('This account is banned.', { status: 403, code: 'ACCOUNT_BANNED' });
                if (requireVerifiedEmail && config.nodeEnv === 'production' && session.user.emailVerified !== true) throw new AppError('Verify your email address before accessing the workspace.', { status: 403, code: 'EMAIL_VERIFICATION_REQUIRED' });
                const organizationId = session.session?.activeOrganizationId || null;
                const workspaceId = organizationId || stableWorkspaceId(session.user.id);
                await store.ensureWorkspace(workspaceId, {
                    name: session.user.name ? `${session.user.name}'s workspace` : 'My workspace',
                    entitlementOwnerUserId: organizationId ? null : session.user.id
                });
                const workspaceState = await store.getWorkspaceState?.(workspaceId);
                if (workspaceIsSuspended(workspaceState)) throw new AppError('This workspace is suspended.', { status: 423, code: 'WORKSPACE_SUSPENDED' });
                if (requireLegalAcceptance && config.nodeEnv === 'production' && typeof store.hasCurrentLegalAcceptance === 'function') {
                    const accepted = await store.hasCurrentLegalAcceptance(session.user.id, workspaceId, [
                        { documentType: 'terms', documentVersion: SIGNUP_ACCEPTANCE.termsVersion, purpose: 'signup' },
                        { documentType: 'acceptable_use', documentVersion: SIGNUP_ACCEPTANCE.acceptableUseVersion, purpose: 'signup' }
                    ]);
                    if (!accepted) throw new AppError('Accept the current Terms of Service and Acceptable Use Policy before continuing.', { status: 428, code: 'LEGAL_ACCEPTANCE_REQUIRED' });
                }
                request.platformIdentity = { userId: session.user.id, workspaceId, session };
                return next();
            }
            const candidate = extractApiKey(request);
            if (candidate) {
                if (!keyMatches(candidate, config.apiKeys)) return next(new AppError('A valid API key is required.', { status: 401, code: 'AUTHENTICATION_REQUIRED' }));
                const apiKeyId = crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 16);
                const workspaceId = `ws_api_${apiKeyId}`;
                await store.ensureWorkspace(workspaceId, { name: 'API workspace' });
                request.apiKeyId = apiKeyId;
                request.platformIdentity = { userId: `api_${apiKeyId}`, workspaceId, session: null };
                return next();
            }
            if (config.nodeEnv !== 'production') {
                const workspaceId = request.get('x-workspace-id')?.slice(0, 128) || config.demoWorkspaceId;
                await store.ensureWorkspace(workspaceId, { name: 'Development workspace' });
                request.platformIdentity = { userId: 'development-user', workspaceId, session: null };
                return next();
            }
            return next(new AppError('Sign in to access this workspace.', { status: 401, code: 'AUTHENTICATION_REQUIRED' }));
        } catch (error) {
            return next(error);
        }
    };
}

function blockBannedEmailSignIn({ store }) {
    return async (request, _response, next) => {
        try {
            if (request.path !== '/sign-in/email' || typeof request.body?.email !== 'string' || typeof store.getUserStateByEmail !== 'function') return next();
            const state = await store.getUserStateByEmail(request.body.email.trim().toLowerCase());
            if (userIsBanned(state)) return next(new AppError('This account is banned.', { status: 403, code: 'ACCOUNT_BANNED' }));
            return next();
        } catch (error) { return next(error); }
    };
}

function requireTrustedMutationOrigin(config, authService = null) {
    const trusted = new Set(config.corsOrigins.map((origin) => new URL(origin).origin));
    trusted.add(new URL(config.auth.baseUrl).origin);
    trusted.add(new URL(config.appUrl).origin);
    return async (request, _response, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
        const origin = request.get('origin');
        if (origin && trusted.has(origin)) return next();
        if (!origin && config.nodeEnv !== 'production') return next();
        const candidate = extractApiKey(request);
        if (candidate && keyMatches(candidate, config.apiKeys)) {
            try {
                const session = await authService?.session?.(request);
                if (!session?.user?.id) {
                    request.verifiedApiKeyIdentity = true;
                    return next();
                }
            } catch (error) {
                return next(error);
            }
        }
        return next(new AppError('The request origin is not trusted.', { status: 403, code: 'UNTRUSTED_MUTATION_ORIGIN' }));
    };
}

function requirePlatformAdmin({ config, authService, store }) {
    return require('./security').requireSecurePlatformAdmin({ config, authService, store });
}

module.exports = { AUTH_ENDPOINTS, accountStateAllowsSensitiveMutation, authTrustedOrigins, blockBannedEmailSignIn, createAuthService, isOrganizationMutationPath, isSensitiveVerificationIdentifier, platformIdentity, requirePlatformAdmin, requireTrustedMutationOrigin, stableWorkspaceId, userIsBanned, workspaceIsSuspended };
