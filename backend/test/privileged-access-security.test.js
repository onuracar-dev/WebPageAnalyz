const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { sessionBinding } = require('../auth/security');
const {
    ADMIN_PERMISSIONS,
    ADMIN_ROLES,
    hasAdminPermission,
    permissionsForRole,
    resolveAdminRoutePolicy
} = require('../auth/admin-policy');

const logger = { info() {}, warn() {}, error() {} };
const origin = 'https://dashboard.example';

async function harness(t, { role = 'super_admin', webAuthnRequired = false, actorId = `${role}-actor` } = {}) {
    const config = loadConfig({
        NODE_ENV: 'production',
        ADMIN_WEBAUTHN_REQUIRED: String(webAuthnRequired),
        CORS_ORIGINS: origin,
        APP_URL: origin,
        BETTER_AUTH_URL: origin,
        WORKER_ENABLED: 'false',
        RATE_LIMIT_MAX: '1000',
        ADMIN_RATE_LIMIT_MAX: '1000'
    });
    const store = new MemoryPlatformStore();
    const session = {
        user: { id: actorId, email: `${actorId}@example.test`, name: actorId, emailVerified: true, twoFactorEnabled: true },
        session: { id: `${actorId}-session`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    };
    await store.registerUser({ id: actorId, name: actorId, email: session.user.email });
    await store.upsertAdminAccount({ userId: actorId, email: session.user.email, role, active: true });
    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session),
        userId: actorId,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + config.adminSecurity.stepUpMaxAgeMs),
        method: 'password_totp',
        securityVersion: 1
    });
    const authService = {
        enabled: true,
        async session() { return session; },
        async reauthenticate() { return { status: true }; },
        async handler(_request, response) { response.status(404).json({ code: 'AUTH_TEST_HANDLER_NOT_IMPLEMENTED' }); },
        async close() {}
    };
    const app = createApp({ config, platformStore: store, authService, logger });
    t.after(() => app.locals.closeResources());
    return { app, config, session, store };
}

test('built-in roles and permissions are canonical, finite and deny unknown permission names', () => {
    assert.deepEqual(ADMIN_ROLES, ['super_admin', 'admin', 'moderator', 'support']);
    assert.equal(new Set(ADMIN_PERMISSIONS).size, ADMIN_PERMISSIONS.length);
    assert.equal(hasAdminPermission('super_admin', 'security.admins.manage'), true);
    assert.equal(hasAdminPermission('admin', 'security.admins.manage'), false);
    assert.equal(hasAdminPermission('moderator', 'credits.manage'), false);
    assert.equal(hasAdminPermission('support', 'support.reply'), true);
    assert.equal(hasAdminPermission('super_admin', 'unknown.root'), false);
    assert.equal(permissionsForRole('operator').includes('credits.manage'), false);
});

test('route policy is explicit, domain based and unknown privileged routes deny by default', async (t) => {
    const { app } = await harness(t);
    assert.equal(resolveAdminRoutePolicy({ method: 'POST', originalUrl: '/api/v1/admin/users/u1/ban' }).permission, 'users.ban');
    assert.equal(resolveAdminRoutePolicy({ method: 'GET', originalUrl: '/api/v1/admin/support/tickets' }).permission, 'support.read');
    assert.equal(resolveAdminRoutePolicy({ method: 'GET', originalUrl: '/api/v1/admin/not-registered' }), null);
    const denied = await request(app).get('/api/v1/admin/not-registered').expect(403);
    assert.equal(denied.body.code, 'ADMIN_ROUTE_POLICY_MISSING');
});

test('support and moderator receive only their canonical operational permissions', async (t) => {
    const support = await harness(t, { role: 'support' });
    await support.store.registerUser({ id: 'target', name: 'Target', email: 'target@example.test' });
    await request(support.app).get('/api/v1/admin/users/target').expect(200);
    const supportCredit = await request(support.app)
        .post('/api/v1/admin/users/target/credits').set('Origin', origin)
        .send({ kind: 'page', amount: 1, reason: 'not permitted', confirm: true }).expect(403);
    assert.equal(supportCredit.body.code, 'ADMIN_PERMISSION_DENIED');
    const supportBan = await request(support.app)
        .post('/api/v1/admin/users/target/ban').set('Origin', origin)
        .send({ reason: 'not permitted', confirm: true }).expect(403);
    assert.equal(supportBan.body.code, 'ADMIN_PERMISSION_DENIED');

    const moderator = await harness(t, { role: 'moderator' });
    await moderator.store.registerUser({ id: 'moderated-user', name: 'Moderated', email: 'moderated@example.test' });
    await request(moderator.app)
        .post('/api/v1/admin/users/moderated-user/ban').set('Origin', origin)
        .send({ reason: 'confirmed moderation action', confirm: true }).expect(200);
    const moderatorCredits = await request(moderator.app)
        .post('/api/v1/admin/users/moderated-user/credits').set('Origin', origin)
        .send({ kind: 'page', amount: 1, reason: 'not permitted', confirm: true }).expect(403);
    assert.equal(moderatorCredits.body.code, 'ADMIN_PERMISSION_DENIED');
});

test('admin, moderator and support cannot self-promote or assign privileged roles', async (t) => {
    for (const role of ['admin', 'moderator', 'support']) {
        const current = await harness(t, { role, actorId: `${role}-self` });
        const denied = await request(current.app)
            .put(`/api/v1/admin/security/admins/${role}-self`).set('Origin', origin)
            .send({ role: 'super_admin', active: true, reason: 'self escalation', confirm: true }).expect(403);
        assert.equal(denied.body.code, 'ADMIN_PERMISSION_DENIED');
    }
});

test('last active super admin is preserved while one of two super admins may be deactivated', async (t) => {
    const { app, store } = await harness(t, { role: 'super_admin', actorId: 'super-one' });
    const blocked = await request(app)
        .put('/api/v1/admin/security/admins/super-one').set('Origin', origin)
        .send({ role: 'admin', active: true, reason: 'unsafe downgrade', confirm: true }).expect(409);
    assert.equal(blocked.body.code, 'LAST_SUPER_ADMIN_REQUIRED');

    await store.registerUser({ id: 'super-two', name: 'Super Two', email: 'super-two@example.test' });
    await request(app)
        .put('/api/v1/admin/security/admins/super-two').set('Origin', origin)
        .send({ role: 'super_admin', active: true, reason: 'establish backup admin', confirm: true }).expect(200);
    await request(app)
        .put('/api/v1/admin/security/admins/super-two').set('Origin', origin)
        .send({ role: 'admin', active: false, reason: 'remove one of two admins', confirm: true }).expect(200);
    assert.equal((await store.getAdminAccount('super-one')).active, true);
});

test('production WebAuthn policy allows read-only use but gates critical mutations and rejects TOTP-only step-up', async (t) => {
    const { app, session, store } = await harness(t, { webAuthnRequired: true, actorId: 'webauthn-admin' });
    await store.registerUser({ id: 'target-user', name: 'Target', email: 'target@example.test' });
    await request(app).get('/api/v1/admin/users/target-user').expect(200);
    const enrollment = await request(app)
        .post('/api/v1/admin/users/target-user/ban').set('Origin', origin)
        .send({ reason: 'critical action', confirm: true }).expect(403);
    assert.equal(enrollment.body.code, 'ADMIN_WEBAUTHN_ENROLLMENT_REQUIRED');

    store.adminPasskeys.set('key-1', { id: 'key-1', userId: 'webauthn-admin', name: 'Primary', deviceType: 'multiDevice', backedUp: false, createdAt: new Date().toISOString() });
    const totpOnly = await request(app)
        .post('/api/v1/admin/users/target-user/ban').set('Origin', origin)
        .send({ reason: 'critical action', confirm: true }).expect(403);
    assert.equal(totpOnly.body.code, 'ADMIN_WEBAUTHN_STEP_UP_REQUIRED');

    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session), userId: 'webauthn-admin', verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000), method: 'webauthn', securityVersion: 1
    });
    await request(app)
        .post('/api/v1/admin/users/target-user/ban').set('Origin', origin)
        .send({ reason: 'passkey verified action', confirm: true }).expect(200);
});

test('expired or stale-version privileged step-up cannot authorize a critical mutation', async (t) => {
    const { app, session, store } = await harness(t, { actorId: 'stale-admin' });
    await store.registerUser({ id: 'stale-target', name: 'Target', email: 'stale-target@example.test' });
    const account = store.adminAccounts.get('stale-admin');
    account.securityVersion = 2;
    const stale = await request(app)
        .post('/api/v1/admin/users/stale-target/ban').set('Origin', origin)
        .send({ reason: 'stale marker', confirm: true }).expect(403);
    assert.equal(stale.body.code, 'ADMIN_STEP_UP_REQUIRED');
    await store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: 'stale-admin', verifiedAt: new Date(Date.now() - 700_000), expiresAt: new Date(Date.now() - 1), method: 'password_totp', securityVersion: 2 });
    const expired = await request(app)
        .post('/api/v1/admin/users/stale-target/ban').set('Origin', origin)
        .send({ reason: 'expired marker', confirm: true }).expect(403);
    assert.equal(expired.body.code, 'ADMIN_STEP_UP_REQUIRED');
});

test('recovery codes are shown once, rotate as a batch, consume once and revoke prior step-up state', async (t) => {
    const { app, session, store } = await harness(t, { actorId: 'recovery-admin' });
    const first = await request(app)
        .post('/api/v1/admin/security/recovery-codes').set('Origin', origin)
        .send({ reason: 'initial recovery set', confirm: true }).expect(201);
    assert.equal(first.body.shownOnce, true);
    assert.equal(first.body.codes.length, 10);
    const oldCode = first.body.codes[0];
    const second = await request(app)
        .post('/api/v1/admin/security/recovery-codes').set('Origin', origin)
        .send({ reason: 'rotate recovery set', confirm: true }).expect(201);
    const rotatedOut = await request(app)
        .post('/api/v1/admin/security/recovery/use').set('Origin', origin)
        .send({ code: oldCode, password: 'correct-password', totpCode: '123456', confirm: true }).expect(403);
    assert.equal(rotatedOut.body.code, 'ADMIN_RECOVERY_CODE_INVALID');

    const activeCode = second.body.codes[0];
    await request(app)
        .post('/api/v1/admin/security/recovery/use').set('Origin', origin)
        .send({ code: activeCode, password: 'correct-password', totpCode: '123456', confirm: true }).expect(200);
    assert.equal(await store.getAdminReauthentication(sessionBinding(session), 'recovery-admin'), null);
    const replay = await request(app)
        .post('/api/v1/admin/security/recovery/use').set('Origin', origin)
        .send({ code: activeCode, password: 'correct-password', totpCode: '123456', confirm: true }).expect(403);
    assert.equal(replay.body.code, 'ADMIN_RECOVERY_CODE_INVALID');
});

test('privileged passkey removal is origin-checked, WebAuthn-authorized and concurrent-final-key safe', async (t) => {
    const { app, session, store } = await harness(t, { actorId: 'passkey-admin', webAuthnRequired: true });
    store.adminPasskeys.set('passkey-primary', { id: 'passkey-primary', userId: 'passkey-admin', name: 'Primary', deviceType: 'singleDevice', backedUp: false, createdAt: new Date().toISOString() });
    store.adminPasskeys.set('passkey-backup', { id: 'passkey-backup', userId: 'passkey-admin', name: 'Backup', deviceType: 'singleDevice', backedUp: false, createdAt: new Date().toISOString() });
    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session),
        userId: 'passkey-admin',
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        method: 'webauthn',
        securityVersion: 1
    });

    const untrusted = await request(app)
        .post('/api/auth/passkey/delete-passkey')
        .send({ id: 'passkey-primary' })
        .expect(403);
    assert.equal(untrusted.body.code, 'UNTRUSTED_MUTATION_ORIGIN');

    const attempts = await Promise.all([
        request(app).post('/api/auth/passkey/delete-passkey').set('Origin', origin).send({ id: 'passkey-primary' }),
        request(app).post('/api/auth/passkey/delete-passkey').set('Origin', origin).send({ id: 'passkey-backup' })
    ]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 409]);
    assert.equal(attempts.find((result) => result.status === 409).body.code, 'ADMIN_FINAL_PASSKEY_REQUIRED');
    assert.equal(await store.countUserPasskeys('passkey-admin'), 1);
    assert.equal(store.auditLog.filter((event) => event.action === 'security.webauthn_removed').length, 1);
});

test('privileged password change forces official session revocation and invalidates stale security state', async (t) => {
    const config = loadConfig({ NODE_ENV: 'development', APP_URL: 'http://localhost:8080', CORS_ORIGINS: 'http://localhost:8080', WORKER_ENABLED: 'false' });
    const store = new MemoryPlatformStore();
    const session = {
        user: { id: 'password-admin', email: 'password-admin@example.test', emailVerified: true, twoFactorEnabled: true },
        session: { id: 'password-admin-session', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    };
    await store.registerUser({ id: session.user.id, name: 'Password Admin', email: session.user.email });
    await store.upsertAdminAccount({ userId: session.user.id, email: session.user.email, role: 'admin', active: true });
    await store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: session.user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), method: 'password_totp', securityVersion: 1 });
    let officialBody = null;
    const authService = {
        enabled: true,
        async session() { return session; },
        async handler(requestContext, response) { officialBody = requestContext.body; response.status(200).json({ status: true }); },
        async close() {}
    };
    const app = createApp({ config, platformStore: store, authService, logger });
    t.after(() => app.locals.closeResources());

    await request(app).post('/api/auth/change-password').set('Origin', 'http://localhost:8080').send({ currentPassword: 'old-password', newPassword: 'new-password', revokeOtherSessions: false }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(officialBody.revokeOtherSessions, true);
    assert.equal((await store.getAdminAccount(session.user.id)).securityVersion, 2);
    assert.equal(await store.getAdminReauthentication(sessionBinding(session), session.user.id), null);
    assert.equal(store.auditLog.filter((event) => event.action === 'security.password_changed').length, 1);
});
