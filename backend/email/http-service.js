const crypto = require('node:crypto');
const http = require('node:http');
const { AppError } = require('../lib/errors');
const { senderAddress } = require('./resend-provider');
const { recipientAddress } = require('./templates');

function integer(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function loadEmailServiceConfig(env = process.env) {
    const nodeEnv = String(env.NODE_ENV || 'development').toLowerCase();
    const config = Object.freeze({
        nodeEnv,
        provider: String(env.EMAIL_PROVIDER || 'resend').trim().toLowerCase(),
        host: env.EMAIL_SERVICE_HOST || '0.0.0.0',
        port: integer(env.EMAIL_SERVICE_PORT, 5020, 1, 65_535),
        internalToken: String(env.EMAIL_SERVICE_TOKEN || ''),
        maxBodyBytes: integer(env.EMAIL_SERVICE_MAX_BODY_BYTES, 16 * 1024, 1_024, 64 * 1024),
        maxResponseBytes: integer(env.EMAIL_SERVICE_MAX_RESPONSE_BYTES, 16 * 1024, 1_024, 64 * 1024),
        maxConcurrency: integer(env.EMAIL_SERVICE_MAX_CONCURRENCY, 4, 1, 32),
        rateLimitPerMinute: integer(env.EMAIL_SERVICE_RATE_LIMIT_PER_MINUTE, 120, 1, 10_000),
        requestTimeoutMs: integer(env.EMAIL_SERVICE_REQUEST_TIMEOUT_MS, 15_000, 1_000, 60_000),
        resend: Object.freeze({
            apiKey: String(env.RESEND_API_KEY || ''),
            from: String(env.EMAIL_FROM || ''),
            supportEmail: String(env.SUPPORT_EMAIL || ''),
            appUrl: String(env.APP_URL || ''),
            timeoutMs: integer(env.EMAIL_PROVIDER_TIMEOUT_MS, 10_000, 1_000, 30_000),
            maxResponseBytes: integer(env.EMAIL_PROVIDER_MAX_RESPONSE_BYTES, 16 * 1024, 1_024, 64 * 1024)
        })
    });
    if (nodeEnv === 'production') {
        if (config.provider !== 'resend') throw new Error('EMAIL_PROVIDER must be resend for the production email service.');
        const missing = [];
        if (config.internalToken.length < 32) missing.push('EMAIL_SERVICE_TOKEN');
        if (config.resend.apiKey.length < 16) missing.push('RESEND_API_KEY');
        if (!config.resend.from) missing.push('EMAIL_FROM');
        if (!config.resend.supportEmail) missing.push('SUPPORT_EMAIL');
        if (!config.resend.appUrl) missing.push('APP_URL');
        if (missing.length) throw new Error(`Email service production configuration is incomplete: ${missing.join(', ')}.`);
        const appUrl = new URL(config.resend.appUrl);
        if (appUrl.protocol !== 'https:') throw new Error('APP_URL must use https:// in production email service.');
        if (appUrl.username || appUrl.password) throw new Error('APP_URL must not contain credentials.');
        senderAddress(config.resend.from);
        recipientAddress(config.resend.supportEmail);
    }
    return config;
}

function authorized(header, token) {
    if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const received = Buffer.from(header.slice(7));
    const expected = Buffer.from(token);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function readBody(request, maxBytes) {
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError('Content-Type must be application/json.', { status: 415, code: 'EMAIL_CONTENT_TYPE_INVALID', expose: true });
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('Email request body exceeded its configured limit.', { status: 413, code: 'EMAIL_REQUEST_TOO_LARGE', expose: true });
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes) throw new AppError('Email request body exceeded its configured limit.', { status: 413, code: 'EMAIL_REQUEST_TOO_LARGE', expose: true });
        chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (cause) { throw new AppError('Email request must be valid JSON.', { status: 400, code: 'EMAIL_INPUT_INVALID', expose: true, cause }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Email request must be an object.', { status: 400, code: 'EMAIL_INPUT_INVALID', expose: true });
    const allowed = new Set(['kind', 'to', 'url', 'data', 'idempotencyKey']);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new AppError('Email request contains unsupported fields.', { status: 400, code: 'EMAIL_INPUT_INVALID', expose: true });
    return body;
}

function sendJson(response, status, payload, maxBytes) {
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > maxBytes) {
        status = 502;
        body = JSON.stringify({ ok: false, error: { code: 'EMAIL_RESPONSE_TOO_LARGE', message: 'Email service response exceeded its configured limit.' } });
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
}

function createLimiter(limit, clock) {
    const buckets = new Map();
    return (key) => {
        const now = clock();
        const bucket = buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            buckets.set(key, { count: 1, resetAt: now + 60_000 });
            return true;
        }
        if (bucket.count >= limit) return false;
        bucket.count += 1;
        return true;
    };
}

function safeError(error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return {
        status,
        payload: {
            ok: false,
            error: {
                code: typeof error?.code === 'string' ? error.code : 'EMAIL_SERVICE_ERROR',
                message: error?.expose === true || status < 500 ? String(error.message).slice(0, 300) : 'Email delivery is temporarily unavailable.'
            }
        }
    };
}

function createEmailHttpService({ provider, config, logger = null, clock = Date.now } = {}) {
    if (!provider || typeof provider.send !== 'function') throw new TypeError('Email provider must implement send.');
    if (!config?.internalToken) throw new Error('EMAIL_SERVICE_TOKEN is required.');
    const takeRate = createLimiter(config.rateLimitPerMinute, clock);
    let active = 0;
    const server = http.createServer(async (request, response) => {
        const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(request.headers['x-request-id'] || '') ? request.headers['x-request-id'] : crypto.randomUUID();
        const startedAt = clock();
        let pathname;
        try { pathname = new URL(request.url || '/', 'http://email-service.internal').pathname; } catch { return sendJson(response, 400, { ok: false, error: { code: 'EMAIL_INPUT_INVALID', message: 'Invalid request target.' } }, config.maxResponseBytes); }
        if (request.method === 'GET' && pathname === '/healthz') return sendJson(response, 200, { status: 'ok', provider: provider.name, configured: provider.configured }, config.maxResponseBytes);
        if (request.method !== 'POST' || pathname !== '/v1/messages') return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, config.maxResponseBytes);
        if (!authorized(request.headers.authorization, config.internalToken)) return sendJson(response, 401, { ok: false, error: { code: 'EMAIL_SERVICE_UNAUTHORIZED', message: 'Unauthorized.' } }, config.maxResponseBytes);
        if (!takeRate(request.socket.remoteAddress || 'internal')) return sendJson(response, 429, { ok: false, error: { code: 'EMAIL_SERVICE_RATE_LIMITED', message: 'Email service rate limit exceeded.' } }, config.maxResponseBytes);
        if (active >= config.maxConcurrency) return sendJson(response, 429, { ok: false, error: { code: 'EMAIL_SERVICE_BUSY', message: 'Email service concurrency limit reached.' } }, config.maxResponseBytes);
        active += 1;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.requestTimeoutMs);
        timeout.unref?.();
        request.once('aborted', () => controller.abort());
        try {
            const body = await readBody(request, config.maxBodyBytes);
            const result = await provider.send(body, { signal: controller.signal });
            sendJson(response, 200, { ok: true, result }, config.maxResponseBytes);
            logger?.info?.('Internal email operation completed', { requestId, kind: body.kind, status: 200, durationMs: clock() - startedAt });
        } catch (error) {
            const safe = safeError(timedOut
                ? new AppError('Internal email operation timed out.', { status: 504, code: 'EMAIL_SERVICE_TIMEOUT' })
                : error);
            sendJson(response, safe.status, safe.payload, config.maxResponseBytes);
            logger?.[safe.status >= 500 ? 'warn' : 'info']?.('Internal email operation failed', { requestId, code: safe.payload.error.code, status: safe.status, durationMs: clock() - startedAt });
        } finally { clearTimeout(timeout); active -= 1; }
    });
    server.requestTimeout = config.requestTimeoutMs;
    server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;
    return {
        server,
        listen(port = config.port, host = config.host) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
            });
        },
        close() { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    };
}

module.exports = { authorized, createEmailHttpService, loadEmailServiceConfig, readBody, safeError };
