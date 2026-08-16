const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { resolveCheckoutIdentity } = require('../billing/provider');
const { createStripeService } = require('../billing/stripe');
const { createPaddleProvider, mapPaddleEvent } = require('../billing/paddle');

async function commercialStore() {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_billing', name: 'Billing owner', email: 'billing@example.test' });
    await store.registerUser({ id: 'user_other', name: 'Other user', email: 'other@example.test' });
    await store.ensureWorkspace('ws_billing_a', { entitlementOwnerUserId: 'user_billing' });
    await store.ensureWorkspace('ws_billing_b', { entitlementOwnerUserId: 'user_billing' });
    return store;
}

function acceptanceInput(overrides = {}) {
    return {
        workspaceId: 'ws_billing_a', userId: 'user_billing', planId: 'studio', provider: 'stripe',
        catalogVersion: 'catalog-user-billing', amountMinor: 9900, currency: 'USD', billingInterval: 'month',
        termsVersion: 'terms-user-billing', refundPolicyVersion: 'refund-user-billing', requestId: 'req-user-billing',
        idempotencyKey: 'checkout-user-billing-0001', requestFingerprint: 'fingerprint-user-billing-0001',
        ...overrides
    };
}

test('checkout acceptance serializes one open intent per user across sponsored workspaces', async () => {
    const store = await commercialStore();
    const first = await store.recordCheckoutAcceptance(acceptanceInput());

    await assert.rejects(() => store.recordCheckoutAcceptance(acceptanceInput({
        workspaceId: 'ws_billing_b', provider: 'paddle', idempotencyKey: 'checkout-user-billing-0002', requestFingerprint: 'fingerprint-user-billing-0002'
    })), { code: 'CHECKOUT_IN_PROGRESS' });

    await store.markCheckoutAcceptance({ userId: 'user_billing', workspaceId: 'ws_billing_a' }, first.id, { status: 'completed', providerCheckoutId: 'cs_completed' });
    const second = await store.recordCheckoutAcceptance(acceptanceInput({
        workspaceId: 'ws_billing_b', provider: 'paddle', idempotencyKey: 'checkout-user-billing-0002', requestFingerprint: 'fingerprint-user-billing-0002'
    }));
    assert.equal(second.userId, 'user_billing');
    assert.equal(second.workspaceId, 'ws_billing_b');

    await assert.rejects(() => store.recordCheckoutAcceptance(acceptanceInput({
        workspaceId: 'ws_billing_b', idempotencyKey: first.idempotencyKey
    })), { code: 'IDEMPOTENCY_KEY_REUSED' });
});

test('persisted checkout user is immutable during provider identity resolution', async () => {
    const store = await commercialStore();
    const acceptance = await store.recordCheckoutAcceptance(acceptanceInput());
    await assert.rejects(() => resolveCheckoutIdentity({
        config: { nodeEnv: 'test' }, store, provider: 'stripe',
        params: { userId: 'user_other', workspaceId: acceptance.workspaceId, planId: acceptance.planId, acceptanceId: acceptance.id, idempotencyKey: acceptance.idempotencyKey }
    }), { code: 'CHECKOUT_ACCEPTANCE_NOT_FOUND' });
    const resolved = await resolveCheckoutIdentity({
        config: { nodeEnv: 'test' }, store, provider: 'stripe',
        params: { userId: 'user_billing', workspaceId: acceptance.workspaceId, planId: acceptance.planId, acceptanceId: acceptance.id, idempotencyKey: acceptance.idempotencyKey }
    });
    assert.equal(resolved.userId, 'user_billing');
});

test('Stripe checkout metadata and Paddle customData carry the immutable acceptance user', async () => {
    const stripeStore = await commercialStore();
    const stripeAcceptance = await stripeStore.recordCheckoutAcceptance(acceptanceInput());
    const stripeCalls = [];
    const stripe = createStripeService({
        config: loadConfig({ NODE_ENV: 'test', APP_URL: 'https://app.example.test', STRIPE_SECRET_KEY: 'sk_test_user_billing', STRIPE_PRICE_STUDIO: 'price_studio' }),
        store: stripeStore,
        stripeClient: {
            checkout: { sessions: { create: async (input, options) => { stripeCalls.push({ input, options }); return { id: 'cs_user_billing', url: 'https://stripe.example.test/checkout' }; } } },
            webhooks: { constructEvent() { throw new Error('not used'); } },
            billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.example.test/portal' }) } }
        }
    });
    await stripe.createCheckout({ userId: 'user_billing', workspaceId: 'ws_billing_a', planId: 'studio', acceptanceId: stripeAcceptance.id, idempotencyKey: stripeAcceptance.idempotencyKey });
    assert.equal(stripeCalls[0].input.metadata.userId, 'user_billing');
    assert.equal(stripeCalls[0].input.subscription_data.metadata.userId, 'user_billing');

    const paddleStore = await commercialStore();
    const paddleAcceptance = await paddleStore.recordCheckoutAcceptance(acceptanceInput({ provider: 'paddle' }));
    const paddleCalls = [];
    const paddle = createPaddleProvider({
        config: { nodeEnv: 'test', appUrl: 'https://app.example.test', paddle: { apiKey: 'pdl_test_user_billing', environment: 'sandbox', prices: { studio: 'pri_studio' }, products: { studio: 'pro_studio' }, freePlanId: 'free' } },
        store: paddleStore,
        paddleClient: { transactions: { create: async (input, options) => { paddleCalls.push({ input, options }); return { id: 'txn_user_billing', checkout: { url: 'https://paddle.example.test/checkout' } }; } } }
    });
    await paddle.createCheckout({ userId: 'user_billing', workspaceId: 'ws_billing_a', planId: 'studio', acceptanceId: paddleAcceptance.id, idempotencyKey: paddleAcceptance.idempotencyKey });
    assert.equal(paddleCalls[0].input.customData.userId, 'user_billing');
});

test('provider subscription events mutate the user profile, preserve workspace plan, and remain ordered/idempotent', async () => {
    const store = await commercialStore();
    const active = {
        provider: 'paddle', eventId: 'evt_user_active', eventType: 'subscription.updated', occurredAt: '2030-01-02T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-02T00:00:00.000Z'),
        userId: 'user_billing', workspaceId: 'ws_billing_a', resourceKind: 'subscription', externalObjectId: 'sub_user_billing',
        subscription: { providerSubscriptionId: 'sub_user_billing', providerCustomerId: 'ctm_user_billing', status: 'active' },
        entitlement: { action: 'set_plan', planId: 'studio', access: 'paid', reason: 'subscription_paid' }
    };
    const concurrent = await Promise.all([store.applyBillingProviderEvent(active), store.applyBillingProviderEvent(active)]);
    const first = concurrent.find((result) => result.applied);
    const replay = concurrent.find((result) => result.duplicate);
    const stale = await store.applyBillingProviderEvent({
        ...active, eventId: 'evt_user_older', occurredAt: '2030-01-01T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-01T00:00:00.000Z'),
        entitlement: { ...active.entitlement, planId: 'signal' }
    });

    assert.equal(first.applied, true);
    assert.equal(replay.duplicate, true);
    assert.equal(stale.stale, true);
    assert.equal((await store.getWorkspace('ws_billing_a')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'studio');
    assert.equal((await store.getUserEffectiveEntitlements('user_other')).effectivePlanId, 'free');
    assert.equal((await store.getBillingSubscription({ userId: 'user_billing' }, 'paddle')).userId, 'user_billing');
    assert.equal([...store.userPlanChanges.values()].filter((change) => change.userId === 'user_billing').length, 1);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'subscription.reconciled' && entry.metadata?.targetUserId === 'user_billing').length, 1);
});

test('provider events reject a user and workspace sponsor mismatch without granting either account', async () => {
    const store = await commercialStore();
    await assert.rejects(() => store.applyBillingProviderEvent({
        provider: 'paddle', eventId: 'evt_wrong_owner', eventType: 'subscription.updated',
        occurredAt: '2030-01-02T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-02T00:00:00.000Z'),
        userId: 'user_other', workspaceId: 'ws_billing_a', resourceKind: 'subscription', externalObjectId: 'sub_wrong_owner',
        subscription: { providerSubscriptionId: 'sub_wrong_owner', status: 'active' },
        entitlement: { action: 'set_plan', planId: 'studio', access: 'paid', reason: 'subscription_paid' }
    }), { code: 'BILLING_USER_WORKSPACE_MISMATCH' });
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_other')).effectivePlanId, 'free');
    assert.equal(await store.getBillingSubscription({ userId: 'user_other' }, 'paddle'), null);
});

test('follow-up provider DTOs resolve the subscription user without a workspace reference', async () => {
    const store = await commercialStore();
    await store.applyBillingProviderEvent({
        provider: 'paddle', eventId: 'evt_link_subscription', eventType: 'subscription.updated', occurredAt: '2030-01-01T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-01T00:00:00.000Z'),
        userId: 'user_billing', workspaceId: 'ws_billing_a', resourceKind: 'subscription', externalObjectId: 'sub_linked',
        subscription: { providerSubscriptionId: 'sub_linked', status: 'active' }, entitlement: { action: 'set_plan', planId: 'signal', access: 'paid', reason: 'subscription_paid' }
    });
    const payment = await store.applyBillingProviderEvent({
        provider: 'paddle', eventId: 'evt_link_payment', eventType: 'transaction.completed', occurredAt: '2030-01-02T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-02T00:00:00.000Z'),
        resourceKind: 'payment', externalObjectId: 'txn_linked', payment: { providerSubscriptionId: 'sub_linked', providerTransactionId: 'txn_linked', status: 'completed' },
        entitlement: { action: 'preserve', planId: null, access: 'paid', reason: 'payment_completed' }
    });
    assert.equal(payment.applied, true);
    assert.equal(payment.subscription.userId, 'user_billing');
    assert.equal(payment.subscription.workspaceId, 'ws_billing_a');
});

test('Paddle webhook DTO preserves customData userId', () => {
    const dto = mapPaddleEvent({
        event_id: 'evt_dto_user', event_type: 'subscription.updated', occurred_at: '2030-01-01T00:00:00.000Z',
        data: { id: 'sub_dto_user', customer_id: 'ctm_dto_user', status: 'active', custom_data: { userId: 'user_billing', workspaceId: 'ws_billing_a' }, items: [{ price: { id: 'pri_studio', product_id: 'pro_studio' } }] }
    }, () => 'studio');
    assert.equal(dto.userId, 'user_billing');
    assert.equal(dto.workspaceId, 'ws_billing_a');
});
