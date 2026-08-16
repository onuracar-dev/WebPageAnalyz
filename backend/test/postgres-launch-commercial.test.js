const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');

const connectionString = process.env.TEST_DATABASE_URL;

function providerEvent(userId, workspaceId, eventId, occurredAtMs, status, planId, action, access) {
    return {
        provider: 'paddle',
        eventId,
        eventType: 'subscription.updated',
        occurredAt: new Date(occurredAtMs).toISOString(),
        occurredAtMs,
        externalObjectId: `sub_${workspaceId}`,
        userId,
        workspaceId,
        resourceKind: 'subscription',
        rawEvent: { event_id: eventId },
        subscription: {
            providerCustomerId: `ctm_${workspaceId}`,
            providerSubscriptionId: `sub_${workspaceId}`,
            providerPriceId: `pri_${planId || 'studio'}`,
            providerProductId: `pro_${planId || 'studio'}`,
            status,
            currentPeriodEnd: '2030-01-01T00:00:00.000Z'
        },
        entitlement: { action, planId, access, reason: status }
    };
}

test('PostgreSQL launch schema executes checkout, legal, authorization, redeem and AI contracts', {
    skip: !connectionString && 'TEST_DATABASE_URL is not configured'
}, async () => {
    const store = new PostgresPlatformStore(connectionString);
    const suffix = crypto.randomUUID();
    const workspaceId = `ws_launch_${suffix}`;
    const userId = `user_launch_${suffix}`;
    let redeemId;
    try {
        await store.pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [userId, 'Launch User', `${userId}@example.test`]);
        const workspace = await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
        assert.equal(workspace.planId, 'free');
        const studio = await store.getPlan('studio');
        const enterprise = await store.getPlan('enterprise');
        assert.equal(studio.limits.seats, 5);
        assert.equal(enterprise.limits.seats, 15);
        assert.equal(studio.entitlements.monitoring, undefined);
        assert.equal(studio.entitlements.white_label, undefined);
        assert.equal(enterprise.entitlements.expert_review, undefined);
        assert.equal(JSON.stringify([studio.features, enterprise.features]).match(/monitoring|white-label|priority support|expert-reviewed/gi), null);
        assert.ok(enterprise.features.includes('Read-only journey tests + signed report webhooks'));

        const project = await store.createProject(workspaceId, {
            name: 'Authorized launch target', origin: 'https://example.com', locale: 'en'
        }, { entitlementUserId: userId, requestedByUserId: userId, limit: 1 });
        await store.recordTargetAuthorization({
            workspaceId, projectId: project.id, userId, origin: project.origin,
            attestationVersion: '1.0', requestId: `target_${suffix}`
        });
        assert.deepEqual(
            (await store.listTargetAuthorizations(workspaceId, { projectId: project.id })).map((record) => record.origin),
            ['https://example.com']
        );

        await store.recordLegalAcceptance({
            userId, workspaceId, documentType: 'terms', documentVersion: '1.0',
            purpose: 'signup', requestId: `legal_${suffix}`
        });
        await store.recordLegalAcceptance({
            userId, workspaceId, documentType: 'acceptable_use', documentVersion: '1.0',
            purpose: 'signup', requestId: `aup_${suffix}`
        });
        assert.equal(await store.hasCurrentLegalAcceptance(userId, workspaceId, {
            documentType: 'acceptable_use', documentVersion: '1.0', purpose: 'signup'
        }), true);

        const checkout = await store.recordCheckoutAcceptance({
            workspaceId, userId, planId: 'signal', provider: 'paddle', catalogVersion: 'launch-v1',
            amountMinor: 2900, currency: 'USD', billingInterval: 'month', termsVersion: '1.0',
            refundPolicyVersion: '1.0', requestId: `checkout_${suffix}`, idempotencyKey: `checkout_${suffix}`
        });
        const marked = await store.markCheckoutAcceptance({ userId, workspaceId }, checkout.idempotencyKey, {
            status: 'checkout_created', providerCheckoutId: `txn_${suffix}`
        });
        assert.equal(marked.providerCheckoutId, `txn_${suffix}`);

        const redeemPlaintext = `LAUNCH${suffix.replaceAll('-', '').slice(0, 12)}`;
        const code = await store.createRedeemCode({
            code: redeemPlaintext,
            bonusAiCredits: 2,
            maxGlobalRedemptions: 1,
            maxPerUser: 1,
            createdBy: 'launch-test',
            adminNote: 'disposable PostgreSQL acceptance'
        });
        redeemId = code.id;
        await store.redeemCode(workspaceId, userId, redeemPlaintext, { requestId: `redeem_${suffix}` });
        assert.equal((await store.getUserEffectiveEntitlements(userId)).limits.aiRemediations, 7);

        const reservation = await store.consumeAiGeneration(workspaceId, {
            userId, entitlementUserId: userId, findingFingerprint: `finding_${suffix}`, requestedModel: 'provider/model',
            provider: 'openrouter', promptVersion: 'p1', evidenceVersion: 'e1',
            idempotencyKey: `ai_${suffix}`
        });
        await store.settleAiGeneration(workspaceId, reservation.usage.id, {
            status: 'completed', actualModel: 'provider/model',
            usageMetadata: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            costMetadata: { cost: 0.01 }
        });
        assert.equal(await store.dailyAiCost(workspaceId), 0.01);
    } finally {
        if (redeemId) await store.pool.query('DELETE FROM wpa_redeem_codes WHERE id=$1', [redeemId]).catch(() => {});
        await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await store.pool.query('DELETE FROM "user" WHERE id=$1', [userId]).catch(() => {});
        await store.close();
    }
});

test('PostgreSQL provider ledger is idempotent, ordered and preserves grace before terminal downgrade', {
    skip: !connectionString && 'TEST_DATABASE_URL is not configured'
}, async () => {
    const store = new PostgresPlatformStore(connectionString);
    const workspaceId = `ws_billing_${crypto.randomUUID()}`;
    const userId = `user_billing_${crypto.randomUUID()}`;
    const base = Date.UTC(2026, 7, 15, 12);
    try {
        await store.pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [userId, 'Billing User', `${userId}@example.test`]);
        await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
        const active = providerEvent(userId, workspaceId, `evt_active_${workspaceId}`, base, 'active', 'studio', 'set_plan', 'paid');
        assert.equal((await store.applyBillingProviderEvent(active)).applied, true);
        assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements(userId)).effectivePlanId, 'studio');

        const grace = providerEvent(userId, workspaceId, `evt_grace_${workspaceId}`, base + 1_000, 'past_due', null, 'preserve', 'grace');
        assert.equal((await store.applyBillingProviderEvent(grace)).applied, true);
        assert.equal((await store.applyBillingProviderEvent(grace)).duplicate, true);
        assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements(userId)).effectivePlanId, 'studio');
        assert.equal((await store.getBillingSubscription({ userId }, 'paddle')).accessState, 'grace');

        const stale = providerEvent(userId, workspaceId, `evt_stale_${workspaceId}`, base - 1_000, 'canceled', 'free', 'set_plan', 'free');
        assert.equal((await store.applyBillingProviderEvent(stale)).stale, true);
        assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements(userId)).effectivePlanId, 'studio');

        const terminal = providerEvent(userId, workspaceId, `evt_terminal_${workspaceId}`, base + 2_000, 'canceled', 'free', 'set_plan', 'free');
        assert.equal((await store.applyBillingProviderEvent(terminal)).applied, true);
        assert.equal((await store.getWorkspace(workspaceId)).planId, 'free');
        assert.equal((await store.getUserEffectiveEntitlements(userId)).effectivePlanId, 'free');
    } finally {
        await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await store.pool.query('DELETE FROM "user" WHERE id=$1', [userId]).catch(() => {});
        await store.close();
    }
});
