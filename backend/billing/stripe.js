const crypto = require('node:crypto');
const Stripe = require('stripe');
const { AppError } = require('../lib/errors');
const {
    assertBillingProvider,
    assertCheckoutCatalogBinding,
    assertCheckoutSubscriptionAvailable,
    assertSelfServeCheckoutPlan,
    entitlementDecision,
    normalizeCheckoutInput,
    resolveCheckoutIdentity,
    unavailableProviderMethod
} = require('./provider');

function checkoutKey(userId, workspaceId, planId, subscriptionId, explicitKey, acceptanceId = null) {
    const commercialSubject = userId || workspaceId;
    const identity = acceptanceId
        ? `${commercialSubject}\0${workspaceId || ''}\0acceptance\0${acceptanceId}\0${explicitKey || ''}`
        : (explicitKey
            ? `${commercialSubject}\0${workspaceId || ''}\0${planId}\0client\0${explicitKey}`
            : `${commercialSubject}\0${workspaceId || ''}\0${planId}\0${subscriptionId || ''}`);
    const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40);
    return `wpa-checkout-${digest}`;
}

function stripeCatalog(config) {
    return config.billing?.stripe || config.stripe || {};
}

function expectedStripeLiveMode(config) {
    const secretKey = stripeCatalog(config).secretKey || '';
    if (secretKey.startsWith('sk_live_')) return true;
    if (secretKey.startsWith('sk_test_')) return false;
    return null;
}

function assertStripeWebhookEnvironment(event, config) {
    const catalog = stripeCatalog(config);
    const expectedLiveMode = expectedStripeLiveMode(config);
    if (config.nodeEnv === 'production' && (expectedLiveMode === null || typeof event.livemode !== 'boolean')) {
        throw new AppError('Stripe webhook environment could not be verified.', { status: 503, code: 'BILLING_PROVIDER_ENVIRONMENT_UNVERIFIED' });
    }
    if (typeof event.livemode === 'boolean' && expectedLiveMode !== null && event.livemode !== expectedLiveMode) {
        throw new AppError('Stripe webhook environment does not match the configured key.', { status: 400, code: 'BILLING_PROVIDER_ENVIRONMENT_MISMATCH' });
    }
    if (catalog.accountId && config.nodeEnv === 'production' && !event.account) {
        throw new AppError('Stripe webhook account could not be verified.', { status: 503, code: 'BILLING_PROVIDER_ACCOUNT_UNVERIFIED' });
    }
    if (catalog.accountId && event.account && catalog.accountId !== event.account) {
        throw new AppError('Stripe webhook account does not match the configured account.', { status: 400, code: 'BILLING_PROVIDER_ACCOUNT_MISMATCH' });
    }
}

function assertStripeCatalogPayload(object, planId, config) {
    const catalog = stripeCatalog(config);
    const item = object?.items?.data?.[0] || {};
    const price = item.price && typeof item.price === 'object' ? item.price : {};
    const priceId = String(price.id || item.price_id || '');
    const productId = String(price.product || item.product || '');
    const metadataPlanId = object?.metadata?.planId || null;
    if (metadataPlanId && planId && metadataPlanId !== planId) {
        throw new AppError('Stripe subscription metadata does not match its mapped price.', { status: 409, code: 'BILLING_CATALOG_PLAN_MISMATCH' });
    }
    const expectedPriceId = catalog.prices?.[planId];
    if (expectedPriceId && priceId !== expectedPriceId) {
        throw new AppError('Stripe subscription price does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_PRICE_MISMATCH' });
    }
    const expectedProductId = catalog.products?.[planId];
    if (expectedProductId && productId !== expectedProductId) {
        throw new AppError('Stripe subscription product does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_PRODUCT_MISMATCH' });
    }
    const expectedAmount = (catalog.amountMinor || catalog.amounts || {})[planId];
    if (expectedAmount !== undefined && Number(price.unit_amount) !== Number(expectedAmount)) {
        throw new AppError('Stripe subscription amount does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_AMOUNT_MISMATCH' });
    }
    const expectedCurrency = catalog.currency || catalog.currencyCode;
    if (expectedCurrency && String(price.currency || '').toUpperCase() !== String(expectedCurrency).toUpperCase()) {
        throw new AppError('Stripe subscription currency does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_CURRENCY_MISMATCH' });
    }
}

function createStripeService({ config, store, stripeClient = null, now = () => Date.now() }) {
    const stripeConfig = stripeCatalog(config);
    if (!stripeConfig?.secretKey) {
        const unavailable = unavailableProviderMethod('Stripe');
        return assertBillingProvider({
            provider: 'stripe',
            signatureHeaderName: 'stripe-signature',
            checkoutAcceptanceMode: 'persist_before_provider_call',
            enabled: false,
            createCheckout: unavailable,
            createCustomerPortal: unavailable,
            createPortal: unavailable,
            cancelSubscription: unavailable,
            getSubscription: unavailable,
            reconcileSubscription: unavailable,
            handleWebhook: unavailable,
            mapExternalProductToPlan: unavailable
        });
    }
    const stripe = stripeClient || new Stripe(stripeConfig.secretKey);
    const planForPrice = Object.fromEntries(Object.entries(stripeConfig.prices).filter(([, price]) => price).map(([plan, price]) => [price, plan]));
    const planForProduct = Object.fromEntries(Object.entries(stripeConfig.products || {}).filter(([, product]) => product).map(([plan, product]) => [product, plan]));
    const service = {
        provider: 'stripe',
        signatureHeaderName: 'stripe-signature',
        checkoutAcceptanceMode: 'persist_before_provider_call',
        enabled: true,
        mapExternalProductToPlan({ priceId = '', productId = '' } = {}) {
            const pricePlan = planForPrice[priceId] || null;
            const productPlan = planForProduct[productId] || null;
            if (pricePlan && productPlan && pricePlan !== productPlan) {
                throw new AppError('Stripe price and product map to different plans.', { status: 409, code: 'BILLING_CATALOG_PRODUCT_PRICE_MISMATCH' });
            }
            return pricePlan || productPlan || null;
        },
        async createCheckout(workspaceId, planId, explicitIdempotencyKey = null) {
            let params = normalizeCheckoutInput(workspaceId, planId, explicitIdempotencyKey);
            params = await resolveCheckoutIdentity({ config, store, provider: 'stripe', params });
            workspaceId = params.workspaceId;
            const userId = params.userId || null;
            planId = params.planId;
            explicitIdempotencyKey = params.idempotencyKey || null;
            assertSelfServeCheckoutPlan(planId);
            const price = stripeConfig.prices[planId];
            if (!price) throw new AppError('Checkout is not configured for this plan.', { status: 503, code: 'PLAN_CHECKOUT_NOT_CONFIGURED' });
            assertCheckoutCatalogBinding({ config, provider: 'stripe', planId, acceptance: params.acceptance });
            const subscription = await assertCheckoutSubscriptionAvailable({ store, config, provider: 'stripe', userId, workspaceId });
            const idempotencyKey = checkoutKey(
                userId,
                workspaceId,
                planId,
                subscription?.stripeSubscriptionId || subscription?.providerSubscriptionId,
                explicitIdempotencyKey,
                params.acceptanceId || null
            );
            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                line_items: [{ price, quantity: 1 }],
                client_reference_id: workspaceId,
                metadata: { ...(userId ? { userId } : {}), workspaceId, planId, ...(params.acceptanceId ? { acceptanceId: params.acceptanceId } : {}) },
                subscription_data: { metadata: { ...(userId ? { userId } : {}), workspaceId, planId, ...(params.acceptanceId ? { acceptanceId: params.acceptanceId } : {}) } },
                success_url: `${config.appUrl}/app?billing=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${config.appUrl}/app?billing=cancelled`
            }, { idempotencyKey });
            if (params.idempotencyKey && store?.markCheckoutAcceptance) {
                await store.markCheckoutAcceptance(userId ? { userId, workspaceId } : workspaceId, params.idempotencyKey, { status: 'checkout_created', providerCheckoutId: session.id });
            }
            return { id: session.id, url: session.url };
        },
        async createCustomerPortal(input) {
            const identity = input && typeof input === 'object' ? input : { workspaceId: input };
            const subscription = await store.getBillingSubscription?.(identity, 'stripe') || await store.getSubscription?.(identity);
            const customerId = subscription?.providerCustomerId || subscription?.stripeCustomerId;
            if (!customerId) throw new AppError('This workspace does not have a Stripe-managed subscription yet.', { status: 409, code: 'BILLING_SUBSCRIPTION_NOT_FOUND' });
            const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.appUrl}/app?billing=return` });
            return { provider: 'stripe', url: session.url };
        },
        async cancelSubscription(input) {
            const params = typeof input === 'object' && input !== null ? { ...input } : { subscriptionId: input };
            if (!params.subscriptionId && (params.userId || params.workspaceId)) {
                const stored = await service.getSubscription({ userId: params.userId, workspaceId: params.workspaceId });
                params.subscriptionId = stored?.providerSubscriptionId || stored?.stripeSubscriptionId || null;
            }
            if (!params.subscriptionId) throw new AppError('A Stripe subscription id is required.', { status: 400, code: 'BILLING_SUBSCRIPTION_ID_REQUIRED' });
            const subscription = params.immediately
                ? await stripe.subscriptions.cancel(params.subscriptionId)
                : await stripe.subscriptions.update(params.subscriptionId, { cancel_at_period_end: true });
            return {
                provider: 'stripe',
                providerSubscriptionId: subscription.id,
                status: subscription.status,
                scheduledChange: subscription.cancel_at_period_end
                    ? { action: 'cancel', effectiveAt: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null }
                    : null
            };
        },
        async getSubscription(input) {
            const params = typeof input === 'object' ? input : { subscriptionId: input };
            if (params.subscriptionId) return stripe.subscriptions.retrieve(params.subscriptionId);
            const identity = params.userId ? { userId: params.userId, workspaceId: params.workspaceId } : params.workspaceId;
            if ((params.userId || params.workspaceId) && store?.getBillingSubscription) return store.getBillingSubscription(identity, 'stripe');
            if (params.userId || params.workspaceId) return store.getSubscription?.(identity) || null;
            return null;
        },
        async reconcileSubscription(input) {
            const params = typeof input === 'object' && input !== null ? { ...input } : { workspaceId: input };
            if (!params.userId && !params.workspaceId) throw new AppError('A user or workspace is required for billing reconciliation.', { status: 400, code: 'BILLING_USER_MISSING' });
            if (!params.subscriptionId) {
                const stored = await service.getSubscription({ userId: params.userId, workspaceId: params.workspaceId });
                params.subscriptionId = stored?.providerSubscriptionId || stored?.stripeSubscriptionId || null;
                params.userId ||= stored?.userId || null;
                params.workspaceId ||= stored?.workspaceId || null;
            }
            if (!params.subscriptionId) throw new AppError('A Stripe subscription id is required.', { status: 400, code: 'BILLING_SUBSCRIPTION_ID_REQUIRED' });
            const object = await stripe.subscriptions.retrieve(params.subscriptionId);
            const priceId = object.items?.data?.[0]?.price?.id || '';
            const productId = String(object.items?.data?.[0]?.price?.product || '');
            const planId = service.mapExternalProductToPlan({ priceId, productId });
            assertStripeCatalogPayload(object, planId, config);
            const status = String(object.status || '').toLowerCase();
            const scheduledChange = object.cancel_at_period_end ? { action: 'cancel', effectiveAt: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null } : null;
            const entitlement = entitlementDecision({ status, planId, scheduledChange, freePlanId: 'free' });
            if (entitlement.action === 'set_plan' && entitlement.access === 'paid' && !planId) throw new AppError('Stripe price is not mapped to a plan.', { status: 409, code: 'BILLING_PRICE_UNMAPPED' });
            const occurredAt = params.occurredAt ? new Date(params.occurredAt).toISOString() : new Date(now()).toISOString();
            const reconciliationKey = JSON.stringify({ id: object.id, status, period: object.current_period_end || null, cancelAtPeriodEnd: Boolean(object.cancel_at_period_end), priceId });
            const dto = {
                provider: 'stripe', eventId: `reconcile_stripe_${crypto.createHash('sha256').update(reconciliationKey).digest('hex').slice(0, 32)}`,
                eventType: 'subscription.reconciled', occurredAt, occurredAtMs: Date.parse(occurredAt), externalObjectId: object.id,
                userId: params.userId || object.metadata?.userId || null,
                workspaceId: params.workspaceId || object.metadata?.workspaceId || null, resourceKind: 'subscription', rawEvent: { reconciliation: true, subscription: object },
                subscription: {
                    providerCustomerId: String(object.customer || ''), providerSubscriptionId: object.id,
                    providerPriceId: priceId, providerProductId: String(object.items?.data?.[0]?.price?.product || ''),
                    status, currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
                    scheduledChange
                },
                entitlement
            };
            if (!store?.applyBillingProviderEvent) return { reconciled: false, applied: false, event: dto };
            const result = await store.applyBillingProviderEvent(dto);
            return { reconciled: true, applied: Boolean(result?.applied), duplicate: Boolean(result?.duplicate), ignored: Boolean(result?.ignored), event: dto };
        },
        async handleWebhook(rawBody, signature) {
            if (!stripeConfig.webhookSecret) throw new AppError('Stripe webhooks are not configured.', { status: 503, code: 'BILLING_WEBHOOK_NOT_CONFIGURED' });
            let event;
            try { event = stripe.webhooks.constructEvent(rawBody, signature, stripeConfig.webhookSecret); }
            catch (cause) { throw new AppError('Invalid Stripe webhook signature.', { status: 400, code: 'INVALID_WEBHOOK_SIGNATURE', cause }); }
            assertStripeWebhookEnvironment(event, config);
            if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
                return { received: true, applied: false };
            }
            const object = event.data.object;
            const workspaceId = object.metadata?.workspaceId;
            if (!workspaceId) throw new AppError('Stripe subscription is missing its workspace reference.', { status: 400, code: 'BILLING_WORKSPACE_MISSING' });
            const priceId = object.items?.data?.[0]?.price?.id || '';
            const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(object.status || '').toLowerCase();
            const productId = String(object.items?.data?.[0]?.price?.product || '');
            const planId = service.mapExternalProductToPlan({ priceId, productId });
            assertStripeCatalogPayload(object, planId, config);
            let checkoutIdentity = null;
            if (object.metadata?.acceptanceId && event.type !== 'customer.subscription.deleted') {
                checkoutIdentity = await resolveCheckoutIdentity({
                    config,
                    store,
                    provider: 'stripe',
                    allowCompleted: true,
                    params: { objectInput: true, userId: object.metadata?.userId || null, workspaceId, planId, acceptanceId: object.metadata.acceptanceId }
                });
            }
            const userId = checkoutIdentity?.userId || object.metadata?.userId || null;
            const scheduledChange = object.cancel_at_period_end ? { action: 'cancel', effectiveAt: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null } : null;
            const entitlement = entitlementDecision({ status, planId, scheduledChange, freePlanId: 'free' });
            if (entitlement.action === 'set_plan' && entitlement.access === 'paid' && !planId) throw new AppError('Stripe price is not mapped to a plan.', { status: 409, code: 'BILLING_PRICE_UNMAPPED' });
            if (typeof store.applyBillingProviderEvent === 'function') {
                const result = await store.applyBillingProviderEvent({
                    provider: 'stripe', eventId: event.id, eventType: event.type,
                    occurredAt: new Date(event.created * 1000).toISOString(), occurredAtMs: event.created * 1000,
                    externalObjectId: object.id, userId, workspaceId, resourceKind: 'subscription', rawEvent: event,
                    subscription: {
                        providerCustomerId: String(object.customer || ''), providerSubscriptionId: object.id,
                        providerPriceId: priceId, providerProductId: String(object.items?.data?.[0]?.price?.product || ''),
                        status, currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
                        scheduledChange
                    },
                    entitlement
                });
                if (checkoutIdentity?.acceptance?.idempotencyKey && entitlement.access === 'paid' && !result.ignored) {
                    await store.markCheckoutAcceptance?.(userId ? { userId, workspaceId } : workspaceId, checkoutIdentity.acceptance.idempotencyKey, { status: 'completed', providerCheckoutId: checkoutIdentity.acceptance.providerCheckoutId || null });
                }
                return { received: true, applied: Boolean(result.applied), duplicate: Boolean(result.duplicate), ignored: Boolean(result.ignored), planId: entitlement.action === 'set_plan' ? entitlement.planId : null };
            }
            await store.ensureWorkspace(workspaceId);
            const ledger = await store.recordBillingEvent?.(workspaceId, { ...event, userId });
            if (ledger && !ledger.accepted) return { received: true, applied: false, duplicate: true };
            try {
                const result = await store.applySubscriptionEvent(workspaceId, {
                    userId,
                    stripeCustomerId: String(object.customer || ''),
                    stripeSubscriptionId: object.id,
                    stripePriceId: priceId,
                    status,
                    currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null
                }, event);
                if (result.applied && entitlement.action === 'set_plan') {
                    const entitlementUserId = userId || result.subscription?.userId || await store.resolveEntitlementUser?.(workspaceId, null);
                    if (!entitlementUserId) throw new AppError('Stripe subscription is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
                    await store.assignUserPlan(entitlementUserId, entitlement.planId || 'free', {
                        actorId: 'stripe:webhook', source: 'provider', sourceId: event.id,
                        reason: entitlement.reason, requestId: event.id,
                        idempotencyKey: `stripe:${event.id}`, requestFingerprint: `stripe:${event.id}:${entitlement.planId || 'free'}`
                    });
                }
                await store.markBillingEvent?.(event.id, result.applied ? 'applied' : 'ignored');
                return { received: true, applied: result.applied, planId: entitlement.action === 'set_plan' ? entitlement.planId : null };
            } catch (error) {
                try { await store.markBillingEvent?.(event.id, 'failed'); } catch { /* preserve the original webhook failure */ }
                throw error;
            }
        }
    };
    service.createPortal = service.createCustomerPortal;
    return assertBillingProvider(service);
}

module.exports = { createStripeService };
