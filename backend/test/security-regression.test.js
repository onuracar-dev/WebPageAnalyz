const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../config');
const { createApp } = require('../app');
const { MemoryPlatformStore } = require('../platform/store');
const { AUTH_ENDPOINTS, authTrustedOrigins } = require('../auth/better-auth');
const { assignWorkspacePlanWithAudit, sessionBinding, setPlanEntitlementWithAudit } = require('../auth/security');
const {
    ROLE_PERMISSIONS,
    WORKSPACE_PERMISSIONS,
    assertWorkspacePermission,
    attachWorkspaceMembership,
    normalizeRole,
    setWorkspaceMembershipForTests
} = require('../auth/workspace-policy');

const silentLogger = { info() {}, warn() {}, error() {} };
async function grantReauthentication(store, session, config, { verifiedAt = new Date(), expiresAt = new Date(Date.now() + config.adminReauthMaxAgeMs), method = 'password_totp', securityVersion = 1 } = {}) {
    return store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: session.user.id, verifiedAt, expiresAt, method, securityVersion });
}

async function grantWebAuthnReauthentication(store, session, config) {
    store.adminPasskeys.set(`passkey-${session.user.id}`, { id: `passkey-${session.user.id}`, userId: session.user.id, name: 'Test security key', deviceType: 'singleDevice', backedUp: false, createdAt: new Date().toISOString() });
    return grantReauthentication(store, session, config, { method: 'webauthn' });
}

function appFor(t, { config, session = null, store = new MemoryPlatformStore(), authAccount, reauthenticate = async () => ({ status: true }) } = {}) {
    if (authAccount) store.upsertAdminAccount(authAccount);
    const app = createApp({
        config,
        platformStore: store,
        logger: silentLogger,
        authService: { async session() { return session; }, async reauthenticate(request, credentials) { return reauthenticate(request, credentials); }, async close() {} },
        validateUrl: async () => ({ url: 'https://example.com/', hostname: 'example.com', port: 443, address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }] }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return 'solution'; }, async generateExecutiveSummary() { return 'summary'; } }
    });
    t.after(() => app.locals.closeResources());
    return { app, store };
}

test('workspace RBAC matrix is explicit and fail-closed for viewers', () => {
    const all = Object.values(WORKSPACE_PERMISSIONS);
    for (const permission of all) assert.doesNotThrow(() => assertWorkspacePermission({ role: 'owner' }, permission));
    for (const permission of all) {
        const expected = ROLE_PERMISSIONS.admin.includes(permission);
        if (expected) assert.doesNotThrow(() => assertWorkspacePermission({ role: 'admin' }, permission));
        else assert.throws(() => assertWorkspacePermission({ role: 'admin' }, permission), (error) => error.code === 'WORKSPACE_PERMISSION_DENIED');
    }
    for (const permission of [WORKSPACE_PERMISSIONS.project, WORKSPACE_PERMISSIONS.scan, WORKSPACE_PERMISSIONS.sourceUpload, WORKSPACE_PERMISSIONS.share, WORKSPACE_PERMISSIONS.review]) {
        assert.doesNotThrow(() => assertWorkspacePermission({ role: 'analyst' }, permission));
    }
    for (const permission of [WORKSPACE_PERMISSIONS.settings, WORKSPACE_PERMISSIONS.billing, WORKSPACE_PERMISSIONS.integrations]) {
        assert.throws(() => assertWorkspacePermission({ role: 'analyst' }, permission), (error) => error.code === 'WORKSPACE_PERMISSION_DENIED');
    }
    for (const permission of all) assert.throws(() => assertWorkspacePermission({ role: 'viewer' }, permission), (error) => error.code === 'WORKSPACE_PERMISSION_DENIED');
});

test('auth redirect contract trusts only configured exact app/auth origins', () => {
    const config = loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://dashboard.example',
        APP_URL: 'https://app.example',
        BETTER_AUTH_URL: 'https://auth.example',
        WORKER_ENABLED: 'false'
    });
    const origins = authTrustedOrigins(config);
    assert.ok(origins.includes('https://dashboard.example'));
    assert.ok(origins.includes('https://app.example'));
    assert.ok(origins.includes('https://auth.example'));
    assert.equal(origins.includes('https://evil.example'), false);
    assert.equal(config.corsOrigins.includes('https://app.example'), true);
    assert.deepEqual(AUTH_ENDPOINTS, {
        requestPasswordReset: '/api/auth/request-password-reset',
        resetPasswordCallback: '/api/auth/reset-password/:token',
        resetPassword: '/api/auth/reset-password',
        sendVerificationEmail: '/api/auth/send-verification-email',
        verifyEmail: '/api/auth/verify-email'
    });
});

function organizationMembershipStore({ applicationRole = null, organizationRole = null } = {}) {
    let storedRole = applicationRole;
    return {
        pool: {
            async query(sql, parameters) {
                if (sql.startsWith('SELECT workspace_id AS')) {
                    return { rows: storedRole ? [{ workspaceId: parameters[0], userId: parameters[1], role: storedRole }] : [] };
                }
                if (sql.includes('FROM member')) return { rows: organizationRole ? [{ role: organizationRole }] : [] };
                if (sql.startsWith('DELETE FROM wpa_memberships')) { storedRole = null; return { rowCount: 1 }; }
                if (sql.startsWith('INSERT INTO wpa_memberships')) {
                    storedRole = parameters[2];
                    return { rows: [{ workspaceId: parameters[0], userId: parameters[1], role: storedRole }] };
                }
                throw new Error(`Unexpected membership query: ${sql}`);
            }
        }
    };
}

async function resolveRole(store) {
    const requestContext = { platformIdentity: { userId: 'user-1', workspaceId: 'org-1', session: { session: { activeOrganizationId: 'org-1' } } } };
    const errors = [];
    await attachWorkspaceMembership({ config: { nodeEnv: 'production' }, store })(requestContext, {}, (error) => { if (error) errors.push(error); });
    assert.equal(errors.length, 0);
    return requestContext.platformIdentity.role;
}

async function resolveMembershipError(store) {
    const requestContext = { platformIdentity: { userId: 'user-1', workspaceId: 'org-1', session: { session: { activeOrganizationId: 'org-1' } } } };
    const errors = [];
    await attachWorkspaceMembership({ config: { nodeEnv: 'production' }, store })(requestContext, {}, (error) => { if (error) errors.push(error); });
    return errors[0]?.code;
}

test('workspace membership is authoritative and Better Auth organization roles map deterministically', async () => {
    assert.equal(normalizeRole('owner'), 'owner');
    assert.equal(normalizeRole('admin'), 'admin');
    assert.equal(normalizeRole('member'), 'analyst');
    assert.equal(normalizeRole('viewer'), 'viewer');
    assert.equal(await resolveRole(organizationMembershipStore({ organizationRole: 'owner' })), 'owner');
    assert.equal(await resolveRole(organizationMembershipStore({ organizationRole: 'admin' })), 'admin');
    assert.equal(await resolveRole(organizationMembershipStore({ organizationRole: 'member' })), 'analyst');
    assert.equal(await resolveRole(organizationMembershipStore({ organizationRole: 'viewer' })), 'viewer');
    assert.equal(await resolveRole(organizationMembershipStore({ applicationRole: 'viewer', organizationRole: 'owner' })), 'owner');
    assert.equal(await resolveMembershipError(organizationMembershipStore({ applicationRole: 'owner' })), 'WORKSPACE_MEMBERSHIP_REQUIRED');
});

test('session admin read access requires verified email, registered role and 2FA without prompting on every page', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const account = { userId: 'admin-1', email: 'admin@example.com', role: 'super_admin', active: true };
    const session = { user: { id: 'admin-1', email: 'admin@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'session-admin-1' } };
    const store = new MemoryPlatformStore();
    await grantReauthentication(store, session, config);
    const { app } = appFor(t, { config, session, store, authAccount: account });
    const me = await request(app).get('/api/v1/admin/me').expect(200);
    assert.equal(me.body.admin.role, 'super_admin');

    const stale = appFor(t, { config, session: { ...session, session: { id: 'session-admin-stale', updatedAt: new Date().toISOString() } }, authAccount: account }).app;
    await request(stale).get('/api/v1/admin/me').expect(200);
    await request(stale).post('/api/v1/admin/users/target/plan').set('Origin', 'https://dashboard.example').send({ planId: 'studio', reason: 'critical mutation', confirm: true }).expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_WEBAUTHN_ENROLLMENT_REQUIRED'));
    const twoFactorMissing = appFor(t, { config, session: { ...session, user: { ...session.user, twoFactorEnabled: false } }, authAccount: account }).app;
    await request(twoFactorMissing).get('/api/v1/admin/me').expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_2FA_REQUIRED'));
    const unverified = appFor(t, { config, session: { ...session, user: { ...session.user, emailVerified: false } }, authAccount: account }).app;
    await request(unverified).get('/api/v1/admin/me').expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_EMAIL_UNVERIFIED'));
});

test('admin re-auth verifies the current password and creates an expiring server-side session marker', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const session = { user: { id: 'admin-reauth', email: 'reauth@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'session-reauth-1' } };
    const store = new MemoryPlatformStore();
    const passwords = [];
    const { app } = appFor(t, {
        config,
        session,
        store,
        authAccount: { userId: 'admin-reauth', email: 'reauth@example.com', role: 'super_admin', active: true },
        reauthenticate: async (_request, credentials) => { passwords.push(credentials); return { status: true }; }
    });
    const result = await request(app).post('/api/v1/admin/reauth').set('Origin', 'https://dashboard.example').send({ password: 'correct-password', totpCode: '123456' }).expect(200);
    assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'reauthenticated']);
    assert.equal(result.body.reauthenticated, true);
    assert.ok(result.body.expiresAt);
    assert.deepEqual(passwords[0], { password: 'correct-password', totpCode: '123456' });
    await request(app).get('/api/v1/admin/me').expect(200);

    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session),
        userId: session.user.id,
        verifiedAt: new Date(Date.now() - config.adminReauthMaxAgeMs - 1_000),
        expiresAt: new Date(Date.now() - 1_000)
    });
    await request(app).get('/api/v1/admin/me').expect(200);
    const expiredStatus = await request(app).get('/api/v1/admin/access-status').expect(200);
    assert.equal(expiredStatus.body.reauthenticated, false);

    const replayAttempt = { ...session, session: { ...session.session, reauthenticatedAt: new Date().toISOString() } };
    const replayApp = appFor(t, {
        config,
        session: replayAttempt,
        store: new MemoryPlatformStore(),
        authAccount: { userId: 'admin-reauth', email: 'reauth@example.com', role: 'super_admin', active: true }
    }).app;
    await request(replayApp).get('/api/v1/admin/me').expect(200);
    const replayStatus = await request(replayApp).get('/api/v1/admin/access-status').expect(200);
    assert.equal(replayStatus.body.reauthenticated, false);
});

test('local admin re-auth lasts for the active Better Auth session without crossing a session boundary', async (t) => {
    const config = loadConfig({
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:8080',
        CORS_ORIGINS: 'http://localhost:8080',
        ADMIN_REAUTH_SESSION_LIFETIME: 'true',
        WORKER_ENABLED: 'false'
    });
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const session = {
        user: { id: 'admin-local-session', email: 'local-admin@example.com', emailVerified: true, twoFactorEnabled: true },
        session: { id: 'local-admin-session-1', expiresAt: sessionExpiresAt }
    };
    const account = { userId: session.user.id, email: session.user.email, role: 'super_admin', active: true };
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'local-critical-target', email: 'target@example.com' });
    const { app } = appFor(t, { config, session, store, authAccount: account });

    const result = await request(app)
        .post('/api/v1/admin/reauth')
        .set('Origin', 'http://localhost:8080')
        .send({ password: 'correct-password', totpCode: '123456' })
        .expect(200);
    assert.equal(new Date(result.body.expiresAt).toISOString(), sessionExpiresAt);

    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session),
        userId: session.user.id,
        verifiedAt: new Date(Date.now() - config.adminReauthMaxAgeMs - 60_000),
        expiresAt: sessionExpiresAt
    });
    await request(app).get('/api/v1/admin/me').expect(200);
    await request(app).post('/api/v1/admin/users/local-critical-target/plan').set('Origin', 'http://localhost:8080').set('Idempotency-Key', 'local-plan-same-session').send({ planId: 'studio', reason: 'same-session local operation', confirm: true }).expect(201);

    const nextSession = { ...session, session: { ...session.session, id: 'local-admin-session-2' } };
    const nextSessionApp = appFor(t, { config, session: nextSession, store, authAccount: account }).app;
    await request(nextSessionApp).get('/api/v1/admin/me').expect(200);
    await request(nextSessionApp).post('/api/v1/admin/users/local-critical-target/plan').set('Origin', 'http://localhost:8080').set('Idempotency-Key', 'local-plan-new-session').send({ planId: 'signal', reason: 'different session must step up', confirm: true }).expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_STEP_UP_REQUIRED'));
});

test('admin access-status is a non-privileged pre-reauth contract', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const session = { user: { id: 'admin-status', email: 'status@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'session-status' } };
    const store = new MemoryPlatformStore();
    const { app } = appFor(t, { config, session, store, authAccount: { userId: 'admin-status', email: 'status@example.com', role: 'admin', active: true } });
    const before = await request(app).get('/api/v1/admin/access-status').expect(200);
    assert.deepEqual(before.body, {
        authenticated: true,
        administrator: true,
        emailVerified: true,
        twoFactorEnabled: true,
        reauthenticated: false,
        reauthRequired: true,
        webAuthnRequired: true,
        webAuthnCredentialCount: 0,
        webAuthnEnrollmentRequired: true,
        recommendedWebAuthnCredentialCount: 2,
        role: 'admin'
    });
    assert.equal(before.body.overview, undefined);
    await grantReauthentication(store, session, config);
    const after = await request(app).get('/api/v1/admin/access-status').expect(200);
    assert.equal(after.body.reauthenticated, true);
    assert.equal(after.body.reauthRequired, false);

    const customer = appFor(t, { config, session: { user: { id: 'status-customer', email: 'customer@example.com', emailVerified: true, twoFactorEnabled: false }, session: { id: 'session-customer' } } }).app;
    const customerStatus = await request(customer).get('/api/v1/admin/access-status').expect(200);
    assert.deepEqual(customerStatus.body, {
        authenticated: true,
        administrator: false,
        emailVerified: true,
        twoFactorEnabled: false,
        reauthenticated: false,
        reauthRequired: false,
        webAuthnRequired: false,
        webAuthnCredentialCount: 0,
        webAuthnEnrollmentRequired: false,
        recommendedWebAuthnCredentialCount: 2,
        role: null
    });

    const anonymous = appFor(t, { config, session: null }).app;
    const anonymousStatus = await request(anonymous).get('/api/v1/admin/access-status').expect(200);
    assert.deepEqual(anonymousStatus.body, {
        authenticated: false,
        administrator: false,
        emailVerified: false,
        twoFactorEnabled: false,
        reauthenticated: false,
        reauthRequired: false,
        webAuthnRequired: false,
        webAuthnCredentialCount: 0,
        webAuthnEnrollmentRequired: false,
        role: null
    });
});

test('failed admin re-auth is throttled and audited without password or TOTP material', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', ADMIN_REAUTH_RATE_LIMIT_MAX: '2', WORKER_ENABLED: 'false' });
    const session = { user: { id: 'admin-fail', email: 'fail@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'session-fail' } };
    const store = new MemoryPlatformStore();
    const { app } = appFor(t, {
        config,
        session,
        store,
        authAccount: { userId: 'admin-fail', email: 'fail@example.com', role: 'super_admin', active: true },
        reauthenticate: async () => ({ status: false })
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(app).post('/api/v1/admin/reauth').set('Origin', 'https://dashboard.example').send({ password: 'do-not-log-this-password', totpCode: '654321' }).expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_REAUTH_FAILED'));
    }
    await request(app).post('/api/v1/admin/reauth').set('Origin', 'https://dashboard.example').send({ password: 'do-not-log-this-password', totpCode: '654321' }).expect(429).expect(({ body }) => assert.equal(body.code, 'RATE_LIMIT_EXCEEDED'));
    const attempts = store.auditLog.filter((entry) => entry.action === 'security.step_up_failed');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].workspaceId, null);
    assert.equal(attempts[0].actorId, 'admin-fail');
    assert.equal(attempts[0].metadata.reason, 'credential_verification_failed');
    assert.ok(attempts[0].metadata.requestId);
    assert.equal(JSON.stringify(attempts).includes('do-not-log-this-password'), false);
    assert.equal(JSON.stringify(attempts).includes('654321'), false);
});

test('a session cookie cannot use a fake or valid API key to bypass production mutation origin checks', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', API_KEYS: 'verified-automation-key', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const session = { user: { id: 'customer-csrf', email: 'customer@example.com', emailVerified: true, twoFactorEnabled: false }, session: { id: 'session-csrf-1' } };
    const { app } = appFor(t, { config, session });
    const body = { name: 'Example', url: 'https://example.com', locale: 'en' };
    await request(app).post('/api/v1/projects').set('X-API-Key', 'fake-key').send(body).expect(403).expect(({ body: responseBody }) => assert.equal(responseBody.code, 'UNTRUSTED_MUTATION_ORIGIN'));
    await request(app).post('/api/v1/projects').set('X-API-Key', 'verified-automation-key').send(body).expect(403).expect(({ body: responseBody }) => assert.equal(responseBody.code, 'UNTRUSTED_MUTATION_ORIGIN'));
});

test('the Better Auth surface has an outer IP budget for brute-force and reset traffic', async (t) => {
    const config = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', AUTH_RATE_LIMIT_MAX: '2', WORKER_ENABLED: 'false' });
    const app = createApp({
        config,
        platformStore: new MemoryPlatformStore(),
        logger: silentLogger,
        authService: {
            enabled: true,
            async handler(_request, response) { response.status(200).json({ handled: true }); },
            async session() { return null; },
            async close() {}
        },
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return 'solution'; }, async generateExecutiveSummary() { return 'summary'; } }
    });
    t.after(() => app.locals.closeResources());
    await request(app).post('/api/auth/sign-in/email').send({ email: 'user@example.com', password: 'wrong' }).expect(200);
    await request(app).post('/api/auth/request-password-reset').send({ email: 'user@example.com' }).expect(200);
    await request(app).post('/api/auth/sign-in/email').send({ email: 'user@example.com', password: 'wrong' }).expect(429).expect(({ body }) => assert.equal(body.code, 'RATE_LIMIT_EXCEEDED'));
});

test('only session super_admin can change user plans and every change has before/after actor reason requestId audit data', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const session = { user: { id: 'admin-2', email: 'admin2@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'session-admin-2' } };
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user-a', email: 'customer@example.com' });
    await grantWebAuthnReauthentication(store, session, config);
    const { app } = appFor(t, { config, session, store, authAccount: { userId: 'admin-2', email: 'admin2@example.com', role: 'super_admin', active: true } });
    await request(app).post('/api/v1/admin/users/user-a/plan').set('Origin', 'https://dashboard.example').set('X-Request-Id', 'req-plan-1').set('Idempotency-Key', 'user-plan-1').send({ planId: 'studio', reason: 'approved plan migration', confirm: true }).expect(201);
    await request(app).put('/api/v1/admin/plans/studio/entitlements/core_audit').set('Origin', 'https://dashboard.example').set('X-Request-Id', 'req-ent-1').send({ executionMode: 'automated', limit: null, reason: 'approved catalog correction', confirm: true }).expect(200);
    const planAudit = store.auditLog.find((entry) => entry.action === 'user.plan_changed');
    assert.deepEqual(planAudit.before, { planId: 'free' });
    assert.deepEqual(planAudit.after, { planId: 'studio' });
    assert.equal(planAudit.actorId, 'admin-2');
    assert.equal(planAudit.reason, 'approved plan migration');
    assert.equal(planAudit.requestId, 'req-plan-1');
    assert.equal(planAudit.metadata.targetUserId, 'user-a');
    const entitlementAudit = store.auditLog.find((entry) => entry.action === 'plan.entitlement_changed');
    assert.equal(entitlementAudit.workspaceId, null);
    assert.equal(entitlementAudit.metadata.reason, 'approved catalog correction');
    assert.equal(entitlementAudit.metadata.requestId, 'req-ent-1');

    const operatorSession = { ...session, user: { ...session.user, id: 'operator-1', email: 'operator@example.com' }, session: { id: 'session-operator-1' } };
    const operatorStore = new MemoryPlatformStore();
    await grantReauthentication(operatorStore, operatorSession, config);
    const operator = appFor(t, { config, session: operatorSession, store: operatorStore, authAccount: { userId: 'operator-1', email: 'operator@example.com', role: 'operator', active: true } }).app;
    await request(operator).post('/api/v1/admin/users/user-a/plan').set('Origin', 'https://dashboard.example').send({ planId: 'enterprise', reason: 'not allowed', confirm: true }).expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_PERMISSION_DENIED'));
});

test('entitlement audit failure rolls back the in-memory store and the PostgreSQL contract issues ROLLBACK', async () => {
    const memory = new MemoryPlatformStore();
    const before = structuredClone((await memory.getPlan('signal')).entitlements.core_audit);
    memory.logAudit = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => setPlanEntitlementWithAudit({ store: memory, planId: 'signal', moduleId: 'core_audit', entitlement: { executionMode: 'disabled' }, actorId: 'admin', reason: 'test', requestId: 'req' }), /audit unavailable/);
    assert.deepEqual((await memory.getPlan('signal')).entitlements.core_audit, before);

    const queries = [];
    const client = {
        async query(sql) {
            queries.push(sql);
            if (sql === 'BEGIN') return {};
            if (sql.includes('SELECT id,name,price_usd')) return { rows: [{ id: 'signal', name: 'Signal', priceUsd: 29, description: '', limits: {}, features: [], entitlements: { core_audit: { executionMode: 'automated' } } }] };
            if (sql.startsWith('UPDATE wpa_plan_catalog')) return { rows: [{ id: 'signal', entitlements: { core_audit: { executionMode: 'disabled' } } }] };
            if (sql.startsWith('INSERT INTO wpa_audit_log')) throw new Error('audit unavailable');
            return {};
        },
        release() {}
    };
    const postgres = { pool: { async connect() { return client; } } };
    await assert.rejects(() => setPlanEntitlementWithAudit({ store: postgres, planId: 'signal', moduleId: 'core_audit', entitlement: { executionMode: 'disabled' }, actorId: 'admin', reason: 'test', requestId: 'req' }), /audit unavailable/);
    assert.ok(queries.includes('ROLLBACK'));

    const planStore = new MemoryPlatformStore();
    await planStore.ensureWorkspace('ws-rollback', { planId: 'signal' });
    planStore.logAudit = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => assignWorkspacePlanWithAudit({ store: planStore, workspaceId: 'ws-rollback', planId: 'studio', actorId: 'admin', reason: 'test', requestId: 'req-plan' }), /audit unavailable/);
    assert.equal((await planStore.getWorkspace('ws-rollback')).planId, 'signal');
});

test('direct PostgreSQL plan helper shares the launch allowlist and keeps Expert Review assignable', async () => {
    let connects = 0;
    const queries = [];
    const client = {
        async query(sql, values = []) {
            queries.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT') return {};
            if (sql.includes('SELECT id,name,price_usd')) return { rows: [{ id: 'signal', name: 'Signal', priceUsd: 29, description: '', limits: {}, features: [], entitlements: {} }] };
            if (sql.startsWith('UPDATE wpa_plan_catalog')) return { rows: [{ id: 'signal', entitlements: JSON.parse(values[1]) }] };
            if (sql.startsWith('INSERT INTO wpa_audit_log')) return { rows: [] };
            return { rows: [] };
        },
        release() {}
    };
    const postgres = { pool: { async connect() { connects += 1; return client; } } };
    for (const moduleId of ['monitoring', 'white_label', 'not_a_module']) {
        await assert.rejects(() => setPlanEntitlementWithAudit({
            store: postgres, planId: 'signal', moduleId, entitlement: { executionMode: 'automated' },
            actorId: 'admin', reason: 'invalid module', requestId: `reject-${moduleId}`
        }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
    }
    assert.equal(connects, 0);
    const plan = await setPlanEntitlementWithAudit({
        store: postgres, planId: 'signal', moduleId: 'expert_review', entitlement: { executionMode: 'operator_assisted', limit: 1 },
        actorId: 'admin', reason: 'approved Expert Review workflow', requestId: 'accept-expert-review'
    });
    assert.deepEqual(plan.entitlements.expert_review, { executionMode: 'operator_assisted', limit: 1 });
    assert.equal(connects, 1);
    assert.ok(queries.includes('COMMIT'));
});

test('production legacy routes are disabled by default and explicit enablement requires API_KEYS', async (t) => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', LEGACY_API_ENABLED: 'true' }), /LEGACY_API_ENABLED requires API_KEYS/);
    const disabled = appFor(t, { config: loadConfig({ NODE_ENV: 'production', WORKER_ENABLED: 'false' }) }).app;
    for (const path of ['/api/analyze', '/api/solve', '/api/executive-summary']) {
        await request(disabled).post(path).send({}).expect(404).expect(({ body }) => assert.equal(body.code, 'LEGACY_API_DISABLED'));
    }

    const enabledConfig = loadConfig({ NODE_ENV: 'production', API_KEYS: 'legacy-secret', LEGACY_API_ENABLED: 'true', WORKER_ENABLED: 'false' });
    const enabled = appFor(t, { config: enabledConfig }).app;
    await request(enabled).post('/api/solve').send({ issue: { title: 'x' } }).expect(401);
    await request(enabled).post('/api/solve').set('X-API-Key', 'legacy-secret').send({ issue: { title: 'x' } }).expect(200);
});

test('development legacy compatibility requires an explicit unauthenticated exception', () => {
    const config = loadConfig({ NODE_ENV: 'development', LEGACY_API_ENABLED: 'true', LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT: 'true' });
    assert.equal(config.legacyApi.allowUnauthenticatedDevelopment, true);
});

test('test membership fixtures can set roles without weakening production defaults', () => {
    const store = new MemoryPlatformStore();
    setWorkspaceMembershipForTests(store, 'ws-1', 'user-1', 'viewer');
    assert.throws(() => assertWorkspacePermission({ role: 'viewer' }, WORKSPACE_PERMISSIONS.settings), (error) => error.code === 'WORKSPACE_PERMISSION_DENIED');
});
