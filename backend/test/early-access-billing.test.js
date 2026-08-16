const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createBillingProvider } = require('../billing');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');

const logger = { info() {}, warn() {}, error() {} };

function earlyAccessConfig() {
    return loadConfig({
        NODE_ENV: 'test',
        PAYMENTS_ENABLED: 'false',
        LEGACY_API_ENABLED: 'false',
        CORS_ORIGINS: 'https://dashboard.example',
        RATE_LIMIT_MAX: '1000',
        ADMIN_RATE_LIMIT_MAX: '1000',
        WORKER_ENABLED: 'false'
    });
}

function checkoutBody() {
    return {
        planId: 'studio',
        accepted: true,
        recurringAcknowledged: true,
        termsVersion: '1.0',
        refundPolicyVersion: '1.0'
    };
}

function platformServiceFor(store) {
    return {
        async start() {},
        async close() {},
        recordCheckoutAcceptance(input) { return store.recordCheckoutAcceptance(input); },
        markCheckoutAcceptance(identity, idempotencyKey, input) { return store.markCheckoutAcceptance(identity, idempotencyKey, input); }
    };
}

function createTestApp({ config, store, billingProvider }) {
    return createApp({
        config,
        logger,
        platformStore: store,
        platformService: platformServiceFor(store),
        billingProvider,
        aiService: { configured: false, async tryGenerateRemediation() { return { ok: false, error: { code: 'AI_SERVICE_NOT_CONFIGURED', status: 503 } }; } },
        emailTransport: { configured: false, provider: 'none', async send() { throw new Error('disabled'); } },
        sourceService: { async start() {}, async close() {}, async purgeExpiredArtifacts() {}, async purgeExpiredStaging() {} },
        integrationService: { async processWebhookOutbox() { return { processed: 0 }; }, async close() {} },
        engineLabService: { catalog() { return []; }, listRuns() { return []; }, getRun() { return null; }, close() {} },
        validateUrl: async (url) => ({ url: new URL(url).toString(), hostname: new URL(url).hostname, port: 443, address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }] }),
        analysisService: { async analyze() { return {}; } }
    });
}

function providerTrap() {
    const calls = [];
    const called = (method) => async () => { calls.push(method); return null; };
    return {
        provider: 'paddle',
        signatureHeaderName: 'paddle-signature',
        createCheckout: called('createCheckout'),
        createCustomerPortal: called('createCustomerPortal'),
        cancelSubscription: called('cancelSubscription'),
        getSubscription: called('getSubscription'),
        reconcileSubscription: called('reconcileSubscription'),
        handleWebhook: called('handleWebhook'),
        mapExternalProductToPlan() { calls.push('mapExternalProductToPlan'); return null; },
        calls
    };
}

test('disabled billing factory never initializes Paddle and exposes only local subscription reads', async () => {
    const config = earlyAccessConfig();
    const store = new MemoryPlatformStore();
    let paddlePropertyReads = 0;
    const paddleClient = new Proxy({}, { get() { paddlePropertyReads += 1; throw new Error('Paddle client must not be read'); } });
    const provider = createBillingProvider({ config, store, paddleClient });

    assert.equal(provider.provider, 'disabled');
    assert.equal(provider.paymentsEnabled, false);
    assert.equal(await provider.getSubscription({ userId: 'early-user', workspaceId: 'early-workspace' }), null);
    await assert.rejects(() => provider.createCheckout({}), { code: 'PAYMENTS_DISABLED', status: 409 });
    await assert.rejects(() => provider.handleWebhook(Buffer.from('{}'), ''), { code: 'PAYMENTS_DISABLED', status: 409 });
    assert.equal(paddlePropertyReads, 0);
});

test('disabled checkout, portal, cancel and webhook routes fail before persistence or provider invocation', async (t) => {
    const config = earlyAccessConfig();
    const store = new MemoryPlatformStore();
    const trap = providerTrap();
    const application = createTestApp({ config, store, billingProvider: trap });
    t.after(() => application.locals.closeResources());

    const checkout = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_early_access')
        .set('Idempotency-Key', 'early-access-checkout-0001')
        .send(checkoutBody())
        .expect(409);
    const malformedCheckout = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_early_access')
        .send({})
        .expect(409);
    const portal = await request(application)
        .post('/api/v1/billing/portal')
        .set('X-Workspace-Id', 'ws_early_access')
        .expect(409);
    const cancel = await request(application)
        .post('/api/v1/billing/cancel')
        .set('X-Workspace-Id', 'ws_early_access')
        .expect(409);
    const webhook = await request(application)
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(409);
    const subscription = await request(application)
        .get('/api/v1/billing/subscription')
        .set('X-Workspace-Id', 'ws_early_access')
        .expect(200);

    for (const response of [checkout, malformedCheckout, portal, cancel, webhook]) assert.equal(response.body.code, 'PAYMENTS_DISABLED');
    assert.equal(subscription.body.subscription, null);
    assert.deepEqual(trap.calls, []);
    assert.equal(store.checkoutAcceptances.size, 0);
});

test('disabled public legal configuration advertises redeem-only access and no Paddle processor', async (t) => {
    const config = earlyAccessConfig();
    const store = new MemoryPlatformStore();
    const application = createTestApp({ config, store, billingProvider: providerTrap() });
    t.after(() => application.locals.closeResources());

    const response = await request(application).get('/api/v1/legal/config').expect(200);
    assert.equal(response.body.billing.paymentsEnabled, false);
    assert.equal(response.body.billing.mode, 'redeem_only');
    assert.equal(response.body.billing.merchantOfRecord, null);
    assert.equal(response.body.billing.recurring, false);
    assert.equal(response.body.subprocessors.some((entry) => entry.provider === 'Paddle'), false);
});

test('Free users can receive Signal or Studio through expiring redeem grants without a subscription', async () => {
    const store = new MemoryPlatformStore();
    const now = new Date('2026-08-17T12:00:00.000Z');
    for (const planId of ['signal', 'studio']) {
        const userId = `early-${planId}-user`;
        const workspaceId = `early-${planId}-workspace`;
        const codeValue = `EARLY${planId.toUpperCase()}2026`;
        await store.registerUser({ id: userId, email: `${userId}@example.test` });
        await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
        await store.createRedeemCode({
            code: codeValue,
            temporaryPlanId: planId,
            durationDays: 1,
            maxGlobalRedemptions: 1,
            maxPerWorkspace: 1,
            createdBy: 'early-access-admin'
        });

        const redeemed = await store.redeemCode(workspaceId, userId, codeValue, { now });
        assert.equal(redeemed.effective.effectivePlanId, planId);
        assert.equal(await store.getSubscription({ userId, workspaceId }), null);
        const expired = await store.getEffectiveEntitlements(workspaceId, new Date('2026-08-19T12:00:00.000Z'));
        assert.equal(expired.effectivePlanId, 'free');
    }
});
