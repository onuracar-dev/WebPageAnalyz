const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore, PostgresPlatformStore } = require('../platform/store');
const { operationFingerprint } = require('../domain/idempotency');

const checkout = (overrides = {}) => ({
    workspaceId: 'ws_checkout_invariant', userId: 'user_checkout', planId: 'signal', provider: 'paddle',
    catalogVersion: 'catalog-v1', amountMinor: 2900, currency: 'USD', billingInterval: 'month',
    termsVersion: 'terms-v1', refundPolicyVersion: 'refund-v1', requestId: 'request-checkout',
    idempotencyKey: 'checkout-operation-0001', requestFingerprint: operationFingerprint({ planId: 'signal' }),
    ...overrides
});

async function commercialReplayContract(store, suffix = '') {
    const workspaceId = `ws_commercial_replay${suffix}`;
    await store.ensureWorkspace(workspaceId);

    const accepted = await store.recordCheckoutAcceptance(checkout({ workspaceId, idempotencyKey: `checkout-operation${suffix}-0001` }));
    const replay = await store.recordCheckoutAcceptance(checkout({ workspaceId, idempotencyKey: `checkout-operation${suffix}-0001` }));
    assert.equal(replay.id, accepted.id);
    await assert.rejects(() => store.recordCheckoutAcceptance(checkout({
        workspaceId,
        idempotencyKey: `checkout-operation${suffix}-0001`,
        planId: 'studio',
        amountMinor: 9900,
        requestFingerprint: operationFingerprint({ planId: 'studio' })
    })), { code: 'IDEMPOTENCY_KEY_REUSED' });
    const [claimA, claimB] = await Promise.all([
        store.claimCheckoutAcceptance(workspaceId, accepted.id, { owner: `checkout-worker-a${suffix}`, leaseMs: 10_000 }),
        store.claimCheckoutAcceptance(workspaceId, accepted.id, { owner: `checkout-worker-b${suffix}`, leaseMs: 10_000 })
    ]);
    assert.equal([claimA, claimB].filter((claim) => claim.claimed).length, 1, 'one checkout setup lease may be active');
    const winner = claimA.claimed ? claimA : claimB;
    assert.equal(await store.releaseCheckoutAcceptanceClaim(workspaceId, accepted.id, { owner: 'wrong-owner', leaseToken: winner.leaseToken }), null);
    assert.ok(await store.releaseCheckoutAcceptanceClaim(workspaceId, accepted.id, { owner: winner.leaseOwner, leaseToken: winner.leaseToken }));
    const recoveryClaim = await store.claimCheckoutAcceptance(workspaceId, accepted.id, { owner: `checkout-recovery${suffix}`, leaseMs: 10_000 });
    assert.equal(recoveryClaim.claimed, true);
    await store.markCheckoutAcceptance(workspaceId, accepted.id, { status: 'checkout_created', providerCheckoutId: `provider-checkout${suffix}` });
    assert.ok(await store.releaseCheckoutAcceptanceClaim(workspaceId, accepted.id, { owner: recoveryClaim.leaseOwner, leaseToken: recoveryClaim.leaseToken }));

    const creditContext = {
        actorId: 'admin-1', reason: 'service recovery', requestId: `request-credit${suffix}`,
        idempotencyKey: `credit-operation${suffix}-0001`, requestFingerprint: operationFingerprint({ kind: 'page', amount: 100 })
    };
    const [creditA, creditB] = await Promise.all([
        store.adjustCredits(workspaceId, 'page', 100, creditContext),
        store.adjustCredits(workspaceId, 'page', 100, creditContext)
    ]);
    assert.equal(creditA.id, creditB.id, 'one logical admin adjustment must have one ledger row');
    const credits = await store.listCreditAdjustments(workspaceId);
    assert.equal(credits.filter((entry) => entry.id === creditA.id).length, 1);
    await assert.rejects(() => store.adjustCredits(workspaceId, 'page', 200, {
        ...creditContext, requestFingerprint: operationFingerprint({ kind: 'page', amount: 200 })
    }), { code: 'IDEMPOTENCY_KEY_REUSED' });

    const grantInput = { source: 'admin', temporaryPlanId: 'studio', expiresAt: '2030-01-01T00:00:00.000Z' };
    const grantContext = {
        actorId: 'admin-1', reason: 'bounded pilot', requestId: `request-grant${suffix}`,
        idempotencyKey: `grant-operation${suffix}-0001`, requestFingerprint: operationFingerprint(grantInput)
    };
    const [grantA, grantB] = await Promise.all([
        store.grantEntitlement(workspaceId, grantInput, grantContext),
        store.grantEntitlement(workspaceId, grantInput, grantContext)
    ]);
    assert.equal(grantA.id, grantB.id, 'one logical entitlement grant must have one grant row');
}

test('Memory commercial mutations replay one logical operation and reject changed bodies', async () => {
    await commercialReplayContract(new MemoryPlatformStore(), '-memory');
});

test('Memory redeem replay with maxPerWorkspace > 1 returns the original grant', async () => {
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws_redeem_replay';
    await store.ensureWorkspace(workspaceId);
    await store.createRedeemCode({
        code: 'REPLAY-REDEEM-01', active: true, maxGlobalRedemptions: 5, maxPerWorkspace: 2,
        bonusPageCredits: 5, createdBy: 'admin-1', reason: 'test', requestId: 'create-redeem'
    });
    const context = {
        requestId: 'redeem-request-1', idempotencyKey: 'redeem-operation-0001',
        requestFingerprint: operationFingerprint({ code: 'REPLAY-REDEEM-01' })
    };
    const [left, right] = await Promise.all([
        store.redeemCode(workspaceId, 'user-1', 'REPLAY-REDEEM-01', context),
        store.redeemCode(workspaceId, 'user-1', 'REPLAY-REDEEM-01', context)
    ]);
    assert.equal(left.redemption.id, right.redemption.id);
    assert.equal(left.grant.id, right.grant.id);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL commercial mutations satisfy the same replay contract', { skip: !databaseUrl }, async () => {
    const store = new PostgresPlatformStore(databaseUrl);
    try { await commercialReplayContract(store, `-pg-${Date.now()}`); }
    finally { await store.close(); }
});
