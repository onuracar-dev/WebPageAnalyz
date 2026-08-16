const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { shareSchema } = require('../validation/schemas');

test('share expiry contract accepts only bounded product choices', () => {
    assert.equal(shareSchema.parse({}).expiresInDays, 30);
    for (const days of [7, 30, 90]) assert.equal(shareSchema.parse({ expiresInDays: days }).expiresInDays, days);
    for (const value of [0, 1, 14, 365, '30']) assert.throws(() => shareSchema.parse({ expiresInDays: value }));
});

test('public share API preserves the browser envelope and minimized DTO', async (t) => {
    const app = createApp({
        config: loadConfig({ NODE_ENV: 'test', WORKER_ENABLED: 'false', CORS_ORIGINS: 'http://localhost:5173' }),
        logger: { info() {}, warn() {}, error() {} },
        platformService: {
            async start() {},
            async close() {},
            async getSharedReport(token) {
                assert.match(token, /^[A-Za-z0-9_-]+$/);
                return { id: 'rpt_public', version: 2, status: 'published', publishedAt: '2026-08-14T00:00:00.000Z', payload: { summary: {}, modules: {}, pages: [] } };
            }
        }
    });
    t.after(() => app.locals.closeResources());
    const response = await request(app).get('/api/v1/shared-reports/public_token_123456').expect(200);
    assert.deepEqual(Object.keys(response.body), ['report']);
    assert.equal(response.body.report.id, 'rpt_public');
    assert.equal(response.body.report.workspaceId, undefined);
    assert.deepEqual(response.body.report.payload.pages, []);
});
