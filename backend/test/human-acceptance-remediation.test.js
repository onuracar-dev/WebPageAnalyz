const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { createPlatformService } = require('../platform/service');
const { MemoryPlatformStore } = require('../platform/store');
const { getPlan } = require('../domain/plans');

function serviceFor(store) {
    return createPlatformService({
        store,
        queue: {},
        analysisPool: { stats: { active: 0 } },
        analysisService: {},
        validateUrl: async (url) => ({ url }),
        config: {
            executionRole: 'api',
            browserExecutionDisabled: true,
            sourceExecutionDisabled: true,
            maxConcurrentAnalyses: 1,
            verificationTtlMs: 86_400_000
        },
        logger: { warn() {}, info() {}, error() {} }
    });
}

async function persona(store, userId, workspaceId, planId) {
    await store.registerUser({ id: userId, email: `${userId}@example.test` });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
    await store.assignWorkspaceEntitlementOwner(workspaceId, userId, { ifUnset: false });
    if (planId !== 'free') {
        await store.assignUserPlan(userId, planId, {
            actorId: 'qa-admin', reason: 'Focused commercial capability regression', requestId: `req-${userId}`
        });
    }
}

test('report export, comparison and sharing fail closed at the promised plan boundary', async () => {
    const store = new MemoryPlatformStore();
    const service = serviceFor(store);
    await persona(store, 'free-user', 'free-workspace', 'free');
    await persona(store, 'signal-user', 'signal-workspace', 'signal');
    await persona(store, 'studio-user', 'studio-workspace', 'studio');

    for (const capability of ['report_export', 'report_compare', 'report_share']) {
        await assert.rejects(
            service.assertCommercialCapability('free-workspace', 'free-user', capability),
            (error) => error.code === 'PLAN_UPGRADE_REQUIRED' && error.status === 403
        );
    }

    assert.equal((await service.assertCommercialCapability('signal-workspace', 'signal-user', 'report_export')).effectivePlanId, 'signal');
    for (const capability of ['report_compare', 'report_share']) {
        await assert.rejects(
            service.assertCommercialCapability('signal-workspace', 'signal-user', capability),
            (error) => error.code === 'PLAN_UPGRADE_REQUIRED' && error.status === 403
        );
    }

    for (const capability of ['report_export', 'report_compare', 'report_share']) {
        assert.equal((await service.assertCommercialCapability('studio-workspace', 'studio-user', capability)).effectivePlanId, 'studio');
    }
});

test('Enterprise is a strict Studio analysis-depth superset in the executable catalog', () => {
    const studio = getPlan('studio');
    const enterprise = getPlan('enterprise');
    assert.equal(enterprise.name, 'Enterprise');
    for (const moduleId of ['geo', 'design', 'backend_surface']) {
        assert.equal(enterprise.entitlements[moduleId].executionMode, studio.entitlements[moduleId].executionMode);
        assert.equal(enterprise.entitlements[moduleId].limit, studio.entitlements[moduleId].limit);
    }
    assert.equal(enterprise.entitlements.source_audit.limit, enterprise.limits.sourceAudits);
    for (const moduleId of ['full_site_crawl', 'performance_plus', 'passive_security']) {
        assert.ok(enterprise.entitlements[moduleId], `Enterprise must retain Studio module ${moduleId}`);
    }
    for (const planId of ['free', 'signal', 'studio', 'enterprise']) {
        assert.equal(getPlan(planId).features.some((feature) => /\bseats?\b/i.test(feature)), false, `${planId} must not advertise an unshipped seat-management workflow`);
    }
});

test('Free report HTTP routes deny commercial operations before report lookup or worker enqueue', async (t) => {
    const store = new MemoryPlatformStore();
    const workspaceId = 'free-http-workspace';
    await store.ensureWorkspace(workspaceId);
    const app = createApp({
        config: loadConfig({ NODE_ENV: 'development', WORKER_ENABLED: 'false', PDF_EXECUTION_DISABLED: 'true' }),
        platformStore: store,
        logger: { warn() {}, info() {}, error() {} }
    });
    t.after(() => app.locals.closeResources());

    for (const path of [
        '/api/v1/reports/not-a-report/export?format=json',
        '/api/v1/reports/not-a-report/export?format=pdf',
        '/api/v1/reports/compare/left/right'
    ]) {
        const response = await request(app).get(path).set('x-workspace-id', workspaceId).expect(403);
        assert.equal(response.body.code, 'PLAN_UPGRADE_REQUIRED');
    }
    const share = await request(app)
        .post('/api/v1/reports/not-a-report/share')
        .set('x-workspace-id', workspaceId)
        .send({ expiresInDays: 30 })
        .expect(403);
    assert.equal(share.body.code, 'PLAN_UPGRADE_REQUIRED');
});
