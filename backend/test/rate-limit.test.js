const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { limiter, PgRateLimitStore, isScanProgressRead } = require('../middleware/rate-limit');

test('admin requests use a separate budget and do not consume the general API budget', async () => {
    const app = express();
    app.use('/api/v1/admin', limiter({ windowMs: 60_000, max: 2, message: 'Admin limited.' }));
    app.use('/api', limiter({
        windowMs: 60_000,
        max: 1,
        message: 'General limited.',
        skip: (incoming) => incoming.originalUrl.startsWith('/api/v1/admin')
    }));
    app.get('/api/v1/admin/test', (_incoming, response) => response.json({ ok: true }));
    app.get('/api/public', (_incoming, response) => response.json({ ok: true }));

    await request(app).get('/api/v1/admin/test').expect(200);
    await request(app).get('/api/v1/admin/test').expect(200);
    const adminLimited = await request(app).get('/api/v1/admin/test').expect(429);
    assert.equal(adminLimited.body.error, 'Admin limited.');

    await request(app).get('/api/public').expect(200);
    const generalLimited = await request(app).get('/api/public').expect(429);
    assert.equal(generalLimited.body.error, 'General limited.');
});

test('PostgreSQL rate-limit stores namespace identical client keys by endpoint budget', async () => {
    const calls = [];
    const pool = {
        async query(sql, values) {
            calls.push({ sql, values });
            return { rows: [{ hits: 1, window_started_at: new Date('2026-01-01T00:00:00.000Z') }] };
        }
    };
    const login = new PgRateLimitStore(pool, 'login');
    const redeem = new PgRateLimitStore(pool, 'redeem');
    await login.increment('ip:203.0.113.4', 60_000);
    await redeem.increment('ip:203.0.113.4', 60_000);
    assert.deepEqual(calls[0].values, ['login', 'ip:203.0.113.4', 60_000]);
    assert.deepEqual(calls[1].values, ['redeem', 'ip:203.0.113.4', 60_000]);
    assert.match(calls[0].sql, /ON CONFLICT\(namespace,key\)/);
    assert.throws(() => new PgRateLimitStore(pool, 'invalid namespace'), /namespace/i);
});

test('scan progress and event reads use a separate budget from ordinary API traffic', async () => {
    const app = express();
    const progressLimiter = limiter({ windowMs: 60_000, max: 2, message: 'Progress limited.' });
    app.use('/api/v1/scans/:id/progress', progressLimiter);
    app.use('/api/v1/scans/:id/events', progressLimiter);
    app.use('/api', limiter({ windowMs: 60_000, max: 1, message: 'General limited.', skip: isScanProgressRead }));
    app.get('/api/v1/scans/:id/progress', (_incoming, response) => response.json({ ok: true }));
    app.get('/api/v1/scans/:id/events', (_incoming, response) => response.json({ ok: true }));
    app.get('/api/v1/dashboard', (_incoming, response) => response.json({ ok: true }));

    await request(app).get('/api/v1/scans/scan-1/progress').expect(200);
    await request(app).get('/api/v1/scans/scan-1/events?after=4').expect(200);
    const progressLimited = await request(app).get('/api/v1/scans/scan-1/progress').expect(429);
    assert.equal(progressLimited.body.error, 'Progress limited.');

    await request(app).get('/api/v1/dashboard').expect(200);
    await request(app).get('/api/v1/dashboard').expect(429);
});
