const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPlatformStore } = require('../platform/store');
const { operationFingerprint } = require('../domain/idempotency');

const databaseUrl = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-08-15T12:00:00.000Z');
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';

function commercialContext(userId, operation, payload) {
    return {
        actorId: 'admin-commercial',
        reason: 'commercial ownership PostgreSQL contract',
        requestId: `request-${operation}`,
        idempotencyKey: `${operation}-operation-0001`,
        requestFingerprint: operationFingerprint({ userId, ...payload })
    };
}

function scanManifest(planId = 'free') {
    return {
        schemaVersion: 2,
        project: { origin: 'https://example.com/' },
        plan: { id: planId, limits: { pageCredits: 5 } },
        entitlements: {},
        urls: ['https://example.com/']
    };
}

test('PostgreSQL enforces user-scoped plan, grants, scan snapshots and page quota across workspaces', { skip: !databaseUrl }, async (t) => {
    const store = new PostgresPlatformStore(databaseUrl);
    t.after(() => store.close());
    await store.pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES
        ('pg-sponsor','PG Sponsor','pg-sponsor@example.com',true),
        ('pg-member','PG Member','pg-member@example.com',true)`);
    await store.ensureWorkspace('pg-workspace-a', { entitlementOwnerUserId: 'pg-sponsor' });
    await store.ensureWorkspace('pg-workspace-b', { entitlementOwnerUserId: 'pg-sponsor' });
    await store.assignUserPlan('pg-sponsor', 'studio', commercialContext('pg-sponsor', 'pg-plan', { planId: 'studio' }));
    await store.adjustUserCredits('pg-sponsor', 'page', 7, commercialContext('pg-sponsor', 'pg-credit', { kind: 'page', amount: 7 }));
    await store.grantUserEntitlement('pg-sponsor', {
        source: 'admin', entitlementOverrides: { expert_review: { executionMode: 'operator_assisted', limit: 1 } },
        startsAt: '2026-08-01T00:00:00.000Z', expiresAt: EXPIRES_AT
    }, commercialContext('pg-sponsor', 'pg-feature', { moduleId: 'expert_review', executionMode: 'operator_assisted', startsAt: '2026-08-01T00:00:00.000Z', expiresAt: EXPIRES_AT }));
    const effective = await store.getUserEffectiveEntitlements('pg-sponsor', NOW);
    assert.equal(effective.effectivePlanId, 'studio');
    assert.equal(effective.limits.pageCredits, 157);
    assert.deepEqual(effective.entitlements.expert_review, { executionMode: 'operator_assisted', limit: 1 });

    const projectA = await store.createProject('pg-workspace-a', { name: 'A', origin: 'https://a.example.com', locale: 'en' }, { entitlementUserId: 'pg-sponsor', requestedByUserId: 'pg-member', limit: 10 });
    const projectB = await store.createProject('pg-workspace-b', { name: 'B', origin: 'https://b.example.com', locale: 'en' }, { entitlementUserId: 'pg-sponsor', requestedByUserId: 'pg-member', limit: 10 });
    const scanA = await store.createScan('pg-workspace-a', projectA.id, scanManifest('studio'), { entitlementUserId: 'pg-sponsor', requestedByUserId: 'pg-member' });
    const scanB = await store.createScan('pg-workspace-b', projectB.id, scanManifest('studio'), { entitlementUserId: 'pg-sponsor', requestedByUserId: 'pg-member' });
    const reservations = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => store.reserveCredit(
        index % 2 ? 'pg-workspace-b' : 'pg-workspace-a', index % 2 ? scanB.id : scanA.id, `pg-page-${index}`, 5, NOW, 'pg-sponsor'
    )));
    assert.equal(reservations.filter((entry) => entry.status === 'fulfilled').length, 5);
    assert.equal(reservations.filter((entry) => entry.status === 'rejected')[0].reason.code, 'PAGE_CREDIT_LIMIT_REACHED');
    assert.equal((await store.getUsage('pg-sponsor', NOW)).reserved, 5);
    assert.equal((await store.getScan('pg-workspace-a', scanA.id)).requestedByUserId, 'pg-member');
    assert.equal((await store.getScan('pg-workspace-a', scanA.id)).entitlementUserId, 'pg-sponsor');
    assert.equal((await store.getWorkspace('pg-workspace-a')).planId, 'free');
});

test('PostgreSQL provider billing updates the user and rejects a mismatched workspace sponsor atomically', { skip: !databaseUrl }, async (t) => {
    const store = new PostgresPlatformStore(databaseUrl);
    t.after(() => store.close());
    await store.pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES
        ('pg-billing-owner','PG Billing Owner','pg-billing-owner@example.com',true),
        ('pg-billing-other','PG Billing Other','pg-billing-other@example.com',true)`);
    await store.ensureWorkspace('pg-billing-workspace', { entitlementOwnerUserId: 'pg-billing-owner' });
    const event = {
        provider: 'paddle', eventId: 'evt_pg_billing_active', eventType: 'subscription.updated',
        occurredAt: '2030-01-02T00:00:00.000Z', occurredAtMs: Date.parse('2030-01-02T00:00:00.000Z'),
        userId: 'pg-billing-owner', workspaceId: 'pg-billing-workspace', resourceKind: 'subscription', externalObjectId: 'sub_pg_billing',
        subscription: { providerSubscriptionId: 'sub_pg_billing', providerCustomerId: 'ctm_pg_billing', status: 'active' },
        entitlement: { action: 'set_plan', planId: 'studio', access: 'paid', reason: 'subscription_paid' }
    };
    assert.equal((await store.applyBillingProviderEvent(event)).applied, true);
    assert.equal((await store.getWorkspace('pg-billing-workspace')).planId, 'free');
    assert.equal((await store.getUserEffectiveEntitlements('pg-billing-owner')).effectivePlanId, 'studio');
    assert.equal((await store.getBillingSubscription({ userId: 'pg-billing-owner' }, 'paddle')).userId, 'pg-billing-owner');

    await assert.rejects(() => store.applyBillingProviderEvent({
        ...event, eventId: 'evt_pg_billing_wrong_owner', userId: 'pg-billing-other', externalObjectId: 'sub_pg_billing_wrong_owner',
        subscription: { ...event.subscription, providerSubscriptionId: 'sub_pg_billing_wrong_owner' }
    }), { code: 'BILLING_USER_WORKSPACE_MISMATCH' });
    assert.equal((await store.getUserEffectiveEntitlements('pg-billing-other')).effectivePlanId, 'free');
    assert.equal(await store.getBillingSubscription({ userId: 'pg-billing-other' }, 'paddle'), null);
});
