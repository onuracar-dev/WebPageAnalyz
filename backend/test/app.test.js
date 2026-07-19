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

test('CORS allows configured origins and rejects untrusted origins', async () => {
    await request(app()).get('/healthz').set('Origin', 'https://dashboard.example').expect('Access-Control-Allow-Origin', 'https://dashboard.example').expect(200);
    const rejected = await request(app()).get('/healthz').set('Origin', 'https://evil.example').expect(403);
    assert.equal(rejected.body.code, 'CORS_ORIGIN_DENIED');
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
