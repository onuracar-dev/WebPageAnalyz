const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');

const silentLogger = { info() {}, warn() {}, error() {} };
const report = {
    scores: { performance: 90, seo: 80, accessibility: 70, bestPractices: 60 },
    categories: { performance: [], seo: [], accessibility: [], bestPractices: [] }
};
const validTarget = {
    url: 'https://example.com/', hostname: 'example.com', port: 443,
    address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }]
};

function config(extra = {}) {
    return loadConfig({
        NODE_ENV: 'test',
        CORS_ORIGINS: 'https://dashboard.example',
        LEGACY_API_ENABLED: 'true',
        LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT: 'true',
        RATE_LIMIT_MAX: '1000',
        ANALYZE_RATE_LIMIT_MAX: '1000',
        AI_RATE_LIMIT_MAX: '1000',
        ...extra
    });
}

function app(options = {}) {
    return createApp({
        config: options.config || config(),
        logger: silentLogger,
        validateUrl: options.validateUrl || (async () => validTarget),
        analysisService: options.analysisService || { analyze: async () => report },
        geminiService: options.geminiService || {
            solveIssue: async () => 'solution',
            generateExecutiveSummary: async () => 'summary'
        },
        ...(options.platformService ? { platformService: options.platformService } : {}),
        clearArtifacts: options.clearArtifacts || (async () => 0)
    });
}

test('health endpoint exposes security headers and request ID', async () => {
    const response = await request(app()).get('/healthz').expect(200);
    assert.equal(response.body.status, 'ok');
    assert.ok(response.headers['x-request-id']);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
});

test('public legal config fails closed without operator identity and exposes no provider secrets', async () => {
    const response = await request(app()).get('/api/v1/legal/config').expect(200);
    assert.equal(response.body.ready, false);
    assert.equal(response.body.operator, null);
    assert.equal(response.body.documents.terms.version, '1.0');
    assert.equal(response.body.documents.privacy.version, '1.0');
    assert.equal(JSON.stringify(response.body).includes('API_KEY'), false);
    assert.equal(JSON.stringify(response.body).includes('webhookSecret'), false);
});

test('Terms and AUP acceptance stores current versions without fake privacy consent', async () => {
    const api = app();
    const response = await request(api).post('/api/v1/legal/acceptances')
        .set('X-Workspace-Id', 'ws_legal_acceptance')
        .send({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' })
        .expect(201);
    assert.equal(response.body.accepted, true);
    assert.deepEqual(response.body.acceptances.map((entry) => entry.documentType).sort(), ['acceptable_use', 'terms']);
    assert.equal(JSON.stringify(response.body).includes('privacy'), false);
});

test('CORS allows configured origins and rejects untrusted origins', async () => {
    await request(app()).get('/healthz').set('Origin', 'https://dashboard.example').expect('Access-Control-Allow-Origin', 'https://dashboard.example').expect(200);
    const rejected = await request(app()).get('/healthz').set('Origin', 'https://evil.example').expect(403);
    assert.equal(rejected.body.code, 'CORS_ORIGIN_DENIED');
});

test('public status is unauthenticated and omits private diagnostics', async (t) => {
    const api = app({ config: config({ NODE_ENV: 'production', APP_URL: 'https://dashboard.example', LEGACY_API_ENABLED: 'false', WORKER_ENABLED: 'false' }) });
    t.after(() => api.locals.closeResources());
    const publicStatus = await request(api).get('/api/v1/status').expect(200);
    assert.ok(publicStatus.body.checkedAt);
    assert.ok(['operational', 'degraded'].includes(publicStatus.body.overall));
    assert.ok(Array.isArray(publicStatus.body.components));
    assert.equal(publicStatus.body.components.find((component) => component.id === 'analysis')?.status, 'unavailable');
    assert.equal(publicStatus.body.overall, 'degraded');
    assert.equal(Object.hasOwn(publicStatus.body, 'analysisCapacity'), false);
    assert.equal(Object.hasOwn(publicStatus.body, 'aiConfigured'), false);
    assert.equal(Object.hasOwn(publicStatus.body, 'authConfigured'), false);
    await request(api).get('/api/v1/status/details').expect(401);
});

test('analysis rejects invalid and private URLs before analyzers run', async () => {
    let called = false;
    const api = createApp({
        config: config(),
        logger: silentLogger,
        analysisService: { analyze: async () => { called = true; return report; } },
        geminiService: { solveIssue: async () => '', generateExecutiveSummary: async () => '' }
    });
    await request(api).post('/api/analyze').send({ url: 'http://127.0.0.1/admin' }).expect(400).expect(({ body }) => {
        assert.equal(body.code, 'PRIVATE_TARGET_BLOCKED');
    });
    assert.equal(called, false);
});

test('analysis endpoint validates input and returns mocked report', async () => {
    await request(app()).post('/api/analyze').send({ url: 'https://example.com', unexpected: true }).expect(400);
    const response = await request(app()).post('/api/analyze').send({ url: 'https://example.com' }).expect(200);
    assert.equal(response.body.url, validTarget.url);
    assert.deepEqual(response.body.report, report);
});

test('malformed and oversized JSON receive stable errors', async () => {
    const invalid = await request(app()).post('/api/analyze').set('Content-Type', 'application/json').send('{nope').expect(400);
    assert.equal(invalid.body.code, 'INVALID_JSON');
    const oversized = await request(app()).post('/api/analyze').send({ url: `https://example.com/${'x'.repeat(40_000)}` }).expect(413);
    assert.equal(oversized.body.code, 'REQUEST_TOO_LARGE');
});

test('optional API key protects expensive endpoints when configured', async () => {
    const api = app({ config: config({ API_KEYS: 'test-secret' }) });
    await request(api).post('/api/analyze').send({ url: 'https://example.com' }).expect(401);
    await request(api).post('/api/analyze').set('X-API-Key', 'wrong').send({ url: 'https://example.com' }).expect(401);
    await request(api).post('/api/analyze').set('X-API-Key', 'test-secret').send({ url: 'https://example.com' }).expect(200);
});

test('analysis endpoint has a stricter rate limit', async () => {
    const api = app({ config: config({ ANALYZE_RATE_LIMIT_MAX: '1' }) });
    await request(api).post('/api/analyze').send({ url: 'https://example.com' }).expect(200);
    const limited = await request(api).post('/api/analyze').send({ url: 'https://example.com' }).expect(429);
    assert.equal(limited.body.code, 'RATE_LIMIT_EXCEEDED');
});

test('AI payloads are bounded and score values are validated', async () => {
    await request(app()).post('/api/solve').send({ issue: { title: 'x'.repeat(301) } }).expect(400);
    await request(app()).post('/api/executive-summary').send({
        scores: { performance: 101, seo: 80, accessibility: 70, bestPractices: 60 }
    }).expect(400);
    await request(app()).post('/api/solve').send({ issue: { title: 'Missing alt text', source: 'Axe' } }).expect(200);
});

test('administrative log deletion is disabled without a key and authenticated with one', async () => {
    await request(app()).delete('/api/logs').expect(503).expect(({ body }) => {
        assert.equal(body.code, 'ADMIN_ENDPOINT_DISABLED');
    });
    let cleared = false;
    const api = app({
        config: config({ ADMIN_API_KEYS: 'admin-secret' }),
        clearArtifacts: async () => { cleared = true; return 3; }
    });
    await request(api).delete('/api/logs').expect(401);
    const response = await request(api).delete('/api/logs').set('Authorization', 'Bearer admin-secret').expect(200);
    assert.equal(response.body.deletedCount, 3);
    assert.equal(cleared, true);
});

test('unexpected internal errors are not disclosed to clients', async () => {
    const api = app({ analysisService: { analyze: async () => { throw new Error('sensitive backend detail'); } } });
    const response = await request(api).post('/api/analyze').send({ url: 'https://example.com' }).expect(500);
    assert.equal(response.body.code, 'INTERNAL_ERROR');
    assert.equal(response.body.error, 'An unexpected server error occurred.');
    assert.equal(JSON.stringify(response.body).includes('sensitive backend detail'), false);
});

test('SaaS plan catalog and development workspace routes share the live platform contract', async () => {
    const api = app();
    const catalog = await request(api).get('/api/v1/plans').expect(200);
    assert.deepEqual(catalog.body.plans.map((plan) => [plan.id, plan.priceUsd]), [['signal', 29], ['studio', 99], ['enterprise', 349]]);
    const workspace = await request(api).get('/api/v1/workspace').set('X-Workspace-Id', 'ws_route_test').expect(200);
    assert.equal(workspace.body.plan.id, 'free');
    const created = await request(api).post('/api/v1/projects').set('X-Workspace-Id', 'ws_route_test').set('Idempotency-Key', 'project-route-contract-1').send({
        name: 'Example', url: 'https://example.com', locale: 'en',
        authorizationAttested: true, authorizationVersion: '1.0', additionalSubdomains: []
    }).expect(201);
    assert.equal(created.body.project.origin, 'https://example.com');
    await request(api).post(`/api/v1/projects/${created.body.project.id}/verify-target`).set('X-Workspace-Id', 'ws_route_test').send({ method: 'operator' }).expect(200);
});

test('scan progress API preserves rendered-link provenance without exposing page reports', async (context) => {
    const platformService = {
        async start() {}, async close() {},
        async getScanProgress(workspaceId, scanId) {
            return {
                scan: { id: scanId, workspaceId, status: 'running' },
                counts: { queued: 1, running: 0, completed: 1 },
                pages: [{
                    scanId, workspaceId, pageKey: 'rendered-page', url: 'https://example.com/spa', pageIndex: 1, status: 'queued',
                    discovery: { sources: [{ type: 'rendered_link', referrer: 'https://example.com/' }] }, modules: {}
                }],
                events: [], lastEventId: 0, historyLimit: 200
            };
        }
    };
    const api = app({ platformService });
    context.after(() => api.locals.closeResources());

    const response = await request(api).get('/api/v1/scans/scan-rendered/progress').set('X-Workspace-Id', 'ws_rendered_api').expect(200);

    assert.deepEqual(response.body.pages[0].discovery.sources, [{ type: 'rendered_link', referrer: 'https://example.com/' }]);
    assert.equal(Object.hasOwn(response.body.pages[0], 'report'), false);
});

test('production workspace endpoints do not trust a caller-supplied workspace header', async () => {
    const api = app({ config: config({
        NODE_ENV: 'production',
        LEGACY_API_ENABLED: 'false',
        LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT: 'false',
    }) });
    const response = await request(api).get('/api/v1/workspace').set('X-Workspace-Id', 'ws_other_tenant').expect(401);
    assert.equal(response.body.code, 'AUTHENTICATION_REQUIRED');
});
