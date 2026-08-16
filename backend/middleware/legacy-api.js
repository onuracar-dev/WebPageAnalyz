const { AppError } = require('../lib/errors');
const { optionalApiKey } = require('./auth');

function requireLegacyApiAccess(config) {
    return (request, response, next) => {
        if (!config.legacyApi?.enabled) {
            return next(new AppError('This legacy endpoint is disabled.', { status: 404, code: 'LEGACY_API_DISABLED' }));
        }
        if (config.legacyApi.allowUnauthenticatedDevelopment && !config.apiKeys.length) return next();
        if (!config.apiKeys.length) {
            return next(new AppError('This legacy endpoint is disabled until API_KEYS is configured.', { status: 503, code: 'LEGACY_API_KEY_NOT_CONFIGURED' }));
        }
        return optionalApiKey(config.apiKeys)(request, response, next);
    };
}

module.exports = { requireLegacyApiAccess };
