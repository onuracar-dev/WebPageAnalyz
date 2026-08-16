const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { createEmailTransport } = require('../auth/email-transport');

test('email transport is explicitly unavailable until configured', async () => {
    const transport = createEmailTransport({ config: loadConfig({ NODE_ENV: 'test' }) });
    assert.equal(transport.configured, false);
    await assert.rejects(() => transport.send({ kind: 'reset', to: 'user@example.com', url: 'https://app.example/reset' }), { code: 'RESET_PASSWORD_DISABLED' });
    await assert.rejects(() => transport.send({ kind: 'verification', to: 'user@example.com', url: 'https://app.example/verify' }), { code: 'VERIFICATION_EMAIL_NOT_ENABLED' });
});

test('explicit email disable and provider none win over credentials or injected transport', async () => {
    const config = loadConfig({ NODE_ENV: 'test', EMAIL_DELIVERY_ENABLED: 'false', EMAIL_PROVIDER: 'generic', EMAIL_PROVIDER_URL: 'https://mail.example/send', EMAIL_PROVIDER_API_KEY: 'secret', EMAIL_FROM: 'noreply@example.com' });
    const transport = createEmailTransport({ config, transport: { async send() { throw new Error('must not send'); } } });
    assert.equal(transport.configured, false);
    await assert.rejects(() => transport.send({ kind: 'reset', to: 'user@example.com', url: 'https://app.example/reset' }), { code: 'RESET_PASSWORD_DISABLED' });
    const none = loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'none', EMAIL_PROVIDER_URL: 'https://mail.example/send', EMAIL_PROVIDER_API_KEY: 'secret', EMAIL_FROM: 'noreply@example.com' });
    assert.equal(createEmailTransport({ config: none }).configured, false);
});

test('configured transactional email uses HTTPS, timeout and redacted observability', async () => {
    let request;
    const logger = { info(_message, details) { assert.equal(details.providerHost, 'mail.example'); assert.equal(Object.hasOwn(details, 'url'), false); } };
    const transport = createEmailTransport({
        config: loadConfig({ NODE_ENV: 'production', EMAIL_PROVIDER_URL: 'https://mail.example/send', EMAIL_PROVIDER_API_KEY: 'secret', EMAIL_FROM: 'noreply@example.com', EMAIL_PROVIDER_HOST_ALLOWLIST: 'mail.example' }),
        logger,
        fetchImpl: async (_url, options) => { request = options; return { ok: true }; }
    });
    assert.equal(transport.configured, true);
    await transport.send({ kind: 'verification', to: 'user@example.com', url: 'https://app.example/verify?token=secret' });
    assert.equal(request.redirect, 'error');
    assert.equal(JSON.parse(request.body).callbackUrl.endsWith('secret'), true);
    await assert.rejects(() => createEmailTransport({ config: loadConfig({ NODE_ENV: 'production', EMAIL_PROVIDER_URL: 'http://mail.example/send', EMAIL_PROVIDER_API_KEY: 'secret', EMAIL_FROM: 'noreply@example.com' }) }).send({ kind: 'reset', to: 'u', url: 'https://app.example/reset' }), { code: 'EMAIL_PROVIDER_INVALID' });
});
