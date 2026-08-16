const crypto = require('node:crypto');
const http = require('node:http');
const { AppError } = require('../lib/errors');
const { engineLabRunSchema } = require('../validation/schemas');

const IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;
const ARTIFACT_FILENAME = /^[A-Za-z0-9_-]{1,140}\.(?:png|jpe?g|webp)$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function authorized(header, expectedToken) {
    if (!expectedToken || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const received = Buffer.from(header.slice(7));
    const expected = Buffer.from(expectedToken);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function safeRequestId(value) {
    return REQUEST_ID.test(value || '') ? value : crypto.randomUUID();
}

function hasControlCharacters(value) {
    return [...String(value || '')].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
    });
}

function safeIdentity(value, name) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.length > 200 || hasControlCharacters(normalized)) {
        throw new AppError(`${name} is invalid.`, { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    }
    return normalized;
}

function safeIdempotencyKey(value) {
    const normalized = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalized)) {
        throw new AppError('Engine Lab idempotency key is invalid.', { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', expose: true });
    }
    return normalized;
}

function safeRequestFingerprint(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new AppError('Engine Lab request fingerprint is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    }
    return normalized;
}

function decodeIdentifier(value) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch (cause) {
        throw new AppError('Engine Lab identifier is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true, cause });
    }
    if (!IDENTIFIER.test(decoded)) throw new AppError('Engine Lab identifier is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    return decoded;
}

function decodeArtifactFilename(value) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch (cause) {
        throw new AppError('Engine Lab artifact filename is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true, cause });
    }
    if (!ARTIFACT_FILENAME.test(decoded)) throw new AppError('Engine Lab artifact filename is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    return decoded;
}

async function readJsonBody(request, maxBytes) {
    const mediaType = String(request.headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim();
    if (mediaType !== 'application/json') {
        throw new AppError('Content-Type must be application/json.', { status: 415, code: 'ENGINE_LAB_CONTENT_TYPE_INVALID', expose: true });
    }
    const requestTooLarge = () => {
        request.resume?.();
        const error = new AppError('Engine Lab request body exceeded the configured limit.', { status: 413, code: 'ENGINE_LAB_SERVICE_REQUEST_TOO_LARGE', expose: true });
        error.closeConnection = true;
        return error;
    };
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw requestTooLarge();
    }
    const chunks = [];
    let total = 0;
    let raw = null;
    try {
        for await (const chunk of request) {
            total += chunk.length;
            if (total > maxBytes) {
                chunk.fill?.(0);
                throw requestTooLarge();
            }
            chunks.push(chunk);
        }
        raw = Buffer.concat(chunks, total);
        const body = JSON.parse(raw.toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        return body;
    } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError('Engine Lab request body must be a valid JSON object.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true, cause });
    } finally {
        raw?.fill(0);
        for (const chunk of chunks) chunk.fill?.(0);
    }
}

function strictKeys(body, allowed) {
    const allowlist = new Set(allowed);
    if (Object.keys(body).some((key) => !allowlist.has(key))) {
        throw new AppError('Engine Lab request contains unsupported fields.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    }
}

function decodeSource(value, maxSourceBytes) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new AppError('Engine Lab source package encoding is invalid.', { status: 400, code: 'ENGINE_LAB_SOURCE_INVALID', expose: true });
    }
    if (value.length > Math.ceil(maxSourceBytes / 3) * 4 + 4) {
        throw new AppError('Engine Lab source package exceeded the configured limit.', { status: 413, code: 'SOURCE_FILE_TOO_LARGE', expose: true });
    }
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length > maxSourceBytes || buffer.toString('base64') !== value) {
        buffer.fill(0);
        throw new AppError('Engine Lab source package exceeded the configured limit.', { status: 413, code: 'SOURCE_FILE_TOO_LARGE', expose: true });
    }
    return buffer;
}

function validateCreateBody(body, maxSourceBytes) {
    strictKeys(body, ['targetUrl', 'engineIds', 'journey', 'crawlerLimit', 'actorId', 'requestId', 'idempotencyKey', 'requestFingerprint', 'sourceBase64']);
    const parsed = engineLabRunSchema.safeParse({
        targetUrl: body.targetUrl,
        engineIds: body.engineIds,
        ...(body.journey === undefined ? {} : { journey: body.journey }),
        ...(body.crawlerLimit === undefined ? {} : { crawlerLimit: body.crawlerLimit })
    });
    if (!parsed.success) {
        throw new AppError('Engine Lab request validation failed.', { status: 400, code: 'VALIDATION_ERROR', expose: true, details: parsed.error.issues });
    }
    return {
        ...parsed.data,
        actorId: safeIdentity(body.actorId, 'Engine Lab actor'),
        requestId: safeRequestId(body.requestId),
        ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: safeIdempotencyKey(body.idempotencyKey) }),
        ...(body.requestFingerprint === undefined ? {} : { requestFingerprint: safeRequestFingerprint(body.requestFingerprint) }),
        sourceBuffer: decodeSource(body.sourceBase64, maxSourceBytes)
    };
}

function validateCancelBody(body) {
    strictKeys(body, ['actorId', 'reason', 'requestId']);
    const reason = String(body.reason || '').trim();
    if (reason.length < 5 || reason.length > 500 || hasControlCharacters(reason)) {
        throw new AppError('Engine Lab cancellation reason is invalid.', { status: 400, code: 'ENGINE_LAB_INPUT_INVALID', expose: true });
    }
    return {
        actorId: safeIdentity(body.actorId, 'Engine Lab actor'),
        reason,
        requestId: safeRequestId(body.requestId)
    };
}

function safeError(error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'ENGINE_LAB_SERVICE_ERROR';
    const message = error?.expose === true || status < 500 ? String(error.message).slice(0, 300) : 'Engine Lab operation is temporarily unavailable.';
    return { status, payload: { ok: false, error: { code, message } } };
}

function jsonBuffer(payload, maxBytes) {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length <= maxBytes) return { status: null, body };
    return {
        status: 502,
        body: Buffer.from(JSON.stringify({ ok: false, error: { code: 'ENGINE_LAB_SERVICE_RESPONSE_TOO_LARGE', message: 'Engine Lab service response exceeded its configured limit.' } }))
    };
}

function sendJson(response, status, payload, maxBytes) {
    const encoded = jsonBuffer(payload, maxBytes);
    const finalStatus = encoded.status || status;
    response.writeHead(finalStatus, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': encoded.body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(encoded.body);
}

function createEngineLabHttpService({ engineLabService, config, logger = null } = {}) {
    if (!engineLabService) throw new Error('Engine Lab service is required.');
    const serviceConfig = config?.engineLab || config || {};
    if (!serviceConfig.internalToken) throw new Error('ENGINE_LAB_SERVICE_TOKEN is required.');
    const maxBodyBytes = Math.min(Math.max(Number(serviceConfig.maxBodyBytes) || 70 * 1024 * 1024, 1_024), 300 * 1024 * 1024);
    const maxResponseBytes = Math.min(Math.max(Number(serviceConfig.maxResponseBytes) || 16 * 1024 * 1024, 1_024), 64 * 1024 * 1024);
    const maxArtifactBytes = Math.min(Math.max(Number(serviceConfig.maxArtifactBytes) || 9 * 1024 * 1024, 1_024), 32 * 1024 * 1024);
    const maxSourceBytes = Math.min(Math.max(Number(config?.sourceUploadMaxBytes) || 50 * 1024 * 1024, 1_024), 200 * 1024 * 1024);
    let activeRequests = 0;
    const maxConcurrentRequests = Math.min(Math.max(Number(serviceConfig.maxConcurrentRequests) || 16, 1), 64);

    const server = http.createServer(async (request, response) => {
        const requestId = safeRequestId(request.headers['x-request-id']);
        let pathname;
        try { pathname = new URL(request.url || '/', 'http://engine-lab.internal').pathname; } catch {
            return sendJson(response, 400, { ok: false, error: { code: 'ENGINE_LAB_INPUT_INVALID', message: 'Invalid request target.' } }, maxResponseBytes);
        }
        if (request.method === 'GET' && pathname === '/healthz') {
            return sendJson(response, 200, { status: 'ok', configured: true }, maxResponseBytes);
        }
        if (!authorized(request.headers.authorization, serviceConfig.internalToken)) {
            return sendJson(response, 401, { ok: false, error: { code: 'ENGINE_LAB_SERVICE_UNAUTHORIZED', message: 'Unauthorized.' } }, maxResponseBytes);
        }
        if (activeRequests >= maxConcurrentRequests) {
            return sendJson(response, 429, { ok: false, error: { code: 'ENGINE_LAB_SERVICE_BUSY', message: 'Engine Lab service is busy.' } }, maxResponseBytes);
        }
        activeRequests += 1;
        try {
            if (request.method === 'GET' && pathname === '/v1/catalog') {
                return sendJson(response, 200, { ok: true, engines: await engineLabService.catalog() }, maxResponseBytes);
            }
            if (request.method === 'GET' && pathname === '/v1/runs') {
                return sendJson(response, 200, { ok: true, runs: await engineLabService.listRuns() }, maxResponseBytes);
            }
            if (request.method === 'POST' && pathname === '/v1/runs') {
                const body = await readJsonBody(request, maxBodyBytes);
                const input = validateCreateBody(body, maxSourceBytes);
                try {
                    const run = await engineLabService.createRun(input);
                    return sendJson(response, 202, { ok: true, run }, maxResponseBytes);
                } finally {
                    input.sourceBuffer?.fill(0);
                }
            }

            const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(pathname);
            if (request.method === 'POST' && cancelMatch) {
                const id = decodeIdentifier(cancelMatch[1]);
                const context = validateCancelBody(await readJsonBody(request, Math.min(maxBodyBytes, 16 * 1024)));
                const run = await engineLabService.cancelRun(id, context.actorId, { reason: context.reason, requestId: context.requestId });
                return sendJson(response, 200, { ok: true, run }, maxResponseBytes);
            }

            const artifactMatch = /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/.exec(pathname);
            if (request.method === 'GET' && artifactMatch) {
                const artifact = await engineLabService.getArtifact(decodeIdentifier(artifactMatch[1]), decodeIdentifier(artifactMatch[2]), decodeArtifactFilename(artifactMatch[3]));
                if (!Buffer.isBuffer(artifact?.buffer) || artifact.buffer.length > maxArtifactBytes || !IMAGE_MIME_TYPES.has(artifact.mimeType)) {
                    throw new AppError('Engine Lab artifact is invalid.', { status: 502, code: 'ENGINE_LAB_SERVICE_INVALID_ARTIFACT' });
                }
                response.writeHead(200, {
                    'Content-Type': artifact.mimeType,
                    'Content-Length': artifact.buffer.length,
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff'
                });
                response.end(artifact.buffer);
                return;
            }

            const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(pathname);
            if (request.method === 'GET' && runMatch) {
                return sendJson(response, 200, { ok: true, run: await engineLabService.getRun(decodeIdentifier(runMatch[1])) }, maxResponseBytes);
            }
            return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, maxResponseBytes);
        } catch (error) {
            const safe = safeError(error);
            logger?.warn?.('Engine Lab internal request failed', { requestId, method: request.method, path: pathname, status: safe.status, errorCode: safe.payload.error.code });
            if (!response.headersSent && !response.destroyed) {
                if (error?.closeConnection) response.setHeader('Connection', 'close');
                sendJson(response, safe.status, safe.payload, maxResponseBytes);
            }
        } finally {
            activeRequests -= 1;
        }
    });

    server.requestTimeout = Math.min(Math.max(Number(serviceConfig.requestTimeoutMs) || 30_000, 1_000), 120_000);
    server.headersTimeout = Math.min(server.requestTimeout, 15_000);
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;

    return {
        server,
        listen(port = serviceConfig.port ?? 5030, host = serviceConfig.host || '0.0.0.0') {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve(server.address());
                });
            });
        },
        async close() {
            const listenerClose = server.listening
                ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
                : Promise.resolve();
            server.closeIdleConnections?.();
            await Promise.all([listenerClose, Promise.resolve(engineLabService.close?.())]);
        }
    };
}

module.exports = {
    authorized,
    createEngineLabHttpService,
    decodeSource,
    readJsonBody,
    safeError,
    validateCancelBody,
    validateCreateBody
};
