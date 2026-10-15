const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp } = require('../app');
const { JobQueue } = require('../job-queue');
const { AppError } = require('../lib/errors');
const { loadConfig } = require('../config');

function createTestContext(customConfig = {}) {
    const config = {
        port: 8080,
        host: '127.0.0.1',
        nodeEnv: 'test',
        allowedOrigin: '',
        trustProxy: false,
        rateLimitPerHour: 1000,
        scanConcurrency: 1,
        maxQueue: 5,
        resultTtlMs: 30 * 60 * 1000,
        scanTimeoutMs: 10_000,
        engineTimeoutMs: 5_000,
        consentVersion: '2026-10-15',
        consentSalt: 'test-salt',
        artifactDir: './test-artifacts',
        allowedPorts: [80, 443],
        ...customConfig
    };

    const runner = customConfig.customRunner || {
        runScan: async (url) => ({
            status: 'completed',
            engines: {
                lighthouse: { status: 'completed', durationMs: 100 },
                axe: { status: 'completed', durationMs: 50 }
            },
            findings: [
                {
                    id: 'finding-1',
                    ruleId: 'test.rule',
                    category: 'performance',
                    severity: 'high',
                    title: 'Test issue',
                    engineId: 'lighthouse',
                    pageUrl: url
                }
            ],
            summary: {
                bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
                byCategory: { performance: 1 }
            }
        })
    };

    const queue = new JobQueue({
        runner,
        concurrency: config.scanConcurrency,
        maxQueue: config.maxQueue,
        scanTimeoutMs: config.scanTimeoutMs,
        resultTtlMs: config.resultTtlMs
    });

    const mockValidator = async (url) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new AppError('Disallowed protocol', { status: 400, code: 'INVALID_TARGET_URL' });
        }
        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '169.254.169.254' ||
            hostname === '10.0.0.1'
        ) {
            throw new AppError('Private IP blocked', { status: 400, code: 'PRIVATE_TARGET_BLOCKED' });
        }
        return { url: parsed.toString(), hostname };
    };

    const app = createApp({
        config,
        queue,
        runner,
        urlValidator: mockValidator
    });

    return { app, queue, config };
}

describe('WebPage Analyzer Lite API', () => {
    describe('GET /api/health', () => {
        it('returns ok and queue stats', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app).get('/api/health');
                assert.equal(res.status, 200);
                assert.equal(res.body.ok, true);
                assert.equal(typeof res.body.queue.running, 'number');
                assert.equal(typeof res.body.queue.waiting, 'number');
            } finally {
                queue.close();
            }
        });
    });

    describe('GET /api/engines', () => {
        it('returns only included engines and excludes crawler/zapBaseline/journey/osvScanner', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app).get('/api/engines');
                assert.equal(res.status, 200);
                assert.ok(Array.isArray(res.body.engines));

                const ids = res.body.engines.map((e) => e.id);
                // Must NOT contain excluded engines
                assert.equal(ids.includes('crawler'), false, 'crawler must be excluded');
                assert.equal(ids.includes('zapBaseline'), false, 'zapBaseline must be excluded');
                assert.equal(ids.includes('journey'), false, 'journey must be excluded');
                assert.equal(ids.includes('osvScanner'), false, 'osvScanner must be excluded');

                // Must contain included engines
                assert.ok(ids.includes('lighthouse'));
                assert.ok(ids.includes('axe'));
                assert.ok(ids.includes('yellowLab'));
                assert.ok(ids.includes('wpaPage'));
                assert.ok(ids.includes('performancePlus'));
                assert.ok(ids.includes('advancedGeo'));
                assert.ok(ids.includes('visualUx'));

                // Verify fields
                for (const engine of res.body.engines) {
                    assert.ok(engine.id);
                    assert.ok(engine.name);
                    assert.ok(engine.description);
                    assert.equal(typeof engine.external, 'boolean');
                }
            } finally {
                queue.close();
            }
        });
    });

    describe('POST /api/scans - Consent Validation', () => {
        it('returns 400 CONSENT_REQUIRED if consent is missing', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app)
                    .post('/api/scans')
                    .send({ url: 'https://example.com' });
                assert.equal(res.status, 400);
                assert.equal(res.body.error?.code, 'CONSENT_REQUIRED');
            } finally {
                queue.close();
            }
        });

        it('returns 400 CONSENT_REQUIRED if consent.accepted is false', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://example.com',
                        consent: { accepted: false, version: '2026-10-15' }
                    });
                assert.equal(res.status, 400);
                assert.equal(res.body.error?.code, 'CONSENT_REQUIRED');
            } finally {
                queue.close();
            }
        });

        it('returns 400 CONSENT_REQUIRED if consent version mismatches', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://example.com',
                        consent: { accepted: true, version: 'wrong-version' }
                    });
                assert.equal(res.status, 400);
                assert.equal(res.body.error?.code, 'CONSENT_REQUIRED');
            } finally {
                queue.close();
            }
        });
    });

    describe('POST /api/scans - SSRF and URL Safety', () => {
        const disallowed = [
            'http://127.0.0.1',
            'http://localhost',
            'http://169.254.169.254',
            'http://10.0.0.1',
            'file:///etc/passwd',
            'ftp://example.com'
        ];

        for (const url of disallowed) {
            it(`rejects disallowed target: ${url} with 400 URL_NOT_ALLOWED`, async () => {
                const { app, queue } = createTestContext();
                try {
                    const res = await supertest(app)
                        .post('/api/scans')
                        .send({
                            url,
                            consent: { accepted: true, version: '2026-10-15' }
                        });
                    assert.equal(res.status, 400);
                    assert.equal(res.body.error?.code, 'URL_NOT_ALLOWED');
                } finally {
                    queue.close();
                }
            });
        }
    });

    describe('POST /api/scans - Queue Full', () => {
        it('returns 429 QUEUE_FULL when queue limit is reached', async () => {
            // Use a runner that does not finish immediately so jobs stay queued/running
            const neverEndingRunner = { runScan: () => new Promise(() => {}) };
            const { app, queue } = createTestContext({
                maxQueue: 2,
                customRunner: neverEndingRunner
            });
            try {
                // Fill queue
                queue.enqueue({ id: '1', url: 'https://site1.com' });
                queue.enqueue({ id: '2', url: 'https://site2.com' });

                const res = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://site3.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(res.status, 429);
                assert.equal(res.body.error?.code, 'QUEUE_FULL');
            } finally {
                queue.close();
            }
        });
    });

    describe('POST /api/scans - Deduplication', () => {
        it('returns existing job id if same URL is already active in queue', async () => {
            const neverEndingRunner = { runScan: () => new Promise(() => {}) };
            const { app, queue } = createTestContext({
                customRunner: neverEndingRunner
            });
            try {
                const first = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://example.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(first.status, 202);
                const originalId = first.body.id;

                const second = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://example.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(second.status, 202);
                assert.equal(second.body.id, originalId);
            } finally {
                queue.close();
            }
        });
    });

    describe('GET /api/scans/:id', () => {
        it('returns 404 SCAN_NOT_FOUND for unknown id', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app).get('/api/scans/unknown-id-1234');
                assert.equal(res.status, 404);
                assert.equal(res.body.error?.code, 'SCAN_NOT_FOUND');
            } finally {
                queue.close();
            }
        });

        it('returns queued scan position and details', async () => {
            const { app, queue } = createTestContext();
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://test-example.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(postRes.status, 202);
                const scanId = postRes.body.id;

                const getRes = await supertest(app).get(`/api/scans/${scanId}`);
                assert.equal(getRes.status, 200);
                assert.equal(getRes.body.id, scanId);
                assert.ok(getRes.body.url.startsWith('https://test-example.com'));
                assert.ok(['queued', 'running', 'completed'].includes(getRes.body.status));
                assert.ok(getRes.body.engines);
                assert.ok(Array.isArray(getRes.body.findings));
                assert.ok(getRes.body.summary);
            } finally {
                queue.close();
            }
        });

        it('returns sanitized error field when scan status is failed (Revizyon 1 - c)', async () => {
            const failingRunner = {
                runScan: async () => {
                    const err = new Error('playwright call log details\nError: connect ECONNREFUSED');
                    err.code = 'SCAN_FAILED';
                    throw err;
                }
            };
            const { app, queue } = createTestContext({ customRunner: failingRunner });
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://fail-test.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(postRes.status, 202);
                const scanId = postRes.body.id;

                // Wait for failingRunner to reject
                await new Promise((r) => setTimeout(r, 60));

                const getRes = await supertest(app).get(`/api/scans/${scanId}`);
                assert.equal(getRes.status, 200);
                assert.equal(getRes.body.status, 'failed');
                assert.ok(getRes.body.error);
                assert.equal(getRes.body.error.code, 'SCAN_FAILED');
                assert.equal(getRes.body.error.message, 'Scan execution failed.');
                assert.equal(getRes.body.error.message.includes('playwright'), false);
            } finally {
                queue.close();
            }
        });
    });

    describe('Config Validation (Revizyon 1 - d)', () => {
        it('throws an error in production when CONSENT_SALT is missing', () => {
            assert.throws(() => {
                loadConfig({ NODE_ENV: 'production' });
            }, (err) => err.message.includes('CONSENT_SALT environment variable is required in production.'));
        });

        it('loads successfully when CONSENT_SALT is provided in production', () => {
            const cfg = loadConfig({ NODE_ENV: 'production', CONSENT_SALT: 'secure-prod-salt' });
            assert.equal(cfg.consentSalt, 'secure-prod-salt');
            assert.equal(cfg.timeouts.scanMs, 480000);
            assert.equal(cfg.timeouts.lighthouseMs, 180000);
            assert.equal(cfg.timeouts.axeMs, 90000);
            assert.equal(cfg.timeouts.yellowLabMs, 150000);
            assert.equal(cfg.timeouts.wpaPageMs, 120000);
            assert.equal(cfg.timeouts.advancedBrowserMs, 150000);
        });
    });

    describe('CORS policy (Revizyon 1 - 6)', () => {
        it('fails closed in production when ALLOWED_ORIGIN is empty', async () => {
            const { app, queue } = createTestContext({ nodeEnv: 'production', allowedOrigin: '' });
            try {
                const res = await supertest(app)
                    .get('/api/health')
                    .set('Origin', 'https://unauthorized-domain.com');
                assert.equal(res.status, 200);
                assert.equal(res.headers['access-control-allow-origin'], undefined);
            } finally {
                queue.close();
            }
        });

        it('allows specific origin when ALLOWED_ORIGIN is set', async () => {
            const { app, queue } = createTestContext({ allowedOrigin: 'https://webpageanalyzer.onuracar.dev' });
            try {
                const res = await supertest(app)
                    .get('/api/health')
                    .set('Origin', 'https://webpageanalyzer.onuracar.dev');
                assert.equal(res.status, 200);
                assert.equal(res.headers['access-control-allow-origin'], 'https://webpageanalyzer.onuracar.dev');
            } finally {
                queue.close();
            }
        });
    });
});
