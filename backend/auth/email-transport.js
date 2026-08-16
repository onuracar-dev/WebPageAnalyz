const { AppError } = require('../lib/errors');
const { createEmailServiceClient } = require('../email/client');
const { callbackUrl, normalizeEmailRequest } = require('../email/templates');

function disabledCode(kind) {
    if (kind === 'verification') return 'VERIFICATION_EMAIL_NOT_ENABLED';
    if (kind === 'reset') return 'RESET_PASSWORD_DISABLED';
    return 'EMAIL_DELIVERY_DISABLED';
}

function unavailableTransport(provider = 'none') {
    return {
        configured: false,
        provider,
        async send({ kind } = {}) {
            throw new AppError('Transactional email delivery is not configured.', { status: 503, code: disabledCode(kind) });
        }
    };
}

// Kept only as a compatibility boundary for existing development/test adapters.
// Production Resend credentials belong exclusively to the isolated email service.
function createLegacyGenericTransport({ config, fetchImpl, logger }) {
    const providerUrl = String(config.email?.providerUrl || '');
    const apiKey = String(config.email?.apiKey || '');
    const configured = Boolean(providerUrl && apiKey && config.email?.from);
    return {
        configured,
        provider: 'generic',
        async send(input) {
            if (!configured) throw new AppError('Transactional email delivery is not configured.', { status: 503, code: disabledCode(input?.kind) });
            let endpoint;
            try { endpoint = new URL(providerUrl); } catch (cause) { throw new AppError('Transactional email provider configuration is invalid.', { status: 503, code: 'EMAIL_PROVIDER_INVALID', cause }); }
            if (endpoint.protocol !== 'https:' && !(config.nodeEnv !== 'production' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) throw new AppError('Transactional email provider must use HTTPS.', { status: 503, code: 'EMAIL_PROVIDER_INVALID' });
            const allowlist = config.email?.providerHostAllowlist || [];
            if (allowlist.length && !allowlist.includes(endpoint.hostname)) throw new AppError('Transactional email provider is not allowlisted.', { status: 503, code: 'EMAIL_PROVIDER_INVALID' });
            const normalized = normalizeEmailRequest(input);
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.email?.timeoutMs || 10_000);
            timer.unref?.();
            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST', redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({
                        from: String(config.email.from).slice(0, 320),
                        to: normalized.to,
                        template: normalized.kind === 'verification' ? 'verify-email' : normalized.kind === 'reset' ? 'reset-password' : normalized.kind,
                        callbackUrl: normalized.url ? callbackUrl(normalized.url) : null
                    })
                });
                if (!response.ok) throw new Error(`provider_status_${response.status}`);
                logger?.info?.('Legacy transactional email accepted', { kind: normalized.kind, provider: 'generic', providerHost: endpoint.hostname });
                return { accepted: true, provider: 'generic', messageId: null };
            } catch (cause) {
                if (timedOut) throw new AppError('Transactional email delivery timed out.', { status: 504, code: 'EMAIL_PROVIDER_TIMEOUT', cause });
                throw new AppError('Transactional email delivery failed.', { status: 503, code: 'EMAIL_PROVIDER_UNAVAILABLE', cause });
            } finally { clearTimeout(timer); }
        }
    };
}

function createEmailTransport({ config, fetchImpl = fetch, transport = null, logger = null } = {}) {
    const provider = String(config.email?.provider || 'none').toLowerCase();
    const deliveryEnabled = config.email?.deliveryEnabled !== false && provider !== 'none';
    if (transport?.send && deliveryEnabled) return transport;
    if (!deliveryEnabled) return unavailableTransport(provider);

    const baseUrl = config.email?.serviceUrl || config.emailService?.url || config.emailServiceUrl || '';
    const token = config.email?.internalToken || config.email?.serviceToken || config.emailService?.token || config.emailServiceToken || '';
    if (baseUrl && token) {
        return createEmailServiceClient({
            baseUrl,
            token,
            allowedHosts: config.email?.serviceHostAllowlist,
            timeoutMs: config.email?.timeoutMs,
            fetchImpl
        });
    }

    const legacyGeneric = provider === 'generic'
        || (provider === 'resend' && !config.email?.resendApiKey && config.email?.apiKey && config.email?.providerUrl && !/^https:\/\/api\.resend\.com\/emails\/?$/i.test(config.email.providerUrl));
    if (legacyGeneric) return createLegacyGenericTransport({ config, fetchImpl, logger });
    return unavailableTransport(provider);
}

module.exports = { createEmailTransport, createLegacyGenericTransport, unavailableTransport };
