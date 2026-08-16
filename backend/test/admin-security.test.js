const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');

const silentLogger = { info() {}, warn() {}, error() {} };

function buildApp(t, { session, env = {} } = {}) {
    const config = loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://dashboard.example',
        APP_URL: 'https://dashboard.example',
        BETTER_AUTH_URL: 'https://dashboard.example',
        RATE_LIMIT_MAX: '1000',
        WORKER_ENABLED: 'false',
        ...env
    });
    const app = createApp({
        config,
        logger: silentLogger,
        authService: { async session() { return session || null; }, async close() {} },
        validateUrl: async () => ({ url: 'https://example.com/', hostname: 'example.com', port: 443, address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }] }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    return app;
}

test('admin route rejects an unverified account before any role is considered', async (t) => {
    const app = buildApp(t, { session: { user: { id: 'owner-1', email: 'owner@example.com', name: 'Owner', emailVerified: false, twoFactorEnabled: false }, session: {} } });
    const response = await request(app).get('/api/v1/admin/overview').expect(403);
    assert.equal(response.body.code, 'ADMIN_EMAIL_UNVERIFIED');
});

test('a public signup email cannot bootstrap an administrator during a session request', async (t) => {
    const app = buildApp(t, { session: { user: { id: 'owner-2', email: 'OWNER@example.com', name: 'Owner', emailVerified: true, twoFactorEnabled: true }, session: { id: 'public-signup-session' } } });
    const response = await request(app).get('/api/v1/admin/me').expect(403);
    assert.equal(response.body.code, 'ADMIN_ROLE_REQUIRED');
});

test('ordinary customer sessions cannot enter the admin control plane', async (t) => {
    const app = buildApp(t, { session: { user: { id: 'customer-1', email: 'customer@example.com', emailVerified: true, twoFactorEnabled: true }, session: { id: 'customer-session' } } });
    const response = await request(app).get('/api/v1/admin/me').expect(403);
    assert.equal(response.body.code, 'ADMIN_ROLE_REQUIRED');
    await request(app).get('/api/v1/admin/resources/users').expect(403);
});

test('production mutations reject missing origins and accept the configured origin', async (t) => {
    const app = buildApp(t, { session: { user: { id: 'customer-2', email: 'customer@example.com', name: 'Customer', emailVerified: true, twoFactorEnabled: false }, session: {} } });
    const body = { name: 'Example', url: 'https://example.com', locale: 'en', authorizationAttested: true, authorizationVersion: '1.0', additionalSubdomains: [] };
    const rejected = await request(app).post('/api/v1/projects').send(body).expect(403);
    assert.equal(rejected.body.code, 'UNTRUSTED_MUTATION_ORIGIN');
    await request(app).post('/api/v1/legal/acceptances').set('Origin', 'https://dashboard.example').send({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' }).expect(201);
    await request(app).post('/api/v1/projects').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'project-origin-security-1').send(body).expect(201);
});

test('admin API keys cannot enter the session-backed administrator control plane', async (t) => {
    const app = buildApp(t, { env: { ADMIN_API_KEYS: 'automation-secret' } });
    const response = await request(app).get('/api/v1/admin/me').set('Authorization', 'Bearer automation-secret').expect(401);
    assert.equal(response.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
});
