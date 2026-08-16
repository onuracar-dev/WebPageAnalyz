const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createPaddleProvider } = require('../billing/paddle');
const { createStripeService } = require('../billing/stripe');

const paddleWebhookSecret = 'pdl_business_logic_provider_secret';
const paddleTimestamp = 2_000_000_000;

function paddleConfig(overrides = {}) {
    return {
        nodeEnv: 'test',
        appUrl: 'https://dashboard.example',
        paddle: {
            apiKey: 'pdl_sdbx_business_logic_key',
            webhookSecret: paddleWebhookSecret,
            webhookToleranceSeconds: 5,
            environment: 'sandbox',
            prices: { signal: 'pri_signal', studio: 'pri_studio', enterprise: 'pri_enterprise' },
            products: { signal: 'pro_signal', studio: 'pro_studio', enterprise: 'pro_enterprise' },
            freePlanId: 'free',
            ...overrides
        }
    };
}

function signedPaddleEvent(event, secret = paddleWebhookSecret) {
    const body = JSON.stringify(event);
    const digest = crypto.createHmac('sha256', secret).update(`${paddleTimestamp}:${body}`).digest('hex');
    return { body: Buffer.from(body), signature: `ts=${paddleTimestamp};h1=${digest}` };
}

function paddleSubscriptionEvent({ productId = 'pro_studio', priceId = 'pri_studio', customData = { workspaceId: 'ws_1' }, status = 'active' } = {}) {
    return {
        event_id: `evt_${productId}_${priceId}`,
        event_type: 'subscription.updated',
        occurred_at: '2033-05-18T03:33:20.000Z',
        data: {
            id: 'sub_business_logic',
            customer_id: 'ctm_business_logic',
            status,
            custom_data: customData,
            current_billing_period: { ends_at: '2033-06-18T03:33:20.000Z' },
            items: [{ price: { id: priceId, product_id: productId } }]
        }
    };
}

function stripeCheckoutClient(calls) {
    return {
        checkout: {
            sessions: {
                create: async (params, options) => {
                    calls.push({ params, options });
                    return { id: `cs_${calls.length}`, url: 'https://checkout.stripe.test/session' };
                }
            }
        },
        webhooks: { constructEvent() { throw new Error('not used'); } },
        billingPortal: { sessions: { create: async () => ({ url: 'https://portal.stripe.test' }) } }
    };
}

function stripeWebhookClient(event) {
    return {
        checkout: { sessions: { create: async () => ({ id: 'unused', url: 'https://checkout.stripe.test' }) } },
        webhooks: { constructEvent() { return event; } },
        billingPortal: { sessions: { create: async () => ({ url: 'https://portal.stripe.test' }) } }
    };
}

async function recordAcceptance(store, { id, workspaceId, userId = 'user_business_logic', planId = 'studio', provider = 'paddle', amountMinor = 9900, currency = 'USD', idempotencyKey = 'client-retry' } = {}) {
    return store.recordCheckoutAcceptance({
        id,
        workspaceId,
        userId,
        planId,
        provider,
        catalogVersion: 'catalog-business-logic',
        amountMinor,
        currency,
        billingInterval: 'month',
        termsVersion: 'terms-business-logic',
        refundPolicyVersion: 'refund-business-logic',
        requestId: `request-${id}`,
        idempotencyKey
    });
}

test('checkout providers reject active, grace, and paid subscriptions before provider calls', async () => {
    for (const subscription of [
        { status: 'active' },
        { status: 'past_due' },
        { status: 'incomplete', accessState: 'paid' },
        { status: 'canceled', accessState: 'grace' }
    ]) {
        const stripeCalls = [];
        const stripeStore = new MemoryPlatformStore();
        stripeStore.subscriptions.set(`stripe-${subscription.status}-${subscription.accessState || 'none'}`, {
            workspaceId: `stripe-${subscription.status}-${subscription.accessState || 'none'}`,
            provider: 'stripe',
            ...subscription
        });
        const stripeService = createStripeService({
            config: loadConfig({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_business_logic', STRIPE_PRICE_STUDIO: 'price_studio' }),
            store: stripeStore,
            stripeClient: stripeCheckoutClient(stripeCalls)
        });
        const stripeWorkspaceId = `stripe-${subscription.status}-${subscription.accessState || 'none'}`;
        await assert.rejects(
            () => stripeService.createCheckout(stripeWorkspaceId, 'studio', 'retry-key'),
            (error) => error.code === 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE'
        );
        assert.equal(stripeCalls.length, 0);

        const paddleCalls = [];
        const paddleStore = new MemoryPlatformStore();
        const paddleWorkspaceId = `paddle-${subscription.status}-${subscription.accessState || 'none'}`;
        paddleStore.subscriptions.set(paddleWorkspaceId, { workspaceId: paddleWorkspaceId, provider: 'paddle', ...subscription });
        const paddleService = createPaddleProvider({
            config: paddleConfig(),
            store: paddleStore,
            paddleClient: { transactions: { create: async (...args) => { paddleCalls.push(args); return { id: 'unused' }; } } }
        });
        await assert.rejects(
            () => paddleService.createCheckout(paddleWorkspaceId, 'studio', 'retry-key'),
            (error) => error.code === 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE'
        );
        assert.equal(paddleCalls.length, 0);
    }
});

test('Paddle idempotency keys are namespaced by provider, commercial user, acceptance, and client identity', async () => {
    const calls = [];
    const store = new MemoryPlatformStore();
    const first = await recordAcceptance(store, { id: 'ca_ws_one', workspaceId: 'ws_one', userId: 'user_one', idempotencyKey: 'same-client-key' });
    const second = await recordAcceptance(store, { id: 'ca_ws_two', workspaceId: 'ws_two', userId: 'user_two', idempotencyKey: 'same-client-key' });
    const provider = createPaddleProvider({
        config: paddleConfig(),
        store,
        paddleClient: {
            transactions: {
                create: async (input, options) => {
                    calls.push({ input, options });
                    return { id: `txn_${calls.length}`, checkout: { url: 'https://checkout.paddle.test' } };
                }
            }
        }
    });

    await provider.createCheckout({ userId: first.userId, workspaceId: first.workspaceId, planId: 'studio', acceptanceId: first.id, idempotencyKey: first.idempotencyKey });
    await provider.createCheckout({ userId: second.userId, workspaceId: second.workspaceId, planId: 'studio', acceptanceId: second.id, idempotencyKey: second.idempotencyKey });

    assert.equal(calls.length, 2);
    assert.match(calls[0].options.idempotencyKey, /^wpa-paddle-checkout-[a-f0-9]{48}$/);
    assert.match(calls[1].options.idempotencyKey, /^wpa-paddle-checkout-[a-f0-9]{48}$/);
    assert.notEqual(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
    assert.equal(calls[0].input.customData.acceptanceId, first.id);
    assert.equal(calls[1].input.customData.acceptanceId, second.id);
    assert.equal(calls[0].input.customData.userId, 'user_one');
    assert.equal(calls[1].input.customData.userId, 'user_two');
});

test('checkout retries use persisted acceptance identity and reject a mutable plan/key mismatch', async () => {
    const calls = [];
    const store = new MemoryPlatformStore();
    const acceptance = await recordAcceptance(store, {
        id: 'ca_stripe_identity', workspaceId: 'ws_identity', provider: 'stripe', planId: 'studio', idempotencyKey: 'persisted-key'
    });
    const service = createStripeService({
        config: loadConfig({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_business_logic', STRIPE_PRICE_STUDIO: 'price_studio' }),
        store,
        stripeClient: stripeCheckoutClient(calls)
    });

    await assert.rejects(
        () => service.createCheckout({ workspaceId: acceptance.workspaceId, planId: 'signal', acceptanceId: acceptance.id, idempotencyKey: acceptance.idempotencyKey }),
        { code: 'CHECKOUT_ACCEPTANCE_PLAN_MISMATCH' }
    );
    await assert.rejects(
        () => service.createCheckout({ workspaceId: acceptance.workspaceId, planId: acceptance.planId, acceptanceId: acceptance.id, idempotencyKey: 'mutable-key' }),
        { code: 'CHECKOUT_ACCEPTANCE_KEY_MISMATCH' }
    );
    assert.equal(calls.length, 0);

    const checkout = await service.createCheckout({
        workspaceId: acceptance.workspaceId,
        planId: acceptance.planId,
        acceptanceId: acceptance.id,
        idempotencyKey: acceptance.idempotencyKey
    });
    assert.equal(checkout.id, 'cs_1');
    assert.equal(calls[0].params.metadata.acceptanceId, acceptance.id);
    assert.equal(calls[0].params.metadata.planId, acceptance.planId);
    assert.match(calls[0].options.idempotencyKey, /^wpa-checkout-[a-f0-9]{40}$/);
});

test('Stripe production webhooks fail closed when live-mode or configured account identity is not authoritative', async () => {
    const baseConfig = {
        nodeEnv: 'production',
        appUrl: 'https://dashboard.example',
        stripe: {
            secretKey: 'sk_live_business_logic',
            webhookSecret: 'whsec_business_logic',
            accountId: 'acct_expected',
            prices: { studio: 'price_studio' }
        }
    };
    const object = {
        id: 'sub_environment',
        customer: 'cus_environment',
        status: 'active',
        metadata: { workspaceId: 'ws_environment' },
        items: { data: [{ price: { id: 'price_studio', product: 'prod_studio', unit_amount: 9900, currency: 'usd' } }] }
    };

    const missingMode = createStripeService({
        config: baseConfig,
        store: new MemoryPlatformStore(),
        stripeClient: stripeWebhookClient({ type: 'customer.subscription.updated', data: { object } })
    });
    await assert.rejects(() => missingMode.handleWebhook(Buffer.from('{}'), 'injected'), { code: 'BILLING_PROVIDER_ENVIRONMENT_UNVERIFIED' });

    const wrongMode = createStripeService({
        config: baseConfig,
        store: new MemoryPlatformStore(),
        stripeClient: stripeWebhookClient({ livemode: false, type: 'customer.subscription.updated', data: { object } })
    });
    await assert.rejects(() => wrongMode.handleWebhook(Buffer.from('{}'), 'injected'), { code: 'BILLING_PROVIDER_ENVIRONMENT_MISMATCH' });

    const missingAccount = createStripeService({
        config: baseConfig,
        store: new MemoryPlatformStore(),
        stripeClient: stripeWebhookClient({ livemode: true, type: 'customer.subscription.updated', data: { object } })
    });
    await assert.rejects(() => missingAccount.handleWebhook(Buffer.from('{}'), 'injected'), { code: 'BILLING_PROVIDER_ACCOUNT_UNVERIFIED' });

    const wrongAccount = createStripeService({
        config: baseConfig,
        store: new MemoryPlatformStore(),
        stripeClient: stripeWebhookClient({ livemode: true, account: 'acct_other', type: 'customer.subscription.updated', data: { object } })
    });
    await assert.rejects(() => wrongAccount.handleWebhook(Buffer.from('{}'), 'injected'), { code: 'BILLING_PROVIDER_ACCOUNT_MISMATCH' });
});

test('Stripe webhook rejects an authoritative catalog amount mismatch before store application', async () => {
    let applyCalls = 0;
    const store = new MemoryPlatformStore();
    store.applyBillingProviderEvent = async () => { applyCalls += 1; return { applied: true }; };
    const config = {
        nodeEnv: 'test',
        appUrl: 'https://dashboard.example',
        stripe: {
            secretKey: 'sk_test_business_logic',
            webhookSecret: 'whsec_business_logic',
            prices: { studio: 'price_studio' },
            products: { studio: 'prod_studio' },
            amountMinor: { studio: 9900 },
            currency: 'USD'
        }
    };
    const service = createStripeService({
        config,
        store,
        stripeClient: stripeWebhookClient({
            livemode: false,
            type: 'customer.subscription.updated',
            data: { object: {
                id: 'sub_catalog', customer: 'cus_catalog', status: 'active',
                metadata: { workspaceId: 'ws_catalog' },
                items: { data: [{ price: { id: 'price_studio', product: 'prod_studio', unit_amount: 1, currency: 'usd' } }] }
            } }
        })
    });

    await assert.rejects(() => service.handleWebhook(Buffer.from('{}'), 'injected'), { code: 'BILLING_CATALOG_AMOUNT_MISMATCH' });
    assert.equal(applyCalls, 0);
});

test('Paddle strict catalog validation rejects a product mismatch before store application', async () => {
    let applyCalls = 0;
    const store = new MemoryPlatformStore();
    store.applyBillingProviderEvent = async () => { applyCalls += 1; return { applied: true }; };
    const provider = createPaddleProvider({
        config: paddleConfig({ strictCatalogValidation: true }),
        store,
        paddleClient: {},
        now: () => paddleTimestamp * 1000
    });
    const signed = signedPaddleEvent(paddleSubscriptionEvent({ productId: 'pro_unknown', priceId: 'pri_studio' }));

    await assert.rejects(() => provider.handleWebhook(signed.body, signed.signature), { code: 'BILLING_CATALOG_PRODUCT_MISMATCH' });
    assert.equal(applyCalls, 0);
});

test('Paddle production webhooks fail closed when the configured environment is not production', async () => {
    const provider = createPaddleProvider({
        config: { ...paddleConfig({ environment: 'sandbox' }), nodeEnv: 'production' },
        store: new MemoryPlatformStore(),
        paddleClient: {},
        now: () => paddleTimestamp * 1000
    });
    const signed = signedPaddleEvent(paddleSubscriptionEvent());
    await assert.rejects(() => provider.handleWebhook(signed.body, signed.signature), { code: 'BILLING_PROVIDER_ENVIRONMENT_UNVERIFIED' });
});

test('Paddle production webhooks reject an authoritative account mismatch', async () => {
    const provider = createPaddleProvider({
        config: { ...paddleConfig({ environment: 'production', accountId: 'acct_expected' }), nodeEnv: 'production' },
        store: new MemoryPlatformStore(),
        paddleClient: {},
        now: () => paddleTimestamp * 1000
    });
    const event = paddleSubscriptionEvent();
    event.data.account_id = 'acct_other';
    const signed = signedPaddleEvent(event);
    await assert.rejects(() => provider.handleWebhook(signed.body, signed.signature), { code: 'BILLING_PROVIDER_ACCOUNT_MISMATCH' });
});
