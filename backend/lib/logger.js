function serializeError(error) {
    if (!error) return undefined;
    return {
        name: error.name,
        message: redact(error.message),
        code: error.code,
        stack: process.env.NODE_ENV === 'production' ? undefined : redact(error.stack)
    };
}

function redact(value) {
    return String(value || '')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
        .replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
        // URL userinfo is credential material even when no query string is present.
        .replace(/(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, '$1[redacted]@')
        .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[redacted]')
        .replace(/\b(?:AIza[\w-]{20,}|npm_[A-Za-z0-9]{20,})\b/g, '[redacted-secret]')
        .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+\b/gi, '[redacted-secret]')
        .replace(/\bwhsec_[A-Za-z0-9]+\b/gi, '[redacted-secret]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[redacted-secret]')
        .replace(/(cookie|set-cookie|x-wpa-signature)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/(authorization|x-api-key|password|passphrase|totp|secret|token|access[-_]?token|refresh[-_]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

const sensitiveKey = /(?:password|passphrase|totp|secret|token|api[-_]?key|authorization|cookie|set-cookie|signature|access[-_]?token|refresh[-_]?token)/i;

function sanitizeValue(value, key = '', seen = new WeakSet(), depth = 0) {
    if (sensitiveKey.test(key)) return '[redacted]';
    if (value instanceof Error) return serializeError(value);
    if (typeof value === 'string') return redact(value);
    if (value === null || typeof value !== 'object') return value;
    if (Buffer.isBuffer(value)) return '[redacted-buffer]';
    if (depth >= 5) return '[truncated]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, '', seen, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, seen, depth + 1)]));
}

function sanitizeContext(context = {}) {
    return sanitizeValue(context);
}

function write(level, message, context = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        message: redact(message),
        ...sanitizeContext(context)
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

const logger = {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context)
};

module.exports = { logger, redact, serializeError, sanitizeContext };
