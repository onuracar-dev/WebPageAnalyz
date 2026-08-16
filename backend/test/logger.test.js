const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, sanitizeContext } = require('../lib/logger');

test('logger redacts URL queries and recognizable secrets', () => {
    const fakeNpmToken = `npm_${'a'.repeat(24)}`;
    const value = redact(`failed https://example.com/path?token=secret ${fakeNpmToken}`);
    assert.equal(value.includes('token=secret'), false);
    assert.equal(value.includes(fakeNpmToken), false);
    assert.match(value, /\[redacted\]/);
});

test('logger redacts URL userinfo credentials', () => {
    const value = redact('request failed https://alice:super-secret@example.com/private/path');
    assert.equal(value.includes('alice'), false);
    assert.equal(value.includes('super-secret'), false);
    assert.match(value, /https:\/\/\[redacted\]@example\.com\/private\/path/);
});

test('logger redacts billing, webhook, provider and cookie material', () => {
    const value = redact('sk_live_123456 whsec_abcdef ghp_123456 glpat-abcdef Cookie: session=secret X-WPA-Signature: sha256=secret');
    assert.equal(value.includes('sk_live_123456'), false);
    assert.equal(value.includes('whsec_abcdef'), false);
    assert.equal(value.includes('ghp_123456'), false);
    assert.equal(value.includes('glpat-abcdef'), false);
    assert.equal(value.includes('session=secret'), false);
    assert.equal(value.includes('sha256=secret'), false);
});

test('logger redacts the complete Bearer credential from headers and free text', () => {
    const value = redact('Authorization: Bearer super-secret-jwt-value Bearer another-secret');
    assert.equal(value.includes('super-secret-jwt-value'), false);
    assert.equal(value.includes('another-secret'), false);
});

test('logger sanitizes sensitive context keys and nested error strings', () => {
    const safe = sanitizeContext({
        password: 'do-not-log',
        nested: { authorization: 'Bearer secret', detail: 'https://example.com/?token=secret' },
        error: new Error('provider failed with secret=do-not-log')
    });
    assert.equal(safe.password, '[redacted]');
    assert.equal(safe.nested.authorization, '[redacted]');
    assert.equal(safe.nested.detail.includes('token=secret'), false);
    assert.equal(safe.error.message.includes('secret=do-not-log'), false);
});
