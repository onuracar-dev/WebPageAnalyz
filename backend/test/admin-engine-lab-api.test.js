const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { sessionBinding } = require('../auth/security');

const logger = { info() {}, warn() {}, error() {} };

async function appFor(t, role = 'admin', env = {}) {
    const config = loadConfig({ NODE_ENV: 'production', ADMIN_WEBAUTHN_REQUIRED: 'false', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example', WORKER_ENABLED: 'false', RATE_LIMIT_MAX: '1000', ADMIN_RATE_LIMIT_MAX: '1000', ...env });
    const session = { user: { id: `${role}-1`, email: `${role}@example.com`, emailVerified: true, twoFactorEnabled: true }, session: { id: `${role}-session` } };
    const store = new MemoryPlatformStore();
    await store.upsertAdminAccount({ userId: session.user.id, email: session.user.email, role, active: true });
    await store.recordAdminReauthentication({ sessionId: sessionBinding(session), userId: session.user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + config.adminReauthMaxAgeMs) });
    const calls = [];
    const cancelCalls = [];
    const engineLabService = {
        catalog: () => [{ id: 'lighthouse', label: 'Lighthouse' }], listRuns: () => [], getRun: (id) => ({ id }), close() {},
        async getArtifact(runId, engineId, filename) {
            assert.equal(runId, 'lab-1');
            assert.equal(engineId, 'wpaPage');
            assert.equal(filename, 'desktop.png');
            return { buffer: Buffer.from('png-bytes'), mimeType: 'image/png' };
        },
        async createRun(input) { calls.push(input); return { id: 'lab-1', status: 'queued', engines: [] }; },
        async cancelRun(id, actorId, context) { cancelCalls.push({ id, actorId, context }); return { id, actorId, status: 'cancelled' }; }
    };
    const app = createApp({
        config, platformStore: store, logger, engineLabService,
        authService: { async session() { return session; }, async close() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, port: 443, address: '8.8.8.8' }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    return { app, calls, cancelCalls };
}

test('reauthenticated admin can inspect catalog and start selected engines', async (t) => {
    const { app, calls } = await appFor(t, 'admin');
    const catalog = await request(app).get('/api/v1/admin/engine-lab/catalog').expect(200);
    assert.equal(catalog.body.engines[0].id, 'lighthouse');
    const response = await request(app).post('/api/v1/admin/engine-lab/runs')
        .set('Origin', 'https://dashboard.example')
        .set('Idempotency-Key', 'engine-lab-api-request-0001')
        .field('targetUrl', 'https://example.com/')
        .field('engineIds', JSON.stringify(['lighthouse']))
        .field('crawlerLimit', '25')
        .expect(202);
    assert.equal(response.body.run.id, 'lab-1');
    assert.deepEqual(calls[0].engineIds, ['lighthouse']);
    assert.equal(calls[0].actorId, 'admin-1');
    assert.equal(calls[0].idempotencyKey, 'engine-lab-api-request-0001');
    assert.match(calls[0].requestFingerprint, /^[a-f0-9]{64}$/);
});

test('Engine Lab accepts the portal default Journey definition across the multipart API boundary', async (t) => {
    const { app, calls } = await appFor(t, 'admin');
    const journey = {
        name: 'Landing page renders',
        steps: [
            { action: 'goto', path: '/' },
            { action: 'expectVisible', selector: 'body' }
        ]
    };
    await request(app).post('/api/v1/admin/engine-lab/runs')
        .set('Origin', 'https://dashboard.example')
        .field('targetUrl', 'https://example.com/')
        .field('engineIds', JSON.stringify(['journey']))
        .field('journey', JSON.stringify(journey))
        .field('crawlerLimit', '25')
        .expect(202);
    assert.deepEqual(calls[0].journey, journey);
    assert.deepEqual(calls[0].engineIds, ['journey']);
});

test('Engine Lab uses administrator budgets instead of the customer scan rate limit', async (t) => {
    const { app, calls } = await appFor(t, 'admin', {
        ANALYZE_RATE_LIMIT_MAX: '1',
        ADMIN_MUTATION_RATE_LIMIT_MAX: '10'
    });
    const start = (key) => request(app).post('/api/v1/admin/engine-lab/runs')
        .set('Origin', 'https://dashboard.example')
        .set('Idempotency-Key', key)
        .field('targetUrl', 'https://example.com/')
        .field('engineIds', JSON.stringify(['lighthouse']))
        .field('crawlerLimit', '25');

    await start('engine-lab-admin-budget-0001').expect(202);
    await start('engine-lab-admin-budget-0002').expect(202);
    assert.equal(calls.length, 2);
});

test('admin can retrieve a protected Lab screenshot with hardened response headers', async (t) => {
    const { app } = await appFor(t, 'admin');
    const response = await request(app)
        .get('/api/v1/admin/engine-lab/runs/lab-1/artifacts/wpaPage/desktop.png')
        .expect(200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.body, Buffer.from('png-bytes'));
});

test('Engine Lab cancellation requires a confirmed reason and forwards the HTTP request ID', async (t) => {
    const { app, cancelCalls } = await appFor(t, 'admin');
    await request(app).post('/api/v1/admin/engine-lab/runs/lab-1/cancel')
        .set('Origin', 'https://dashboard.example')
        .send({ reason: 'Stop invalid bounded run', confirm: true })
        .expect(200);
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].context.reason, 'Stop invalid bounded run');
    assert.match(cancelCalls[0].context.requestId, /^[0-9a-f-]{36}$/);
    await request(app).post('/api/v1/admin/engine-lab/runs/lab-1/cancel')
        .set('Origin', 'https://dashboard.example')
        .send({ reason: 'Missing confirmation' })
        .expect(400);
    assert.equal(cancelCalls.length, 1);
});

test('operator cannot use Engine Lab and malformed selections fail before service execution', async (t) => {
    const operator = await appFor(t, 'operator');
    await request(operator.app).get('/api/v1/admin/engine-lab/catalog').expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_PERMISSION_DENIED'));
    const admin = await appFor(t, 'admin');
    await request(admin.app).post('/api/v1/admin/engine-lab/runs')
        .set('Origin', 'https://dashboard.example')
        .field('targetUrl', 'https://example.com/')
        .field('engineIds', JSON.stringify(['unknown']))
        .expect(400).expect(({ body }) => assert.equal(body.code, 'VALIDATION_ERROR'));
    assert.equal(admin.calls.length, 0);
});
