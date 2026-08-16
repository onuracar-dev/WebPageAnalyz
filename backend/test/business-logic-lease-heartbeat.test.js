const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore, PostgresPlatformStore } = require('../platform/store');

async function leaseContract(store, suffix) {
    const workspaceId = `ws_lease_${suffix}`;
    await store.ensureWorkspace(workspaceId);
    const project = await store.createProject(workspaceId, { name: 'Lease', origin: 'https://example.com/', locale: 'en' });
    const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com/'] });
    await store.updateScan(workspaceId, scan.id, { status: 'running' }, { expectedStatus: 'queued' });
    const [page] = await store.createScanPages(workspaceId, scan.id, ['https://example.com/']);
    const claim = await store.claimScanPage(workspaceId, scan.id, page.pageKey, { owner: 'lease-worker', leaseMs: 1_000 });
    const originalExpiry = new Date(claim.leaseExpiresAt).getTime();
    const renewed = await store.renewScanPageLease(workspaceId, scan.id, page.pageKey, { owner: claim.leaseOwner, leaseToken: claim.leaseToken, leaseMs: 10_000 });
    assert.equal(new Date(renewed.leaseExpiresAt).getTime() > originalExpiry, true);
    assert.equal(await store.renewScanPageLease(workspaceId, scan.id, page.pageKey, { owner: 'other-worker', leaseToken: claim.leaseToken, leaseMs: 10_000 }), null);

    const jobKey = `source:${suffix}`;
    await store.createExecutionResult({ jobKey, workspaceId, kind: 'source', input: {} });
    const execution = await store.claimExecutionResult(jobKey, { owner: 'lease-worker', leaseMs: 1_000 });
    const executionExpiry = new Date(execution.leaseExpiresAt).getTime();
    const executionRenewed = await store.renewExecutionResultLease(jobKey, { owner: execution.leaseOwner, leaseToken: execution.leaseToken, leaseMs: 10_000 });
    assert.equal(new Date(executionRenewed.leaseExpiresAt).getTime() > executionExpiry, true);
    assert.equal(await store.renewExecutionResultLease(jobKey, { owner: execution.leaseOwner, leaseToken: 'wrong-token', leaseMs: 10_000 }), null);
}

test('Memory page and worker execution leases renew only for the fenced owner', async () => {
    await leaseContract(new MemoryPlatformStore(), 'memory');
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL page and worker execution leases renew only for the fenced owner', { skip: !databaseUrl }, async () => {
    const store = new PostgresPlatformStore(databaseUrl);
    try { await leaseContract(store, `pg-${Date.now()}`); }
    finally { await store.close(); }
});
