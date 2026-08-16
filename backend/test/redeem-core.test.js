const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore } = require('../platform/store');

test('redeem hashes codes, enforces workspace/global limits and composes expiring grants without mutating billing', async () => {
    const store = new MemoryPlatformStore();
    await store.registerUser({ id: 'user_1', email: 'user1@example.com' });
    await store.assignUserPlan('user_1', 'signal', { actorId: 'billing:test', reason: 'Active paid subscription fixture', idempotencyKey: 'plan-user-1', requestFingerprint: 'plan-user-1' });
    await store.ensureWorkspace('ws_one', { planId: 'free', entitlementOwnerUserId: 'user_1' });
    await store.ensureWorkspace('ws_two', { planId: 'free' });
    store.subscriptions.set('ws_one', { workspaceId: 'ws_one', userId: 'user_1', provider: 'paddle', billingPlanId: 'signal', status: 'active' });
    const created = await store.createRedeemCode({
        code: 'WPAFOUNDERS', temporaryPlanId: 'studio', durationDays: 30, bonusPageCredits: 50, bonusAiCredits: 500,
        maxGlobalRedemptions: 2, maxPerWorkspace: 1, createdBy: 'admin_1', adminNote: 'pilot'
    });
    const stored = store.redeemCodes.get(created.id);
    assert.ok(Buffer.isBuffer(stored.codeHash));
    assert.ok(Buffer.isBuffer(stored.codeSalt));
    assert.doesNotMatch(JSON.stringify(stored), /WPAFOUNDERS/);

    const now = new Date('2026-08-15T00:00:00.000Z');
    const first = await store.redeemCode('ws_one', 'user_1', 'wpafounders', { now, requestId: 'req_1' });
    assert.equal(first.effective.effectivePlanId, 'studio');
    assert.equal(first.effective.limits.pageCredits, 200);
    assert.equal(first.effective.limits.aiRemediations, 1500);
    assert.equal((await store.getSubscription('ws_one')).billingPlanId, 'signal');
    assert.equal((await store.getUserCommercialProfile('user_1')).planId, 'signal');
    assert.equal((await store.getWorkspace('ws_one')).planId, 'free');
    await assert.rejects(() => store.redeemCode('ws_one', 'user_1', 'WPAFOUNDERS', { now }), { code: 'REDEEM_USER_LIMIT_REACHED' });

    await store.redeemCode('ws_two', 'user_2', 'WPAFOUNDERS', { now });
    await store.ensureWorkspace('ws_three');
    await assert.rejects(() => store.redeemCode('ws_three', 'user_3', 'WPAFOUNDERS', { now }), { code: 'REDEEM_CODE_LIMIT_REACHED' });
    const expired = await store.getEffectiveEntitlements('ws_one', new Date('2026-10-01T00:00:00.000Z'));
    assert.equal(expired.effectivePlanId, 'signal');
    assert.equal(expired.limits.pageCredits, 25);
});

test('disabling prevents new redemption and revoking a code removes its active grants', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_revoke');
    const code = await store.createRedeemCode({ code: 'PARTNER2026', temporaryPlanId: 'studio', createdBy: 'admin_1' });
    await store.redeemCode('ws_revoke', 'user_1', 'PARTNER2026');
    assert.equal((await store.getEffectiveEntitlements('ws_revoke')).effectivePlanId, 'studio');
    await store.mutateRedeemCode(code.id, { revoke: true }, { actorId: 'admin_1', reason: 'pilot ended', requestId: 'req_revoke' });
    assert.equal((await store.getEffectiveEntitlements('ws_revoke')).effectivePlanId, 'free');
    await assert.rejects(() => store.redeemCode('ws_revoke', 'user_1', 'PARTNER2026'), { code: 'REDEEM_CODE_INVALID' });
});
