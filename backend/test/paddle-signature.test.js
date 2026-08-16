const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyPaddleSignature } = require('../billing/paddle');

const secret = 'pdl_ntfset_test_secret';
const timestamp = 2_000_000_000;
const now = () => timestamp * 1000;

function signature(body, { ts = timestamp, extra = [] } = {}) {
    const digest = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return [`ts=${ts}`, ...extra.map((value) => `h1=${value}`), `h1=${digest}`].join(';');
}

test('Paddle signature verification uses the exact raw body and accepts a matching h1 during rotation', () => {
    const rawBody = Buffer.from('{"event_id":"evt_1","data":{"value":"exact spacing"}}');
    const header = signature(rawBody.toString('utf8'), { extra: ['0'.repeat(64)] });
    const verified = verifyPaddleSignature(rawBody, header, secret, { now, toleranceSeconds: 5 });
    assert.equal(verified.timestamp, timestamp);
    assert.equal(verified.rawBody, rawBody.toString('utf8'));
    assert.throws(
        () => verifyPaddleSignature(Buffer.from('{"event_id":"evt_1", "data":{"value":"exact spacing"}}'), header, secret, { now, toleranceSeconds: 5 }),
        { code: 'INVALID_WEBHOOK_SIGNATURE' }
    );
});

test('Paddle signature verification rejects replayed, future, malformed, and non-raw payloads', () => {
    const body = '{}';
    assert.throws(
        () => verifyPaddleSignature(body, signature(body, { ts: timestamp - 6 }), secret, { now, toleranceSeconds: 5 }),
        { code: 'INVALID_WEBHOOK_SIGNATURE' }
    );
    assert.throws(
        () => verifyPaddleSignature(body, signature(body, { ts: timestamp + 6 }), secret, { now, toleranceSeconds: 5 }),
        { code: 'INVALID_WEBHOOK_SIGNATURE' }
    );
    assert.throws(
        () => verifyPaddleSignature(body, `ts=${timestamp};h1=not-hex`, secret, { now, toleranceSeconds: 5 }),
        { code: 'INVALID_WEBHOOK_SIGNATURE' }
    );
    assert.throws(
        () => verifyPaddleSignature({ parsed: true }, signature(body), secret, { now, toleranceSeconds: 5 }),
        { code: 'BILLING_RAW_BODY_REQUIRED' }
    );
});
