const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore } = require('../platform/store');
const { assertPrincipalActive } = require('../auth/workspace-policy');

test('ban and suspension are enforced server-side and dangerous state changes are audited', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_state');
    await store.setUserState('user_1', 'banned', { actorId: 'admin_1', reason: 'abuse', requestId: 'req_ban', email: 'user@example.test' });
    await assert.rejects(() => assertPrincipalActive(store, { userId: 'user_1', workspaceId: 'ws_state' }), { code: 'USER_BANNED' });
    await store.setUserState('user_1', 'active', { actorId: 'admin_1', reason: 'appeal accepted', requestId: 'req_unban' });
    assert.deepEqual(await assertPrincipalActive(store, { userId: 'user_1', workspaceId: 'ws_state' }).then(({ userState, workspaceState }) => ({ userState: userState.state, workspaceState: workspaceState.state })), {
        userState: 'active', workspaceState: 'active'
    });
    await store.setWorkspaceState('ws_state', 'suspended', { actorId: 'admin_1', reason: 'billing review', requestId: 'req_suspend' });
    await assert.rejects(() => assertPrincipalActive(store, { userId: 'user_1', workspaceId: 'ws_state' }), { code: 'WORKSPACE_SUSPENDED' });
    await store.setWorkspaceState('ws_state', 'active', { actorId: 'admin_1', reason: 'billing review cleared', requestId: 'req_unsuspend' });
    assert.deepEqual(await assertPrincipalActive(store, { userId: 'user_1', workspaceId: 'ws_state' }).then(({ userState, workspaceState }) => ({ userState: userState.state, workspaceState: workspaceState.state })), {
        userState: 'active', workspaceState: 'active'
    });
    for (const [action, reason, requestId] of [
        ['user.banned', 'abuse', 'req_ban'],
        ['user.unbanned', 'appeal accepted', 'req_unban'],
        ['workspace.suspended', 'billing review', 'req_suspend'],
        ['workspace.unsuspended', 'billing review cleared', 'req_unsuspend']
    ]) {
        const audit = store.auditLog.find((event) => event.action === action);
        assert.ok(audit, `${action} audit must exist`);
        assert.equal(audit.reason, reason);
        assert.equal(audit.requestId, requestId);
    }
});

test('manual credits and entitlements expire automatically and audit metadata is redacted', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_grants');
    await store.adjustCredits('ws_grants', 'page', 25, { actorId: 'admin_1', reason: 'service recovery', requestId: 'req_credit', expiresAt: '2026-09-01T00:00:00.000Z' });
    const creditAudit = store.auditLog.find((event) => event.action === 'credits.granted');
    assert.ok(creditAudit, 'positive credit adjustment must emit credits.granted');
    assert.equal(creditAudit.reason, 'service recovery');
    assert.equal(creditAudit.requestId, 'req_credit');
    assert.equal(creditAudit.metadata.creditType, 'page');
    assert.equal(creditAudit.metadata.amount, 25);
    const grant = await store.grantEntitlement('ws_grants', { temporaryPlanId: 'studio', entitlementOverrides: { api_webhooks: { executionMode: 'automated' } }, startsAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z' }, { actorId: 'admin_1', reason: 'pilot', requestId: 'req_grant' });
    assert.equal((await store.getEffectiveEntitlements('ws_grants', new Date('2026-08-20'))).limits.pageCredits, 175);
    assert.equal((await store.getEffectiveEntitlements('ws_grants', new Date('2026-09-02'))).effectivePlanId, 'free');
    await store.logAudit({ action: 'test.redaction', entityType: 'test', metadata: { apiKey: 'sk_secret', nested: { password: 'never-store', safe: 'ok' } } });
    assert.equal(store.auditLog[0].metadata.apiKey, '[REDACTED]');
    assert.equal(store.auditLog[0].metadata.nested.password, '[REDACTED]');
    assert.equal(store.auditLog[0].metadata.nested.safe, 'ok');
    await store.revokeEntitlement(grant.id, { actorId: 'admin_1', reason: 'ended', requestId: 'req_end' });
});

test('scan cancellation releases reservations and safe retry reuses the same scan and credit records', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_scan');
    const project = await store.createProject('ws_scan', { name: 'Target', origin: 'https://example.com', locale: 'en' });
    const scan = await store.createScan('ws_scan', project.id, { urls: ['https://example.com/'] });
    await store.createScanPages('ws_scan', scan.id, ['https://example.com/']);
    await store.reserveCredit('ws_scan', scan.id, 'https://example.com/', 5);
    await store.cancelScan('ws_scan', scan.id, { actorId: 'admin_1', reason: 'stuck job', requestId: 'req_cancel', idempotencyKey: 'cancel-click-1' });
    assert.equal((await store.getScan('ws_scan', scan.id)).status, 'cancelled');
    assert.equal([...store.credits.values()][0].state, 'released');
    const retried = await store.retryScan('ws_scan', scan.id, { actorId: 'admin_1', reason: 'provider recovered', requestId: 'req_retry', idempotencyKey: 'retry-click-1', creditLimit: 5 });
    assert.equal(retried.scan.id, scan.id);
    assert.equal(retried.requeuedPages, 1);
    assert.equal([...store.credits.values()][0].state, 'reserved');
    const cancelledAudit = store.auditLog.find((entry) => entry.action === 'scan.cancelled');
    const retriedAudit = store.auditLog.find((entry) => entry.action === 'scan.retried');
    assert.deepEqual([cancelledAudit.requestId, cancelledAudit.metadata.idempotencyKey], ['req_cancel', 'cancel-click-1']);
    assert.deepEqual([retriedAudit.requestId, retriedAudit.metadata.idempotencyKey], ['req_retry', 'retry-click-1']);
    assert.equal((await store.retryScan('ws_scan', scan.id, { actorId: 'admin_1', reason: 'duplicate click', creditLimit: 5 })).idempotent, true);
    assert.equal(store.reports.size, 0);
});
