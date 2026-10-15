const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp } = require('../app');
const { JobQueue } = require('../job-queue');
const { AppError } = require('../lib/errors');
const { loadConfig } = require('../config');
const { resolveRedirects } = require('../security/url-resolver');

function createTestContext(customConfig = {}) {
    const nowFn = customConfig.nowFn || (() => Date.now());
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
        hostCooldownMs: customConfig.hostCooldownMs ?? 10 * 60 * 1000,
        dailyScanLimit: customConfig.dailyScanLimit ?? 200,
        maxStoredResults: customConfig.maxStoredResults ?? 100,
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
        resultTtlMs: config.resultTtlMs,
        maxStoredResults: config.maxStoredResults
    });

    const mockValidator = customConfig.urlValidator || (async (url) => {
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
    });

    const redirectResolver = customConfig.redirectResolver || (customConfig.lookup ? undefined : async (url) => ({ resolvedUrl: url, hops: 0, redirected: false }));

    const app = createApp({
        config,
        queue,
        runner,
        urlValidator: mockValidator,
        nowFn,
        limiter: customConfig.limiter,
        redirectResolver,
        lookup: customConfig.lookup
    });

    return { app, queue, config, nowFn };
}

describe('WebPage Analyzer Lite API', () => {
    describe('GET /api/health', () => {
        it('returns ok, queue stats, and dailyRemaining', async () => {
            const { app, queue } = createTestContext();
            try {
                const res = await supertest(app).get('/api/health');
                assert.equal(res.status, 200);
                assert.equal(res.body.ok, true);
                assert.equal(typeof res.body.queue.running, 'number');
                assert.equal(typeof res.body.queue.waiting, 'number');
                assert.equal(typeof res.body.dailyRemaining, 'number');
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

    describe('Abuse Prevention & Limits (Revizyon 2)', () => {
        it('returns 429 HOST_COOLDOWN with retryAfterSeconds when scanning different URL on same host during cooldown (Revizyon 2 - a)', async () => {
            let currentTime = 1700000000000;
            const nowFn = () => currentTime;
            const { app, queue } = createTestContext({ nowFn, hostCooldownMs: 600000 });
            try {
                // First scan on https://site-cooldown.com/page1
                const first = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://site-cooldown.com/page1',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(first.status, 202);

                // Advance 100 seconds
                currentTime += 100000;

                // Second scan on https://site-cooldown.com/page2 (different URL, same host)
                const second = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://site-cooldown.com/page2',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(second.status, 429);
                assert.equal(second.body.error?.code, 'HOST_COOLDOWN');
                assert.equal(typeof second.body.retryAfterSeconds, 'number');
                assert.ok(second.body.retryAfterSeconds > 0);
                assert.equal(second.body.retryAfterSeconds, 500); // 600 - 100 = 500s
                assert.equal(second.headers['retry-after'], '500');
            } finally {
                queue.close();
            }
        });

        it('returns cached completed result without decrementing daily limit when same URL is requested in cooldown (Revizyon 2 - b)', async () => {
            let currentTime = 1700000000000;
            const nowFn = () => currentTime;
            const { app, queue } = createTestContext({ nowFn, hostCooldownMs: 600000, dailyScanLimit: 50 });
            try {
                // Check initial dailyRemaining
                const healthBefore = await supertest(app).get('/api/health');
                assert.equal(healthBefore.body.dailyRemaining, 50);

                // 1. Submit scan for https://cached-test.com/home
                const first = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://cached-test.com/home',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(first.status, 202);

                // Wait for runner to complete
                await new Promise((r) => setTimeout(r, 60));

                // Check dailyRemaining after 1 scan
                const healthMid = await supertest(app).get('/api/health');
                assert.equal(healthMid.body.dailyRemaining, 49);

                // 2. Submit same URL again within cooldown
                currentTime += 60000; // 1 minute later
                const second = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://cached-test.com/home',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(second.status, 200);
                assert.equal(second.body.id, first.body.id);
                assert.equal(second.body.status, 'completed');
                assert.equal(second.body.cached, true);

                // Check dailyRemaining did NOT decrement
                const healthAfter = await supertest(app).get('/api/health');
                assert.equal(healthAfter.body.dailyRemaining, 49);
            } finally {
                queue.close();
            }
        });

        it('enforces DAILY_SCAN_LIMIT and resets count when UTC day changes via injected clock (Revizyon 2 - c)', async () => {
            // 2026-10-15T12:00:00.000Z
            let currentTime = Date.UTC(2026, 9, 15, 12, 0, 0);
            const nowFn = () => currentTime;
            const { app, queue } = createTestContext({ nowFn, dailyScanLimit: 2 });
            try {
                // 1st scan on site1
                const res1 = await supertest(app)
                    .post('/api/scans')
                    .send({ url: 'https://site1.com', consent: { accepted: true, version: '2026-10-15' } });
                assert.equal(res1.status, 202);

                // 2nd scan on site2
                const res2 = await supertest(app)
                    .post('/api/scans')
                    .send({ url: 'https://site2.com', consent: { accepted: true, version: '2026-10-15' } });
                assert.equal(res2.status, 202);

                // 3rd scan on site3 should exceed daily limit
                const res3 = await supertest(app)
                    .post('/api/scans')
                    .send({ url: 'https://site3.com', consent: { accepted: true, version: '2026-10-15' } });
                assert.equal(res3.status, 429);
                assert.equal(res3.body.error?.code, 'DAILY_LIMIT_REACHED');

                const healthLimit = await supertest(app).get('/api/health');
                assert.equal(healthLimit.body.dailyRemaining, 0);

                // Advance injected clock to next UTC day (2026-10-16T00:00:01.000Z)
                currentTime = Date.UTC(2026, 9, 16, 0, 0, 1);

                // Health should now show daily limit reset
                const healthNextDay = await supertest(app).get('/api/health');
                assert.equal(healthNextDay.body.dailyRemaining, 2);

                // 4th scan on site3 should now succeed
                const res4 = await supertest(app)
                    .post('/api/scans')
                    .send({ url: 'https://site3.com', consent: { accepted: true, version: '2026-10-15' } });
                assert.equal(res4.status, 202);
            } finally {
                queue.close();
            }
        });
    });

    describe('Live Engine Progress (Revizyon 3)', () => {
        it('initializes all 7 engines with pending status upon enqueue (Revizyon 3 - a)', async () => {
            const neverEndingRunner = {
                runScan: async () => new Promise(() => {}) // Stays running forever
            };
            const { app, queue } = createTestContext({ customRunner: neverEndingRunner });
            try {
                // Job 1 runs and holds concurrency
                await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://active-site-1.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                // Job 2 is strictly queued in waitingQueue
                const postRes2 = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://queued-site-2.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(postRes2.status, 202);
                const scanId2 = postRes2.body.id;

                const getRes2 = await supertest(app).get(`/api/scans/${scanId2}`);
                assert.equal(getRes2.status, 200);
                assert.equal(getRes2.body.status, 'queued');

                const expected = ['lighthouse', 'axe', 'yellowLab', 'wpaPage', 'performancePlus', 'advancedGeo', 'visualUx'];
                for (const engineId of expected) {
                    assert.ok(getRes2.body.engines[engineId], `Engine ${engineId} must exist`);
                    assert.equal(
                        getRes2.body.engines[engineId].status,
                        'pending',
                        `Engine ${engineId} must have pending status while queued`
                    );
                }
            } finally {
                queue.close();
            }
        });

        it('shows mixed running and completed engines live on GET while scan is in progress (Revizyon 3 - b)', async () => {
            let releaseBlocker;
            const blockerPromise = new Promise((resolve) => { releaseBlocker = resolve; });

            const fakeLiveRunner = {
                runScan: async (url, { onEngineUpdate } = {}) => {
                    // 1. Immediately complete lighthouse
                    if (onEngineUpdate) {
                        onEngineUpdate('lighthouse', { status: 'running', startedAt: new Date().toISOString() });
                        onEngineUpdate('lighthouse', { status: 'completed', durationMs: 120 });
                        // 2. Start axe and keep it running
                        onEngineUpdate('axe', { status: 'running', startedAt: new Date().toISOString() });
                    }

                    // Wait until test inspects the intermediate state
                    await blockerPromise;

                    if (onEngineUpdate) {
                        onEngineUpdate('axe', { status: 'completed', durationMs: 200 });
                    }

                    return {
                        status: 'completed',
                        engines: {
                            lighthouse: { status: 'completed', durationMs: 120 },
                            axe: { status: 'completed', durationMs: 200 }
                        },
                        findings: [],
                        summary: { bySeverity: {}, byCategory: {} }
                    };
                }
            };

            const { app, queue } = createTestContext({ customRunner: fakeLiveRunner });
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://live-progress-test.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });
                assert.equal(postRes.status, 202);
                const scanId = postRes.body.id;

                // Yield so setImmediate in enqueue starts the job
                await new Promise((r) => setTimeout(r, 20));

                // GET intermediate state
                const midRes = await supertest(app).get(`/api/scans/${scanId}`);
                assert.equal(midRes.status, 200);
                assert.equal(midRes.body.status, 'running');

                // Verify mixed statuses:
                // lighthouse is completed
                assert.equal(midRes.body.engines.lighthouse.status, 'completed');
                assert.equal(midRes.body.engines.lighthouse.durationMs, 120);

                // axe is running
                assert.equal(midRes.body.engines.axe.status, 'running');
                assert.ok(midRes.body.engines.axe.startedAt);

                // other engines still pending
                assert.equal(midRes.body.engines.yellowLab.status, 'pending');
                assert.equal(midRes.body.engines.wpaPage.status, 'pending');

                // findings and summary are empty while scan is running
                assert.deepEqual(midRes.body.findings, []);
            } finally {
                releaseBlocker();
                queue.close();
            }
        });
    });

    describe('Follow Redirects & Safe Proxy (Revizyon 4)', () => {
        it('follows 308 apex -> www redirect; job.url is final URL and requestedUrl is original URL (Revizyon 4 - a)', async () => {
            const mockFetch = async (url) => {
                if (url === 'https://example-apex.com/' || url === 'https://example-apex.com') {
                    return {
                        status: 308,
                        headers: new Headers({ location: 'https://www.example-apex.com/' })
                    };
                }
                if (url === 'https://www.example-apex.com/') {
                    return {
                        status: 200,
                        headers: new Headers()
                    };
                }
                throw new Error(`Unexpected fetch URL: ${url}`);
            };

            const redirectResolver = (url, opts) => resolveRedirects(url, { ...opts, fetchFn: mockFetch });
            const { app, queue } = createTestContext({ redirectResolver });
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://example-apex.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(postRes.status, 202);
                assert.equal(postRes.body.url, 'https://www.example-apex.com/');
                assert.equal(postRes.body.requestedUrl, 'https://example-apex.com/');

                const scanId = postRes.body.id;
                const getRes = await supertest(app).get(`/api/scans/${scanId}`);
                assert.equal(getRes.status, 200);
                assert.equal(getRes.body.url, 'https://www.example-apex.com/');
                assert.equal(getRes.body.requestedUrl, 'https://example-apex.com/');
            } finally {
                queue.close();
            }
        });

        it('returns 400 URL_NOT_ALLOWED when redirect target points to a private IP (Revizyon 4 - b)', async () => {
            const mockFetch = async (url) => {
                if (url === 'https://open-redirect.com/' || url === 'https://open-redirect.com') {
                    return {
                        status: 302,
                        headers: new Headers({ location: 'http://127.0.0.1/admin' })
                    };
                }
                return { status: 200, headers: new Headers() };
            };

            const redirectResolver = (url, opts) => resolveRedirects(url, { ...opts, fetchFn: mockFetch });
            const { app, queue } = createTestContext({ redirectResolver });
            try {
                const res = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://open-redirect.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(res.status, 400);
                assert.equal(res.body.error?.code, 'URL_NOT_ALLOWED');
            } finally {
                queue.close();
            }
        });

        it('falls back to original URL when redirects exceed 5 hops (Revizyon 4 - c)', async () => {
            let hopCount = 0;
            const mockFetch = async (url) => {
                hopCount += 1;
                return {
                    status: 302,
                    headers: new Headers({ location: `https://infinite-loop.com/step-${hopCount}` })
                };
            };

            const redirectResolver = (url, opts) => resolveRedirects(url, { ...opts, fetchFn: mockFetch });
            const { app, queue } = createTestContext({ redirectResolver });
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://infinite-loop.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(postRes.status, 202);
                // When 5 hops is exceeded, falls back to initial requested URL
                assert.equal(postRes.body.url, 'https://infinite-loop.com/');
                assert.equal(postRes.body.requestedUrl, 'https://infinite-loop.com/');
                assert.equal(hopCount, 5);
            } finally {
                queue.close();
            }
        });

        it('falls back to original URL on network error during redirect resolution (Revizyon 4 - d)', async () => {
            const mockFetch = async () => {
                throw new Error('fetch failed: ECONNREFUSED');
            };

            const redirectResolver = (url, opts) => resolveRedirects(url, { ...opts, fetchFn: mockFetch });
            const { app, queue } = createTestContext({ redirectResolver });
            try {
                const postRes = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://network-error-site.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(postRes.status, 202);
                assert.equal(postRes.body.url, 'https://network-error-site.com/');
                assert.equal(postRes.body.requestedUrl, 'https://network-error-site.com/');
            } finally {
                queue.close();
            }
        });
    });

    describe('SSRF Hardening & DNS Rebinding (Revizyon 5)', () => {
        it('blocks request and returns 400 URL_NOT_ALLOWED when DNS rebinding resolves to private IP at connection time (Revizyon 5 - a)', async () => {
            let dnsCalls = 0;
            const rebindingLookup = async () => {
                dnsCalls += 1;
                // First query (initial URL validation): public IP
                if (dnsCalls === 1) {
                    return [{ address: '93.184.216.34', family: 4 }];
                }
                // Subsequent query (at connection time): private IP
                return [{ address: '127.0.0.1', family: 4 }];
            };

            const { app, queue } = createTestContext({
                lookup: rebindingLookup,
                urlValidator: async (u) => {
                    const parsed = new URL(u);
                    const records = await rebindingLookup(parsed.hostname);
                    const ip = records[0].address;
                    if (['127.0.0.1', '10.0.0.1'].includes(ip)) {
                        throw new AppError('Private IP blocked', { status: 400, code: 'PRIVATE_TARGET_BLOCKED' });
                    }
                    return { url: parsed.toString(), hostname: parsed.hostname };
                }
            });

            try {
                const res = await supertest(app)
                    .post('/api/scans')
                    .send({
                        url: 'https://rebinding-attack.com',
                        consent: { accepted: true, version: '2026-10-15' }
                    });

                assert.equal(res.status, 400);
                assert.equal(res.body.error?.code, 'URL_NOT_ALLOWED');
                assert.ok(dnsCalls >= 2, 'Must have resolved DNS at least twice (validation and connection)');
            } finally {
                queue.close();
            }
        });

        it('returns within budget when target server accepts connection but sends no headers (Revizyon 5 - b)', async () => {
            const net = require('node:net');
            let serverSocket;
            const silentServer = net.createServer((socket) => {
                serverSocket = socket;
                // Accept TCP connection, deliberately send no HTTP headers or data
            });

            await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
            const port = silentServer.address().port;

            try {
                const startTime = Date.now();
                // 500ms budget to verify fast non-blocking return well below 10s
                const result = await resolveRedirects(`http://127.0.0.1:${port}/hang`, {
                    timeoutMs: 500,
                    allowPrivate: true,
                    validator: async (u) => ({ url: u })
                });

                const elapsed = Date.now() - startTime;
                assert.ok(elapsed >= 450, `Elapsed should be at least ~500ms, was ${elapsed}ms`);
                assert.ok(elapsed < 3000, `Elapsed must be well below 10s, was ${elapsed}ms`);
                assert.equal(result.resolvedUrl, `http://127.0.0.1:${port}/hang`);
                assert.equal(result.hops, 0);
                assert.equal(result.redirected, false);
            } finally {
                if (serverSocket) serverSocket.destroy();
                await new Promise((resolve) => silentServer.close(resolve));
            }
        });
    });
});


