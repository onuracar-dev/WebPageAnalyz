const { randomUUID } = require('node:crypto');
const { AppError, isAbortError } = require('../lib/errors');
const { normalizeEmailRequest } = require('./templates');

const DEFAULT_EMAIL_SERVICE_HOSTS = Object.freeze(['email-service', 'localhost', '127.0.0.1', '::1']);

function serviceUrl(value, allowedHosts = DEFAULT_EMAIL_SERVICE_HOSTS) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (cause) { throw new AppError('Email service URL is invalid.', { status: 503, code: 'EMAIL_SERVICE_NOT_CONFIGURED', cause }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new AppError('Email service URL is invalid.', { status: 503, code: 'EMAIL_SERVICE_NOT_CONFIGURED' });
    if (!new Set(allowedHosts.map((host) => String(host).toLowerCase())).has(parsed.hostname.toLowerCase())) throw new AppError('Email service host is not allowlisted.', { status: 503, code: 'EMAIL_SERVICE_NOT_CONFIGURED' });
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed;
}

async function limitedResponse(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('Email service response exceeded its limit.', { status: 502, code: 'EMAIL_SERVICE_INVALID_RESPONSE' });
    let text;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new AppError('Email service response exceeded its limit.', { status: 502, code: 'EMAIL_SERVICE_INVALID_RESPONSE' });
            }
            chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
    } else {
        text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    }
    if (Buffer.byteLength(text) > maxBytes) throw new AppError('Email service response exceeded its limit.', { status: 502, code: 'EMAIL_SERVICE_INVALID_RESPONSE' });
    try { return JSON.parse(text); } catch (cause) { throw new AppError('Email service response was invalid.', { status: 502, code: 'EMAIL_SERVICE_INVALID_RESPONSE', cause }); }
}

function createEmailServiceClient({ baseUrl, token, allowedHosts = DEFAULT_EMAIL_SERVICE_HOSTS, timeoutMs = 12_000, maxBodyBytes = 16 * 1024, maxResponseBytes = 16 * 1024, fetchImpl = fetch } = {}) {
    let endpoint = null;
    try { endpoint = serviceUrl(baseUrl, allowedHosts); } catch { endpoint = null; }
    const configured = Boolean(endpoint && token);
    return {
        configured,
        provider: 'internal-email-service',
        async send(input) {
            if (!configured) throw new AppError('Internal email service is not configured.', { status: 503, code: 'EMAIL_SERVICE_NOT_CONFIGURED' });
            const normalized = normalizeEmailRequest(input);
            const body = JSON.stringify(normalized);
            if (Buffer.byteLength(body) > maxBodyBytes) throw new AppError('Email request exceeded its configured limit.', { status: 413, code: 'EMAIL_REQUEST_TOO_LARGE', expose: true });
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            timer.unref?.();
            try {
                const target = new URL('v1/messages', endpoint.href.endsWith('/') ? endpoint : new URL(`${endpoint.href}/`));
                const response = await fetchImpl(target, {
                    method: 'POST', redirect: 'error', signal: controller.signal,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-Request-Id': randomUUID()
                    },
                    body
                });
                const payload = await limitedResponse(response, maxResponseBytes);
                if (!response.ok || payload?.ok !== true || payload?.result?.accepted !== true) {
                    throw new AppError('Internal email service could not deliver the message.', {
                        status: Number.isInteger(response.status) && response.status >= 400 ? response.status : 503,
                        code: typeof payload?.error?.code === 'string' ? payload.error.code : 'EMAIL_SERVICE_UNAVAILABLE'
                    });
                }
                return payload.result;
            } catch (cause) {
                if (timedOut || isAbortError(cause)) throw new AppError('Internal email service timed out.', { status: 504, code: 'EMAIL_SERVICE_TIMEOUT', cause });
                if (cause instanceof AppError) throw cause;
                throw new AppError('Internal email service is unavailable.', { status: 503, code: 'EMAIL_SERVICE_UNAVAILABLE', cause });
            } finally { clearTimeout(timer); }
        }
    };
}

module.exports = { DEFAULT_EMAIL_SERVICE_HOSTS, createEmailServiceClient, serviceUrl };
