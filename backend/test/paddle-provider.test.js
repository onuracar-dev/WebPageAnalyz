const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertBillingProvider } = require('../billing/provider');
const { createPaddleProvider } = require('../billing/paddle');
const { createStripeService } = require('../billing/stripe');
const { createBillingProvider } = require('../billing');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');

const webhookSecret = 'pdl_ntfset_provider_secret';
const timestamp = 2_000_000_000;
const now = () => timestamp * 1000;

function config(overrides = {}) {
    return {
        appUrl: 'https://dashboard.example',
        paddle: {
            apiKey: 'pdl_sdbx_test',
            webhookSecret,
            webhookToleranceSeconds: 5,
            prices: { signal: 'pri_signal', studio: 'pri_studio', enterprise: 'pri_enterprise' },
            products: { signal: 'pro_signal', studio: 'pro_studio', enterprise: 'pro_enterprise' },
            freePlanId: 'free',
            ...overrides
        }
    };
}

function signedEvent(event) {
    const body = JSON.stringify(event);
    const digest = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}:${body}`).digest('hex');
    return { body: Buffer.from(body), signature: `ts=${timestamp};h1=${digest}` };
}

function subscriptionEvent({ id, status, priceId = 'pri_studio', scheduledChange = null, occurredAt = '2033-05-18T03:33:20.000Z' }) {
    return {
        event_id: id,
        event_type: 'subscription.updated',
        occurred_at: occurredAt,
        data: {
            id: 'sub_1',
            customer_id: 'ctm_1',
            status,
            custom_data: { userId: 'user_1', workspaceId: 'ws_1' },
            current_billing_period: { ends_at: '2033-06-18T03:33:20.000Z' },
            scheduled_change: scheduledChange,
            items: [{ price: { id: priceId, product_id: 'pro_studio' } }]
        }
    };
}

test('Paddle provider maps paid, grace, scheduled cancellation, paused, and canceled entitlement decisions', async () => {
    const applied = [];
    const store = { applyBillingProviderEvent: async (event) => { applied.push(event); return { applied: true }; } };
    const provider = createPaddleProvider({ config: config(), store, paddleClient: {}, now });
    assert.equal(assertBillingProvider(provider), provider);

    for (const status of ['active', 'trialing']) {
        const event = signedEvent(subscriptionEvent({ id: `evt_${status}`, status }));
        const result = await provider.handleWebhook(event.body, event.signature);
        assert.equal(result.event.entitlement.action, 'set_plan');
        assert.equal(result.event.entitlement.planId, 'studio');
        assert.equal(result.event.entitlement.access, 'paid');
    }

    const pastDue = signedEvent(subscriptionEvent({ id: 'evt_past_due', status: 'past_due' }));
    assert.deepEqual((await provider.handleWebhook(pastDue.body, pastDue.signature)).event.entitlement, {
        action: 'preserve', planId: null, access: 'grace', reason: 'payment_collection_grace'
    });

    const scheduled = signedEvent(subscriptionEvent({
        id: 'evt_scheduled',
        status: 'active',
        scheduledChange: { action: 'cancel', effective_at: '2033-06-18T03:33:20.000Z' }
    }));
    const scheduledDto = (await provider.handleWebhook(scheduled.body, scheduled.signature)).event;
    assert.equal(scheduledDto.entitlement.planId, 'studio');
    assert.equal(scheduledDto.entitlement.reason, 'scheduled_cancellation_not_effective');
    assert.equal(scheduledDto.subscription.scheduledChange.effectiveAt, '2033-06-18T03:33:20.000Z');

    for (const status of ['paused', 'canceled', 'expired', 'unpaid']) {
        const event = signedEvent(subscriptionEvent({ id: `evt_${status}`, status }));
        const decision = (await provider.handleWebhook(event.body, event.signature)).event.entitlement;
        assert.deepEqual(decision, {
            action: 'set_plan', planId: 'free', access: 'free', reason: `subscription_${status}`
        });
    }
    assert.equal(applied.length, 8);
    assert.ok(applied.every((event) => event.provider === 'paddle' && Number.isFinite(event.occurredAtMs)));
});

test('Paddle price changes apply Signal to Studio upgrade and Studio to Signal downgrade on one subscription', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_1', email: 'user-1@example.test' });
    await store.ensureWorkspace('ws_1', { entitlementOwnerUserId: 'user_1' });
    const provider = createPaddleProvider({ config: config(), store, paddleClient: {}, now });
    const transitions = [
        { id: 'evt_signal_initial', priceId: 'pri_signal', occurredAt: '2033-05-18T03:31:20.000Z', planId: 'signal' },
        { id: 'evt_upgrade_studio', priceId: 'pri_studio', occurredAt: '2033-05-18T03:32:20.000Z', planId: 'studio' },
        { id: 'evt_downgrade_signal', priceId: 'pri_signal', occurredAt: '2033-05-18T03:33:20.000Z', planId: 'signal' }
    ];

    for (const transition of transitions) {
        const event = signedEvent(subscriptionEvent({
            id: transition.id,
            status: 'active',
            priceId: transition.priceId,
            occurredAt: transition.occurredAt
        }));
        const result = await provider.handleWebhook(event.body, event.signature);
        assert.equal(result.applied, true);
        assert.equal(result.event.entitlement.planId, transition.planId);
        assert.equal((await store.getWorkspace('ws_1')).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements('user_1')).effectivePlanId, transition.planId);
    }
});

test('Paddle provider exposes order-ready payment and refund DTOs through one atomic store boundary', async () => {
    const seen = [];
    const store = {
        async applyBillingProviderEvent(event) {
            seen.push(event);
            return seen.length === 1 ? { applied: true } : { applied: false, duplicate: true };
        }
    };
    const provider = createPaddleProvider({ config: config(), store, paddleClient: {}, now });
    const payment = signedEvent({
        event_id: 'evt_payment', event_type: 'transaction.completed', occurred_at: '2033-05-18T03:33:20Z',
        data: { id: 'txn_1', customer_id: 'ctm_1', subscription_id: 'sub_1', status: 'completed', currency_code: 'USD', details: { totals: { total: '9900' } }, custom_data: { workspaceId: 'ws_1' } }
    });
    const first = await provider.handleWebhook(payment.body, payment.signature);
    assert.equal(first.applied, true);
    assert.deepEqual(first.event.payment, {
        providerTransactionId: 'txn_1', providerCustomerId: 'ctm_1', providerSubscriptionId: 'sub_1',
        status: 'completed', currencyCode: 'USD', total: '9900', invoiceNumber: null
    });

    const refund = signedEvent({
        event_id: 'evt_refund', event_type: 'adjustment.updated', occurred_at: '2033-05-18T03:33:20Z',
        data: { id: 'adj_1', transaction_id: 'txn_1', action: 'refund', status: 'approved', reason: 'requested_by_customer', currency_code: 'USD', totals: { total: '9900' }, custom_data: { workspaceId: 'ws_1' } }
    });
    const second = await provider.handleWebhook(refund.body, refund.signature);
    assert.equal(second.applied, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.event.resourceKind, 'refund');
    assert.equal(second.event.refund.status, 'approved');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].eventId, 'evt_payment');
    assert.equal(seen[1].eventId, 'evt_refund');
});

test('replaying the same Paddle payment webhook is idempotent and creates no duplicate ledger effect', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_1', email: 'user-1@example.test' });
    await store.ensureWorkspace('ws_1', { entitlementOwnerUserId: 'user_1' });
    const provider = createPaddleProvider({ config: config(), store, paddleClient: {}, now });
    const payment = signedEvent({
        event_id: 'evt_payment_duplicate', event_type: 'transaction.completed', occurred_at: '2033-05-18T03:33:20Z',
        data: { id: 'txn_duplicate', customer_id: 'ctm_1', subscription_id: 'sub_1', status: 'completed', currency_code: 'USD', details: { totals: { total: '9900' } }, custom_data: { userId: 'user_1', workspaceId: 'ws_1' } }
    });

    const first = await provider.handleWebhook(payment.body, payment.signature);
    const second = await provider.handleWebhook(payment.body, payment.signature);

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(second.duplicate, true);
    assert.equal(store.billingEvents.size, 1);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'payment.reconciled').length, 1);
    assert.equal((await store.getBillingSubscription({ userId: 'user_1' }, 'paddle')).payment.providerTransactionId, 'txn_duplicate');
    assert.equal(store.entitlementGrants.size, 0);
});

test('Paddle checkout, portal, cancellation, and subscription retrieval are dependency-injected', async () => {
    const calls = [];
    const client = {
        transactions: { create: async (input, options) => { calls.push(['checkout', input, options]); return { id: 'txn_checkout', status: 'ready', checkout: { url: 'https://checkout.paddle.test/txn_checkout' } }; } },
        customerPortalSessions: { create: async (customerId) => { calls.push(['portal', customerId]); return { url: 'https://portal.paddle.test/session', expiresAt: '2033-05-18T03:38:20Z' }; } },
        subscriptions: {
            cancel: async (subscriptionId, input) => { calls.push(['cancel', subscriptionId, input]); return { id: subscriptionId, status: 'active', scheduled_change: { action: 'cancel' } }; },
            get: async (subscriptionId) => { calls.push(['get', subscriptionId]); return { id: subscriptionId, status: 'active' }; }
        }
    };
    const store = {
        getBillingSubscription: async () => ({ providerCustomerId: 'ctm_portal', providerSubscriptionId: 'sub_portal' }),
        markCheckoutAcceptance: async (...input) => { calls.push(['acceptance', ...input]); }
    };
    const provider = createPaddleProvider({ config: config(), store, paddleClient: client, now });
    const checkout = await provider.createCheckout({ workspaceId: 'ws_1', planId: 'studio', idempotencyKey: 'intent_1' });
    assert.equal(checkout.url, 'https://checkout.paddle.test/txn_checkout');
    assert.deepEqual(calls[0][1].items, [{ priceId: 'pri_studio', quantity: 1 }]);
    assert.deepEqual(calls[0][2], { idempotencyKey: 'intent_1' });
    assert.deepEqual(calls[1], ['acceptance', 'ws_1', 'intent_1', { status: 'checkout_created', providerCheckoutId: 'txn_checkout' }]);
    assert.equal((await provider.createCustomerPortal({ workspaceId: 'ws_1' })).url, 'https://portal.paddle.test/session');
    assert.equal((await provider.cancelSubscription({ subscriptionId: 'sub_portal' })).status, 'active');
    assert.deepEqual(calls.find((call) => call[0] === 'cancel')[2], { effectiveFrom: 'next_billing_period' });
    assert.equal((await provider.getSubscription({ subscriptionId: 'sub_portal' })).id, 'sub_portal');
});

test('Paddle reconciliation fetches the authoritative subscription and applies the normalized entitlement event', async () => {
    const calls = [];
    const applied = [];
    const client = {
        subscriptions: {
            async get(subscriptionId) {
                calls.push(subscriptionId);
                return {
                    id: subscriptionId,
                    customer_id: 'ctm_reconcile',
                    status: 'active',
                    updated_at: '2033-05-18T03:33:20.000Z',
                    current_billing_period: { ends_at: '2033-06-18T03:33:20.000Z' },
                    items: [{ price: { id: 'pri_studio', product_id: 'pro_studio' } }]
                };
            }
        }
    };
    const store = {
        async getBillingSubscription(workspaceId, providerName) {
            assert.equal(workspaceId, 'ws_reconcile');
            assert.equal(providerName, 'paddle');
            return { providerSubscriptionId: 'sub_reconcile' };
        },
        async applyBillingProviderEvent(event) {
            applied.push(event);
            return { applied: true };
        }
    };
    const provider = createPaddleProvider({ config: config(), store, paddleClient: client, now });

    const result = await provider.reconcileSubscription({ workspaceId: 'ws_reconcile' });

    assert.deepEqual(calls, ['sub_reconcile']);
    assert.equal(result.reconciled, true);
    assert.equal(result.applied, true);
    assert.equal(result.duplicate, false);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].provider, 'paddle');
    assert.equal(applied[0].resourceKind, 'subscription');
    assert.equal(applied[0].workspaceId, 'ws_reconcile');
    assert.equal(applied[0].subscription.providerSubscriptionId, 'sub_reconcile');
    assert.equal(applied[0].entitlement.action, 'set_plan');
    assert.equal(applied[0].entitlement.planId, 'studio');
    assert.match(applied[0].eventId, /^reconcile_paddle_[a-f0-9]{32}$/);
});

test('legacy Stripe service preserves provider-neutral aliases and rejects checkout for an active subscription', async () => {
    const stripeConfig = loadConfig({ NODE_ENV: 'test', APP_URL: 'https://dashboard.example', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_PRICE_STUDIO: 'price_studio' });
    const stripeClient = {
        checkout: { sessions: { create: async () => ({ id: 'unused', url: 'https://checkout.stripe.test' }) } },
        webhooks: { constructEvent() { throw new Error('not used'); } },
        billingPortal: { sessions: { create: async () => ({ url: 'https://portal.stripe.test' }) } },
        subscriptions: { update: async () => ({ id: 'sub_1', status: 'active', cancel_at_period_end: true, current_period_end: 2_000_000_000 }) }
    };
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_stripe');
    await store.applySubscriptionEvent('ws_stripe', { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripePriceId: '', status: 'active', currentPeriodEnd: null }, { id: 'evt_1', created: 1 });
    const provider = createStripeService({ config: stripeConfig, store, stripeClient });
    assert.equal(assertBillingProvider(provider), provider);
    await assert.rejects(() => provider.createCheckout({ workspaceId: 'ws_stripe', planId: 'studio', idempotencyKey: 'intent_1' }), { code: 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE' });
    assert.equal((await provider.createPortal('ws_stripe')).url, 'https://portal.stripe.test');
    assert.equal((await provider.cancelSubscription({ subscriptionId: 'sub_1' })).scheduledChange.action, 'cancel');
});

test('billing factory selects the configured provider and exposes its webhook header contract', () => {
    const paddleConfig = config();
    const provider = createBillingProvider({
        config: { ...paddleConfig, billing: { provider: 'paddle', paddle: paddleConfig.paddle } },
        store: {}, paddleClient: {}, now
    });
    assert.equal(provider.provider, 'paddle');
    assert.equal(provider.signatureHeaderName, 'paddle-signature');
    assert.equal(provider.checkoutAcceptanceMode, 'persist_before_provider_call');
    assert.equal(typeof provider.reconcileSubscription, 'function');
});
