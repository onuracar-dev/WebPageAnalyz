const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIServiceClient } = require('../ai/client');
const { createAIHttpService, loadAIServiceConfig } = require('../ai/http-service');
const { REMEDIATION_SCHEMA_VERSION } = require('../ai/schemas');

const token = 'internal-test-token-that-is-long-enough';
const result = Object.freeze({
    operation: 'remediation',
    output: Object.freeze({
        schemaVersion: REMEDIATION_SCHEMA_VERSION,
        summary: 'Özet', likelyCause: 'Neden', steps: Object.freeze(['Adım']), codeExample: null,
        caveats: Object.freeze(['Doğrulayın']), confidence: 'medium'
    }),
    metadata: Object.freeze({ provider: 'fixture', requestedModel: 'fixture', actualModel: 'fixture', actualProvider: 'fixture', latencyMs: 1 })
});

function config(overrides = {}) {
    return {
        internalToken: token, host: '127.0.0.1', port: 0, maxBodyBytes: 2_048, maxResponseBytes: 32_768,
        maxConcurrency: 2, rateLimitPerMinute: 20, requestTimeoutMs: 5_000, ...overrides
    };
}

async function runningService(t, provider, overrides) {
    const service = createAIHttpService({ provider, config: config(overrides), logger: { info() {}, warn() {} } });
    const address = await service.listen(0, '127.0.0.1');
    t.after(() => service.close());
    return `http://127.0.0.1:${address.port}`;
}

test('AI service exposes health and requires internal bearer auth', async (t) => {
    const provider = { name: 'fixture', configured: true, async generateRemediation() { return result; }, async generateExecutiveSummary() { return result; } };
    const baseUrl = await runningService(t, provider);
    assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), { status: 'ok', provider: 'fixture', configured: true });
    const unauthorized = await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
});

test('API-side AI client reaches only the allowlisted internal service and returns normalized result', async (t) => {
    let received;
    let receivedSummary;
    const provider = {
        name: 'fixture', configured: true,
        async generateRemediation(finding) { received = finding; return result; },
        async generateExecutiveSummary(input) { receivedSummary = input; return { ...result, operation: 'executive-summary' }; }
    };
    const baseUrl = await runningService(t, provider);
    const client = createAIServiceClient({ baseUrl, internalToken: token });
    const response = await client.generateRemediation({ title: 'Fixture', description: 'Description' });
    assert.equal(response.output.schemaVersion, REMEDIATION_SCHEMA_VERSION);
    assert.equal(received.title, 'Fixture');
    const summary = await client.generateExecutiveSummary({ performance: 50 });
    assert.equal(summary.operation, 'executive-summary');
    assert.deepEqual(receivedSummary, { scores: { performance: 50 } });
    assert.equal(createAIServiceClient({ baseUrl: 'https://public.example', internalToken: token }).configured, false);
});

test('AI service enforces body and concurrency limits and masks provider errors', async (t) => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const provider = {
        name: 'fixture', configured: true,
        async generateRemediation() { entered(); await new Promise((resolve) => { release = resolve; }); return result; },
        async generateExecutiveSummary() { throw new Error('provider-secret-detail'); }
    };
    const baseUrl = await runningService(t, provider, { maxConcurrency: 1, maxBodyBytes: 256 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const first = fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'B' } }) });
    await started;
    const busy = await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'B' } }) });
    assert.equal(busy.status, 429);
    release();
    assert.equal((await first).status, 200);
    const oversized = await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'x'.repeat(500) } }) });
    assert.equal(oversized.status, 413);
    const unknown = await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'B' }, extra: true }) });
    assert.equal(unknown.status, 400);
    const failed = await fetch(`${baseUrl}/v1/executive-summaries`, { method: 'POST', headers, body: JSON.stringify({ scores: { performance: 50 } }) });
    const failedBody = await failed.json();
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failedBody), /provider-secret-detail/);
});

test('AI client exposes a clean fail-soft result for core-scan-independent use', async () => {
    const client = createAIServiceClient({
        baseUrl: 'http://ai-service:5010', internalToken: token,
        fetchImpl: async () => { throw new Error('socket detail'); }
    });
    const response = await client.tryGenerateRemediation({ title: 'A', description: 'B' });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'AI_SERVICE_UNAVAILABLE');
    assert.equal(Object.hasOwn(response.error, 'message'), false);
});

test('AI service enforces its exact env contract and per-minute rate limit', async (t) => {
    const env = {
        NODE_ENV: 'production', AI_SERVICE_TOKEN: token, OPENROUTER_API_KEY: 'sk-or-v1-key-long-enough',
        OPENROUTER_MODEL_PRIMARY: 'vendor/primary', OPENROUTER_MODEL_FALLBACKS: 'vendor/fallback-a,vendor/fallback-b',
        OPENROUTER_SITE_URL: 'https://app.example.com', OPENROUTER_APP_NAME: 'WebPageAnalyz',
        AI_MAX_REQUESTS_PER_MINUTE: '1', AI_MAX_CONCURRENT_REQUESTS: '1', AI_MAX_OUTPUT_TOKENS: '900'
    };
    const loaded = loadAIServiceConfig(env);
    assert.equal(loaded.internalToken, token);
    assert.deepEqual(loaded.openRouter.fallbackModels, ['vendor/fallback-a', 'vendor/fallback-b']);
    assert.equal(loaded.openRouter.maxOutputTokens, 900);
    assert.equal(loaded.openRouter.maxInputTokens, 4_096);
    assert.equal(loaded.openRouter.zeroDataRetention, false);
    assert.equal(loaded.openRouter.structuredOutputMode, 'native');
    assert.equal(loaded.openRouter.reasoningEffort, null);
    assert.equal(loaded.rateLimitPerMinute, 1);
    const provider = { name: 'fixture', configured: true, async generateRemediation() { return result; }, async generateExecutiveSummary() { return result; } };
    const baseUrl = await runningService(t, provider, { rateLimitPerMinute: 1 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'B' } }) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/remediations`, { method: 'POST', headers, body: JSON.stringify({ finding: { title: 'A', description: 'B' } }) })).status, 429);
    assert.throws(() => loadAIServiceConfig({ ...env, AI_SERVICE_TOKEN: '' }), /AI_SERVICE_TOKEN/);
    assert.throws(() => loadAIServiceConfig({ ...env, AI_PROVIDER: 'gemini' }), /AI_PROVIDER/);
    assert.throws(() => loadAIServiceConfig({ ...env, OPENROUTER_METADATA_ENABLED: 'false' }), /OPENROUTER_METADATA_ENABLED/);
    assert.throws(() => loadAIServiceConfig({ ...env, OPENROUTER_STRUCTURED_OUTPUT_MODE: 'prompt' }), /must remain native in production/);
    const localCompatibility = loadAIServiceConfig({
        ...env,
        NODE_ENV: 'development',
        OPENROUTER_STRUCTURED_OUTPUT_MODE: 'prompt',
        OPENROUTER_REASONING_EFFORT: 'none'
    });
    assert.equal(localCompatibility.openRouter.structuredOutputMode, 'prompt');
    assert.equal(localCompatibility.openRouter.reasoningEffort, 'none');
});
