const path = require('node:path');
require('dotenv').config();

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
}

function parseTrustProxy(value) {
    if (!value || value === 'false' || value === '0') return false;
    if (value === 'true' || value === '1') return 1;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
    return value;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';

    const consentSalt = env.CONSENT_SALT;
    if (nodeEnv === 'production' && (!consentSalt || !String(consentSalt).trim())) {
        throw new Error('CONSENT_SALT environment variable is required in production.');
    }

    const scanTimeoutMs = parseNumber(env.SCAN_TIMEOUT_MS, 8 * 60 * 1000); // 8 minutes default for sequential browser lane
    const lighthouseTimeoutMs = parseNumber(env.LIGHTHOUSE_TIMEOUT_MS, 180 * 1000); // 180s
    const axeTimeoutMs = parseNumber(env.AXE_TIMEOUT_MS, 90 * 1000); // 90s
    const yellowLabTimeoutMs = parseNumber(env.YELLOWLAB_TIMEOUT_MS, 150 * 1000); // 150s
    const wpaPageTimeoutMs = parseNumber(env.WPAPAGE_TIMEOUT_MS, 120 * 1000); // 120s
    const advancedBrowserTimeoutMs = parseNumber(env.ADVANCED_BROWSER_TIMEOUT_MS, 150 * 1000); // 150s

    return Object.freeze({
        port: parseNumber(env.PORT, 8080),
        host: env.HOST || '0.0.0.0',
        nodeEnv,
        allowedOrigin: env.ALLOWED_ORIGIN || '',
        trustProxy: parseTrustProxy(env.TRUST_PROXY),
        rateLimitPerHour: parseNumber(env.RATE_LIMIT_PER_HOUR, 3),
        scanConcurrency: parseNumber(env.SCAN_CONCURRENCY, 1),
        maxQueue: parseNumber(env.MAX_QUEUE, 5),
        resultTtlMs: parseNumber(env.RESULT_TTL_MS, 30 * 60 * 1000),
        hostCooldownMs: parseNumber(env.HOST_COOLDOWN_MS, 10 * 60 * 1000),
        dailyScanLimit: parseNumber(env.DAILY_SCAN_LIMIT, 200),
        maxStoredResults: parseNumber(env.MAX_STORED_RESULTS, 100),
        scanTimeoutMs,
        timeouts: Object.freeze({
            scanMs: scanTimeoutMs,
            lighthouseMs: lighthouseTimeoutMs,
            axeMs: axeTimeoutMs,
            yellowLabMs: yellowLabTimeoutMs,
            wpaPageMs: wpaPageTimeoutMs,
            advancedBrowserMs: advancedBrowserTimeoutMs
        }),
        lighthouseTimeoutMs,
        axeTimeoutMs,
        yellowLabTimeoutMs,
        wpaPageTimeoutMs,
        advancedBrowserTimeoutMs,
        consentVersion: env.CONSENT_VERSION || '2026-10-15',
        consentSalt: consentSalt || 'development-consent-salt',
        chromePath: env.CHROME_PATH || '',
        chromeNoSandbox: parseBoolean(env.CHROME_NO_SANDBOX, false),
        artifactDir: env.ARTIFACT_DIR || path.join(__dirname, 'artifacts'),
        allowedPorts: Object.freeze([80, 443]),
        proxyConnectTimeoutMs: parseNumber(env.PROXY_CONNECT_TIMEOUT_MS, 10_000),
        yellowLabMaxPollAttempts: parseNumber(env.YELLOWLAB_MAX_POLL_ATTEMPTS, 24)
    });
}

let config;
try {
    config = loadConfig(process.env);
} catch (err) {
    if (process.env.NODE_ENV === 'test') {
        // Fallback for test runner if process.env has not set CONSENT_SALT
        config = loadConfig({ ...process.env, CONSENT_SALT: 'test-consent-salt' });
    } else {
        throw err;
    }
}

module.exports = { config, loadConfig };
