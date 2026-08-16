const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');

function canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function operationFingerprint(value) {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeIdempotencyKey(value, { required = true } = {}) {
    const key = String(value || '').trim();
    if (!key && !required) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
        throw new AppError('A valid Idempotency-Key header is required.', { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    return key;
}

function assertIdempotentReplay(existingFingerprint, requestedFingerprint) {
    if (existingFingerprint && requestedFingerprint && existingFingerprint !== requestedFingerprint) {
        throw new AppError('The idempotency key was already used for a different request.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    }
}

module.exports = { canonicalize, operationFingerprint, normalizeIdempotencyKey, assertIdempotentReplay };
