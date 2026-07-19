const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../lib/logger');

test('logger redacts URL queries and recognizable secrets', () => {
    const fakeNpmToken = `npm_${'a'.repeat(24)}`;
    const value = redact(`failed https://example.com/path?token=secret ${fakeNpmToken}`);
    assert.equal(value.includes('token=secret'), false);
    assert.equal(value.includes(fakeNpmToken), false);
    assert.match(value, /\[redacted\]/);
});
