const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { sessionBinding } = require('../auth/security');
const { createPaddleProvider } = require('../billing/paddle');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');

const paddleWebhookSecret = 'pdl_ntfset_launch_minimum_secret';
const paddleTimestamp = 2_000_000_000;
const paddleNow = () => paddleTimestamp * 1000;
const occurredAt = '2033-05-18T03:33:20.000Z';
const logger = { info() {}, warn() {}, error() {} };

function paddleConfig() {
    return {
        appUrl: 'https://dashboard.example',
        paddle: {
            apiKey: 'pdl_sdbx_launch_minimum_key',
            webhookSecret: paddleWebhookSecret,
            webhookToleranceSeconds: 5,
            prices: { signal: 'pri_signal', studio: 'pri_studio', enterprise: 'pri_enterprise' },
            products: { signal: 'pro_signal', studio: 'pro_studio', enterprise: 'pro_enterprise' },
            freePlanId: 'free'
        }
    };
}

function subscriptionEvent({ eventId, userId, workspaceId, priceId, productId }) {
    return {
        event_id: eventId,
        event_type: 'subscription.updated',
        occurred_at: occurredAt,
        data: {
            id: `sub_${eventId}`,
            customer_id: `ctm_${eventId}`,
            status: 'active',
            custom_data: { userId, workspaceId },
            current_billing_period: { ends_at: '2033-06-18T03:33:20.000Z' },
            items: [{ price: { id: priceId, product_id: productId } }]
        }
    };
}

function signPaddleEvent(event) {
    const body = JSON.stringify(event);
    const digest = crypto.createHmac('sha256', paddleWebhookSecret).update(`${paddleTimestamp}:${body}`).digest('hex');
    return { body: Buffer.from(body), signature: `ts=${paddleTimestamp};h1=${digest}` };
}

function collectKeys(value, keys = new Set()) {
    if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry, keys);
    } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            keys.add(key.toLowerCase());
            collectKeys(entry, keys);
        }
    }
    return keys;
}

test('active Paddle pri_signal subscription applies the Signal workspace entitlement', async () => {
    const workspaceId = 'ws_paddle_signal';
    const userId = 'user_paddle_signal';
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: userId, email: 'paddle-signal@example.test' });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
    const provider = createPaddleProvider({ config: paddleConfig(), store, paddleClient: {}, now: paddleNow });
    const signed = signPaddleEvent(subscriptionEvent({
        eventId: 'evt_signal_active', userId, workspaceId, priceId: 'pri_signal', productId: 'pro_signal'
    }));

    const result = await provider.handleWebhook(signed.body, signed.signature);
    const workspace = await store.getWorkspace(workspaceId);
    const subscription = await store.getBillingSubscription({ userId }, 'paddle');
    const effective = await store.getEffectiveEntitlements(workspaceId);

    assert.equal(result.applied, true);
    assert.equal(result.event.entitlement.planId, 'signal');
    assert.equal(result.event.entitlement.access, 'paid');
    assert.equal(workspace.planId, 'free');
    assert.equal(subscription.billingPlanId, 'signal');
    assert.equal(subscription.accessState, 'paid');
    assert.equal(effective.id, 'signal');
});

test('unknown active Paddle product and price are rejected before store application', async () => {
    const workspaceId = 'ws_paddle_unmapped';
    const store = new MemoryPlatformStore();
    const originalApply = store.applyBillingProviderEvent.bind(store);
    let applyCalls = 0;
    store.applyBillingProviderEvent = async (event) => {
        applyCalls += 1;
        return originalApply(event);
    };
    const provider = createPaddleProvider({ config: paddleConfig(), store, paddleClient: {}, now: paddleNow });
    const signed = signPaddleEvent(subscriptionEvent({
        eventId: 'evt_unmapped_active', workspaceId, priceId: 'pri_unknown', productId: 'pro_unknown'
    }));

    await assert.rejects(
        () => provider.handleWebhook(signed.body, signed.signature),
        (error) => {
            assert.equal(error.code, 'BILLING_PRODUCT_UNMAPPED');
            assert.equal(error.status, 409);
            return true;
        }
    );
    assert.equal(applyCalls, 0);
    assert.equal(store.billingEvents.size, 0);
    assert.equal(store.workspaces.has(workspaceId), false);
});

test('expired redeem code fails closed without creating a redemption or entitlement grant', async () => {
    const store = new MemoryPlatformStore();
    await store.createRedeemCode({
        code: 'EXPIRED2026',
        expiresAt: '2026-08-14T23:59:59.000Z',
        maxGlobalRedemptions: 1,
        maxPerWorkspace: 1,
        temporaryPlanId: 'studio',
        createdBy: 'admin-launch',
        reason: 'Deterministic expiry fixture',
        requestId: 'req-redeem-create'
    });

    await assert.rejects(
        () => store.redeemCode('ws_expired_redeem', 'user-expired', 'EXPIRED2026', {
            now: new Date('2026-08-15T00:00:00.000Z'),
            requestId: 'req-redeem-expired'
        }),
        { code: 'REDEEM_CODE_EXPIRED', status: 409 }
    );
    assert.equal(store.redeemRedemptions.size, 0);
    assert.equal(store.entitlementGrants.size, 0);
});

test('negative page and AI adjustments reduce effective limits and preserve revocation audit context', async () => {
    const workspaceId = 'ws_negative_credits';
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace(workspaceId);
    const before = await store.getEffectiveEntitlements(workspaceId);

    const page = await store.adjustCredits(workspaceId, 'page', -2, {
        actorId: 'admin-credit', reason: 'Reverse duplicate page credit', requestId: 'req-page-revoke'
    });
    const ai = await store.adjustCredits(workspaceId, 'ai', -3, {
        actorId: 'admin-credit', reason: 'Reverse duplicate AI credit', requestId: 'req-ai-revoke'
    });
    const after = await store.getEffectiveEntitlements(workspaceId);

    assert.equal(after.limits.pageCredits, before.limits.pageCredits - 2);
    assert.equal(after.limits.aiRemediations, before.limits.aiRemediations - 3);
    for (const [adjustment, reason, requestId] of [
        [page, 'Reverse duplicate page credit', 'req-page-revoke'],
        [ai, 'Reverse duplicate AI credit', 'req-ai-revoke']
    ]) {
        const audit = store.auditLog.find((entry) => entry.entityId === adjustment.id);
        assert.equal(audit.action, 'credits.revoked');
        assert.equal(audit.reason, reason);
        assert.equal(audit.requestId, requestId);
        assert.equal(audit.metadata.amount, adjustment.amount);
        assert.equal(audit.metadata.creditType, adjustment.creditType);
    }
});

test('authenticated admin HTTP DTOs omit provider credentials and database or auth secrets', async (t) => {
    const secrets = {
        database: 'db-password-launch-sentinel',
        auth: 'better-auth-launch-secret-sentinel-1234567890',
        paddleApi: 'pdl_sdbx_provider-secret-sentinel',
        paddleWebhook: 'pdl_ntfset_webhook-secret-sentinel',
        openRouter: 'sk-or-openrouter-secret-sentinel',
        resend: 're_resend-secret-sentinel',
        source: 'source-encryption-secret-sentinel',
        integration: 'encrypted-integration-secret-sentinel',
        rawProvider: 'raw-provider-payload-secret-sentinel'
    };
    const config = loadConfig({
        NODE_ENV: 'test',
        APP_URL: 'https://dashboard.example',
        BETTER_AUTH_URL: 'https://dashboard.example',
        BETTER_AUTH_SECRET: secrets.auth,
        DATABASE_URL: `postgresql://runtime:${secrets.database}@db.example/wpa`,
        BILLING_PROVIDER: 'paddle',
        PADDLE_API_KEY: secrets.paddleApi,
        PADDLE_WEBHOOK_SECRET: secrets.paddleWebhook,
        PADDLE_PRICE_SIGNAL: 'pri_signal',
        PADDLE_PRICE_STUDIO: 'pri_studio',
        OPENROUTER_API_KEY: secrets.openRouter,
        RESEND_API_KEY: secrets.resend,
        SOURCE_ENCRYPTION_KEY: secrets.source,
        BROWSER_EXECUTION_DISABLED: 'true',
        SOURCE_EXECUTION_DISABLED: 'true',
        PDF_EXECUTION_DISABLED: 'true',
        WORKER_ENABLED: 'false',
        RATE_LIMIT_MAX: '1000',
        ADMIN_RATE_LIMIT_MAX: '1000'
    });
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws_admin_dto';
    const commercialUserId = 'user_admin_dto';
    await store.registerUser({ id: commercialUserId, email: 'commercial-admin-dto@example.test' });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: commercialUserId });
    await store.upsertIntegration(workspaceId, 'webhook', {
        status: 'configured',
        displayName: 'hooks.example.com',
        encryptedCredentials: Buffer.from(secrets.integration),
        configuration: { url: 'https://hooks.example.com/wpa' },
        connectedBy: 'admin-dto'
    });
    await store.applyBillingProviderEvent({
        provider: 'paddle',
        eventId: 'evt_admin_dto',
        eventType: 'subscription.updated',
        occurredAt,
        occurredAtMs: Date.parse(occurredAt),
        externalObjectId: 'sub_admin_dto',
        userId: commercialUserId,
        workspaceId,
        resourceKind: 'subscription',
        rawEvent: { privateProviderField: secrets.rawProvider },
        subscription: {
            providerCustomerId: 'ctm_admin_dto',
            providerSubscriptionId: 'sub_admin_dto',
            providerPriceId: 'pri_signal',
            providerProductId: 'pro_signal',
            status: 'active',
            currentPeriodEnd: '2033-06-18T03:33:20.000Z',
            scheduledChange: null
        },
        entitlement: { action: 'set_plan', planId: 'signal', access: 'paid', reason: 'subscription_active' }
    });

    const session = {
        user: { id: 'admin-dto', email: 'admin-dto@example.com', emailVerified: true, twoFactorEnabled: true },
        session: { id: 'admin-dto-session' }
    };
    await store.upsertAdminAccount({ userId: session.user.id, email: session.user.email, role: 'admin', active: true });
    await store.recordAdminReauthentication({
        sessionId: sessionBinding(session),
        userId: session.user.id,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + config.adminReauthMaxAgeMs)
    });
    const app = createApp({
        config,
        platformStore: store,
        logger,
        authService: { async session() { return session; }, async close() {} },
        billingProvider: {
            provider: 'paddle',
            signatureHeaderName: 'paddle-signature',
            async createCheckout() {}, async createCustomerPortal() {}, async cancelSubscription() {},
            async getSubscription() { return null; }, async reconcileSubscription() {}, async handleWebhook() {}
        },
        emailTransport: { configured: false, provider: 'none', async send() {} },
        aiService: { configured: false },
        analysisService: { async analyze() { return {}; } }
    });
    t.after(() => app.locals.closeResources());

    const overview = await request(app).get('/api/v1/admin/overview').expect(200);
    const workspace = await request(app).get(`/api/v1/admin/workspaces/${workspaceId}`).expect(200);
    assert.equal(overview.body.health.find((entry) => entry.id === 'integrations').value, 'Paddle configured');
    assert.equal(workspace.body.workspace.workspace.id, workspaceId);
    assert.equal(workspace.body.workspace.subscription.provider, 'paddle');

    const responsePayload = [overview.body, workspace.body];
    const serialized = JSON.stringify(responsePayload);
    for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false);
    const keys = collectKeys(responsePayload);
    for (const forbidden of [
        'apikey', 'webhooksecret', 'databaseurl', 'authsecret', 'betterauthsecret',
        'password', 'accesstoken', 'refreshtoken', 'encryptedcredentials',
        'sourceencryptionkey', 'clientsecret', 'internaltoken'
    ]) assert.equal(keys.has(forbidden), false, `admin DTO exposed forbidden key: ${forbidden}`);
});
