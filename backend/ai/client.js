const { randomUUID } = require('node:crypto');
const { AppError, isAbortError } = require('../lib/errors');
const { AIProvider } = require('./provider');
const { readLimitedJson } = require('./openrouter-provider');

const DEFAULT_ALLOWED_HOSTS = Object.freeze(['ai-service', 'localhost', '127.0.0.1', '::1']);

function validateServiceBaseUrl(value, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (cause) {
        throw new AppError('AI service URL is invalid.', { status: 503, code: 'AI_SERVICE_NOT_CONFIGURED', expose: true, cause });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new AppError('AI service URL is invalid.', { status: 503, code: 'AI_SERVICE_NOT_CONFIGURED', expose: true });
    }
    const allowlist = new Set(allowedHosts.map((host) => String(host).toLowerCase()));
    if (!allowlist.has(parsed.hostname.toLowerCase())) {
        throw new AppError('AI service host is not allowlisted.', { status: 503, code: 'AI_SERVICE_NOT_CONFIGURED', expose: true });
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed;
}

function requestSignal(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('AI service timeout', 'TimeoutError'));
    }, timeoutMs);
    timer.unref?.();
    return { signal: controller.signal, timedOut: () => timedOut, cleanup: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); } };
}

class AIServiceClient extends AIProvider {
    constructor({
        baseUrl,
        internalToken,
        token,
        allowedHosts = DEFAULT_ALLOWED_HOSTS,
        timeoutMs = 50_000,
        maxRequestBytes = 24 * 1024,
        maxResponseBytes = 96 * 1024,
        fetchImpl = fetch
    } = {}) {
        let endpoint = null;
        try { endpoint = validateServiceBaseUrl(baseUrl, allowedHosts); } catch { endpoint = null; }
        const serviceToken = internalToken || token;
        super({ name: 'internal-ai-service', configured: Boolean(endpoint && serviceToken) });
        this.baseUrl = endpoint;
        this.internalToken = String(serviceToken || '');
        this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 50_000, 1_000), 120_000);
        this.maxRequestBytes = Math.min(Math.max(Number(maxRequestBytes) || 24 * 1024, 1_024), 256 * 1024);
        this.maxResponseBytes = Math.min(Math.max(Number(maxResponseBytes) || 96 * 1024, 1_024), 512 * 1024);
        this.fetchImpl = fetchImpl;
    }

    assertConfigured() {
        if (!this.configured) throw new AppError('Internal AI service is not configured.', { status: 503, code: 'AI_SERVICE_NOT_CONFIGURED', expose: true });
    }

    generateRemediation(finding, context = {}) {
        return this.request('/v1/remediations', { finding }, context);
    }

    generateExecutiveSummary(input, context = {}) {
        return this.request('/v1/executive-summaries', input?.scores ? input : { scores: input }, context);
    }

    async tryGenerateRemediation(finding, context = {}) {
        return this.tryRequest(() => this.generateRemediation(finding, context));
    }

    async tryGenerateExecutiveSummary(input, context = {}) {
        return this.tryRequest(() => this.generateExecutiveSummary(input, context));
    }

    async tryRequest(operation) {
        try {
            return Object.freeze({ ok: true, result: await operation() });
        } catch (error) {
            return Object.freeze({
                ok: false,
                error: Object.freeze({
                    code: String(error?.code || 'AI_SERVICE_UNAVAILABLE'),
                    status: Number.isInteger(error?.status) ? error.status : 503,
                    retryable: !['AI_INPUT_INVALID', 'AI_REQUEST_TOO_LARGE', 'AI_INPUT_TOKEN_LIMIT'].includes(error?.code),
                    metadata: error?.aiMetadata && typeof error.aiMetadata === 'object' ? error.aiMetadata : null
                })
            });
        }
    }

    async request(pathname, payload, context) {
        this.assertConfigured();
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > this.maxRequestBytes) throw new AppError('AI service request exceeded the configured limit.', { status: 413, code: 'AI_REQUEST_TOO_LARGE', expose: true });
        const deadline = requestSignal(context.signal, this.timeoutMs);
        try {
            const endpoint = new URL(pathname.replace(/^\//, ''), this.baseUrl.href.endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.href}/`));
            const response = await this.fetchImpl(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: deadline.signal,
                headers: {
                    Authorization: `Bearer ${this.internalToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-Request-Id': /^[A-Za-z0-9._:-]{1,100}$/.test(context.requestId || '') ? context.requestId : randomUUID()
                },
                body
            });
            const responseBody = await readLimitedJson(response, this.maxResponseBytes);
            if (!response.ok || responseBody?.ok !== true || !responseBody.result) {
                const error = new AppError('Internal AI service could not complete the request.', {
                    status: Number.isInteger(response.status) && response.status >= 400 ? response.status : 503,
                    code: typeof responseBody?.error?.code === 'string' ? responseBody.error.code : 'AI_SERVICE_UNAVAILABLE'
                });
                if (responseBody?.error?.metadata && typeof responseBody.error.metadata === 'object') error.aiMetadata = responseBody.error.metadata;
                throw error;
            }
            return responseBody.result;
        } catch (cause) {
            if (context.signal?.aborted) throw new AppError('AI request was cancelled.', { status: 408, code: 'AI_REQUEST_ABORTED', expose: true, cause });
            if (deadline.timedOut() || isAbortError(cause)) throw new AppError('Internal AI service timed out.', { status: 504, code: 'AI_SERVICE_TIMEOUT', cause });
            if (cause instanceof AppError) throw cause;
            throw new AppError('Internal AI service is unavailable.', { status: 503, code: 'AI_SERVICE_UNAVAILABLE', cause });
        } finally {
            deadline.cleanup();
        }
    }
}

function createAIServiceClient(options) {
    return new AIServiceClient(options);
}

module.exports = { AIServiceClient, DEFAULT_ALLOWED_HOSTS, createAIServiceClient, validateServiceBaseUrl };
