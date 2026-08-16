const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailTransport } = require('../auth/email-transport');
const { createEmailServiceClient } = require('../email/client');
const { createEmailHttpService, loadEmailServiceConfig } = require('../email/http-service');

const token = 'email-internal-token-that-is-long-enough';

function config(overrides = {}) {
    return {
        internalToken: token, host: '127.0.0.1', port: 0, maxBodyBytes: 2_048, maxResponseBytes: 8_192,
        maxConcurrency: 2, rateLimitPerMinute: 20, requestTimeoutMs: 5_000, ...overrides
    };
}

async function start(t, provider, overrides) {
    const service = createEmailHttpService({ provider, config: config(overrides), logger: { info() {}, warn() {} } });
    const address = await service.listen(0, '127.0.0.1');
    t.after(() => service.close());
    return `http://127.0.0.1:${address.port}`;
}

test('email service health, internal auth and API-side client form an isolated boundary', async (t) => {
    let input;
    const provider = { name: 'resend', configured: true, async send(value) { input = value; return { accepted: true, provider: 'resend', messageId: 'email-1' }; } };
    const baseUrl = await start(t, provider);
    assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), { status: 'ok', provider: 'resend', configured: true });
    assert.equal((await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const client = createEmailServiceClient({ baseUrl, token });
    const delivered = await client.send({ kind: 'support', to: 'user@example.com', data: { ticketId: 'ticket-1' } });
    assert.equal(delivered.messageId, 'email-1');
    assert.deepEqual(input, { kind: 'support', to: 'user@example.com', url: null, data: { ticketId: 'ticket-1' }, idempotencyKey: null });
});

test('email service enforces strict body and concurrency limits', async (t) => {
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const provider = {
        name: 'resend', configured: true,
        async send() { entered(); await new Promise((resolve) => { release = resolve; }); return { accepted: true, provider: 'resend' }; }
    };
    const baseUrl = await start(t, provider, { maxConcurrency: 1, maxBodyBytes: 256 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const first = fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ kind: 'security', to: 'user@example.com', data: { event: 'login' } }) });
    await started;
    const busy = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ kind: 'security', to: 'user@example.com', data: { event: 'login' } }) });
    assert.equal(busy.status, 429);
    release();
    assert.equal((await first).status, 200);
    const unknown = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ kind: 'security', to: 'user@example.com', unexpected: true }) });
    assert.equal(unknown.status, 400);
    const large = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ kind: 'security', to: 'user@example.com', data: { event: 'x'.repeat(500) } }) });
    assert.equal(large.status, 413);
});

test('auth transport sends only to the internal email service and never uses a Resend key', async () => {
    let request;
    const transport = createEmailTransport({
        config: {
            nodeEnv: 'production', appUrl: 'https://app.example.com',
            email: {
                provider: 'resend', deliveryEnabled: true, serviceUrl: 'http://email-service:5020', serviceToken: token,
                resendApiKey: 'must-not-be-used-by-api', timeoutMs: 1_000
            }
        },
        fetchImpl: async (url, options) => {
            request = { url: String(url), options };
            return new Response(JSON.stringify({ ok: true, result: { accepted: true, provider: 'resend', messageId: 'email-1' } }), { status: 200 });
        }
    });
    assert.equal(transport.configured, true);
    await transport.send({ kind: 'verification', to: 'user@example.com', url: 'https://app.example.com/verify?token=private' });
    assert.equal(request.url, 'http://email-service:5020/v1/messages');
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    assert.doesNotMatch(JSON.stringify(request.options), /must-not-be-used-by-api/);

    const direct = createEmailTransport({ config: { nodeEnv: 'production', email: { provider: 'resend', deliveryEnabled: true, resendApiKey: 'direct-key', from: 'noreply@example.com' } } });
    assert.equal(direct.configured, false);
});

test('email service production env contract requires service token and Resend-only credentials', () => {
    const env = {
        NODE_ENV: 'production', EMAIL_SERVICE_TOKEN: token, RESEND_API_KEY: 're_live_key_long_enough',
        EMAIL_FROM: 'noreply@example.com', SUPPORT_EMAIL: 'support@example.com', APP_URL: 'https://app.example.com'
    };
    const loaded = loadEmailServiceConfig(env);
    assert.equal(loaded.internalToken, token);
    assert.equal(loaded.resend.apiKey, 're_live_key_long_enough');
    assert.throws(() => loadEmailServiceConfig({ ...env, EMAIL_SERVICE_TOKEN: '' }), /EMAIL_SERVICE_TOKEN/);
    assert.throws(() => loadEmailServiceConfig({ ...env, EMAIL_PROVIDER: 'generic' }), /EMAIL_PROVIDER/);
});

test('email service applies its per-minute rate limit after authentication', async (t) => {
    const provider = { name: 'resend', configured: true, async send() { return { accepted: true, provider: 'resend' }; } };
    const baseUrl = await start(t, provider, { rateLimitPerMinute: 1 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ kind: 'security', to: 'user@example.com', data: { event: 'login' } });
    assert.equal((await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body })).status, 429);
});
