const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { planSalesMode } = require('../domain/plans');

const BILLING_PROVIDER_METHODS = Object.freeze([
    'createCheckout',
    'createCustomerPortal',
    'cancelSubscription',
    'getSubscription',
    'reconcileSubscription',
    'handleWebhook',
    'mapExternalProductToPlan'
]);

const PAID_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const PRESERVE_SUBSCRIPTION_STATUSES = new Set(['past_due']);
const FREE_SUBSCRIPTION_STATUSES = new Set(['canceled', 'cancelled', 'paused', 'unpaid', 'incomplete', 'deleted', 'expired', 'terminated']);
const CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'paid', 'grace']);
const CHECKOUT_BLOCKING_ACCESS_STATES = new Set(['paid', 'grace']);

function assertBillingProvider(provider) {
    if (!provider || typeof provider !== 'object') {
        throw new TypeError('Billing provider must be an object.');
    }
    for (const method of BILLING_PROVIDER_METHODS) {
        if (typeof provider[method] !== 'function') {
            throw new TypeError(`Billing provider is missing ${method}().`);
        }
    }
    return provider;
}

function entitlementDecision({ status, planId = null, scheduledChange = null, freePlanId = 'free' }) {
    const normalizedStatus = String(status || '').toLowerCase();
    if (PAID_SUBSCRIPTION_STATUSES.has(normalizedStatus)) {
        return {
            action: 'set_plan',
            planId,
            access: 'paid',
            reason: scheduledChange?.action === 'cancel'
                ? 'scheduled_cancellation_not_effective'
                : 'subscription_paid'
        };
    }
    if (PRESERVE_SUBSCRIPTION_STATUSES.has(normalizedStatus)) {
        return {
            action: 'preserve',
            planId: null,
            access: 'grace',
            reason: 'payment_collection_grace'
        };
    }
    if (FREE_SUBSCRIPTION_STATUSES.has(normalizedStatus)) {
        return {
            action: 'set_plan',
            planId: freePlanId,
            access: 'free',
            reason: `subscription_${normalizedStatus || 'inactive'}`
        };
    }
    return {
        action: 'preserve',
        planId: null,
        access: 'unknown',
        reason: 'subscription_status_unknown'
    };
}

function unavailableProviderMethod(providerName) {
    return () => {
        throw new AppError(`${providerName} billing is not configured.`, {
            status: 503,
            code: 'BILLING_NOT_CONFIGURED'
        });
    };
}

function normalizeCheckoutInput(input, legacyPlanId = null, legacyIdempotencyKey = null) {
    if (typeof input === 'object' && input !== null) return { ...input, objectInput: true };
    return { workspaceId: input, planId: legacyPlanId, idempotencyKey: legacyIdempotencyKey, objectInput: false };
}

function checkoutProviderIdempotencyKey(provider, {
    userId = null,
    workspaceId,
    planId,
    subscriptionId = null,
    acceptanceId = null,
    clientKey = null
} = {}) {
    const commercialSubject = userId || workspaceId;
    const identity = acceptanceId
        ? `${provider}\0${commercialSubject}\0${workspaceId || ''}\0acceptance\0${acceptanceId}\0${clientKey || ''}`
        : `${provider}\0${commercialSubject}\0${workspaceId || ''}\0${planId || ''}\0${subscriptionId || ''}\0${clientKey || ''}`;
    const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 48);
    return `wpa-${provider}-checkout-${digest}`;
}

async function readStoredSubscription({ store, config, provider, userId = null, workspaceId = null } = {}) {
    const identity = userId ? { userId, workspaceId } : workspaceId;
    const getSubscription = typeof store?.getSubscription === 'function'
        ? () => store.getSubscription(identity)
        : typeof store?.getBillingSubscription === 'function'
            ? () => store.getBillingSubscription(identity, provider)
            : null;
    if (!getSubscription) {
        if (config?.nodeEnv === 'production') {
            throw new AppError('Billing subscription state is unavailable.', { status: 503, code: 'BILLING_SUBSCRIPTION_STATE_UNAVAILABLE' });
        }
        return null;
    }
    return getSubscription();
}

function subscriptionBlocksCheckout(subscription) {
    if (!subscription) return false;
    const status = String(subscription.status || '').trim().toLowerCase();
    const accessState = String(subscription.accessState || subscription.access_state || '').trim().toLowerCase();
    return CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.has(status) || CHECKOUT_BLOCKING_ACCESS_STATES.has(accessState);
}

async function assertCheckoutSubscriptionAvailable({ store, config, provider, userId = null, workspaceId = null } = {}) {
    const subscription = await readStoredSubscription({ store, config, provider, userId, workspaceId });
    if (subscriptionBlocksCheckout(subscription)) {
        throw new AppError('This workspace already has a paid or active subscription.', {
            status: 409,
            code: 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE',
            details: { provider, status: subscription.status || null, accessState: subscription.accessState || subscription.access_state || null }
        });
    }
    return subscription;
}

async function readCheckoutAcceptance(store, { userId = null, workspaceId = null } = {}, acceptanceId) {
    if (!acceptanceId) return null;
    if (typeof store?.getCheckoutAcceptance === 'function') return store.getCheckoutAcceptance({ userId, workspaceId }, acceptanceId);
    if (store?.checkoutAcceptances && typeof store.checkoutAcceptances.values === 'function') {
        for (const acceptance of store.checkoutAcceptances.values()) {
            if (acceptance?.id === acceptanceId && (userId ? acceptance.userId === userId : acceptance.workspaceId === workspaceId)) return structuredClone(acceptance);
        }
    }
    if (typeof store?.pool?.query === 'function') {
        const result = await store.pool.query(
            `SELECT id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,idempotency_key AS "idempotencyKey",status,
                    provider_checkout_id AS "providerCheckoutId",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval"
             FROM wpa_checkout_acceptances WHERE ${userId ? 'user_id' : 'workspace_id'}=$1 AND id=$2`,
            [userId || workspaceId, acceptanceId]
        );
        return result.rows?.[0] || null;
    }
    return null;
}

async function resolveCheckoutIdentity({ config, store, provider, params, allowCompleted = false } = {}) {
    if (!params.acceptanceId) {
        if (config?.nodeEnv === 'production') {
            throw new AppError('A persisted checkout acceptance is required.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_REQUIRED' });
        }
        return params;
    }
    const acceptance = await readCheckoutAcceptance(store, { userId: params.userId, workspaceId: params.workspaceId }, params.acceptanceId);
    if (!acceptance) throw new AppError('The checkout acceptance could not be found.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_NOT_FOUND' });
    if (params.workspaceId && acceptance.workspaceId && params.workspaceId !== acceptance.workspaceId) {
        throw new AppError('The checkout retry belongs to another workspace.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_WORKSPACE_MISMATCH' });
    }
    if (acceptance.provider && String(acceptance.provider).toLowerCase() !== provider) {
        throw new AppError('The checkout acceptance belongs to another billing provider.', { status: 409, code: 'CHECKOUT_PROVIDER_MISMATCH' });
    }
    if (acceptance.planId && params.planId && acceptance.planId !== params.planId) {
        throw new AppError('The checkout retry does not match its persisted plan.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_PLAN_MISMATCH' });
    }
    if (acceptance.idempotencyKey && params.idempotencyKey && acceptance.idempotencyKey !== params.idempotencyKey) {
        throw new AppError('The checkout retry does not match its persisted idempotency key.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_KEY_MISMATCH' });
    }
    if (params.userId && acceptance.userId && params.userId !== acceptance.userId) {
        throw new AppError('The checkout retry belongs to another user.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_USER_MISMATCH' });
    }
    if (config?.nodeEnv === 'production' && !acceptance.userId) {
        throw new AppError('The checkout acceptance is missing its user owner.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_USER_MISSING' });
    }
    const acceptanceStatus = String(acceptance.status || '').toLowerCase();
    if (['expired', 'cancelled'].includes(acceptanceStatus) || (acceptanceStatus === 'completed' && !allowCompleted)) {
        throw new AppError('This checkout acceptance is no longer retryable.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_NOT_RETRYABLE' });
    }
    return {
        ...params,
        userId: acceptance.userId || params.userId || null,
        planId: acceptance.planId || params.planId,
        idempotencyKey: acceptance.idempotencyKey || params.idempotencyKey || acceptance.id,
        acceptance
    };
}

function assertCheckoutCatalogBinding({ config, provider, planId, acceptance } = {}) {
    if (!acceptance) return;
    const catalog = config?.billing?.[provider] || config?.[provider] || {};
    const configuredAmounts = catalog.amountMinor || catalog.amounts || {};
    const expectedAmount = configuredAmounts?.[planId];
    if (expectedAmount !== undefined && Number(acceptance.amountMinor) !== Number(expectedAmount)) {
        throw new AppError('The checkout acceptance amount does not match the provider catalog.', { status: 409, code: 'BILLING_CATALOG_AMOUNT_MISMATCH' });
    }
    const expectedCurrency = catalog.currency || catalog.currencyCode;
    if (expectedCurrency && String(acceptance.currency || '').toUpperCase() !== String(expectedCurrency).toUpperCase()) {
        throw new AppError('The checkout acceptance currency does not match the provider catalog.', { status: 409, code: 'BILLING_CATALOG_CURRENCY_MISMATCH' });
    }
}

function assertSelfServeCheckoutPlan(planId) {
    const salesMode = planSalesMode(planId);
    if (!salesMode) throw new AppError('Unknown billing plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
    if (salesMode !== 'self_serve') throw new AppError('This plan requires a sales or administrator assignment.', { status: 409, code: 'PLAN_CONTACT_REQUIRED', details: { planId, salesMode } });
    return salesMode;
}

module.exports = {
    BILLING_PROVIDER_METHODS,
    FREE_SUBSCRIPTION_STATUSES,
    PAID_SUBSCRIPTION_STATUSES,
    PRESERVE_SUBSCRIPTION_STATUSES,
    assertCheckoutCatalogBinding,
    assertCheckoutSubscriptionAvailable,
    assertSelfServeCheckoutPlan,
    assertBillingProvider,
    checkoutProviderIdempotencyKey,
    entitlementDecision,
    normalizeCheckoutInput,
    resolveCheckoutIdentity,
    unavailableProviderMethod
};
