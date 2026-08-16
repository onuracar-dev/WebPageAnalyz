const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendProvider, RESEND_EMAILS_URL } = require('../email/resend-provider');

test('Resend provider uses the fixed API endpoint and explicit payload for every supported template', async () => {
    const requests = [];
    const logs = [];
    const provider = createResendProvider({
        apiKey: 're_test_secret_key_value',
        from: 'WebPageAnalyz <noreply@example.com>',
        appUrl: 'https://app.example.com',
        supportEmail: 'support@example.com',
        logger: { info(message, details) { logs.push({ message, details }); } },
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return new Response(JSON.stringify({ id: `email-${requests.length}` }), { status: 200 });
        }
    });
    const fixtures = [
        { kind: 'verification', to: 'user@example.com', url: 'https://app.example.com/verify?token=private' },
        { kind: 'reset', to: 'user@example.com', url: 'https://app.example.com/reset?token=private' },
        { kind: 'support', to: 'user@example.com', data: { ticketId: 'ticket-1' } },
        { kind: 'security', to: 'user@example.com', data: { event: '<script>new login</script>' } },
        { kind: 'subscription', to: 'user@example.com', data: { status: 'aktif', plan: 'Pro' }, idempotencyKey: 'subscription-event-1' }
    ];
    for (const fixture of fixtures) assert.equal((await provider.send(fixture)).accepted, true);
    assert.equal(requests.length, 5);
    for (const request of requests) {
        assert.equal(request.url, RESEND_EMAILS_URL);
        assert.equal(request.options.redirect, 'error');
        assert.equal(request.options.headers.Authorization, 'Bearer re_test_secret_key_value');
        const body = JSON.parse(request.options.body);
        assert.deepEqual(body.to, ['user@example.com']);
        assert.equal(typeof body.subject, 'string');
        assert.equal(typeof body.html, 'string');
        assert.equal(typeof body.text, 'string');
    }
    assert.equal(requests[4].options.headers['Idempotency-Key'], 'subscription-event-1');
    assert.doesNotMatch(JSON.stringify(JSON.parse(requests[3].options.body).html), /<script>/);
    assert.equal(logs.length, 5);
    assert.doesNotMatch(JSON.stringify(logs), /user@example\.com|private|re_test_secret/);
});

test('Resend provider validates recipient, callback and configuration before fetch', async () => {
    let calls = 0;
    const provider = createResendProvider({
        apiKey: 're_test_secret_key_value', from: 'noreply@example.com', appUrl: 'https://app.example.com',
        fetchImpl: async () => { calls += 1; return new Response('{}', { status: 200 }); }
    });
    await assert.rejects(() => provider.send({ kind: 'verification', to: 'not-an-email', url: 'https://app.example/verify' }), { code: 'EMAIL_RECIPIENT_INVALID' });
    await assert.rejects(() => provider.send({ kind: 'reset', to: 'user@example.com', url: 'javascript:alert(1)' }), { code: 'EMAIL_CALLBACK_INVALID' });
    await assert.rejects(() => provider.send({ kind: 'reset', to: 'user@example.com', url: 'https://phishing.example/reset' }), { code: 'EMAIL_CALLBACK_INVALID' });
    await assert.rejects(() => provider.send({ kind: 'unknown', to: 'user@example.com' }), { code: 'EMAIL_KIND_INVALID' });
    assert.equal(calls, 0);
});

test('Resend provider bounds timeout without exposing credentials', async () => {
    const provider = createResendProvider({
        apiKey: 're_test_secret_key_value', from: 'noreply@example.com', appUrl: 'https://app.example.com', timeoutMs: 5,
        fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    });
    await assert.rejects(() => provider.send({ kind: 'security', to: 'user@example.com', data: { event: 'login' } }), { code: 'EMAIL_PROVIDER_TIMEOUT' });
});
