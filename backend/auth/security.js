const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { getPlan } = require('../domain/plans');
const { isAdminGrantableModule } = require('../domain/admin-entitlements');
const {
    canonicalAdminRole,
    hasAdminPermission,
    permissionsForRole,
    resolveAdminRoutePolicy
} = require('./admin-policy');

function timestampMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : NaN;
}

function sessionBinding(session) {
    const sessionIdentifier = session?.session?.id || session?.session?.token;
    if (!sessionIdentifier) return null;
    return crypto.createHash('sha256').update(String(sessionIdentifier)).digest('hex');
}

function hasRecentReauthentication(marker, maxAgeMs, now = Date.now(), sessionLifetime = false) {
    const verifiedAt = timestampMs(marker?.verifiedAt);
    const expiresAt = timestampMs(marker?.expiresAt);
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) return false;
    const age = now - verifiedAt;
    return age >= 0 && (sessionLifetime || age <= maxAgeMs) && now < expiresAt;
}

function reauthenticationMatchesPolicy(marker, {
    maxAgeMs,
    now = Date.now(),
    sessionLifetime = false,
    requiredMethod = null,
    securityVersion = null
}) {
    if (!hasRecentReauthentication(marker, maxAgeMs, now, sessionLifetime)) return false;
    if (requiredMethod && marker?.method !== requiredMethod) return false;
    if (securityVersion != null && Number(marker?.securityVersion) !== Number(securityVersion)) return false;
    return true;
}

function roleRequiresWebAuthn(config, role) {
    return Boolean(config.adminSecurity?.webAuthnRequired)
        && (config.adminSecurity?.privilegedRoles || []).includes(canonicalAdminRole(role));
}

function adminReauthenticationExpiresAt(session, config, verifiedAt) {
    if (!config.adminReauthSessionLifetime) return new Date(verifiedAt.getTime() + config.adminReauthMaxAgeMs);
    const sessionExpiresAt = timestampMs(session?.session?.expiresAt);
    if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= verifiedAt.getTime()) {
        throw new AppError('The active administrator session has no usable expiration boundary.', { status: 503, code: 'ADMIN_REAUTH_UNAVAILABLE' });
    }
    return new Date(sessionExpiresAt);
}

async function getAdminAccessStatus({ config, authService, store, request }) {
    const session = await authService.session(request);
    if (!session?.user?.id) {
        return { authenticated: false, administrator: false, emailVerified: false, twoFactorEnabled: false, reauthenticated: false, reauthRequired: false, webAuthnRequired: false, webAuthnCredentialCount: 0, webAuthnEnrollmentRequired: false, role: null };
    }
    const account = await store.getAdminAccount(session.user.id);
    const identityMatches = Boolean(account?.active)
        && String(account.email).toLowerCase() === String(session.user.email || '').toLowerCase();
    const emailVerified = session.user.emailVerified === true;
    const twoFactorEnabled = session.user.twoFactorEnabled === true;
    const role = identityMatches ? canonicalAdminRole(account.role) : null;
    const binding = identityMatches ? sessionBinding(session) : null;
    const marker = identityMatches && binding && typeof store.getAdminReauthentication === 'function'
        ? await store.getAdminReauthentication(binding, session.user.id)
        : null;
    const reauthenticated = reauthenticationMatchesPolicy(marker, {
        maxAgeMs: config.adminReauthMaxAgeMs,
        sessionLifetime: config.adminReauthSessionLifetime,
        securityVersion: account?.securityVersion ?? 1
    });
    const webAuthnCredentialCount = identityMatches && typeof store.countUserPasskeys === 'function'
        ? await store.countUserPasskeys(session.user.id)
        : 0;
    const webAuthnRequired = roleRequiresWebAuthn(config, role);
    return {
        authenticated: true,
        administrator: identityMatches,
        emailVerified,
        twoFactorEnabled,
        reauthenticated,
        reauthRequired: identityMatches && emailVerified && twoFactorEnabled && !reauthenticated,
        webAuthnRequired,
        webAuthnCredentialCount,
        webAuthnEnrollmentRequired: webAuthnRequired && webAuthnCredentialCount < (config.adminSecurity?.minimumCredentialCount || 1),
        recommendedWebAuthnCredentialCount: config.adminSecurity?.recommendedCredentialCount || 2,
        role
    };
}

async function recordFailedAdminReauthentication({ store, session, requestId, binding }) {
    if (typeof store.logAudit !== 'function') return;
    try {
        await store.logAudit({
            workspaceId: null,
            actorId: session?.user?.id || null,
            action: 'security.step_up_failed',
            entityType: 'admin_session',
            entityId: binding || null,
            metadata: { reason: 'credential_verification_failed', requestId }
        });
    } catch {
        // Authentication remains fail-closed if audit persistence is unavailable.
    }
}

function requireSecurePlatformAdmin({ config, authService, store }) {
    return async (request, response, next) => {
        try {
            if (request.adminIdentity) return next();
            const session = await authService.session(request);
            if (!session?.user?.id) {
                response.setHeader('WWW-Authenticate', 'Session realm="webpage-analyzer-admin"');
                return next(new AppError('Administrator sign-in is required.', { status: 401, code: 'ADMIN_AUTHENTICATION_REQUIRED' }));
            }
            if (session.user.emailVerified !== true) {
                return next(new AppError('A verified email address is required for administrator access.', { status: 403, code: 'ADMIN_EMAIL_UNVERIFIED' }));
            }

            const account = await store.getAdminAccount(session.user.id);
            if (!account?.active) return next(new AppError('This account has no active administrator role.', { status: 403, code: 'ADMIN_ROLE_REQUIRED' }));
            if (String(account.email).toLowerCase() !== String(session.user.email || '').toLowerCase()) {
                return next(new AppError('The administrator identity does not match the account record.', { status: 403, code: 'ADMIN_IDENTITY_MISMATCH' }));
            }
            if (session.user.twoFactorEnabled !== true) {
                return next(new AppError('Two-factor authentication is required for administrator access.', { status: 403, code: 'ADMIN_2FA_REQUIRED' }));
            }
            const role = canonicalAdminRole(account.role);
            if (!role) return next(new AppError('The administrator role is not recognized by the current policy.', { status: 403, code: 'ADMIN_ROLE_INVALID' }));
            const binding = sessionBinding(session);
            const webAuthnCredentialCount = typeof store.countUserPasskeys === 'function'
                ? await store.countUserPasskeys(session.user.id)
                : 0;
            const webAuthnRequired = roleRequiresWebAuthn(config, role);
            await store.touchAdminAccount(session.user.id);
            request.adminSessionId = session.session?.id || null;
            request.adminIdentity = {
                actorId: session.user.id,
                email: String(session.user.email).toLowerCase(),
                role,
                permissions: permissionsForRole(role),
                securityVersion: Number(account.securityVersion || 1),
                sessionBinding: binding,
                webAuthnRequired,
                webAuthnCredentialCount,
                webAuthnEnrollmentRequired: webAuthnRequired && webAuthnCredentialCount < (config.adminSecurity?.minimumCredentialCount || 1),
                recommendedWebAuthnCredentialCount: config.adminSecurity?.recommendedCredentialCount || 2,
                via: 'session'
            };
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

function requireAdminReauthentication({ config, authService, store }) {
    return async (request, _response, next) => {
        try {
            const session = await authService.session(request);
            if (!session?.user?.id) return next(new AppError('Administrator sign-in is required.', { status: 401, code: 'ADMIN_AUTHENTICATION_REQUIRED' }));
            if (session.user.emailVerified !== true) return next(new AppError('A verified email address is required for administrator access.', { status: 403, code: 'ADMIN_EMAIL_UNVERIFIED' }));

            const account = await store.getAdminAccount(session.user.id);
            if (!account?.active) return next(new AppError('This account has no active administrator role.', { status: 403, code: 'ADMIN_ROLE_REQUIRED' }));
            if (String(account.email).toLowerCase() !== String(session.user.email || '').toLowerCase()) {
                return next(new AppError('The administrator identity does not match the account record.', { status: 403, code: 'ADMIN_IDENTITY_MISMATCH' }));
            }
            if (session.user.twoFactorEnabled !== true) return next(new AppError('Two-factor authentication is required for administrator access.', { status: 403, code: 'ADMIN_2FA_REQUIRED' }));

            const binding = sessionBinding(session);
            if (!binding || typeof authService.reauthenticate !== 'function' || typeof store.recordAdminReauthentication !== 'function') {
                return next(new AppError('Server-side administrator re-authentication is unavailable.', { status: 503, code: 'ADMIN_REAUTH_UNAVAILABLE' }));
            }
            try {
                const result = await authService.reauthenticate(request, request.validatedBody);
                if (result?.status !== true) throw new Error('Password verification did not succeed.');
            } catch (error) {
                if (error?.code === 'ADMIN_REAUTH_UNAVAILABLE') return next(error);
                await recordFailedAdminReauthentication({ store, session, requestId: request.id, binding });
                return next(new AppError('Administrator re-authentication failed.', { status: 403, code: 'ADMIN_REAUTH_FAILED' }));
            }

            const verifiedAt = new Date();
            const marker = await store.recordAdminReauthentication({
                sessionId: binding,
                userId: session.user.id,
                verifiedAt,
                expiresAt: adminReauthenticationExpiresAt(session, config, verifiedAt),
                method: 'password_totp',
                securityVersion: Number(account.securityVersion || 1)
            });
            await store.logAudit?.({
                workspaceId: null,
                actorId: session.user.id,
                action: 'security.step_up_succeeded',
                entityType: 'admin_session',
                entityId: binding,
                requestId: request.id,
                metadata: { method: 'password_totp' }
            });
            request.adminReauthentication = marker;
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

function requireAdminRouteAuthorization({ config, store }) {
    return async (request, _response, next) => {
        try {
            const policy = resolveAdminRoutePolicy(request);
            if (!policy) return next(new AppError('This privileged route has no authorization policy.', { status: 403, code: 'ADMIN_ROUTE_POLICY_MISSING' }));
            if (!hasAdminPermission(request.adminIdentity?.permissions || [], policy.permission)) {
                return next(new AppError('This administrator does not have the required permission.', {
                    status: 403,
                    code: 'ADMIN_PERMISSION_DENIED',
                    details: { requiredPermission: policy.permission }
                }));
            }
            if (request.adminIdentity.webAuthnEnrollmentRequired && policy.stepUp && !policy.allowDuringEnrollment) {
                return next(new AppError('Enroll a WebAuthn credential before using privileged administrator controls.', {
                    status: 403,
                    code: 'ADMIN_WEBAUTHN_ENROLLMENT_REQUIRED'
                }));
            }
            if (policy.stepUp) {
                const binding = request.adminIdentity.sessionBinding;
                const marker = binding && typeof store.getAdminReauthentication === 'function'
                    ? await store.getAdminReauthentication(binding, request.adminIdentity.actorId)
                    : null;
                const requiredMethod = request.adminIdentity.webAuthnRequired ? 'webauthn' : null;
                if (!reauthenticationMatchesPolicy(marker, {
                    maxAgeMs: config.adminSecurity?.stepUpMaxAgeMs || config.adminReauthMaxAgeMs,
                    // Local development may deliberately keep a password +
                    // TOTP step-up for one Better Auth session. Production
                    // rejects that config, and WebAuthn markers always retain
                    // the bounded critical-action age.
                    sessionLifetime: Boolean(config.adminReauthSessionLifetime && !requiredMethod),
                    requiredMethod,
                    securityVersion: request.adminIdentity.securityVersion
                })) {
                    return next(new AppError(
                        requiredMethod === 'webauthn'
                            ? 'Verify a passkey before performing this critical action.'
                            : 'Re-authenticate before performing this critical action.',
                        { status: 403, code: requiredMethod === 'webauthn' ? 'ADMIN_WEBAUTHN_STEP_UP_REQUIRED' : 'ADMIN_STEP_UP_REQUIRED' }
                    ));
                }
            }
            request.adminRoutePolicy = policy;
            return next();
        } catch (error) { return next(error); }
    };
}

function changeMetadata({ before, after, reason, requestId, extra = {} }) {
    return { before, after, reason, requestId, ...extra };
}

async function insertAudit(client, { workspaceId = null, actorId, action, entityType, entityId, metadata }) {
    await client.query(
        `INSERT INTO wpa_audit_log(id,workspace_id,actor_id,action,entity_type,entity_id,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [`audit_${crypto.randomUUID()}`, workspaceId, actorId || null, action, entityType, entityId || null, JSON.stringify(metadata)]
    );
}

async function assignWorkspacePlanPostgres({ store, workspaceId, planId, actorId, reason, requestId }) {
    const client = await store.pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        const planResult = await client.query('SELECT id FROM wpa_plan_catalog WHERE id=$1', [planId]);
        if (!planResult.rows[0]) throw new AppError('Unknown plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const beforeResult = await client.query('SELECT id,name,plan_id AS "planId",created_at AS "createdAt" FROM wpa_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        if (!beforeResult.rows[0]) {
            await client.query('INSERT INTO wpa_workspaces(id,name,plan_id) VALUES($1,$2,$3)', [workspaceId, 'My workspace', planId]);
        }
        const { rows } = await client.query('UPDATE wpa_workspaces SET plan_id=$2,updated_at=now() WHERE id=$1 RETURNING id,name,plan_id AS "planId",created_at AS "createdAt"', [workspaceId, planId]);
        const workspace = rows[0];
        await insertAudit(client, {
            workspaceId,
            actorId,
            action: 'workspace.plan_changed',
            entityType: 'workspace',
            entityId: workspaceId,
            metadata: changeMetadata({ before: { planId: beforeResult.rows[0]?.planId ?? null }, after: { planId: workspace.planId }, reason, requestId })
        });
        await client.query('COMMIT');
        transactionOpen = false;
        return workspace;
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function assignWorkspacePlanWithAudit({ store, workspaceId, planId, actorId, reason, requestId }) {
    if (store.pool?.connect) return assignWorkspacePlanPostgres({ store, workspaceId, planId, actorId, reason, requestId });
    const plan = await store.getPlan?.(planId) || getPlan(planId);
    if (!plan) throw new AppError('Unknown plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
    const beforeWorkspace = await store.getWorkspace(workspaceId);
    const before = beforeWorkspace ? structuredClone(beforeWorkspace) : null;
    await store.ensureWorkspace(workspaceId);
    const workspace = await store.setWorkspacePlan(workspaceId, planId);
    if (!workspace) throw new AppError('Workspace not found.', { status: 404, code: 'WORKSPACE_NOT_FOUND' });
    try {
        await store.logAudit({
            workspaceId,
            actorId,
            action: 'workspace.plan_changed',
            entityType: 'workspace',
            entityId: workspaceId,
            metadata: changeMetadata({ before: { planId: before?.planId ?? null }, after: { planId: workspace.planId }, reason, requestId })
        });
        return workspace;
    } catch (error) {
        if (before) await store.setWorkspacePlan(workspaceId, before.planId);
        else if (store.workspaces?.delete) store.workspaces.delete(workspaceId);
        throw error;
    }
}

async function setPlanEntitlementPostgres({ store, planId, moduleId, entitlement, actorId, reason, requestId }) {
    const client = await store.pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        const { rows: beforeRows } = await client.query('SELECT id,name,price_usd AS "priceUsd",description,limits,features,entitlements FROM wpa_plan_catalog WHERE id=$1 FOR UPDATE', [planId]);
        const beforePlan = beforeRows[0];
        if (!beforePlan) throw new AppError('Unknown plan.', { status: 404, code: 'PLAN_NOT_FOUND' });
        const before = beforePlan.entitlements?.[moduleId] || null;
        const entitlements = { ...beforePlan.entitlements, [moduleId]: entitlement };
        const { rows } = await client.query('UPDATE wpa_plan_catalog SET entitlements=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id,name,price_usd AS "priceUsd",description,limits,features,entitlements', [planId, JSON.stringify(entitlements)]);
        const plan = rows[0];
        await insertAudit(client, {
            workspaceId: null,
            actorId,
            action: 'plan.entitlement_changed',
            entityType: 'plan',
            entityId: planId,
            metadata: changeMetadata({ before, after: plan.entitlements?.[moduleId] || null, reason, requestId, extra: { moduleId } })
        });
        await client.query('COMMIT');
        transactionOpen = false;
        return plan;
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function setPlanEntitlementWithAudit({ store, planId, moduleId, entitlement, actorId, reason, requestId }) {
    if (!isAdminGrantableModule(moduleId)) throw new AppError('This module cannot be granted.', { status: 400, code: 'ENTITLEMENT_MODULE_NOT_GRANTABLE' });
    if (store.pool?.connect) return setPlanEntitlementPostgres({ store, planId, moduleId, entitlement, actorId, reason, requestId });
    const beforePlan = await store.getPlan?.(planId) || getPlan(planId);
    if (!beforePlan) throw new AppError('Unknown plan.', { status: 404, code: 'PLAN_NOT_FOUND' });
    const hadBefore = Object.hasOwn(beforePlan.entitlements || {}, moduleId);
    const before = structuredClone(beforePlan.entitlements?.[moduleId] || null);
    const plan = await store.setPlanEntitlement(planId, moduleId, entitlement);
    if (!plan) throw new AppError('Unknown plan.', { status: 404, code: 'PLAN_NOT_FOUND' });
    try {
        await store.logAudit({
            workspaceId: null,
            actorId,
            action: 'plan.entitlement_changed',
            entityType: 'plan',
            entityId: planId,
            metadata: changeMetadata({ before, after: plan.entitlements?.[moduleId] || null, reason, requestId, extra: { moduleId } })
        });
        return plan;
    } catch (error) {
        if (hadBefore) await store.setPlanEntitlement(planId, moduleId, before);
        else delete plan.entitlements[moduleId];
        throw error;
    }
}

async function setUserStateWithAudit({ store, userId, state, actorId, reason, requestId }) {
    if (typeof store.setUserState !== 'function') throw new AppError('User state operations are unavailable.', { status: 503, code: 'USER_STATE_UNAVAILABLE' });
    return store.setUserState(userId, state, { actorId, reason, requestId });
}

async function setWorkspaceStateWithAudit({ store, workspaceId, state, actorId, reason, requestId }) {
    if (typeof store.setWorkspaceState !== 'function') throw new AppError('Workspace state operations are unavailable.', { status: 503, code: 'WORKSPACE_STATE_UNAVAILABLE' });
    return store.setWorkspaceState(workspaceId, state, { actorId, reason, requestId });
}

module.exports = {
    adminReauthenticationExpiresAt,
    assignWorkspacePlanWithAudit,
    getAdminAccessStatus,
    hasRecentReauthentication,
    reauthenticationMatchesPolicy,
    requireAdminReauthentication,
    requireAdminRouteAuthorization,
    requireSecurePlatformAdmin,
    roleRequiresWebAuthn,
    sessionBinding,
    setPlanEntitlementWithAudit,
    setUserStateWithAudit,
    setWorkspaceStateWithAudit
};
