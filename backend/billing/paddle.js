const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const {
    assertBillingProvider,
    assertCheckoutCatalogBinding,
    assertCheckoutSubscriptionAvailable,
    assertSelfServeCheckoutPlan,
    checkoutProviderIdempotencyKey,
    entitlementDecision,
    normalizeCheckoutInput,
    resolveCheckoutIdentity,
    unavailableProviderMethod
} = require('./provider');

const SUBSCRIPTION_EVENTS = new Set([
    'subscription.created',
    'subscription.updated',
    'subscription.canceled',
    'subscription.cancelled',
    'subscription.paused',
    'subscription.resumed'
]);

function parseSignatureHeader(header) {
    const parsed = { timestamp: null, signatures: [] };
    for (const part of String(header || '').split(';')) {
        const [key, value] = part.trim().split('=', 2);
        if (key === 'ts' && /^\d+$/.test(value || '')) parsed.timestamp = Number(value);
        if (key === 'h1' && /^[a-f\d]{64}$/i.test(value || '')) parsed.signatures.push(value.toLowerCase());
    }
    return parsed;
}

function safeHexEqual(leftHex, rightHex) {
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyPaddleSignature(rawBody, signatureHeader, secret, {
    now = () => Date.now(),
    toleranceSeconds = 5
} = {}) {
    if (!secret) {
        throw new AppError('Paddle webhooks are not configured.', {
            status: 503,
            code: 'BILLING_WEBHOOK_NOT_CONFIGURED'
        });
    }
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
        throw new AppError('Paddle webhook verification requires the raw request body.', {
            status: 400,
            code: 'BILLING_RAW_BODY_REQUIRED'
        });
    }
    const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
    const currentSeconds = Math.floor(now() / 1000);
    if (!timestamp || signatures.length === 0
        || !Number.isFinite(toleranceSeconds)
        || toleranceSeconds < 0
        || Math.abs(currentSeconds - timestamp) > toleranceSeconds) {
        throw new AppError('Invalid or expired Paddle webhook signature.', {
            status: 400,
            code: 'INVALID_WEBHOOK_SIGNATURE'
        });
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}:${body}`, 'utf8').digest('hex');
    if (!signatures.some((signature) => safeHexEqual(signature, expected))) {
        throw new AppError('Invalid Paddle webhook signature.', {
            status: 400,
            code: 'INVALID_WEBHOOK_SIGNATURE'
        });
    }
    return { timestamp, rawBody: body };
}

function normalizeDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function firstSubscriptionItem(data) {
    return Array.isArray(data?.items) ? data.items[0] || null : null;
}

function externalProductIds(data) {
    const item = firstSubscriptionItem(data);
    return {
        priceId: String(item?.price?.id || item?.price_id || data?.price_id || ''),
        productId: String(item?.price?.product_id || item?.product?.id || data?.product_id || '')
    };
}

function workspaceReference(data) {
    return data?.custom_data?.workspaceId
        || data?.custom_data?.workspace_id
        || data?.customData?.workspaceId
        || data?.metadata?.workspaceId
        || null;
}

function userReference(data) {
    return data?.custom_data?.userId
        || data?.custom_data?.user_id
        || data?.customData?.userId
        || data?.metadata?.userId
        || null;
}

function acceptanceReference(data) {
    return data?.custom_data?.acceptanceId
        || data?.custom_data?.acceptance_id
        || data?.customData?.acceptanceId
        || data?.metadata?.acceptanceId
        || null;
}

function mapPaddleEvent(event, mapExternalProductToPlan, { freePlanId = 'free', validateCatalog = null } = {}) {
    const eventId = String(event?.event_id || event?.eventId || event?.id || '');
    const eventType = String(event?.event_type || event?.eventType || event?.type || '');
    const occurredAt = normalizeDate(event?.occurred_at || event?.occurredAt || event?.created_at);
    if (!eventId || !eventType || !occurredAt) {
        throw new AppError('Paddle webhook event is missing its identity, type, or occurrence time.', {
            status: 400,
            code: 'BILLING_EVENT_INVALID'
        });
    }
    const data = event?.data || {};
    const common = {
        provider: 'paddle',
        eventId,
        eventType,
        occurredAt,
        occurredAtMs: Date.parse(occurredAt),
        externalObjectId: String(data.id || ''),
        userId: userReference(data),
        workspaceId: workspaceReference(data),
        acceptanceId: acceptanceReference(data),
        rawEvent: event
    };

    if (SUBSCRIPTION_EVENTS.has(eventType)) {
        const { priceId, productId } = externalProductIds(data);
        const planId = mapExternalProductToPlan({ productId, priceId });
        validateCatalog?.({ data, planId, priceId, productId });
        const status = String(data.status || (eventType.includes('cancel') ? 'canceled' : '')).toLowerCase();
        const scheduled = data.scheduled_change || data.scheduledChange || null;
        const scheduledChange = scheduled ? {
            action: String(scheduled.action || ''),
            effectiveAt: normalizeDate(scheduled.effective_at || scheduled.effectiveAt)
        } : null;
        const decision = entitlementDecision({ status, planId, scheduledChange, freePlanId });
        if (decision.action === 'set_plan' && decision.access === 'paid' && !planId) {
            throw new AppError('Paddle product or price is not mapped to a plan.', {
                status: 409,
                code: 'BILLING_PRODUCT_UNMAPPED'
            });
        }
        if (!common.workspaceId) {
            throw new AppError('Paddle subscription is missing its workspace reference.', {
                status: 400,
                code: 'BILLING_WORKSPACE_MISSING'
            });
        }
        return {
            ...common,
            resourceKind: 'subscription',
            subscription: {
                providerCustomerId: String(data.customer_id || data.customerId || ''),
                providerSubscriptionId: String(data.id || ''),
                providerPriceId: priceId,
                providerProductId: productId,
                status,
                currentPeriodEnd: normalizeDate(data.current_billing_period?.ends_at || data.currentBillingPeriod?.endsAt),
                scheduledChange
            },
            entitlement: decision
        };
    }

    if (eventType.startsWith('transaction.')) {
        return {
            ...common,
            resourceKind: 'payment',
            payment: {
                providerTransactionId: String(data.id || ''),
                providerCustomerId: String(data.customer_id || data.customerId || ''),
                providerSubscriptionId: String(data.subscription_id || data.subscriptionId || ''),
                status: String(data.status || ''),
                currencyCode: String(data.currency_code || data.currencyCode || ''),
                total: String(data.details?.totals?.total || data.details?.totals?.grand_total || ''),
                invoiceNumber: data.invoice_number || data.invoiceNumber || null
            }
        };
    }

    if (eventType.startsWith('adjustment.')) {
        return {
            ...common,
            resourceKind: 'refund',
            refund: {
                providerAdjustmentId: String(data.id || ''),
                providerTransactionId: String(data.transaction_id || data.transactionId || ''),
                action: String(data.action || ''),
                status: String(data.status || ''),
                reason: String(data.reason || ''),
                currencyCode: String(data.currency_code || data.currencyCode || ''),
                amount: String(data.totals?.total || data.amount || '')
            }
        };
    }

    return { ...common, resourceKind: 'ignored' };
}

function configuredPaddle(config) {
    return config?.billing?.paddle || config?.paddle || {};
}

function assertPaddleWebhookEnvironment(event, config) {
    const paddle = configuredPaddle(config);
    const environment = String(paddle.environment || '').toLowerCase();
    if (config.nodeEnv === 'production' && environment !== 'production') {
        throw new AppError('Paddle webhook environment is not configured for production.', { status: 503, code: 'BILLING_PROVIDER_ENVIRONMENT_UNVERIFIED' });
    }
    const incomingEnvironment = event.environment || event.data?.environment
        || (typeof event.livemode === 'boolean' ? (event.livemode ? 'production' : 'sandbox') : null);
    if (incomingEnvironment && environment && String(incomingEnvironment).toLowerCase() !== environment) {
        throw new AppError('Paddle webhook environment does not match the configured environment.', { status: 400, code: 'BILLING_PROVIDER_ENVIRONMENT_MISMATCH' });
    }
    const expectedAccount = paddle.accountId || paddle.sellerId || paddle.businessId || null;
    const incomingAccount = event.account_id || event.accountId || event.data?.account_id || event.data?.accountId
        || event.data?.seller_id || event.data?.sellerId || event.data?.business_id || event.data?.businessId || null;
    if (expectedAccount && config.nodeEnv === 'production' && !incomingAccount) {
        throw new AppError('Paddle webhook account could not be verified.', { status: 503, code: 'BILLING_PROVIDER_ACCOUNT_UNVERIFIED' });
    }
    if (expectedAccount && incomingAccount && String(expectedAccount) !== String(incomingAccount)) {
        throw new AppError('Paddle webhook account does not match the configured account.', { status: 400, code: 'BILLING_PROVIDER_ACCOUNT_MISMATCH' });
    }
}

function assertPaddleCatalogPayload({ data, planId, priceId, productId, catalog }) {
    if (!planId) return;
    const expectedPriceId = catalog.prices?.[planId];
    if (expectedPriceId && priceId !== expectedPriceId) {
        throw new AppError('Paddle subscription price does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_PRICE_MISMATCH' });
    }
    const expectedProductId = catalog.products?.[planId];
    if (catalog.strictCatalogValidation === true && expectedProductId && productId !== expectedProductId) {
        throw new AppError('Paddle subscription product does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_PRODUCT_MISMATCH' });
    }
    const item = firstSubscriptionItem(data);
    const price = item?.price && typeof item.price === 'object' ? item.price : {};
    const expectedAmount = (catalog.amountMinor || catalog.amounts || {})[planId];
    const actualAmount = price.unit_price?.amount ?? price.unitPrice?.amount ?? price.amount ?? data.amount;
    if (expectedAmount !== undefined && Number(actualAmount) !== Number(expectedAmount)) {
        throw new AppError('Paddle subscription amount does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_AMOUNT_MISMATCH' });
    }
    const expectedCurrency = catalog.currency || catalog.currencyCode;
    const actualCurrency = price.unit_price?.currency_code || price.unitPrice?.currencyCode || price.currency_code || data.currency_code;
    if (expectedCurrency && String(actualCurrency || '').toUpperCase() !== String(expectedCurrency).toUpperCase()) {
        throw new AppError('Paddle subscription currency does not match the configured catalog.', { status: 409, code: 'BILLING_CATALOG_CURRENCY_MISMATCH' });
    }
}

function createPaddleHttpClient({ apiKey, environment = 'production', timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey || typeof fetchImpl !== 'function') return null;
    const baseUrl = environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    async function request(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(idempotencyKey ? { 'Paddle-Idempotency-Key': idempotencyKey } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 10_000))
        });
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        if (!response.ok || !payload?.data) throw new AppError('Paddle API request failed.', { status: 502, code: 'BILLING_PROVIDER_ERROR', details: { provider: 'paddle', httpStatus: response.status } });
        return payload.data;
    }
    return {
        transactions: {
            create(input, options = {}) {
                return request('/transactions', {
                    method: 'POST', idempotencyKey: options.idempotencyKey,
                    body: {
                        items: input.items.map((item) => ({ price_id: item.priceId, quantity: item.quantity })),
                        custom_data: input.customData,
                        ...(input.checkout ? { checkout: input.checkout } : {})
                    }
                });
            }
        },
        customerPortalSessions: {
            create(customerId) { return request(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, { method: 'POST', body: {} }); }
        },
        subscriptions: {
            cancel(subscriptionId, input) { return request(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { method: 'POST', body: { effective_from: input.effectiveFrom } }); },
            get(subscriptionId) { return request(`/subscriptions/${encodeURIComponent(subscriptionId)}`); }
        }
    };
}

function createPaddleProvider({ config, store = null, paddleClient = null, now = () => Date.now() }) {
    const paddle = configuredPaddle(config);
    paddleClient ||= createPaddleHttpClient({ apiKey: paddle.apiKey, environment: paddle.environment, timeoutMs: paddle.timeoutMs });
    const priceMap = { ...(paddle.prices || {}) };
    const productMap = { ...(paddle.products || {}) };
    const planForPrice = Object.fromEntries(Object.entries(priceMap).filter(([, id]) => id).map(([plan, id]) => [id, plan]));
    const planForProduct = Object.fromEntries(Object.entries(productMap).filter(([, id]) => id).map(([plan, id]) => [id, plan]));

    const mapExternalProductToPlan = ({ productId = '', priceId = '' } = {}) => {
        const pricePlan = planForPrice[priceId] || null;
        const productPlan = planForProduct[productId] || null;
        if (paddle.strictCatalogValidation === true && pricePlan && productPlan && pricePlan !== productPlan) {
            throw new AppError('Paddle price and product map to different plans.', { status: 409, code: 'BILLING_CATALOG_PRODUCT_PRICE_MISMATCH' });
        }
        return pricePlan || productPlan || null;
    };
    const validateCatalog = ({ data, planId, priceId, productId }) => assertPaddleCatalogPayload({ data, planId, priceId, productId, catalog: paddle });
    const unavailable = unavailableProviderMethod('Paddle');

    const provider = {
        provider: 'paddle',
        signatureHeaderName: 'paddle-signature',
        checkoutAcceptanceMode: 'persist_before_provider_call',
        enabled: Boolean(paddle.apiKey && paddleClient),
        mapExternalProductToPlan,
        async createCheckout(input, legacyPlanId = null, legacyIdempotencyKey = null) {
            if (!paddle.apiKey || !paddleClient) return unavailable();
            let params = normalizeCheckoutInput(input, legacyPlanId, legacyIdempotencyKey);
            params = await resolveCheckoutIdentity({ config, store, provider: 'paddle', params });
            assertSelfServeCheckoutPlan(params.planId);
            const priceId = priceMap[params.planId];
            if (!priceId) {
                throw new AppError('Checkout is not configured for this plan.', {
                    status: 503,
                    code: 'PLAN_CHECKOUT_NOT_CONFIGURED'
                });
            }
            assertCheckoutCatalogBinding({ config, provider: 'paddle', planId: params.planId, acceptance: params.acceptance });
            const subscription = await assertCheckoutSubscriptionAvailable({ store, config, provider: 'paddle', userId: params.userId || null, workspaceId: params.workspaceId });
            const idempotencyKey = params.acceptanceId
                ? checkoutProviderIdempotencyKey('paddle', {
                    userId: params.userId || null,
                    workspaceId: params.workspaceId,
                    planId: params.planId,
                    subscriptionId: subscription?.providerSubscriptionId || subscription?.paddleSubscriptionId,
                    acceptanceId: params.acceptanceId,
                    clientKey: params.idempotencyKey
                })
                : params.idempotencyKey || null;
            const transaction = await paddleClient.transactions.create({
                items: [{ priceId, quantity: 1 }],
                customData: { ...(params.userId ? { userId: params.userId } : {}), workspaceId: params.workspaceId, planId: params.planId, ...(params.acceptanceId ? { acceptanceId: params.acceptanceId } : {}) },
                checkout: { url: params.checkoutUrl || `${config.appUrl}/app?billing=checkout` }
            }, idempotencyKey ? { idempotencyKey } : undefined);
            if (params.idempotencyKey && store?.markCheckoutAcceptance) {
                await store.markCheckoutAcceptance(params.userId ? { userId: params.userId, workspaceId: params.workspaceId } : params.workspaceId, params.idempotencyKey, { status: 'checkout_created', providerCheckoutId: transaction.id });
            }
            return {
                provider: 'paddle',
                id: transaction.id,
                url: transaction.checkout?.url || transaction.checkout_url || null,
                status: transaction.status || null
            };
        },
        async createCustomerPortal(input) {
            if (!paddle.apiKey || !paddleClient) return unavailable();
            const identity = typeof input === 'object' ? input : { workspaceId: input };
            const subscription = await provider.getSubscription(identity);
            const customerId = subscription?.providerCustomerId || subscription?.paddleCustomerId;
            if (!customerId) {
                throw new AppError('This workspace does not have a Paddle-managed subscription yet.', {
                    status: 409,
                    code: 'BILLING_SUBSCRIPTION_NOT_FOUND'
                });
            }
            const session = await paddleClient.customerPortalSessions.create(customerId);
            return { provider: 'paddle', url: session.urls?.general?.overview || session.url, expiresAt: session.expiresAt || null };
        },
        async cancelSubscription(input) {
            if (!paddle.apiKey || !paddleClient) return unavailable();
            const params = typeof input === 'object' && input !== null ? { ...input } : { subscriptionId: input };
            if (!params.subscriptionId && (params.userId || params.workspaceId)) {
                const stored = await provider.getSubscription({ userId: params.userId, workspaceId: params.workspaceId });
                params.subscriptionId = stored?.providerSubscriptionId || stored?.paddleSubscriptionId || null;
            }
            if (!params.subscriptionId) throw new AppError('A Paddle subscription id is required.', { status: 400, code: 'BILLING_SUBSCRIPTION_ID_REQUIRED' });
            const effectiveFrom = params.immediately ? 'immediately' : 'next_billing_period';
            const subscription = await paddleClient.subscriptions.cancel(params.subscriptionId, { effectiveFrom });
            return {
                provider: 'paddle',
                providerSubscriptionId: subscription.id,
                status: subscription.status,
                scheduledChange: subscription.scheduledChange || subscription.scheduled_change || null
            };
        },
        async getSubscription(input) {
            const params = typeof input === 'object' ? input : { subscriptionId: input };
            if (params.subscriptionId) {
                if (!paddle.apiKey || !paddleClient) return unavailable();
                return paddleClient.subscriptions.get(params.subscriptionId);
            }
            const identity = params.userId ? { userId: params.userId, workspaceId: params.workspaceId } : params.workspaceId;
            if ((params.userId || params.workspaceId) && store?.getBillingSubscription) {
                return store.getBillingSubscription(identity, 'paddle');
            }
            if ((params.userId || params.workspaceId) && store?.getSubscription) return store.getSubscription(identity);
            return null;
        },
        async reconcileSubscription(input) {
            if (!paddle.apiKey || !paddleClient) return unavailable();
            const params = typeof input === 'object' && input !== null ? { ...input } : { workspaceId: input };
            if (!params.userId && !params.workspaceId) throw new AppError('A user or workspace is required for billing reconciliation.', { status: 400, code: 'BILLING_USER_MISSING' });
            if (!params.subscriptionId) {
                const stored = await provider.getSubscription({ userId: params.userId, workspaceId: params.workspaceId });
                params.subscriptionId = stored?.providerSubscriptionId || stored?.paddleSubscriptionId || null;
                params.userId ||= stored?.userId || null;
                params.workspaceId ||= stored?.workspaceId || null;
            }
            if (!params.subscriptionId) throw new AppError('A Paddle subscription id is required.', { status: 400, code: 'BILLING_SUBSCRIPTION_ID_REQUIRED' });
            const subscription = await paddleClient.subscriptions.get(params.subscriptionId);
            const occurredAt = normalizeDate(subscription.updated_at || subscription.updatedAt || params.occurredAt) || new Date(now()).toISOString();
            const reconciliationKey = JSON.stringify({ id: subscription.id, status: subscription.status, period: subscription.current_billing_period || subscription.currentBillingPeriod || null, scheduled: subscription.scheduled_change || subscription.scheduledChange || null });
            const eventId = `reconcile_paddle_${crypto.createHash('sha256').update(reconciliationKey).digest('hex').slice(0, 32)}`;
            const dto = mapPaddleEvent({
                event_id: eventId,
                event_type: 'subscription.updated',
                occurred_at: occurredAt,
                data: {
                    ...subscription,
                    custom_data: { ...(subscription.custom_data || {}), ...(params.userId ? { userId: params.userId } : {}), workspaceId: params.workspaceId }
                }
            }, mapExternalProductToPlan, { freePlanId: paddle.freePlanId || 'free', validateCatalog });
            if (!store?.applyBillingProviderEvent) return { reconciled: false, applied: false, event: dto };
            const result = await store.applyBillingProviderEvent(dto);
            return { reconciled: true, applied: Boolean(result?.applied), duplicate: Boolean(result?.duplicate), ignored: Boolean(result?.ignored), event: dto };
        },
        async handleWebhook(rawBody, signatureHeader) {
            const verified = verifyPaddleSignature(rawBody, signatureHeader, paddle.webhookSecret, {
                now,
                toleranceSeconds: paddle.webhookToleranceSeconds ?? 5
            });
            let event;
            try {
                event = JSON.parse(verified.rawBody);
            } catch (cause) {
                throw new AppError('Paddle webhook body is not valid JSON.', {
                    status: 400,
                    code: 'BILLING_EVENT_INVALID',
                    cause
                });
            }
            assertPaddleWebhookEnvironment(event, config);
            const dto = mapPaddleEvent(event, mapExternalProductToPlan, { freePlanId: paddle.freePlanId || 'free', validateCatalog });
            let checkoutIdentity = null;
            if (dto.acceptanceId && dto.resourceKind === 'subscription' && dto.entitlement?.access !== 'free') {
                checkoutIdentity = await resolveCheckoutIdentity({
                    config,
                    store,
                    provider: 'paddle',
                    allowCompleted: true,
                    params: { objectInput: true, userId: dto.userId || null, workspaceId: dto.workspaceId, planId: dto.entitlement?.planId || null, acceptanceId: dto.acceptanceId }
                });
            }
            if (checkoutIdentity?.userId) dto.userId = checkoutIdentity.userId;
            if (dto.resourceKind === 'ignored') return { received: true, applied: false, event: dto };
            if (!store?.applyBillingProviderEvent) return { received: true, applied: false, event: dto };
            const result = await store.applyBillingProviderEvent(dto);
            if (checkoutIdentity?.acceptance?.idempotencyKey && dto.entitlement?.access === 'paid' && !result?.ignored) {
                await store.markCheckoutAcceptance?.(dto.userId ? { userId: dto.userId, workspaceId: dto.workspaceId } : dto.workspaceId, checkoutIdentity.acceptance.idempotencyKey, { status: 'completed', providerCheckoutId: checkoutIdentity.acceptance.providerCheckoutId || null });
            }
            return {
                received: true,
                applied: Boolean(result?.applied),
                duplicate: Boolean(result?.duplicate),
                ignored: Boolean(result?.ignored),
                event: dto
            };
        }
    };
    provider.createPortal = provider.createCustomerPortal;
    return assertBillingProvider(provider);
}

module.exports = {
    createPaddleHttpClient,
    createPaddleProvider,
    mapPaddleEvent,
    parseSignatureHeader,
    verifyPaddleSignature
};
