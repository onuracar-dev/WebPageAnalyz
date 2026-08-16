const test = require('node:test');
const assert = require('node:assert/strict');
const { FREE_PLAN, PLANS, getPlan, planSalesMode } = require('../domain/plans');
const { MemoryPlatformStore } = require('../platform/store');

function subscriptionEvent({ id, at, status, planId = null, action = 'set_plan', access = 'paid', scheduledChange = null }) {
    return {
        provider: 'paddle', eventId: id, eventType: 'subscription.updated', occurredAt: new Date(at).toISOString(), occurredAtMs: at,
        externalObjectId: 'sub_1', userId: 'user_billing', workspaceId: 'ws_billing', resourceKind: 'subscription', rawEvent: { event_id: id },
        subscription: { providerCustomerId: 'ctm_1', providerSubscriptionId: 'sub_1', providerPriceId: `pri_${planId || 'studio'}`, providerProductId: `pro_${planId || 'studio'}`, status, currentPeriodEnd: '2030-01-01T00:00:00.000Z', scheduledChange },
        entitlement: { action, planId, access, reason: status }
    };
}

test('free is the default internal plan while the three public paid plans stay stable', async () => {
    assert.equal(PLANS.length, 3);
    assert.equal(FREE_PLAN.id, 'free');
    assert.deepEqual(FREE_PLAN.limits, { pageCredits: 5, projects: 1, seats: 1, retentionDays: 7, sourceAudits: 0, aiRemediations: 5 });
    assert.equal(getPlan('signal').limits.aiRemediations, 100);
    assert.equal(getPlan('studio').entitlements.ai_remediation.limit, 1000);
    assert.equal(getPlan('enterprise').entitlements.ai_remediation.limit, 5000);
    assert.equal(planSalesMode('enterprise'), 'contact');
    assert.equal((await new MemoryPlatformStore().listPlans()).find((plan) => plan.id === 'enterprise').salesMode, 'contact');

    const store = new MemoryPlatformStore();
    const workspace = await store.ensureWorkspace('ws_free');
    assert.equal(workspace.planId, 'free');
    assert.equal((await store.getEffectiveEntitlements('ws_free')).limits.pageCredits, 5);
    assert.deepEqual((await store.listPlans()).map((plan) => plan.id), ['signal', 'studio', 'enterprise']);
});

test('provider events apply atomically, preserve grace, order deterministically and downgrade only on terminal state', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_billing', email: 'billing@example.test' });
    await store.ensureWorkspace('ws_billing', { entitlementOwnerUserId: 'user_billing' });
    const base = Date.UTC(2026, 7, 15, 10);
    const active = subscriptionEvent({ id: 'evt_active', at: base, status: 'active', planId: 'studio' });
    assert.equal((await store.applyBillingProviderEvent(active)).applied, true);
    assert.equal((await store.getWorkspace('ws_billing')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'studio');

    const grace = subscriptionEvent({ id: 'evt_grace', at: base + 1_000, status: 'past_due', action: 'preserve', access: 'grace' });
    assert.equal((await store.applyBillingProviderEvent(grace)).applied, true);
    assert.equal((await store.getWorkspace('ws_billing')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'studio');
    assert.equal((await store.getBillingSubscription({ userId: 'user_billing' }, 'paddle')).accessState, 'grace');

    assert.equal((await store.applyBillingProviderEvent(grace)).duplicate, true);
    const old = subscriptionEvent({ id: 'evt_old', at: base - 1_000, status: 'canceled', planId: 'free', access: 'free' });
    assert.equal((await store.applyBillingProviderEvent(old)).stale, true);
    assert.equal((await store.getWorkspace('ws_billing')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'studio');

    const terminal = subscriptionEvent({ id: 'evt_terminal', at: base + 2_000, status: 'canceled', planId: 'free', access: 'free' });
    assert.equal((await store.applyBillingProviderEvent(terminal)).applied, true);
    assert.equal((await store.getWorkspace('ws_billing')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'free');
    assert.equal(store.auditLog[0].action, 'subscription.reconciled');
});

test('payment ordering does not suppress a separately ordered subscription state event', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_billing', email: 'billing@example.test' });
    await store.ensureWorkspace('ws_billing', { entitlementOwnerUserId: 'user_billing' });
    const base = Date.UTC(2026, 7, 15, 10);
    await store.applyBillingProviderEvent(subscriptionEvent({ id: 'evt_sub_active', at: base, status: 'active', planId: 'studio' }));
    await store.applyBillingProviderEvent({
        provider: 'paddle', eventId: 'evt_payment_later', eventType: 'transaction.completed',
        occurredAt: new Date(base + 2_000).toISOString(), occurredAtMs: base + 2_000,
        externalObjectId: 'txn_1', userId: 'user_billing', workspaceId: 'ws_billing', resourceKind: 'payment', rawEvent: {},
        payment: { providerTransactionId: 'txn_1', providerSubscriptionId: 'sub_1', status: 'completed', total: '9900', currencyCode: 'USD' }
    });
    const terminal = await store.applyBillingProviderEvent(subscriptionEvent({ id: 'evt_sub_canceled', at: base + 1_000, status: 'canceled', planId: 'free', access: 'free' }));
    assert.equal(terminal.applied, true);
    assert.equal((await store.getWorkspace('ws_billing')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('user_billing')).effectivePlanId, 'free');
    assert.equal((await store.getBillingSubscription({ userId: 'user_billing' }, 'paddle')).payment.providerTransactionId, 'txn_1');
});
