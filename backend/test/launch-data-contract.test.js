const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MemoryPlatformStore } = require('../platform/store');
const { checkMigrations } = require('../scripts/check-migrations');

test('launch migration contains the coordinated commercial, legal, ops and abuse data authority', async () => {
    const sql = await fs.readFile(path.resolve(__dirname, '../db/migrations/027_launch_commercial_readiness.sql'), 'utf8');
    for (const contract of [
        "ALTER COLUMN plan_id SET DEFAULT 'free'", 'wpa_checkout_acceptances', 'wpa_legal_acceptances', 'wpa_target_authorizations',
        'wpa_redeem_codes', 'wpa_redeem_redemptions', 'wpa_entitlement_grants', 'wpa_credit_adjustments', 'wpa_ai_usage', 'wpa_ai_cache',
        'wpa_audit_immutable', 'wpa_session_active_user_only', 'namespace text', "'enterprise' THEN 'contact'"
    ]) assert.match(sql, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const migrations = await checkMigrations();
    assert.deepEqual(migrations.slice(-5).map(({ filename }) => filename), [
        '037_enterprise_plan_superset.sql',
        '038_enterprise_plan_name.sql',
        '039_remove_unshipped_seat_copy.sql',
        '040_privileged_access_security.sql',
        '041_privileged_admin_set_lock.sql'
    ]);
    assert.equal(migrations.length, 41);
});

test('checkout/legal/target records are versioned and AI cache/usage stays workspace scoped', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_contract');
    const checkout = await store.recordCheckoutAcceptance({ workspaceId: 'ws_contract', userId: 'user_1', planId: 'signal', provider: 'paddle', catalogVersion: 'catalog-2026-08', amountMinor: 2900, currency: 'usd', billingInterval: 'month', termsVersion: 'terms-1', refundPolicyVersion: 'refund-1', requestId: 'req_checkout', idempotencyKey: 'checkout_1' });
    assert.equal((await store.recordCheckoutAcceptance({ ...checkout, currency: 'USD' })).id, checkout.id);
    assert.equal((await store.markCheckoutAcceptance('ws_contract', 'checkout_1', { status: 'checkout_created', providerCheckoutId: 'txn_1' })).providerCheckoutId, 'txn_1');
    await store.recordLegalAcceptance({ userId: 'user_1', workspaceId: 'ws_contract', documentType: 'terms', documentVersion: 'terms-1', purpose: 'signup', requestId: 'req_legal' });
    assert.equal(await store.hasCurrentLegalAcceptance('user_1', 'ws_contract', { documentType: 'terms', documentVersion: 'terms-1', purpose: 'signup' }), true);
    const project = await store.createProject('ws_contract', { name: 'Owned', origin: 'https://example.com', locale: 'en' });
    const authorization = await store.recordTargetAuthorization({ workspaceId: 'ws_contract', projectId: project.id, userId: 'user_1', origin: project.origin, attestationVersion: '1.0', requestId: 'req_target' });
    assert.equal(authorization.attestationVersion, '1.0');
    assert.deepEqual((await store.listTargetAuthorizations('ws_contract', { projectId: project.id })).map((record) => record.origin), ['https://example.com']);

    await store.putAiCache({ cacheKey: 'cache_1', workspaceId: 'ws_contract', findingFingerprint: 'fp_1', promptVersion: 'p1', modelVersion: 'm1', evidenceVersion: 'e1', response: { remediation: 'Fix it' } });
    assert.equal((await store.getAiCache('ws_contract', 'cache_1')).response.remediation, 'Fix it');
    assert.equal(await store.getAiCache('other', 'cache_1'), null);
    await store.putAiCache({ cacheKey: 'cache_1', workspaceId: 'other', findingFingerprint: 'fp_2', promptVersion: 'p1', modelVersion: 'm1', evidenceVersion: 'e2', response: { remediation: 'Other workspace' } });
    assert.equal((await store.getAiCache('ws_contract', 'cache_1')).response.remediation, 'Fix it');
    assert.equal((await store.getAiCache('other', 'cache_1')).response.remediation, 'Other workspace');
    await store.recordAiUsage({ workspaceId: 'ws_contract', userId: 'user_1', findingFingerprint: 'fp_1', requestedModel: 'requested', actualModel: 'actual', provider: 'openrouter', promptVersion: 'p1', evidenceVersion: 'e1', usageMetadata: { totalTokens: 42 }, costMetadata: { cost: 0.125 }, status: 'completed', createdAt: '2026-08-15T10:00:00.000Z' });
    assert.equal(await store.dailyAiCost('ws_contract', new Date('2026-08-15T20:00:00.000Z')), 0.125);
});
