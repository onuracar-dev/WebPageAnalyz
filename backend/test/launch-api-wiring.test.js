const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');

const logger = { info() {}, warn() {}, error() {} };

function config(overrides = {}) {
    return loadConfig({
        NODE_ENV: 'test',
        LEGACY_API_ENABLED: 'false',
        OPENROUTER_MODEL_PRIMARY: 'vendor/evaluated-model',
        AI_DAILY_COST_SOFT_LIMIT_USD: '5',
        AI_DAILY_COST_HARD_LIMIT_USD: '10',
        RATE_LIMIT_MAX: '1000',
        AI_RATE_LIMIT_MAX: '1000',
        ...overrides
    });
}

function appWith({ store, billingProvider, aiService } = {}) {
    const platformStore = store || new MemoryPlatformStore();
    const provider = billingProvider || {
        provider: 'paddle', signatureHeaderName: 'paddle-signature',
        async createCheckout() { throw new Error('not configured'); },
        async createCustomerPortal() { throw new Error('not configured'); },
        async cancelSubscription() { throw new Error('not configured'); },
        async getSubscription() { return null; },
        async reconcileSubscription() { throw new Error('not configured'); },
        async handleWebhook() { return { received: true }; }
    };
    const application = createApp({
        config: config(), logger, platformStore, billingProvider: provider,
        aiService: aiService || { configured: false, async tryGenerateRemediation() { return { ok: false, error: { code: 'AI_SERVICE_NOT_CONFIGURED', status: 503 } }; } },
        emailTransport: { configured: false, provider: 'none', async send() { throw new Error('disabled'); } },
        validateUrl: async (url) => ({ url: new URL(url).toString(), hostname: new URL(url).hostname, port: 443, address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }] }),
        analysisService: { async analyze() { return {}; } }
    });
    return { application, store: platformStore };
}

test('checkout persists versioned recurring acceptance before invoking the configured provider', async (t) => {
    const store = new MemoryPlatformStore();
    let providerObservedAcceptance = false;
    const billingProvider = {
        provider: 'paddle', signatureHeaderName: 'paddle-signature',
        async createCheckout(input) {
            providerObservedAcceptance = store.checkoutAcceptances.size === 1;
            assert.equal(input.planId, 'signal');
            return { provider: 'paddle', id: 'txn_fixture', url: 'https://checkout.paddle.test/txn_fixture', status: 'ready' };
        },
        async createCustomerPortal() { return { url: 'https://portal.paddle.test' }; },
        async cancelSubscription() { return {}; }, async getSubscription() { return null; },
        async reconcileSubscription() { return {}; }, async handleWebhook() { return { received: true }; }
    };
    const { application } = appWith({ store, billingProvider });
    t.after(() => application.locals.closeResources());
    const response = await request(application).post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_checkout')
        .set('Idempotency-Key', 'checkout_fixture_1')
        .send({ planId: 'signal', accepted: true, recurringAcknowledged: true, termsVersion: '1.0', refundPolicyVersion: '1.0' })
        .expect(201);
    assert.equal(providerObservedAcceptance, true);
    assert.equal(response.body.url, 'https://checkout.paddle.test/txn_fixture');
    const acceptance = [...store.checkoutAcceptances.values()][0];
    assert.deepEqual({ planId: acceptance.planId, amountMinor: acceptance.amountMinor, billingInterval: acceptance.billingInterval, provider: acceptance.provider }, {
        planId: 'signal', amountMinor: 2900, billingInterval: 'month', provider: 'paddle'
    });
});

test('finding remediation reserves one quota unit, records provider metadata and reuses its evidence/model cache', async (t) => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_ai');
    const scan = await store.createScan('ws_ai', 'project', { urls: ['https://example.com/'] });
    await store.saveReport('ws_ai', scan.id, {
        findings: [{ fingerprint: 'finding-1', title: 'Missing label', description: 'A form control has no label.', category: 'accessibility', severity: 'high', source: 'axe' }]
    });
    let calls = 0;
    const aiService = {
        configured: true,
        async tryGenerateRemediation() {
            calls += 1;
            return {
                ok: true,
                result: {
                    output: { schemaVersion: 'wpa.ai.remediation.v1', summary: 'Suggested guidance', likelyCause: 'Missing association', steps: ['Add a label'], codeExample: null, caveats: ['Verify in context'], confidence: 'medium' },
                    metadata: { requestedModel: 'vendor/evaluated-model', actualModel: 'vendor/evaluated-model', actualProvider: 'fixture-provider', latencyMs: 12, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, cost: { totalCredits: '0.00003' }, routing: { fallbackUsed: false }, privacy: { dataCollection: 'deny', zeroDataRetentionRequested: false } }
                }
            };
        }
    };
    const { application } = appWith({ store, aiService });
    t.after(() => application.locals.closeResources());
    const first = await request(application).post('/api/v1/findings/finding-1/remediation').set('X-Workspace-Id', 'ws_ai').set('Idempotency-Key', 'ai-finding-operation-0001').send({}).expect(201);
    const second = await request(application).post('/api/v1/findings/finding-1/remediation').set('X-Workspace-Id', 'ws_ai').set('Idempotency-Key', 'ai-finding-operation-0001').send({}).expect(200);
    assert.equal(calls, 1);
    assert.equal(first.body.cached, false);
    assert.equal(first.body.semantics, 'ai_generated_suggestion');
    assert.equal(second.body.cached, true);
    const usage = [...store.aiUsage.values()][0];
    assert.equal(usage.status, 'completed');
    assert.equal(usage.actualModel, 'vendor/evaluated-model');
    assert.equal(usage.usageMetadata.actualProvider, 'fixture-provider');
    assert.equal(usage.costMetadata.cost, 0.00003);
});

test('AI provider failure settles the reservation as failed without consuming the monthly generation quota', async (t) => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_ai_failure');
    const scan = await store.createScan('ws_ai_failure', 'project', { urls: ['https://example.com/'] });
    await store.saveReport('ws_ai_failure', scan.id, { findings: [{ fingerprint: 'finding-failure', title: 'Fixture', description: 'Fixture description' }] });
    await store.updateScan('ws_ai_failure', scan.id, { status: 'completed', completedAt: '2026-08-15T00:00:00.000Z' });
    const completedScanBeforeAi = structuredClone(await store.getScan('ws_ai_failure', scan.id));
    const completedReportBeforeAi = structuredClone(await store.getLatestReportForScan('ws_ai_failure', scan.id));
    let providerCalls = 0;
    const aiService = { configured: true, async tryGenerateRemediation() { providerCalls += 1; return { ok: false, error: { code: 'AI_SERVICE_TIMEOUT', status: 504, metadata: { provider: 'openrouter' } } }; } };
    const { application } = appWith({ store, aiService });
    t.after(() => application.locals.closeResources());
    const response = await request(application).post('/api/v1/findings/finding-failure/remediation').set('X-Workspace-Id', 'ws_ai_failure').set('Idempotency-Key', 'ai-failure-operation-0001').send({}).expect(504);
    assert.equal(response.body.code, 'AI_SERVICE_TIMEOUT');
    const replay = await request(application).post('/api/v1/findings/finding-failure/remediation').set('X-Workspace-Id', 'ws_ai_failure').set('Idempotency-Key', 'ai-failure-operation-0001').send({}).expect(409);
    assert.equal(replay.body.code, 'AI_GENERATION_PREVIOUSLY_FAILED');
    assert.equal(providerCalls, 1, 'a retry of one logical AI operation must not invoke the provider twice');
    const usage = [...store.aiUsage.values()][0];
    assert.equal(usage.status, 'failed');
    assert.deepEqual(await store.getScan('ws_ai_failure', scan.id), completedScanBeforeAi, 'AI failure must not change the completed core scan');
    assert.deepEqual(await store.getLatestReportForScan('ws_ai_failure', scan.id), completedReportBeforeAi, 'AI failure must not change the core report');
    const next = await store.consumeAiGeneration('ws_ai_failure', {
        userId: 'user', findingFingerprint: 'another', requestedModel: 'vendor/evaluated-model', provider: 'openrouter',
        promptVersion: 'wpa-remediation-v1', evidenceVersion: 'v2', idempotencyKey: 'next-generation'
    });
    assert.equal(next.quota.used, 1);
    assert.equal(next.quota.remaining, 4);
});

test('AI cache-write failure keeps a replayable completed result without a second provider call', async (t) => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_ai_cache_failure');
    const scan = await store.createScan('ws_ai_cache_failure', 'project', { urls: ['https://example.com/'] });
    await store.saveReport('ws_ai_cache_failure', scan.id, { findings: [{ fingerprint: 'finding-cache-failure', title: 'Fixture', description: 'Fixture description' }] });
    const originalPut = store.putAiCache.bind(store);
    let cacheAttempts = 0;
    store.putAiCache = async (...args) => {
        cacheAttempts += 1;
        if (cacheAttempts === 1) throw Object.assign(new Error('cache unavailable'), { code: 'CACHE_WRITE_FAILED' });
        return originalPut(...args);
    };
    let providerCalls = 0;
    const output = { schemaVersion: 'wpa.ai.remediation.v1', summary: 'Durable result', likelyCause: 'Fixture', steps: ['Verify'], codeExample: null, caveats: [], confidence: 'medium' };
    const aiService = { configured: true, async tryGenerateRemediation() { providerCalls += 1; return { ok: true, result: { output, metadata: { actualModel: 'vendor/evaluated-model', cost: { totalCredits: '0.001' } } } }; } };
    const { application } = appWith({ store, aiService });
    t.after(() => application.locals.closeResources());
    await request(application).post('/api/v1/findings/finding-cache-failure/remediation').set('X-Workspace-Id', 'ws_ai_cache_failure').set('Idempotency-Key', 'ai-cache-failure-0001').send({}).expect(500);
    const replay = await request(application).post('/api/v1/findings/finding-cache-failure/remediation').set('X-Workspace-Id', 'ws_ai_cache_failure').set('Idempotency-Key', 'ai-cache-failure-0001').send({}).expect(200);
    assert.deepEqual(replay.body.remediation, output);
    assert.equal(providerCalls, 1);
    assert.equal([...store.aiUsage.values()][0].status, 'completed');
});

test('AI remediation rejects globally at the daily hard cost limit before provider invocation or quota reservation', async (t) => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_ai_hard_limit');
    const scan = await store.createScan('ws_ai_hard_limit', 'project', { urls: ['https://example.com/'] });
    await store.saveReport('ws_ai_hard_limit', scan.id, { findings: [{ fingerprint: 'finding-hard-limit', title: 'Fixture', description: 'Cost guard fixture' }] });
    await store.recordAiUsage({
        workspaceId: 'ws_other_cost', userId: 'user-cost', findingFingerprint: 'other-finding', requestedModel: 'vendor/evaluated-model',
        actualModel: 'vendor/evaluated-model', provider: 'openrouter', promptVersion: 'wpa-remediation-v1', evidenceVersion: 'v2',
        idempotencyKey: 'global-cost-fixture', status: 'completed', costMetadata: { cost: 10 }
    });
    let calls = 0;
    const aiService = { configured: true, async tryGenerateRemediation() { calls += 1; return { ok: false, error: { code: 'SHOULD_NOT_RUN', status: 500 } }; } };
    const { application } = appWith({ store, aiService });
    t.after(() => application.locals.closeResources());
    const response = await request(application).post('/api/v1/findings/finding-hard-limit/remediation').set('X-Workspace-Id', 'ws_ai_hard_limit').set('Idempotency-Key', 'ai-hard-limit-operation-0001').send({}).expect(503);
    assert.equal(response.body.code, 'AI_DAILY_COST_LIMIT_REACHED');
    assert.equal(calls, 0);
    assert.equal([...store.aiUsage.values()].filter((entry) => entry.workspaceId === 'ws_ai_hard_limit').length, 0);
});
