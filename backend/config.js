const path = require('node:path');

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boolean(value, fallback = false) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function csv(value, fallback = []) {
    if (!value) return fallback;
    return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function bodyLimit(value) {
    return /^\d+(?:kb|mb)$/i.test(value || '') ? value : '32kb';
}

function loadConfig(env = process.env) {
    const allowedPorts = csv(env.ALLOWED_TARGET_PORTS, ['80', '443'])
        .map((port) => integer(port, null, { min: 1, max: 65535 }))
        .filter(Boolean);

    return Object.freeze({
        nodeEnv: env.NODE_ENV || 'development',
        port: integer(env.PORT, 5000, { min: 1, max: 65535 }),
        trustProxy: boolean(env.TRUST_PROXY, false) ? 1 : false,
        corsOrigins: csv(env.CORS_ORIGINS, ['http://localhost:5173', 'http://127.0.0.1:5173']),
        apiKeys: csv(env.API_KEYS),
        adminApiKeys: csv(env.ADMIN_API_KEYS || env.ADMIN_API_KEY),
        bodyLimit: bodyLimit(env.REQUEST_BODY_LIMIT),
        allowedTargetPorts: allowedPorts.length > 0 ? allowedPorts : [80, 443],
        rateLimits: {
            generalWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            generalMax: integer(env.RATE_LIMIT_MAX, 120),
            analysisWindowMs: integer(env.ANALYZE_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
            analysisMax: integer(env.ANALYZE_RATE_LIMIT_MAX, 10),
            aiWindowMs: integer(env.AI_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
            aiMax: integer(env.AI_RATE_LIMIT_MAX, 20)
        },
        maxConcurrentAnalyses: integer(env.MAX_CONCURRENT_ANALYSES, 1, { min: 1, max: 16 }),
        maxQueuedAnalyses: integer(env.MAX_QUEUED_ANALYSES, 8, { min: 0, max: 100 }),
        timeouts: {
            analysisMs: integer(env.ANALYSIS_TIMEOUT_MS, 4 * 60 * 1000),
            lighthouseMs: integer(env.LIGHTHOUSE_TIMEOUT_MS, 3 * 60 * 1000),
            axeMs: integer(env.AXE_TIMEOUT_MS, 90 * 1000),
            yellowLabMs: integer(env.YELLOWLAB_TIMEOUT_MS, 150 * 1000),
            aiMs: integer(env.AI_TIMEOUT_MS, 45 * 1000),
            proxyConnectMs: integer(env.PROXY_CONNECT_TIMEOUT_MS, 10 * 1000)
        },
        proxyLimits: {
            maxConnections: integer(env.PROXY_MAX_CONNECTIONS, 100, { min: 1, max: 1000 }),
            maxResponseBytes: integer(env.PROXY_MAX_RESPONSE_BYTES, 25 * 1024 * 1024),
            maxTotalBytes: integer(env.PROXY_MAX_TOTAL_BYTES, 250 * 1024 * 1024)
        },
        artifactDir: path.resolve(__dirname, env.ARTIFACT_DIR || 'logs'),
        keepArtifacts: boolean(env.KEEP_ANALYZER_ARTIFACTS, false),
        geminiApiKey: env.GEMINI_API_KEY || '',
        geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
        yellowLabMaxPollAttempts: integer(env.YELLOWLAB_MAX_POLL_ATTEMPTS, 24, { min: 1, max: 60 }),
        chromePath: env.CHROME_PATH || '',
        chromeNoSandbox: boolean(env.CHROME_NO_SANDBOX, false)
    });
}

module.exports = { loadConfig };
