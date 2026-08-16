const crypto = require('node:crypto');
const http = require('node:http');
const { AppError } = require('../lib/errors');
const { assertAIProvider } = require('./provider');

function integer(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boolean(value, fallback) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function csv(value) {
    return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function enumValue(value, fallback, allowed, name) {
    const normalized = String(value || fallback).trim().toLowerCase();
    if (!allowed.includes(normalized)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
    return normalized;
}

function loadAIServiceConfig(env = process.env) {
    const nodeEnv = String(env.NODE_ENV || 'development').toLowerCase();
    const config = Object.freeze({
        nodeEnv,
        provider: String(env.AI_PROVIDER || 'openrouter').trim().toLowerCase(),
        host: env.AI_SERVICE_HOST || '0.0.0.0',
        port: integer(env.AI_SERVICE_PORT, 5010, 1, 65_535),
        internalToken: String(env.AI_SERVICE_TOKEN || env.AI_SERVICE_INTERNAL_TOKEN || ''),
        maxBodyBytes: integer(env.AI_SERVICE_MAX_BODY_BYTES, 24 * 1024, 1_024, 256 * 1024),
        maxResponseBytes: integer(env.AI_SERVICE_MAX_RESPONSE_BYTES, 96 * 1024, 1_024, 512 * 1024),
        maxConcurrency: integer(env.AI_MAX_CONCURRENT_REQUESTS || env.AI_SERVICE_MAX_CONCURRENCY, 2, 1, 16),
        rateLimitPerMinute: integer(env.AI_MAX_REQUESTS_PER_MINUTE || env.AI_SERVICE_RATE_LIMIT_PER_MINUTE, 30, 1, 10_000),
        requestTimeoutMs: integer(env.AI_SERVICE_REQUEST_TIMEOUT_MS, 50_000, 1_000, 120_000),
        openRouter: Object.freeze({
            apiKey: String(env.OPENROUTER_API_KEY || ''),
            primaryModel: String(env.OPENROUTER_MODEL_PRIMARY || env.OPENROUTER_PRIMARY_MODEL || '').trim(),
            fallbackModels: Object.freeze(csv(env.OPENROUTER_MODEL_FALLBACKS || env.OPENROUTER_FALLBACK_MODELS)),
            httpReferer: String(env.OPENROUTER_SITE_URL || env.OPENROUTER_HTTP_REFERER || '').trim(),
            appTitle: String(env.OPENROUTER_APP_NAME || env.OPENROUTER_APP_TITLE || '').trim(),
            timeoutMs: integer(env.OPENROUTER_TIMEOUT_MS, 45_000, 1_000, 120_000),
            maxRequestBytes: integer(env.OPENROUTER_MAX_REQUEST_BYTES, 24 * 1024, 1_024, 256 * 1024),
            maxResponseBytes: integer(env.OPENROUTER_MAX_RESPONSE_BYTES, 64 * 1024, 1_024, 512 * 1024),
            maxInputTokens: integer(env.AI_MAX_INPUT_TOKENS, 4_096, 128, 1_000_000),
            maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 1_200, 64, 100_000),
            maxAttempts: integer(env.OPENROUTER_MAX_ATTEMPTS, 2, 1, 3),
            structuredOutputMode: enumValue(env.OPENROUTER_STRUCTURED_OUTPUT_MODE, 'native', ['native', 'prompt'], 'OPENROUTER_STRUCTURED_OUTPUT_MODE'),
            reasoningEffort: env.OPENROUTER_REASONING_EFFORT
                ? enumValue(env.OPENROUTER_REASONING_EFFORT, '', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'OPENROUTER_REASONING_EFFORT')
                : null,
            metadataEnabled: boolean(env.OPENROUTER_METADATA_ENABLED, true),
            dataCollection: env.OPENROUTER_DATA_COLLECTION === 'allow' ? 'allow' : 'deny',
            zeroDataRetention: boolean(env.OPENROUTER_ZDR, false)
        })
    });
    if (nodeEnv === 'production') {
        if (config.provider !== 'openrouter') throw new Error('AI_PROVIDER must be openrouter for the production AI service.');
        if (!config.openRouter.metadataEnabled) throw new Error('OPENROUTER_METADATA_ENABLED must remain true in production.');
        if (config.openRouter.structuredOutputMode !== 'native') throw new Error('OPENROUTER_STRUCTURED_OUTPUT_MODE must remain native in production.');
        const missing = [];
        if (config.internalToken.length < 32) missing.push('AI_SERVICE_TOKEN');
        if (config.openRouter.apiKey.length < 16) missing.push('OPENROUTER_API_KEY');
        if (!config.openRouter.primaryModel) missing.push('OPENROUTER_MODEL_PRIMARY');
        if (!config.openRouter.httpReferer) missing.push('OPENROUTER_SITE_URL');
        if (!config.openRouter.appTitle) missing.push('OPENROUTER_APP_NAME');
        if (missing.length) throw new Error(`AI service production configuration is incomplete: ${missing.join(', ')}.`);
        let referer;
        try { referer = new URL(config.openRouter.httpReferer); } catch { throw new Error('OPENROUTER_SITE_URL must be a valid URL.'); }
        if (referer.protocol !== 'https:') throw new Error('OPENROUTER_SITE_URL must use https:// in production.');
        if (referer.username || referer.password) throw new Error('OPENROUTER_SITE_URL must not contain credentials.');
    }
    return config;
}

function authorized(header, expectedToken) {
    if (!expectedToken || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const received = Buffer.from(header.slice(7));
    const expected = Buffer.from(expectedToken);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function readJsonBody(request, maxBytes) {
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw new AppError('Content-Type must be application/json.', { status: 415, code: 'AI_CONTENT_TYPE_INVALID', expose: true });
    }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('AI request body exceeded the configured limit.', { status: 413, code: 'AI_REQUEST_TOO_LARGE', expose: true });
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes) throw new AppError('AI request body exceeded the configured limit.', { status: 413, code: 'AI_REQUEST_TOO_LARGE', expose: true });
        chunks.push(chunk);
    }
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        return body;
    } catch (cause) {
        throw new AppError('AI request body must be valid JSON object.', { status: 400, code: 'AI_INPUT_INVALID', expose: true, cause });
    }
}

function safeRequestId(header) {
    return /^[A-Za-z0-9._:-]{1,100}$/.test(header || '') ? header : crypto.randomUUID();
}

function sendJson(response, status, payload, maxBytes) {
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > maxBytes) {
        status = 502;
        body = JSON.stringify({ ok: false, error: { code: 'AI_RESPONSE_TOO_LARGE', message: 'AI service response exceeded its configured limit.' } });
    }
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
}

function safeError(error) {
    const inputError = error?.code === 'AI_INPUT_INVALID' || error instanceof TypeError;
    const status = inputError ? 400 : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'AI_SERVICE_ERROR';
    const message = error?.expose === true || status < 500 ? String(error.message).slice(0, 300) : 'AI operation is temporarily unavailable.';
    const metadata = error?.aiMetadata && typeof error.aiMetadata === 'object' ? error.aiMetadata : undefined;
    return { status, payload: { ok: false, error: { code, message, ...(metadata ? { metadata } : {}) } } };
}

function validateRouteBody(pathname, body) {
    const expected = pathname === '/v1/remediations' ? ['finding'] : ['scores'];
    const keys = Object.keys(body).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new AppError('AI request contains missing or unsupported fields.', { status: 400, code: 'AI_INPUT_INVALID', expose: true });
    }
    return body;
}

function createFixedWindowLimiter({ limit, windowMs = 60_000, clock = Date.now }) {
    const buckets = new Map();
    return {
        take(key) {
            const now = clock();
            const current = buckets.get(key);
            if (!current || now >= current.resetAt) {
                buckets.set(key, { count: 1, resetAt: now + windowMs });
                return true;
            }
            if (current.count >= limit) return false;
            current.count += 1;
            return true;
        }
    };
}

function createAIHttpService({ provider, config, logger = null, clock = Date.now } = {}) {
    assertAIProvider(provider);
    if (!config?.internalToken) throw new Error('AI_SERVICE_TOKEN is required.');
    const limiter = createFixedWindowLimiter({ limit: config.rateLimitPerMinute, clock });
    let active = 0;
    const server = http.createServer(async (request, response) => {
        const startedAt = clock();
        const requestId = safeRequestId(request.headers['x-request-id']);
        let pathname;
        try { pathname = new URL(request.url || '/', 'http://ai-service.internal').pathname; } catch { return sendJson(response, 400, { ok: false, error: { code: 'AI_INPUT_INVALID', message: 'Invalid request target.' } }, config.maxResponseBytes); }
        if (request.method === 'GET' && pathname === '/healthz') {
            return sendJson(response, 200, { status: 'ok', provider: provider.name, configured: provider.configured }, config.maxResponseBytes);
        }
        if (request.method !== 'POST' || !['/v1/remediations', '/v1/executive-summaries'].includes(pathname)) {
            return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, config.maxResponseBytes);
        }
        if (!authorized(request.headers.authorization, config.internalToken)) {
            return sendJson(response, 401, { ok: false, error: { code: 'AI_SERVICE_UNAUTHORIZED', message: 'Unauthorized.' } }, config.maxResponseBytes);
        }
        const rateKey = request.socket.remoteAddress || 'internal';
        if (!limiter.take(rateKey)) {
            return sendJson(response, 429, { ok: false, error: { code: 'AI_SERVICE_RATE_LIMITED', message: 'AI service rate limit exceeded.' } }, config.maxResponseBytes);
        }
        if (active >= config.maxConcurrency) {
            return sendJson(response, 429, { ok: false, error: { code: 'AI_SERVICE_BUSY', message: 'AI service concurrency limit reached.' } }, config.maxResponseBytes);
        }
        active += 1;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.requestTimeoutMs);
        timeout.unref?.();
        request.once('aborted', () => controller.abort());
        try {
            const body = validateRouteBody(pathname, await readJsonBody(request, config.maxBodyBytes));
            const result = pathname === '/v1/remediations'
                ? await provider.generateRemediation(body.finding, { signal: controller.signal, requestId })
                : await provider.generateExecutiveSummary(body, { signal: controller.signal, requestId });
            sendJson(response, 200, { ok: true, result }, config.maxResponseBytes);
            logger?.info?.('Internal AI operation completed', { requestId, operation: result.operation, status: 200, durationMs: clock() - startedAt });
        } catch (error) {
            const safe = safeError(timedOut
                ? new AppError('Internal AI operation timed out.', { status: 504, code: 'AI_SERVICE_TIMEOUT' })
                : error);
            sendJson(response, safe.status, safe.payload, config.maxResponseBytes);
            logger?.[safe.status >= 500 ? 'warn' : 'info']?.('Internal AI operation failed', { requestId, code: safe.payload.error.code, status: safe.status, durationMs: clock() - startedAt });
        } finally {
            clearTimeout(timeout);
            active -= 1;
        }
    });
    server.requestTimeout = config.requestTimeoutMs;
    server.headersTimeout = Math.min(config.requestTimeoutMs, 15_000);
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;
    return {
        server,
        listen(port = config.port, host = config.host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve(server.address());
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    };
}

module.exports = {
    authorized,
    createAIHttpService,
    createFixedWindowLimiter,
    loadAIServiceConfig,
    readJsonBody,
    safeError,
    validateRouteBody
};
