const { AppError } = require('../lib/errors');
const { createDisabledBillingProvider } = require('./disabled');
const { createPaddleProvider } = require('./paddle');
const { createStripeService } = require('./stripe');

function configuredProviderName(config) {
    if (config?.billing?.paymentsEnabled === false) return 'disabled';
    const explicit = String(config?.billing?.provider || '').trim().toLowerCase();
    if (explicit) return explicit;
    if (config?.billing?.paddle?.apiKey || config?.paddle?.apiKey) return 'paddle';
    return 'stripe';
}

function createBillingProvider({ config, store, paddleClient = null, stripeClient = null, now } = {}) {
    const providerName = configuredProviderName(config);
    if (providerName === 'disabled') return createDisabledBillingProvider({ store });
    if (providerName === 'paddle') return createPaddleProvider({ config, store, paddleClient, ...(now ? { now } : {}) });
    if (providerName === 'stripe') return createStripeService({ config, store, stripeClient, ...(now ? { now } : {}) });
    throw new AppError(`Unsupported billing provider '${providerName}'.`, { status: 500, code: 'BILLING_PROVIDER_INVALID', expose: false });
}

module.exports = { configuredProviderName, createBillingProvider };
