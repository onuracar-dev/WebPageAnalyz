const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createStripeService } = require('../billing/stripe');

const webhookSecret = 'whsec_platform_test_secret';

function signedEvent(event) {
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret, timestamp: event.created });
    return { payload: Buffer.from(payload), signature };
}

test('Stripe webhook is signed, idempotent and ignores older subscription state', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_paid', email: 'paid@example.test' });
    await store.ensureWorkspace('ws_paid', { entitlementOwnerUserId: 'user_paid' });
    const config = loadConfig({
        NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRICE_SIGNAL: 'price_signal', STRIPE_PRICE_STUDIO: 'price_studio', STRIPE_PRICE_ENTERPRISE: 'price_enterprise'
    });
    const service = createStripeService({ config, store });
    const event = {
        id: 'evt_new', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 2_000_000_000, metadata: { userId: 'user_paid', workspaceId: 'ws_paid' }, items: { data: [{ price: { id: 'price_studio' } }] } } }
    };
    const signed = signedEvent(event);
    assert.equal((await service.handleWebhook(signed.payload, signed.signature)).applied, true);
    assert.equal((await store.getWorkspace('ws_paid')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_paid')).effectivePlanId, 'studio');
    assert.equal((await service.handleWebhook(signed.payload, signed.signature)).applied, false);

    const older = { ...event, id: 'evt_old', created: event.created - 10, data: { object: { ...event.data.object, items: { data: [{ price: { id: 'price_signal' } }] } } } };
    const signedOlder = signedEvent(older);
    assert.equal((await service.handleWebhook(signedOlder.payload, signedOlder.signature)).applied, false);
    assert.equal((await store.getWorkspace('ws_paid')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_paid')).effectivePlanId, 'studio');
});

test('Stripe webhook rejects a body whose signature does not match', async () => {
    const store = new MemoryPlatformStore();
    const config = loadConfig({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: webhookSecret });
    const service = createStripeService({ config, store });
    await assert.rejects(() => service.handleWebhook(Buffer.from('{}'), 'bad'), { code: 'INVALID_WEBHOOK_SIGNATURE' });
});

test('Stripe grants paid entitlements only for active or trialing subscriptions and orders equal timestamps by event id', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_status', email: 'status@example.test' });
    await store.ensureWorkspace('ws_status', { entitlementOwnerUserId: 'user_status' });
    const config = loadConfig({
        NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRICE_SIGNAL: 'price_signal', STRIPE_PRICE_STUDIO: 'price_studio', STRIPE_PRICE_ENTERPRISE: 'price_enterprise'
    });
    const service = createStripeService({ config, store });
    const base = Math.floor(Date.now() / 1000);
    const event = (id, status, created, priceId = 'price_enterprise') => ({
        id, type: 'customer.subscription.updated', created,
        data: { object: { id: 'sub_status', customer: 'cus_status', status, current_period_end: 2_000_000_000, metadata: { userId: 'user_status', workspaceId: 'ws_status' }, items: { data: [{ price: { id: priceId } }] } } }
    });
    const first = signedEvent(event('evt_active', 'active', base));
    assert.equal((await service.handleWebhook(first.payload, first.signature)).applied, true);
    assert.equal((await store.getWorkspace('ws_status')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_status')).effectivePlanId, 'enterprise');
    const sameTimeOlder = event('evt_aaa', 'active', base, 'price_studio');
    const signedOlder = signedEvent(sameTimeOlder);
    assert.equal((await service.handleWebhook(signedOlder.payload, signedOlder.signature)).applied, false);
    assert.equal((await store.getWorkspace('ws_status')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_status')).effectivePlanId, 'enterprise');
    const sameTimeNewer = event('evt_zzz', 'past_due', base, 'price_enterprise');
    const signedNewer = signedEvent(sameTimeNewer);
    assert.equal((await service.handleWebhook(signedNewer.payload, signedNewer.signature)).applied, true);
    assert.equal((await store.getWorkspace('ws_status')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_status')).effectivePlanId, 'enterprise');
    for (const [index, status] of ['incomplete', 'unpaid', 'canceled', 'deleted'].entries()) {
        const next = event(`evt_${status}`, status, base + 1 + index, 'price_enterprise');
        const signed = signedEvent(next);
        assert.equal((await service.handleWebhook(signed.payload, signed.signature)).applied, true);
        assert.equal((await store.getWorkspace('ws_status')).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements('user_status')).effectivePlanId, 'free');
    }
    const trial = event('evt_trial', 'trialing', base + 10, 'price_studio');
    const signedTrial = signedEvent(trial);
    assert.equal((await service.handleWebhook(signedTrial.payload, signedTrial.signature)).applied, true);
    assert.equal((await store.getWorkspace('ws_status')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_status')).effectivePlanId, 'studio');
});

test('Stripe checkout sends a stable idempotency key for retry/reuse', async () => {
    const calls = [];
    const sessions = new Map();
    const stripeClient = {
        checkout: { sessions: { create: async (params, options) => {
            calls.push({ params, options });
            if (!sessions.has(options.idempotencyKey)) sessions.set(options.idempotencyKey, { id: `cs_${sessions.size + 1}`, url: 'https://checkout.stripe.test/session' });
            return sessions.get(options.idempotencyKey);
        } } },
        webhooks: { constructEvent() { throw new Error('not used'); } },
        billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test' }) } }
    };
    const config = loadConfig({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_PRICE_STUDIO: 'price_studio' });
    const service = createStripeService({ config, store: new MemoryPlatformStore(), stripeClient });
    const first = await service.createCheckout('ws_checkout', 'studio');
    const second = await service.createCheckout('ws_checkout', 'studio');
    assert.equal(first.id, second.id);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
    assert.match(calls[0].options.idempotencyKey, /^wpa-checkout-/);
    await service.createCheckout('ws_other', 'studio', 'client-retry-1');
    await service.createCheckout('ws_checkout', 'studio', 'client-retry-1');
    assert.notEqual(calls[2].options.idempotencyKey, calls[3].options.idempotencyKey);
});

test('Stripe billing portal returns to the billing return route', async () => {
    let params;
    const stripeClient = {
        checkout: { sessions: { create: async () => ({ id: 'unused', url: 'https://checkout.stripe.test' }) } },
        webhooks: { constructEvent() { throw new Error('not used'); } },
        billingPortal: { sessions: { create: async (input) => { params = input; return { url: 'https://billing.stripe.test' }; } } }
    };
    const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'https://dashboard.example', STRIPE_SECRET_KEY: 'sk_test_placeholder' });
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_portal');
    await store.applySubscriptionEvent('ws_portal', { stripeCustomerId: 'cus_portal', stripeSubscriptionId: 'sub_portal', stripePriceId: 'price_studio', status: 'active', currentPeriodEnd: null }, { id: 'evt_portal', created: 1 });
    const service = createStripeService({ config, store, stripeClient });
    await service.createPortal('ws_portal');
    assert.equal(params.return_url, 'https://dashboard.example/app?billing=return');
});
