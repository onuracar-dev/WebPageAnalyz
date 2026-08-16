const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { sessionBinding } = require('../auth/security');
const { operationFingerprint } = require('../domain/idempotency');

const logger = { info() {}, warn() {}, error() {} };

async function appFor(t, { role = 'admin' } = {}) {
    const config = loadConfig({ NODE_ENV: 'production', ADMIN_WEBAUTHN_REQUIRED: 'false', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example', WORKER_ENABLED: 'false', RATE_LIMIT_MAX: '1000', ADMIN_RATE_LIMIT_MAX: '1000' });
    const session = { user: { id: 'admin-audit', email: 'audit@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'admin-audit-session' } };
    const store = new MemoryPlatformStore();
    await store.upsertAdminAccount({ userId: session.user.id, email: session.user.email, role, active: true });
    await store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: session.user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + config.adminReauthMaxAgeMs) });
    const calls = [];
    const platformService = {
        async close() {},
        async adminResources(...args) { calls.push({ operation: 'adminResources', args }); return store.adminResources(...args); },
        async cancelScan(...args) { calls.push({ operation: 'cancelScan', args }); return { id: args[1], status: 'cancelled' }; },
        async retryScan(...args) { calls.push({ operation: 'retryScan', args }); return { id: args[1], status: 'queued' }; },
        async claimExpertReview(...args) { calls.push({ operation: 'claimExpertReview', args }); return { id: args[0], status: 'in_review' }; },
        async decideExpertFinding(...args) { calls.push({ operation: 'decideExpertFinding', args }); return { id: args[0], status: 'in_review' }; },
        async setExpertRoadmap(...args) { calls.push({ operation: 'setExpertRoadmap', args }); return { id: args[0], status: 'in_review' }; },
        async completeOperatorTask(...args) { calls.push({ operation: 'completeOperatorTask', args }); return { id: args[0], status: 'completed' }; },
        async grantUserEntitlement(...args) { calls.push({ operation: 'grantUserEntitlement', args }); return { id: 'grant-1', userId: args[0], ...args[1] }; },
        async getUserEffectiveEntitlements(...args) { calls.push({ operation: 'getUserEffectiveEntitlements', args }); return { entitlements: {} }; },
        async createRedeemCode(...args) { calls.push({ operation: 'createRedeemCode', args }); return { id: 'redeem-1' }; }
    };
    const app = createApp({
        config, platformStore: store, platformService, logger,
        authService: { async session() { return session; }, async close() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, port: 443, address: '8.8.8.8' }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    return { app, calls, store };
}

test('audit resource includes safe actor, affected user and operation snapshots', async (t) => {
    const { app, store } = await appFor(t);
    await store.registerUser({ id: 'admin-audit', name: 'Audit Admin', email: 'audit@example.com' });
    await store.registerUser({ id: 'user-credit-target', name: 'Credit Target', email: 'target@example.com' });
    await store.logAudit({
        workspaceId: 'workspace-credit-target',
        actorId: 'admin-audit',
        action: 'user.credits_granted',
        entityType: 'user_credit_adjustment',
        entityId: 'credit-adjustment-1',
        reason: 'Restore credits after a failed scan.',
        requestId: 'request-credit-1',
        before: null,
        after: { userId: 'user-credit-target', creditType: 'ai', amount: 25 },
        metadata: { targetUserId: 'user-credit-target', creditType: 'ai', amount: 25, apiToken: 'must-not-leak' }
    });

    const response = await request(app)
        .get('/api/v1/admin/resources/audit')
        .set('Origin', 'https://dashboard.example')
        .expect(200);

    assert.equal(response.body.resources.length, 1);
    assert.deepEqual(response.body.resources[0].actor, { id: 'admin-audit', name: 'Audit Admin', email: 'audit@example.com' });
    assert.deepEqual(response.body.resources[0].targetUser, { id: 'user-credit-target', name: 'Credit Target', email: 'target@example.com' });
    assert.deepEqual(response.body.resources[0].after, { userId: 'user-credit-target', creditType: 'ai', amount: 25 });
    assert.equal(response.body.resources[0].metadata.apiToken, '[REDACTED]');
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
});

test('admin mutation routes keep idempotency input separate and forward reason plus HTTP request ID', async (t) => {
    const { app, calls } = await appFor(t);
    const origin = { Origin: 'https://dashboard.example' };
    await request(app).post('/api/v1/admin/workspaces/ws-1/scans/scan-1/cancel').set(origin).set('X-Request-Id', 'http-cancel').send({ reason: 'Stop stuck scan', confirm: true, idempotencyKey: 'cancel-click-1' }).expect(200);
    await request(app).post('/api/v1/admin/workspaces/ws-1/scans/scan-1/retry').set(origin).set('X-Request-Id', 'http-retry').send({ reason: 'Provider recovered', confirm: true, idempotencyKey: 'retry-click-1' }).expect(202);
    await request(app).post('/api/v1/admin/expert-reviews/review-1/claim').set(origin).set('X-Request-Id', 'http-claim').send({ reason: 'Assigned queue review', confirm: true }).expect(200);
    await request(app).put('/api/v1/admin/expert-reviews/review-1/findings/finding-1').set(origin).set('X-Request-Id', 'http-decision').send({ decision: 'accepted', priority: 'p1', rationale: '', reason: 'Evidence accepted', confirm: true }).expect(200);
    await request(app).put('/api/v1/admin/expert-reviews/review-1/roadmap').set(origin).set('X-Request-Id', 'http-roadmap').send({ items: [], reason: 'Roadmap intentionally empty', confirm: true }).expect(200);
    await request(app).post('/api/v1/admin/operator-tasks/task-1/complete').set(origin).set('X-Request-Id', 'http-task').send({ notes: 'Reviewed.', reason: 'Operator evidence complete', confirm: true }).expect(200);

    const cancel = calls.find((entry) => entry.operation === 'cancelScan');
    assert.equal(cancel.args[2].idempotencyKey, 'cancel-click-1');
    assert.equal(cancel.args[4], 'http-cancel');
    const retry = calls.find((entry) => entry.operation === 'retryScan');
    assert.equal(retry.args[2].idempotencyKey, 'retry-click-1');
    assert.equal(retry.args[4], 'http-retry');
    assert.deepEqual(calls.find((entry) => entry.operation === 'claimExpertReview').args[2], { reason: 'Assigned queue review', requestId: 'http-claim' });
    const decision = calls.find((entry) => entry.operation === 'decideExpertFinding');
    assert.equal(Object.hasOwn(decision.args[2], 'confirm'), false);
    assert.deepEqual(decision.args[4], { reason: 'Evidence accepted', requestId: 'http-decision' });
    assert.deepEqual(calls.find((entry) => entry.operation === 'setExpertRoadmap').args[3], { reason: 'Roadmap intentionally empty', requestId: 'http-roadmap' });
    assert.equal(calls.find((entry) => entry.operation === 'completeOperatorTask').args[3], 'http-task');
});

test('central admin mutation routes reject missing explicit confirmation before service execution', async (t) => {
    const { app, calls } = await appFor(t);
    await request(app).post('/api/v1/admin/expert-reviews/review-1/claim')
        .set('Origin', 'https://dashboard.example')
        .send({ reason: 'Missing confirmation' })
        .expect(400);
    await request(app).post('/api/v1/admin/operator-tasks/task-1/complete')
        .set('Origin', 'https://dashboard.example')
        .send({ notes: 'Missing reason and confirmation' })
        .expect(400);
    assert.equal(calls.length, 0);
});

test('admin entitlement APIs reject unknown and non-executable module grants before mutation', async (t) => {
    const { app, calls } = await appFor(t, { role: 'super_admin' });
    const origin = { Origin: 'https://dashboard.example' };
    const expiresAt = '2099-01-01T00:00:00.000Z';
    for (const moduleId of ['monitoring', 'white_label', 'not_a_module']) {
        await request(app).post('/api/v1/admin/users/user-1/entitlements').set(origin).send({
            moduleId, executionMode: 'automated', expiresAt, reason: `Reject ${moduleId}`, confirm: true
        }).expect(400);
        await request(app).put(`/api/v1/admin/plans/signal/entitlements/${moduleId}`).set(origin).send({
            executionMode: 'automated', reason: `Reject ${moduleId}`, confirm: true
        }).expect(400);
    }
    await request(app).post('/api/v1/admin/redeem-codes').set(origin).send({
        code: 'BLOCK2026', maxGlobalRedemptions: 1,
        entitlementOverrides: { monitoring: { executionMode: 'automated' } },
        reason: 'Must reject non-executable grant', confirm: true
    }).expect(400);
    assert.equal(calls.some((entry) => ['grantUserEntitlement', 'createRedeemCode'].includes(entry.operation)), false);

    const grantBody = {
        moduleId: 'expert_review', executionMode: 'operator_assisted', expiresAt,
        reason: 'Assign scoped Expert Review', confirm: true
    };
    await request(app).post('/api/v1/admin/users/user-1/entitlements').set(origin).set('X-Request-Id', 'grant-expert').set('Idempotency-Key', 'grant-expert-operation-1').send(grantBody).expect(201);
    const grant = calls.find((entry) => entry.operation === 'grantUserEntitlement');
    assert.deepEqual(grant.args, [
        'user-1',
        { source: 'admin', temporaryPlanId: null, entitlementOverrides: { expert_review: { executionMode: 'operator_assisted', limit: null } }, expiresAt },
        {
            actorId: 'admin-audit', reason: 'Assign scoped Expert Review', requestId: 'grant-expert',
            idempotencyKey: 'grant-expert-operation-1',
            requestFingerprint: operationFingerprint({ userId: 'user-1', ...grantBody })
        }
    ]);
    await request(app).put('/api/v1/admin/plans/signal/entitlements/expert_review').set(origin).set('X-Request-Id', 'plan-expert').send({
        executionMode: 'operator_assisted', limit: 1, reason: 'Keep Expert Review assignable', confirm: true
    }).expect(200).expect(({ body }) => assert.deepEqual(body.plan.entitlements.expert_review, { executionMode: 'operator_assisted', limit: 1 }));
});
