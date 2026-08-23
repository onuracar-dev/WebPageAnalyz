const { AppError, isAbortError } = require('../lib/errors');
const { bounded, callbackUrl, normalizeEmailRequest, recipientAddress, templateFor } = require('./templates');

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

function senderAddress(value) {
    const from = bounded(value, 320);
    if (!from || /[\r\n]/.test(from)) throw new AppError('Transactional email sender is invalid.', { status: 503, code: 'EMAIL_PROVIDER_INVALID' });
    const bracketed = from.match(/<([^<>]+)>$/);
    recipientAddress(bracketed ? bracketed[1] : from);
    return from;
}

function enforceCallbackOrigin(normalized, appUrl) {
    if (!normalized.url) return;
    let expected;
    try { expected = new URL(callbackUrl(appUrl)).origin; } catch (cause) { throw new AppError('Transactional email application URL is invalid.', { status: 503, code: 'EMAIL_PROVIDER_INVALID', cause }); }
    if (new URL(normalized.url).origin !== expected) throw new AppError('Transactional email callback origin is not allowed.', { status: 400, code: 'EMAIL_CALLBACK_INVALID', expose: true });
}

async function responsePayload(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('Resend response exceeded its configured limit.', { status: 502, code: 'EMAIL_PROVIDER_INVALID_RESPONSE' });
    let text = '';
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
                throw new AppError('Resend response exceeded its configured limit.', { status: 502, code: 'EMAIL_PROVIDER_INVALID_RESPONSE' });
            }
            chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
    } else if (typeof response.text === 'function') text = await response.text();
    else if (typeof response.json === 'function') text = JSON.stringify(await response.json());
    if (Buffer.byteLength(text) > maxBytes) throw new AppError('Resend response exceeded its configured limit.', { status: 502, code: 'EMAIL_PROVIDER_INVALID_RESPONSE' });
    if (!text) return {};
    try { return JSON.parse(text); } catch (cause) { throw new AppError('Resend returned an invalid response.', { status: 502, code: 'EMAIL_PROVIDER_INVALID_RESPONSE', cause }); }
}

function createResendProvider({ apiKey, from, appUrl, supportEmail = '', timeoutMs = 10_000, maxResponseBytes = 16 * 1024, fetchImpl = fetch, logger = null } = {}) {
    const configured = Boolean(apiKey && from);
    return {
        name: 'resend',
        configured,
        async send(input, context = {}) {
            if (!configured) throw new AppError('Resend email delivery is not configured.', { status: 503, code: 'EMAIL_NOT_CONFIGURED' });
            const normalized = normalizeEmailRequest(input);
            enforceCallbackOrigin(normalized, appUrl);
            const template = templateFor(normalized.kind, { url: normalized.url, data: normalized.data, appUrl, supportEmail });
            const requestBody = {
                from: senderAddress(from),
                to: [normalized.to],
                subject: template.subject,
                html: template.html,
                text: template.text,
                tags: [{ name: 'kind', value: normalized.kind }]
            };
            const controller = new AbortController();
            let timedOut = false;
            const abortFromCaller = () => controller.abort(context.signal?.reason);
            if (context.signal?.aborted) abortFromCaller();
            else context.signal?.addEventListener?.('abort', abortFromCaller, { once: true });
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            try {
                const headers = {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                };
                if (normalized.idempotencyKey) headers['Idempotency-Key'] = normalized.idempotencyKey;
                const response = await fetchImpl(RESEND_EMAILS_URL, {
                    method: 'POST', redirect: 'error', signal: controller.signal, headers, body: JSON.stringify(requestBody)
                });
                if (!response.ok) throw new AppError('Resend could not accept the transactional email.', { status: 503, code: 'EMAIL_PROVIDER_UNAVAILABLE' });
                const payload = await responsePayload(response, maxResponseBytes);
                const messageId = typeof payload.id === 'string' ? payload.id.slice(0, 200) : null;
                logger?.info?.('Transactional email accepted', { kind: normalized.kind, provider: 'resend', providerHost: 'api.resend.com', messageId });
                return Object.freeze({ accepted: true, provider: 'resend', messageId });
            } catch (cause) {
                if (context.signal?.aborted && !timedOut) throw new AppError('Email delivery was cancelled.', { status: 408, code: 'EMAIL_REQUEST_ABORTED', cause });
                if (timedOut || isAbortError(cause)) throw new AppError('Resend delivery timed out.', { status: 504, code: 'EMAIL_PROVIDER_TIMEOUT', cause });
                if (cause instanceof AppError) throw cause;
                throw new AppError('Resend could not accept the transactional email.', { status: 503, code: 'EMAIL_PROVIDER_UNAVAILABLE', cause });
            } finally { clearTimeout(timer); context.signal?.removeEventListener?.('abort', abortFromCaller); }
        }
    };
}

module.exports = { RESEND_EMAILS_URL, createResendProvider, enforceCallbackOrigin, responsePayload, senderAddress };
