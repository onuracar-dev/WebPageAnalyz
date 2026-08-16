const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { operationFingerprint } = require('../domain/idempotency');
const { sessionBinding } = require('../auth/security');
const { stableWorkspaceId } = require('../auth/better-auth');

const NOW = new Date('2026-08-15T12:00:00.000Z');
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';

test('migration 036 backfills deterministic sponsors and makes user ownership the durable quota authority', async () => {
    const sql = await fs.readFile(path.resolve(__dirname, '../db/migrations/036_user_commercial_ownership.sql'), 'utf8');
    for (const contract of [
        'wpa_user_entitlement_profiles', 'wpa_user_plan_changes', 'wpa_commercial_ownership_migration_conflicts',
        'entitlement_owner_user_id', 'requested_by_user_id', 'entitlement_user_id', 'max_per_user',
        'WPA_COMMERCIAL_OWNERSHIP_BACKFILL_UNRESOLVED', 'wpa_user_plan_changes_immutable',
        'wpa_checkout_one_open_user_intent_idx', 'wpa_subscriptions_user_idx'
    ]) assert.match(sql, new RegExp(contract));
    assert.match(sql, /ALTER TABLE wpa_entitlement_grants ALTER COLUMN user_id SET NOT NULL/);
    assert.match(sql, /ALTER TABLE wpa_credit_entries ALTER COLUMN entitlement_user_id SET NOT NULL/);
    assert.match(sql, /ON wpa_credit_entries\(entitlement_user_id,period_start,state\)/);
    assert.match(sql, /ON wpa_ai_usage\(entitlement_user_id,created_at\)/);
});

async function register(store, id) {
    return store.registerUser({ id, name: id, email: `${id}@example.com` });
}

async function sponsoredWorkspace(store, workspaceId, entitlementOwnerUserId) {
    return store.ensureWorkspace(workspaceId, { name: workspaceId, entitlementOwnerUserId });
}

function commercialContext(userId, operation, payload) {
    return {
        actorId: 'admin-commercial',
        reason: 'commercial ownership contract',
        requestId: `request-${operation}`,
        idempotencyKey: `${operation}-operation-0001`,
        requestFingerprint: operationFingerprint({ userId, ...payload })
    };
}

function scanManifest(planId = 'free') {
    return {
        schemaVersion: 2,
        project: { origin: 'https://example.com/' },
        plan: { id: planId, limits: { pageCredits: 5 } },
        entitlements: {},
        urls: ['https://example.com/']
    };
}

function aiRequest({ requesterUserId, entitlementUserId, suffix }) {
    return {
        userId: requesterUserId,
        entitlementUserId,
        findingFingerprint: `finding-${suffix}`,
        requestedModel: 'requested-model',
        provider: 'provider',
        promptVersion: 'prompt-v1',
        evidenceVersion: `evidence-${suffix}`,
        idempotencyKey: `ai-generation-${suffix}`
    };
}

test('user commercial plan, credits, and feature grants follow the sponsor across workspaces without becoming another member\'s rights', async () => {
    const store = new MemoryPlatformStore();
    await register(store, 'user-sponsor');
    await register(store, 'user-member');
    await sponsoredWorkspace(store, 'ws-sponsored-a', 'user-sponsor');
    await sponsoredWorkspace(store, 'ws-sponsored-b', 'user-sponsor');

    await store.assignUserPlan('user-sponsor', 'studio', commercialContext('user-sponsor', 'assign-plan', { planId: 'studio' }));
    await store.adjustUserCredits('user-sponsor', 'page', 11, commercialContext('user-sponsor', 'page-credit', { kind: 'page', amount: 11 }));
    await store.adjustUserCredits('user-sponsor', 'ai', 13, commercialContext('user-sponsor', 'ai-credit', { kind: 'ai', amount: 13 }));
    await store.grantUserEntitlement('user-sponsor', {
        source: 'admin',
        entitlementOverrides: { expert_review: { executionMode: 'operator_assisted', limit: 1 } },
        startsAt: '2026-08-01T00:00:00.000Z',
        expiresAt: EXPIRES_AT
    }, commercialContext('user-sponsor', 'feature-grant', {
        moduleId: 'expert_review', executionMode: 'operator_assisted', limit: 1,
        startsAt: '2026-08-01T00:00:00.000Z', expiresAt: EXPIRES_AT
    }));

    assert.equal(await store.resolveEntitlementUser('ws-sponsored-a', 'user-sponsor'), 'user-sponsor');
    assert.equal(await store.resolveEntitlementUser('ws-sponsored-b', 'user-sponsor'), 'user-sponsor');
    assert.equal(await store.resolveEntitlementUser('ws-sponsored-a', 'user-member'), 'user-sponsor');

    const sponsor = await store.getUserEffectiveEntitlements('user-sponsor', NOW);
    const member = await store.getUserEffectiveEntitlements('user-member', NOW);
    assert.equal(sponsor.effectivePlanId, 'studio');
    assert.equal(sponsor.limits.pageCredits, 161);
    assert.equal(sponsor.limits.aiRemediations, 1013);
    assert.deepEqual(sponsor.entitlements.expert_review, { executionMode: 'operator_assisted', limit: 1 });
    assert.equal(member.effectivePlanId, 'free');
    assert.equal(member.limits.pageCredits, 5);
    assert.equal(member.limits.aiRemediations, 5);
    assert.equal(member.entitlements.expert_review, undefined);
});

test('page quota is atomically aggregated by entitlement user across two workspaces and isolated from another user', async () => {
    const store = new MemoryPlatformStore();
    await register(store, 'page-sponsor');
    await register(store, 'page-other');
    await sponsoredWorkspace(store, 'ws-page-a', 'page-sponsor');
    await sponsoredWorkspace(store, 'ws-page-b', 'page-sponsor');
    await sponsoredWorkspace(store, 'ws-page-other', 'page-other');

    const scanA = await store.createScan('ws-page-a', 'project-a', scanManifest(), { requestedByUserId: 'page-sponsor', entitlementUserId: 'page-sponsor' });
    const scanB = await store.createScan('ws-page-b', 'project-b', scanManifest(), { requestedByUserId: 'page-sponsor', entitlementUserId: 'page-sponsor' });
    const reservations = Array.from({ length: 6 }, (_, index) => {
        const workspaceId = index % 2 === 0 ? 'ws-page-a' : 'ws-page-b';
        const scanId = index % 2 === 0 ? scanA.id : scanB.id;
        return store.reserveCredit(workspaceId, scanId, `page-${index}`, 5, NOW, 'page-sponsor');
    });
    const results = await Promise.allSettled(reservations);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    const rejected = results.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 5);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'PAGE_CREDIT_LIMIT_REACHED');
    assert.deepEqual(await store.getUsage('page-sponsor', NOW), {
        periodStart: '2026-08-01', reserved: 5, consumed: 0
    });

    const otherScan = await store.createScan('ws-page-other', 'project-other', scanManifest(), { requestedByUserId: 'page-other', entitlementUserId: 'page-other' });
    await store.reserveCredit('ws-page-other', otherScan.id, 'other-page', 5, NOW, 'page-other');
    assert.equal((await store.getUsage('page-other', NOW)).reserved, 1);
    assert.equal((await store.getUsage('page-sponsor', NOW)).reserved, 5);
});

test('AI quota aggregates by entitlement user across workspaces and remains isolated for another entitlement user', async () => {
    const store = new MemoryPlatformStore();
    await register(store, 'ai-sponsor');
    await register(store, 'ai-other');
    await sponsoredWorkspace(store, 'ws-ai-a', 'ai-sponsor');
    await sponsoredWorkspace(store, 'ws-ai-b', 'ai-sponsor');
    await sponsoredWorkspace(store, 'ws-ai-other', 'ai-other');

    const reservations = Array.from({ length: 6 }, (_, index) => {
        const workspaceId = index % 2 === 0 ? 'ws-ai-a' : 'ws-ai-b';
        return store.consumeAiGeneration(workspaceId, aiRequest({ requesterUserId: 'ai-sponsor', entitlementUserId: 'ai-sponsor', suffix: `sponsor-${index}` }), { now: NOW });
    });
    const results = await Promise.allSettled(reservations);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    const rejected = results.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 5);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'AI_REMEDIATION_LIMIT_REACHED');
    assert.equal(Math.max(...fulfilled.map((entry) => entry.value.quota.used)), 5);

    const other = await store.consumeAiGeneration('ws-ai-other', aiRequest({ requesterUserId: 'ai-other', entitlementUserId: 'ai-other', suffix: 'other-0' }), { now: NOW });
    assert.equal(other.quota.limit, 5);
    assert.equal(other.quota.used, 1);
    assert.equal(other.quota.remaining, 4);
});

test('dashboard reports remaining user-owned allowances without guessing from workspace-local rows', async (t) => {
    const now = new Date();
    const periodStart = `${now.toISOString().slice(0, 7)}-01`;
    const user = { id: 'allowance-user', name: 'Allowance User', email: 'allowance-user@example.com', emailVerified: true };
    const session = { user, session: { id: 'allowance-session' } };
    const workspaceId = stableWorkspaceId(user.id);
    const store = new MemoryPlatformStore();
    await store.registerUser(user);
    await sponsoredWorkspace(store, workspaceId, user.id);
    const project = await store.createProject(workspaceId, { name: 'Allowance target', origin: 'https://example.com/', locale: 'en' }, { entitlementUserId: user.id });
    const scan = await store.createScan(workspaceId, project.id, scanManifest(), { requestedByUserId: user.id, entitlementUserId: user.id });
    await store.reserveCredit(workspaceId, scan.id, 'page-one', 5, now, user.id);
    await store.reserveCredit(workspaceId, scan.id, 'page-two', 5, now, user.id);
    await store.consumeAiGeneration(workspaceId, aiRequest({ requesterUserId: user.id, entitlementUserId: user.id, suffix: 'allowance' }), { now });

    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example', WORKER_ENABLED: 'false', RATE_LIMIT_MAX: '1000' });
    const app = createApp({
        config,
        platformStore: store,
        authService: { async session() { return session; }, async close() {} },
        logger: { info() {}, warn() {}, error() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, port: 443, address: '8.8.8.8' }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    const origin = { Origin: 'https://dashboard.example' };
    await request(app).post('/api/v1/legal/acceptances').set(origin).send({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' }).expect(201);
    const dashboard = await request(app).get('/api/v1/dashboard').set(origin).expect(200);

    assert.deepEqual(dashboard.body.allowances, {
        periodStart,
        pageCredits: { limit: 5, used: 2, remaining: 3, consumed: 0, reserved: 2 },
        aiRemediations: { limit: 5, used: 1, remaining: 4 },
        projects: { limit: 1, used: 1, remaining: 0 },
        sourceAudits: { limit: 0, used: 0, remaining: 0 }
    });
});

test('scan snapshot preserves both requester and commercial sponsor identities', async () => {
    const store = new MemoryPlatformStore();
    await register(store, 'scan-sponsor');
    await register(store, 'scan-member');
    await sponsoredWorkspace(store, 'ws-scan-sponsored', 'scan-sponsor');

    const scan = await store.createScan('ws-scan-sponsored', 'project-scan', scanManifest('studio'), {
        requestedByUserId: 'scan-member',
        entitlementUserId: 'scan-sponsor',
        idempotencyKey: 'scan-sponsor-snapshot-0001',
        requestFingerprint: operationFingerprint({ projectId: 'project-scan', requestedByUserId: 'scan-member', entitlementUserId: 'scan-sponsor' })
    });
    assert.equal(scan.requestedByUserId, 'scan-member');
    assert.equal(scan.entitlementUserId, 'scan-sponsor');

    const durable = await store.getScan('ws-scan-sponsored', scan.id);
    assert.equal(durable.requestedByUserId, 'scan-member');
    assert.equal(durable.entitlementUserId, 'scan-sponsor');
});

test('user plan assignment replays one mutation and rejects an idempotency key with a changed fingerprint', async () => {
    const store = new MemoryPlatformStore();
    await register(store, 'plan-user');
    const context = commercialContext('plan-user', 'plan-replay', { planId: 'studio' });

    const results = await Promise.all([
        store.assignUserPlan('plan-user', 'studio', context),
        store.assignUserPlan('plan-user', 'studio', context)
    ]);
    assert.deepEqual(results.map((entry) => entry.idempotent).sort(), [false, true]);
    assert.equal(results[0].profile.planId, 'studio');
    assert.equal(results[1].profile.planId, 'studio');
    assert.equal(store.auditLog.filter((entry) => entry.action === 'user.plan_changed').length, 1);

    await assert.rejects(() => store.assignUserPlan('plan-user', 'enterprise', {
        ...context,
        requestFingerprint: operationFingerprint({ userId: 'plan-user', planId: 'enterprise' })
    }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    assert.equal((await store.getUserEffectiveEntitlements('plan-user', NOW)).effectivePlanId, 'studio');
});

test('admin HTTP contract mutates user-owned commercial access and leaves workspace commercial routes absent', async (t) => {
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example', WORKER_ENABLED: 'false', RATE_LIMIT_MAX: '1000', ADMIN_RATE_LIMIT_MAX: '1000' });
    const store = new MemoryPlatformStore();
    await register(store, 'http-customer');
    await sponsoredWorkspace(store, 'http-workspace-a', 'http-customer');
    await sponsoredWorkspace(store, 'http-workspace-b', 'http-customer');
    const session = { user: { id: 'http-admin', email: 'admin@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'http-admin-session' } };
    await store.upsertAdminAccount({ userId: session.user.id, email: session.user.email, role: 'super_admin', active: true });
    store.adminPasskeys.set('http-admin-passkey', { id: 'http-admin-passkey', userId: session.user.id, name: 'HTTP test key', deviceType: 'singleDevice', backedUp: false, createdAt: new Date().toISOString() });
    await store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: session.user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + config.adminReauthMaxAgeMs), method: 'webauthn', securityVersion: 1 });
    const app = createApp({
        config, platformStore: store,
        authService: { async session() { return session; }, async close() {} },
        logger: { info() {}, warn() {}, error() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, port: 443, address: '8.8.8.8' }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    const origin = { Origin: 'https://dashboard.example' };

    await request(app).post('/api/v1/admin/users/http-customer/credits').set(origin).set('Idempotency-Key', 'http-credit-1').send({ kind: 'page', amount: 7, reason: 'Customer support credit', confirm: true }).expect(201);
    await request(app).post('/api/v1/admin/users/http-customer/entitlements').set(origin).set('Idempotency-Key', 'http-feature-1').send({ moduleId: 'expert_review', executionMode: 'operator_assisted', expiresAt: EXPIRES_AT, reason: 'Approved customer feature', confirm: true }).expect(201);
    await request(app).post('/api/v1/admin/users/http-customer/plan').set(origin).set('Idempotency-Key', 'http-plan-1').send({ planId: 'studio', reason: 'Approved customer plan', confirm: true }).expect(201);

    const detail = await request(app).get('/api/v1/admin/users/http-customer').expect(200);
    assert.equal(detail.body.user.user.id, 'http-customer');
    assert.equal(detail.body.user.profile.planId, 'studio');
    assert.equal(detail.body.user.effective.limits.pageCredits, 157);
    assert.equal(detail.body.user.workspaces.length, 2);
    assert.equal(detail.body.user.grants.length, 1);
    assert.equal(detail.body.user.creditAdjustments.length, 1);
    assert.equal((await store.getWorkspace('http-workspace-a')).planId, 'free');
    assert.equal((await store.getWorkspace('http-workspace-b')).planId, 'free');

    for (const legacy of [
        request(app).post('/api/v1/admin/workspaces/http-workspace-a/credits').set(origin).send({ kind: 'page', amount: 7, reason: 'Old route must stay gone', confirm: true }),
        request(app).post('/api/v1/admin/workspaces/http-workspace-a/entitlements').set(origin).send({ moduleId: 'expert_review', executionMode: 'operator_assisted', expiresAt: EXPIRES_AT, reason: 'Old route must stay gone', confirm: true }),
        request(app).post('/api/v1/admin/workspaces/http-workspace-a/plan').set(origin).send({ planId: 'enterprise', reason: 'Old route must stay gone', confirm: true })
    ]) {
        const denied = await legacy.expect(403);
        assert.equal(denied.body.code, 'ADMIN_ROUTE_POLICY_MISSING');
    }
});
