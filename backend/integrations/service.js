const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { AppError } = require('../lib/errors');
const { encrypt, decrypt, encryptionKey } = require('../source/service');
const { workspacePlan } = require('../platform/store');

const PROVIDERS = Object.freeze({
    github: {
        label: 'GitHub', authorizationUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', identityUrl: 'https://api.github.com/user', scope: ''
    },
    gitlab: {
        label: 'GitLab', authorizationUrl: 'https://gitlab.com/oauth/authorize', tokenUrl: 'https://gitlab.com/oauth/token', identityUrl: 'https://gitlab.com/api/v4/user', scope: 'read_user read_api read_repository'
    },
    bitbucket: {
        label: 'Bitbucket', authorizationUrl: 'https://bitbucket.org/site/oauth2/authorize', tokenUrl: 'https://bitbucket.org/site/oauth2/access_token', identityUrl: 'https://api.bitbucket.org/2.0/user', scope: ''
    }
});

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function providerFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new AppError('The provider rejected the connection request.', { status: 502, code: 'INTEGRATION_PROVIDER_REJECTED' });
        return body;
    } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError('The provider connection could not be completed.', { status: 502, code: 'INTEGRATION_PROVIDER_UNAVAILABLE', cause });
    } finally { clearTimeout(timeout); }
}

function createIntegrationService({ config, store, validateUrl, logger }) {
    const key = () => encryptionKey(config);
    const redirectUri = (provider) => `${config.auth.baseUrl}/api/v1/integrations/${provider}/callback`;

    async function sendWebhookEvent(event) {
        await requireEntitlement(event.workspaceId, 'webhook');
        const record = await store.getIntegration(event.workspaceId, 'webhook');
        if (!record?.encryptedCredentials || !record.configuration?.url) throw new AppError('Webhook configuration is unavailable.', { status: 503, code: 'WEBHOOK_NOT_CONFIGURED' });
        const target = await validateUrl(record.configuration.url);
        const credentials = JSON.parse(decrypt(record.encryptedCredentials, key()).toString('utf8'));
        const payload = Buffer.from(JSON.stringify(event.payload));
        const signature = crypto.createHmac('sha256', credentials.secret).update(payload).digest('hex');
        await new Promise((resolve, reject) => {
            const url = new URL(target.url);
            const transport = url.protocol === 'https:' ? https : http;
            const request = transport.request({ hostname: target.address, family: target.family, port: target.port, path: `${url.pathname}${url.search}`, method: 'POST', ...(url.protocol === 'https:' ? { servername: target.hostname, rejectUnauthorized: true } : {}), headers: { Host: url.host, 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-WPA-Signature': `sha256=${signature}`, 'X-WPA-Event': event.eventType, 'X-WPA-Idempotency-Key': event.idempotencyKey } }, (response) => {
                response.resume(); response.once('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(Object.assign(new Error(`Webhook returned ${response.statusCode}`), { code: 'WEBHOOK_PROVIDER_REJECTED' })));
            });
            request.setTimeout(10_000, () => request.destroy(Object.assign(new Error('Webhook timeout'), { code: 'WEBHOOK_TIMEOUT' })));
            request.once('error', reject); request.end(payload);
        });
    }

    async function requireEntitlement(workspaceId, provider) {
        const plan = await workspacePlan(store, workspaceId);
        const moduleId = provider === 'webhook' ? 'api_webhooks' : 'source_audit';
        if (!plan.entitlements[moduleId] || plan.entitlements[moduleId].executionMode === 'disabled') {
            throw new AppError(`${PROVIDERS[provider]?.label || 'Webhook'} integration is not available on this plan.`, { status: 403, code: 'MODULE_NOT_ENTITLED' });
        }
        return plan;
    }

    return {
        async list(workspaceId) {
            const plan = await workspacePlan(store, workspaceId);
            const connected = await store.listIntegrations(workspaceId);
            return ['github', 'gitlab', 'bitbucket', 'webhook'].map((provider) => {
                const record = connected.find((item) => item.provider === provider);
                const providerConfig = config.integrations[provider];
                const available = provider === 'webhook'
                    ? Boolean(plan.entitlements.api_webhooks)
                    : Boolean(plan.entitlements.source_audit);
                const serverConfigured = provider === 'webhook' || Boolean(providerConfig?.clientId && providerConfig?.clientSecret);
                return {
                    provider,
                    label: provider === 'webhook' ? 'Webhooks' : PROVIDERS[provider].label,
                    available,
                    serverConfigured,
                    status: record?.status || 'not_connected',
                    displayName: record?.displayName || null,
                    connectedAt: record?.createdAt || null,
                    lastVerifiedAt: record?.lastVerifiedAt || null
                };
            });
        },

        async beginOAuth(workspaceId, provider, userId) {
            if (!PROVIDERS[provider]) throw new AppError('Unknown integration provider.', { status: 404, code: 'INTEGRATION_PROVIDER_NOT_FOUND' });
            await requireEntitlement(workspaceId, provider);
            const providerConfig = config.integrations[provider];
            if (!providerConfig?.clientId || !providerConfig?.clientSecret) throw new AppError(`${PROVIDERS[provider].label} OAuth is not configured on this server.`, { status: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
            const state = crypto.randomBytes(32).toString('base64url');
            await store.createOAuthState({ stateHash: hash(state), workspaceId, provider, userId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
            const url = new URL(PROVIDERS[provider].authorizationUrl);
            url.searchParams.set('client_id', providerConfig.clientId);
            url.searchParams.set('redirect_uri', redirectUri(provider));
            url.searchParams.set('response_type', 'code');
            url.searchParams.set('state', state);
            if (PROVIDERS[provider].scope) url.searchParams.set('scope', PROVIDERS[provider].scope);
            return { url: url.toString() };
        },

        async finishOAuth(workspaceId, provider, userId, { code, state }) {
            if (!PROVIDERS[provider] || !code || !state) throw new AppError('The OAuth callback is incomplete.', { status: 400, code: 'OAUTH_CALLBACK_INVALID' });
            await requireEntitlement(workspaceId, provider);
            const consumed = await store.consumeOAuthState(hash(state), workspaceId, provider, userId);
            if (!consumed) throw new AppError('The OAuth state is invalid, expired or already used.', { status: 400, code: 'OAUTH_STATE_INVALID' });
            const providerConfig = config.integrations[provider];
            const body = new URLSearchParams({ client_id: providerConfig.clientId, client_secret: providerConfig.clientSecret, code, redirect_uri: redirectUri(provider), grant_type: 'authorization_code' });
            const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
            if (provider === 'bitbucket') headers.Authorization = `Basic ${Buffer.from(`${providerConfig.clientId}:${providerConfig.clientSecret}`).toString('base64')}`;
            const token = await providerFetch(PROVIDERS[provider].tokenUrl, { method: 'POST', headers, body });
            if (!token.access_token) throw new AppError('The provider did not return an access token.', { status: 502, code: 'OAUTH_TOKEN_MISSING' });
            const identity = await providerFetch(PROVIDERS[provider].identityUrl, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'WebPage-Analyzer' } });
            await requireEntitlement(workspaceId, provider);
            const displayName = String(identity.login || identity.username || identity.display_name || identity.name || PROVIDERS[provider].label).slice(0, 200);
            const ciphertext = encrypt(Buffer.from(JSON.stringify({ accessToken: token.access_token, refreshToken: token.refresh_token || null, expiresIn: token.expires_in || null })), key());
            await store.upsertIntegration(workspaceId, provider, { status: 'connected', displayName, encryptedCredentials: ciphertext, configuration: { providerUserId: String(identity.id || identity.uuid || '') }, connectedBy: userId, lastVerifiedAt: new Date().toISOString() });
            return { provider, displayName };
        },

        async configureWebhook(workspaceId, input, userId) {
            await requireEntitlement(workspaceId, 'webhook');
            const parsed = new URL(input.url);
            if (config.nodeEnv === 'production' && parsed.protocol !== 'https:') throw new AppError('Production webhooks require HTTPS.', { status: 400, code: 'WEBHOOK_HTTPS_REQUIRED' });
            const validated = await validateUrl(input.url);
            const secret = input.secret || crypto.randomBytes(32).toString('base64url');
            const ciphertext = encrypt(Buffer.from(JSON.stringify({ secret })), key());
            await store.upsertIntegration(workspaceId, 'webhook', { status: 'configured', displayName: new URL(validated.url).host, encryptedCredentials: ciphertext, configuration: { url: validated.url }, connectedBy: userId, lastVerifiedAt: null });
            return { provider: 'webhook', displayName: new URL(validated.url).host, generatedSecret: input.secret ? null : secret };
        },

        async disconnect(workspaceId, provider) {
            if (!['github', 'gitlab', 'bitbucket', 'webhook'].includes(provider)) throw new AppError('Unknown integration provider.', { status: 404, code: 'INTEGRATION_PROVIDER_NOT_FOUND' });
            await store.deleteIntegration(workspaceId, provider);
            return { disconnected: true };
        },

        async deliverReport(workspaceId, report) {
            const record = await store.getIntegration(workspaceId, 'webhook');
            if (!record?.encryptedCredentials || !record.configuration?.url || typeof store.enqueueWebhookOutbox !== 'function') return { queued: false, reason: 'not_configured' };
            try { await requireEntitlement(workspaceId, 'webhook'); }
            catch (error) {
                if (error?.code === 'MODULE_NOT_ENTITLED') return { queued: false, reason: 'not_entitled' };
                throw error;
            }
            const idempotencyKey = `report.created:${report.id}:${report.version}`;
            const event = await store.enqueueWebhookOutbox(workspaceId, {
                eventType: 'report.created', idempotencyKey,
                payload: { id: crypto.randomUUID(), type: 'report.created', createdAt: new Date().toISOString(), data: { reportId: report.id, scanId: report.scanId, version: report.version, status: report.status } }
            });
            // Delivery is intentionally worker-owned. A queued event is not
            // reported as delivered, and transient provider failures remain
            // replayable/dead-lettered in the outbox.
            logger.info?.('Webhook event queued', { workspaceId, reportId: report.id, outboxId: event.id });
            return { queued: true, delivered: false, outboxId: event.id };
        },
        async processWebhookOutbox(owner, { limit = 25 } = {}) {
            if (typeof store.claimWebhookOutbox !== 'function') return { processed: 0, delivered: 0, failed: 0 };
            const events = await store.claimWebhookOutbox(owner, { limit });
            let delivered = 0; let failed = 0; let suppressed = 0;
            for (const event of events) {
                try {
                    await sendWebhookEvent(event);
                    if (await store.completeWebhookOutbox(event.id, owner, event.leaseToken)) delivered += 1;
                } catch (error) {
                    if (error?.code === 'MODULE_NOT_ENTITLED') {
                        if (await store.completeWebhookOutbox(event.id, owner, event.leaseToken)) suppressed += 1;
                        logger.warn('Webhook delivery suppressed after entitlement loss', { workspaceId: event.workspaceId, outboxId: event.id });
                        continue;
                    }
                    failed += 1;
                    await store.failWebhookOutbox(event.id, owner, event.leaseToken, error);
                    logger.warn('Webhook delivery deferred', { workspaceId: event.workspaceId, outboxId: event.id, errorCode: error.code || 'WEBHOOK_DELIVERY_FAILED' });
                }
            }
            return { processed: events.length, delivered, failed, suppressed };
        }
    };
}

module.exports = { createIntegrationService, PROVIDERS };
