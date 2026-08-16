const { AppError } = require('../lib/errors');
const { assertBillingProvider } = require('./provider');

function paymentsDisabledError() {
    return new AppError('Paid billing is disabled during early access. Use a redeem code or an administrator grant.', {
        status: 409,
        code: 'PAYMENTS_DISABLED',
        expose: true
    });
}

async function unavailable() {
    throw paymentsDisabledError();
}

function createDisabledBillingProvider({ store } = {}) {
    return assertBillingProvider({
        provider: 'disabled',
        paymentsEnabled: false,
        signatureHeaderName: 'paddle-signature',
        checkoutAcceptanceMode: 'disabled',
        createCheckout: unavailable,
        createCustomerPortal: unavailable,
        cancelSubscription: unavailable,
        async getSubscription({ userId = null, workspaceId = null } = {}) {
            if (typeof store?.getSubscription !== 'function') return null;
            return store.getSubscription(userId ? { userId, workspaceId } : workspaceId);
        },
        reconcileSubscription: unavailable,
        handleWebhook: unavailable,
        mapExternalProductToPlan() { return null; }
    });
}

module.exports = { createDisabledBillingProvider, paymentsDisabledError };
