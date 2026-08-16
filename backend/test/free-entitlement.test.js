const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { stableWorkspaceId } = require('../auth/better-auth');
const { loadConfig } = require('../config');
const { createIntegrationService } = require('../integrations/service');
const { MemoryPlatformStore } = require('../platform/store');

const logger = { info() {}, warn() {}, error() {} };

test('a verified production session creates a stable personal workspace on the real Free plan', async (t) => {
    const config = loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://dashboard.example',
        APP_URL: 'https://dashboard.example',
        BETTER_AUTH_URL: 'https://dashboard.example',
        WORKER_ENABLED: 'false',
        RATE_LIMIT_MAX: '1000'
    });
    const user = { id: 'new-free-user', email: 'new-free@example.test', name: 'New User', emailVerified: true };
    const session = { user, session: { id: 'new-free-session' } };
    const store = new MemoryPlatformStore();
    const app = createApp({
        config,
        platformStore: store,
        logger,
        authService: { async session() { return session; }, async close() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, port: 443, address: '203.0.113.10' }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    const origin = { Origin: 'https://dashboard.example' };

    await request(app)
        .post('/api/v1/legal/acceptances')
        .set(origin)
        .send({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' })
        .expect(201);

    const response = await request(app).get('/api/v1/workspace').set(origin).expect(200);
    assert.equal(response.body.plan.id, 'free');
    const workspaceId = stableWorkspaceId(user.id);
    assert.equal(response.body.workspace.id, workspaceId);
    assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
});

test('Free workspace fails closed before configuring the paid report-webhook module', async () => {
    const workspaceId = 'ws_free_entitlement';
    const store = new MemoryPlatformStore();
    const workspace = await store.ensureWorkspace(workspaceId);
    assert.equal(workspace.planId, 'free');

    let validationCalls = 0;
    const service = createIntegrationService({
        config: loadConfig({
            NODE_ENV: 'test',
            APP_URL: 'https://wpa.example.com',
            BETTER_AUTH_URL: 'https://wpa.example.com'
        }),
        store,
        validateUrl: async (url) => {
            validationCalls += 1;
            return { url, hostname: new URL(url).hostname, address: '203.0.113.10', family: 4, port: 443 };
        },
        logger: { warn() {} }
    });

    const webhook = (await service.list(workspaceId)).find((item) => item.provider === 'webhook');
    assert.equal(webhook.available, false);

    await assert.rejects(
        () => service.configureWebhook(workspaceId, { url: 'https://hooks.example.com/wpa' }, 'free-user'),
        (error) => {
            assert.equal(error.code, 'MODULE_NOT_ENTITLED');
            assert.equal(error.status, 403);
            return true;
        }
    );

    assert.equal(validationCalls, 0, 'entitlement denial must happen before target validation or egress');
    assert.equal(await store.getIntegration(workspaceId, 'webhook'), null);
    assert.deepEqual(await store.listIntegrations(workspaceId), []);
});
