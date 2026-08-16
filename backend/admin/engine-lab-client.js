const { randomUUID } = require('node:crypto');
const { AppError, isAbortError } = require('../lib/errors');

const DEFAULT_ALLOWED_HOSTS = Object.freeze(['engine-lab-worker', 'analysis-worker', 'localhost', '127.0.0.1', '::1']);
const SAFE_OPERATIONAL_CODES = new Set([
    'ENGINE_LAB_SERVICE_NOT_CONFIGURED',
    'ENGINE_LAB_SERVICE_UNAVAILABLE',
    'ENGINE_LAB_SERVICE_TIMEOUT'
]);

function validateServiceBaseUrl(value, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (cause) {
        throw new AppError('Engine Lab service URL is invalid.', { status: 503, code: 'ENGINE_LAB_SERVICE_NOT_CONFIGURED', expose: true, cause });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new AppError('Engine Lab service URL is invalid.', { status: 503, code: 'ENGINE_LAB_SERVICE_NOT_CONFIGURED', expose: true });
    }
    const allowlist = new Set(allowedHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean));
    if (!allowlist.has(parsed.hostname.toLowerCase())) {
        throw new AppError('Engine Lab service host is not allowlisted.', { status: 503, code: 'ENGINE_LAB_SERVICE_NOT_CONFIGURED', expose: true });
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed;
}

function requestDeadline(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('Engine Lab service timeout', 'TimeoutError'));
    }, timeoutMs);
    timer.unref?.();
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', abort);
        }
    };
}

async function readLimitedBuffer(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new AppError('Engine Lab service response exceeded the configured limit.', { status: 502, code: 'ENGINE_LAB_SERVICE_RESPONSE_TOO_LARGE' });
    }
    const reader = response.body?.getReader?.();
    if (!reader) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new AppError('Engine Lab service response exceeded the configured limit.', { status: 502, code: 'ENGINE_LAB_SERVICE_RESPONSE_TOO_LARGE' });
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

function parseJson(buffer) {
    try {
        const value = JSON.parse(buffer.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        return value;
    } catch (cause) {
        throw new AppError('Engine Lab service returned an invalid response.', { status: 502, code: 'ENGINE_LAB_SERVICE_INVALID_RESPONSE', cause });
    }
}

class EngineLabServiceClient {
    constructor({
        baseUrl,
        internalToken,
        token,
        allowedHosts = DEFAULT_ALLOWED_HOSTS,
        timeoutMs = 30_000,
        maxRequestBytes = 70 * 1024 * 1024,
        maxResponseBytes = 16 * 1024 * 1024,
        maxArtifactBytes = 9 * 1024 * 1024,
        fetchImpl = fetch
    } = {}) {
        let endpoint = null;
        try { endpoint = validateServiceBaseUrl(baseUrl, allowedHosts); } catch { endpoint = null; }
        const serviceToken = internalToken || token;
        this.baseUrl = endpoint;
        this.internalToken = String(serviceToken || '');
        this.configured = Boolean(endpoint && this.internalToken);
        this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 30_000, 1_000), 120_000);
        this.maxRequestBytes = Math.min(Math.max(Number(maxRequestBytes) || 70 * 1024 * 1024, 1_024), 300 * 1024 * 1024);
        this.maxResponseBytes = Math.min(Math.max(Number(maxResponseBytes) || 16 * 1024 * 1024, 1_024), 64 * 1024 * 1024);
        this.maxArtifactBytes = Math.min(Math.max(Number(maxArtifactBytes) || 9 * 1024 * 1024, 1_024), 32 * 1024 * 1024);
        this.fetchImpl = fetchImpl;
    }

    assertConfigured() {
        if (!this.configured) {
            throw new AppError('Engine Lab worker service is not configured.', { status: 503, code: 'ENGINE_LAB_SERVICE_NOT_CONFIGURED', expose: true });
        }
    }

    catalog(context = {}) { return this.requestJson('/v1/catalog', { context }).then((body) => body.engines || []); }
    listRuns(context = {}) { return this.requestJson('/v1/runs', { context }).then((body) => body.runs || []); }
    getRun(id, context = {}) { return this.requestJson(`/v1/runs/${encodeURIComponent(id)}`, { context }).then((body) => body.run); }

    async createRun(input = {}) {
        const sourceBuffer = Buffer.isBuffer(input.sourceBuffer) ? input.sourceBuffer : null;
        const payload = {
            targetUrl: input.targetUrl,
            engineIds: input.engineIds,
            ...(input.journey ? { journey: input.journey } : {}),
            ...(input.crawlerLimit != null ? { crawlerLimit: input.crawlerLimit } : {}),
            actorId: input.actorId,
            requestId: input.requestId,
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}),
            ...(sourceBuffer ? { sourceBase64: sourceBuffer.toString('base64') } : {})
        };
        return this.requestJson('/v1/runs', { method: 'POST', payload, context: input }).then((body) => body.run);
    }

    cancelRun(id, actorId, context = {}) {
        return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
            method: 'POST',
            payload: { actorId, reason: context.reason, requestId: context.requestId },
            context
        }).then((body) => body.run);
    }

    async getArtifact(id, engineId, filename, context = {}) {
        return this.withResponse(`/v1/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(engineId)}/${encodeURIComponent(filename)}`, { context }, async (response) => {
            const buffer = await readLimitedBuffer(response, this.maxArtifactBytes);
            if (!response.ok) throw this.responseError(response, parseJson(buffer));
            const mimeType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
            if (!/^image\/(?:png|jpeg|webp)$/.test(mimeType)) {
                throw new AppError('Engine Lab service returned an invalid artifact.', { status: 502, code: 'ENGINE_LAB_SERVICE_INVALID_ARTIFACT' });
            }
            return { buffer, mimeType };
        });
    }

    async requestJson(pathname, { method = 'GET', payload, context = {} } = {}) {
        let body;
        if (payload !== undefined) {
            body = JSON.stringify(payload);
            if (Buffer.byteLength(body) > this.maxRequestBytes) {
                throw new AppError('Engine Lab service request exceeded the configured limit.', { status: 413, code: 'ENGINE_LAB_SERVICE_REQUEST_TOO_LARGE', expose: true });
            }
        }
        return this.withResponse(pathname, { method, body, context }, async (response) => {
            const buffer = await readLimitedBuffer(response, this.maxResponseBytes);
            const parsed = parseJson(buffer);
            if (!response.ok || parsed.ok !== true) throw this.responseError(response, parsed);
            return parsed;
        });
    }

    async withResponse(pathname, { method = 'GET', body, context = {} } = {}, consume) {
        this.assertConfigured();
        const deadline = requestDeadline(context.signal, this.timeoutMs);
        try {
            const root = this.baseUrl.href.endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.href}/`);
            const endpoint = new URL(pathname.replace(/^\//, ''), root);
            const response = await this.fetchImpl(endpoint, {
                method,
                redirect: 'error',
                signal: deadline.signal,
                headers: {
                    Authorization: `Bearer ${this.internalToken}`,
                    Accept: 'application/json, image/png, image/jpeg, image/webp',
                    'X-Request-Id': /^[A-Za-z0-9._:-]{1,100}$/.test(context.requestId || '') ? context.requestId : randomUUID(),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
                },
                ...(body === undefined ? {} : { body })
            });
            return await consume(response);
        } catch (cause) {
            if (context.signal?.aborted) throw new AppError('Engine Lab request was cancelled.', { status: 408, code: 'ENGINE_LAB_REQUEST_ABORTED', expose: true, cause });
            if (deadline.timedOut() || isAbortError(cause)) {
                throw new AppError('Engine Lab worker service timed out.', { status: 504, code: 'ENGINE_LAB_SERVICE_TIMEOUT', expose: true, cause });
            }
            if (cause instanceof AppError) throw cause;
            throw new AppError('Engine Lab worker service is unavailable.', { status: 503, code: 'ENGINE_LAB_SERVICE_UNAVAILABLE', expose: true, cause });
        } finally {
            deadline.cleanup();
        }
    }

    responseError(response, body) {
        const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 503;
        const code = typeof body?.error?.code === 'string' ? body.error.code : 'ENGINE_LAB_SERVICE_UNAVAILABLE';
        const message = typeof body?.error?.message === 'string' ? body.error.message : 'Engine Lab worker service could not complete the request.';
        return new AppError(message, { status, code, expose: status < 500 || SAFE_OPERATIONAL_CODES.has(code) });
    }

    close() {}
}

function createEngineLabServiceClient(options) {
    return new EngineLabServiceClient(options);
}

module.exports = {
    DEFAULT_ALLOWED_HOSTS,
    EngineLabServiceClient,
    createEngineLabServiceClient,
    readLimitedBuffer,
    validateServiceBaseUrl
};
