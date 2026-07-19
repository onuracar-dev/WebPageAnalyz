const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function clientKey(request) {
    if (request.apiKeyId) return `key:${request.apiKeyId}`;
    return `ip:${ipKeyGenerator(request.ip)}`;
}

function limiter({ windowMs, max, message }) {
    return rateLimit({
        windowMs,
        limit: max,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        keyGenerator: clientKey,
        handler: (request, response) => response.status(429).json({
            error: message,
            code: 'RATE_LIMIT_EXCEEDED',
            requestId: request.id
        })
    });
}

module.exports = { limiter };
