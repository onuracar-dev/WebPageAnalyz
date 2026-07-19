const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');

function extractApiKey(request) {
    const headerKey = request.get('x-api-key');
    const authorization = request.get('authorization');
    const bearerKey = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    return headerKey || bearerKey || '';
}

function safeEqual(left, right) {
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function keyMatches(candidate, configuredKeys) {
    if (!candidate) return false;
    return configuredKeys.some((key) => safeEqual(candidate, key));
}

function optionalApiKey(configuredKeys = []) {
    return (request, response, next) => {
        if (configuredKeys.length === 0) return next();
        const candidate = extractApiKey(request);
        if (!keyMatches(candidate, configuredKeys)) {
            response.setHeader('WWW-Authenticate', 'Bearer realm="webpage-analyzer"');
            return next(new AppError('A valid API key is required.', {
                status: 401,
                code: 'AUTHENTICATION_REQUIRED'
            }));
        }
        request.apiKeyId = crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 16);
        return next();
    };
}

function requireAdminApiKey(configuredKeys = []) {
    return (request, response, next) => {
        if (configuredKeys.length === 0) {
            return next(new AppError('The administrative endpoint is disabled.', {
                status: 503,
                code: 'ADMIN_ENDPOINT_DISABLED'
            }));
        }
        if (!keyMatches(extractApiKey(request), configuredKeys)) {
            response.setHeader('WWW-Authenticate', 'Bearer realm="webpage-analyzer-admin"');
            return next(new AppError('Administrator authentication is required.', {
                status: 401,
                code: 'ADMIN_AUTHENTICATION_REQUIRED'
            }));
        }
        return next();
    };
}

module.exports = { extractApiKey, optionalApiKey, requireAdminApiKey };
