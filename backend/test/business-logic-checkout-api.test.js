const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createPaddleProvider } = require('../billing/paddle');

const logger = { info() {}, warn() {}, error() {} };
const paddleWebhookSecret = 'pdl_checkout_api_webhook_secret';
const paddleTimestamp = 2_000_000_000;

function testConfig(overrides = {}) {
    return loadConfig({
        NODE_ENV: 'test',
        LEGACY_API_ENABLED: 'false',
        CORS_ORIGINS: 'https://dashboard.example',
        RATE_LIMIT_MAX: '1000',
        ADMIN_RATE_LIMIT_MAX: '1000',
        WORKER_ENABLED: 'false',
        ...overrides
    });
}

function checkoutBody(planId = 'signal') {
    return {
        planId,
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
        markCheckoutAcceptance(workspaceId, idempotencyKey, input) { return store.markCheckoutAcceptance(workspaceId, idempotencyKey, input); }
    };
}

function providerFixture(store, { createCheckout = null, handleWebhook = null } = {}) {
    let callCount = 0;
    const provider = {
        provider: 'paddle',
        signatureHeaderName: 'paddle-signature',
        async createCheckout(input) {
            callCount += 1;
            if (createCheckout) return createCheckout(input, callCount);
            await store.markCheckoutAcceptance({ userId: input.userId, workspaceId: input.workspaceId }, input.idempotencyKey, {
                status: 'checkout_created',
                providerCheckoutId: `txn_fixture_${callCount}`
            });
            return { provider: 'paddle', id: `txn_fixture_${callCount}`, url: 'https://checkout.paddle.test/fixture', status: 'ready' };
        },
        async createCustomerPortal() { return { provider: 'paddle', url: 'https://portal.paddle.test' }; },
        async cancelSubscription() { return { provider: 'paddle', status: 'active' }; },
        async getSubscription({ userId, workspaceId } = {}) { return store.getSubscription({ userId, workspaceId }); },
        async reconcileSubscription() { return { reconciled: false, applied: false }; },
        async handleWebhook(rawBody, signature) {
            if (handleWebhook) return handleWebhook(rawBody, signature);
            return { received: true, applied: false };
        }
    };
    Object.defineProperty(provider, 'callCount', { get: () => callCount });
    return provider;
}

function createTestApp({ store, billingProvider, config = testConfig() }) {
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

function signPaddleEvent(event) {
    const body = JSON.stringify(event);
    const digest = crypto.createHmac('sha256', paddleWebhookSecret).update(`${paddleTimestamp}:${body}`).digest('hex');
    return { body: Buffer.from(body), signature: `ts=${paddleTimestamp};h1=${digest}` };
}

async function recordCompletedAcceptance(store, workspaceId, idempotencyKey = 'checkout-completed-0001') {
    const acceptance = await store.recordCheckoutAcceptance({
        id: `ca_${workspaceId}`,
        workspaceId,
        userId: 'development-user',
        planId: 'studio',
        provider: 'paddle',
        catalogVersion: 'catalog-test',
        amountMinor: 9900,
        currency: 'USD',
        billingInterval: 'month',
        termsVersion: '1.0',
        refundPolicyVersion: '1.0',
        requestId: `request-${workspaceId}`,
        idempotencyKey,
        requestFingerprint: 'fingerprint-studio'
    });
    await store.markCheckoutAcceptance(workspaceId, idempotencyKey, {
        status: 'completed',
        providerCheckoutId: 'txn_completed'
    });
    return acceptance;
}

test('checkout rejects a missing Idempotency-Key before creating an acceptance or invoking the provider', async (t) => {
    const store = new MemoryPlatformStore();
    const provider = providerFixture(store);
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());

    const response = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_missing_key')
        .send(checkoutBody())
        .expect(400);

    assert.equal(response.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(provider.callCount, 0);
    assert.equal(store.checkoutAcceptances.size, 0);
});

test('same Idempotency-Key with a different plan returns 409 and never invokes the provider twice', async (t) => {
    const store = new MemoryPlatformStore();
    const provider = providerFixture(store);
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());

    await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_plan_reuse')
        .set('Idempotency-Key', 'checkout-plan-reuse-0001')
        .send(checkoutBody('signal'))
        .expect(201);

    const replay = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_plan_reuse')
        .set('Idempotency-Key', 'checkout-plan-reuse-0001')
        .send(checkoutBody('studio'))
        .expect(409);

    assert.equal(replay.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(provider.callCount, 1);
    assert.equal(store.checkoutAcceptances.size, 1);
});

test('concurrent same-key checkout allows one provider invocation and returns one in-progress response', async (t) => {
    const store = new MemoryPlatformStore();
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    const provider = providerFixture(store, {
        createCheckout: async (input, callNumber) => {
            if (callNumber === 1) {
                enteredResolve();
                await release;
            }
            await store.markCheckoutAcceptance(input.workspaceId, input.idempotencyKey, {
                status: 'checkout_created',
                providerCheckoutId: `txn_concurrent_${callNumber}`
            });
            return { provider: 'paddle', id: `txn_concurrent_${callNumber}`, url: 'https://checkout.paddle.test/concurrent', status: 'ready' };
        }
    });
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());

    const firstPromise = request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_same_key_race')
        .set('Idempotency-Key', 'checkout-same-key-race-0001')
        .send(checkoutBody('signal'))
        .then((response) => response);
    await entered;

    const inProgress = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_same_key_race')
        .set('Idempotency-Key', 'checkout-same-key-race-0001')
        .send(checkoutBody('signal'));
    releaseResolve();
    const first = await firstPromise;
    assert.equal(inProgress.status, 409);
    assert.equal(inProgress.body.code, 'CHECKOUT_IN_PROGRESS');
    assert.equal(first.status, 201);
    assert.equal(provider.callCount, 1);
});

test('ambiguous checkout setup failure releases its fence and retries with the same persisted operation', async (t) => {
    const store = new MemoryPlatformStore();
    const provider = providerFixture(store, {
        createCheckout: async (_input, callNumber) => {
            if (callNumber === 1) throw Object.assign(new Error('provider response lost'), { status: 503, code: 'BILLING_PROVIDER_TIMEOUT' });
            return { provider: 'paddle', id: 'txn_recovered', url: 'https://checkout.paddle.test/recovered', status: 'ready' };
        }
    });
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());
    const operationKey = 'checkout-ambiguous-retry-0001';

    await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_checkout_ambiguous')
        .set('Idempotency-Key', operationKey)
        .send(checkoutBody('signal'))
        .expect(503);
    const recovered = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_checkout_ambiguous')
        .set('Idempotency-Key', operationKey)
        .send(checkoutBody('signal'))
        .expect(201);

    assert.equal(recovered.body.checkout.id, 'txn_recovered');
    assert.equal(provider.callCount, 2);
    assert.equal(store.checkoutAcceptances.size, 1);
    const acceptance = await store.getCheckoutAcceptance('ws_checkout_ambiguous', operationKey);
    assert.equal(acceptance.status, 'checkout_created');
    assert.equal(acceptance.providerCheckoutId, 'txn_recovered');
    assert.equal(acceptance.setupLeaseToken, null);
});

test('concurrent different-key checkout cannot create two open intents for one workspace', async (t) => {
    const store = new MemoryPlatformStore();
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    const provider = providerFixture(store, {
        createCheckout: async (input, callNumber) => {
            if (callNumber === 1) {
                enteredResolve();
                await release;
            }
            await store.markCheckoutAcceptance(input.workspaceId, input.idempotencyKey, {
                status: 'checkout_created',
                providerCheckoutId: `txn_open_intent_${callNumber}`
            });
            return { provider: 'paddle', id: `txn_open_intent_${callNumber}`, url: 'https://checkout.paddle.test/open-intent', status: 'ready' };
        }
    });
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());

    const firstPromise = request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_open_intent')
        .set('Idempotency-Key', 'checkout-open-intent-a-0001')
        .send(checkoutBody('signal'))
        .then((response) => response);
    await entered;

    const second = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', 'ws_open_intent')
        .set('Idempotency-Key', 'checkout-open-intent-b-0001')
        .send(checkoutBody('studio'));
    releaseResolve();
    const first = await firstPromise;
    assert.equal(second.status, 409);
    assert.match(String(second.body.code), /^CHECKOUT_/);
    assert.equal(first.status, 201);
    assert.equal(provider.callCount, 1);
    const openIntents = [...store.checkoutAcceptances.values()].filter((acceptance) => ['accepted', 'checkout_created'].includes(acceptance.status));
    assert.equal(openIntents.length, 1);
});

test('an active user subscription blocks checkout from another sponsored workspace before the provider is called', async (t) => {
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws_active_subscription_api_b';
    await store.registerUser({ id: 'development-user', email: 'development-user@example.test' });
    await store.ensureWorkspace('ws_active_subscription_api_a', { entitlementOwnerUserId: 'development-user' });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: 'development-user' });
    store.subscriptions.set('development-user', { userId: 'development-user', workspaceId: 'ws_active_subscription_api_a', provider: 'paddle', status: 'active', accessState: 'paid', providerSubscriptionId: 'sub_active' });
    const provider = providerFixture(store);
    const application = createTestApp({ store, billingProvider: provider });
    t.after(() => application.locals.closeResources());

    const response = await request(application)
        .post('/api/v1/billing/checkout')
        .set('X-Workspace-Id', workspaceId)
        .set('Idempotency-Key', 'checkout-active-sub-0001')
        .send(checkoutBody('studio'))
        .expect(409);

    assert.equal(response.body.code, 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE');
    assert.equal(provider.callCount, 0);
    assert.equal(store.checkoutAcceptances.size, 0);
});

test('duplicate paid webhook replays after acceptance completion without regressing state or granting twice', async (t) => {
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws_paid_webhook_replay';
    await store.registerUser({ id: 'development-user', email: 'development-user@example.test' });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: 'development-user' });
    const acceptance = await recordCompletedAcceptance(store, workspaceId);
    const config = testConfig({
        PADDLE_API_KEY: 'pdl_sdbx_checkout_api_key',
        PADDLE_WEBHOOK_SECRET: paddleWebhookSecret,
        PADDLE_ENVIRONMENT: 'sandbox',
        PADDLE_PRICE_SIGNAL: 'pri_signal',
        PADDLE_PRICE_STUDIO: 'pri_studio'
    });
    const provider = createPaddleProvider({
        config,
        store,
        paddleClient: {},
        now: () => paddleTimestamp * 1000
    });
    const application = createTestApp({ store, billingProvider: provider, config });
    t.after(() => application.locals.closeResources());
    const event = {
        event_id: 'evt_paid_webhook_replay',
        event_type: 'subscription.updated',
        occurred_at: '2033-05-18T03:33:20.000Z',
        data: {
            id: 'sub_paid_webhook_replay',
            customer_id: 'ctm_paid_webhook_replay',
            status: 'active',
            custom_data: { userId: 'development-user', workspaceId, acceptanceId: acceptance.id },
            current_billing_period: { ends_at: '2033-06-18T03:33:20.000Z' },
            items: [{ price: { id: 'pri_studio', product_id: 'pro_studio' } }]
        }
    };
    const signed = signPaddleEvent(event);
    const sendWebhook = () => request(application)
        .post('/api/v1/billing/webhook')
        .set('paddle-signature', signed.signature)
        .send(signed.body.toString('utf8'))
        .set('Content-Type', 'application/json');

    const first = await sendWebhook();
    const grantsAfterFirst = store.entitlementGrants.size;
    const reconciliationsAfterFirst = store.auditLog.filter((entry) => entry.action === 'subscription.reconciled').length;
    const second = await sendWebhook();

    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(first.body.applied, true);
    assert.equal(second.body.applied, false);
    assert.equal(second.body.duplicate, true);
    assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('development-user')).effectivePlanId, 'studio');
    assert.equal((await store.getBillingSubscription({ userId: 'development-user' }, 'paddle')).accessState, 'paid');
    assert.equal([...store.checkoutAcceptances.values()].find((item) => item.id === acceptance.id).status, 'completed');
    assert.equal(store.entitlementGrants.size, grantsAfterFirst);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'subscription.reconciled').length, reconciliationsAfterFirst);
});
