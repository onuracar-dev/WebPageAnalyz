const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');

const connectionString = process.env.TEST_DATABASE_URL;

async function cleanup(store, workspaceId) {
    await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]);
    await store.close();
}

test('PostgreSQL project limit and same-key replay are serialized', { skip: !connectionString && 'TEST_DATABASE_URL is not configured' }, async () => {
    const store = new PostgresPlatformStore(connectionString);
    const workspaceId = `ws_pg_project_${crypto.randomUUID()}`;
    try {
        await store.ensureWorkspace(workspaceId);
        const [left, right] = await Promise.allSettled([
            store.createProject(workspaceId, { name: 'One', origin: 'https://one.example/', locale: 'en' }, { limit: 1, idempotencyKey: 'pg-project-key-0001', requestFingerprint: 'pg-project-body-v1' }),
            store.createProject(workspaceId, { name: 'Two', origin: 'https://two.example/', locale: 'en' }, { limit: 1, idempotencyKey: 'pg-project-key-0002', requestFingerprint: 'pg-project-body-v2' })
        ]);
        assert.equal([left, right].filter((item) => item.status === 'fulfilled').length, 1);
        const rejected = [left, right].find((item) => item.status === 'rejected');
        assert.equal(rejected.reason.code, 'PROJECT_LIMIT_REACHED');
        const created = left.status === 'fulfilled' ? left.value : right.value;
        const replayKey = created.idempotencyKey || (left.status === 'fulfilled' ? 'pg-project-key-0001' : 'pg-project-key-0002');
        const replayFingerprint = left.status === 'fulfilled' ? 'pg-project-body-v1' : 'pg-project-body-v2';
        const replay = await store.createProject(workspaceId, { name: created.name, origin: created.origin, locale: created.locale }, { limit: 1, idempotencyKey: replayKey, requestFingerprint: replayFingerprint });
        assert.equal(replay.id, created.id);
        assert.equal(replay.idempotent, true);
        await assert.rejects(() => store.createProject(workspaceId, { name: created.name, origin: created.origin, locale: created.locale }, { limit: 1, idempotencyKey: replayKey, requestFingerprint: 'pg-project-different-body' }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    } finally {
        await cleanup(store, workspaceId);
    }
});

test('PostgreSQL same-key scan replay and terminal page credit settlement are durable', { skip: !connectionString && 'TEST_DATABASE_URL is not configured' }, async () => {
    const store = new PostgresPlatformStore(connectionString);
    const workspaceId = `ws_pg_scan_${crypto.randomUUID()}`;
    try {
        await store.ensureWorkspace(workspaceId);
        const project = await store.createProject(workspaceId, { name: 'Scan', origin: 'https://example.com/', locale: 'en' });
        const manifest = { schemaVersion: 2, project: { id: project.id, origin: project.origin }, urls: ['https://example.com/'] };
        const [left, right] = await Promise.all([
            store.createScan(workspaceId, project.id, manifest, { idempotencyKey: 'pg-scan-key-0001', requestFingerprint: 'pg-scan-body-v1' }),
            store.createScan(workspaceId, project.id, manifest, { idempotencyKey: 'pg-scan-key-0001', requestFingerprint: 'pg-scan-body-v1' })
        ]);
        assert.equal(left.id, right.id);
        assert.equal([left, right].filter((item) => item.idempotent).length, 1);
        await assert.rejects(() => store.createScan(workspaceId, project.id, { ...manifest, locale: 'tr' }, { idempotencyKey: 'pg-scan-key-0001', requestFingerprint: 'pg-scan-different-body' }), { code: 'IDEMPOTENCY_KEY_REUSED' });

        await store.updateScan(workspaceId, left.id, { status: 'running' }, { expectedStatus: 'queued' });
        const [page] = await store.createScanPages(workspaceId, left.id, ['https://example.com/'], { maxAttempts: 3 });
        await store.reserveCredit(workspaceId, left.id, 'https://example.com/', 3);
        const claimed = await store.claimScanPage(workspaceId, left.id, page.pageKey, { owner: 'pg-worker' });
        const result = await store.completeScanPageAndSettleCredit(workspaceId, left.id, page.pageKey, { status: 'completed', report: { findings: [] }, leaseOwner: claimed.leaseOwner, leaseToken: claimed.leaseToken, creditKey: 'https://example.com/', creditState: 'consumed' });
        assert.equal(result.page.status, 'completed');
        assert.equal(result.credit.state, 'consumed');
        const replay = await store.completeScanPageAndSettleCredit(workspaceId, left.id, page.pageKey, { status: 'completed', creditKey: 'https://example.com/', creditState: 'consumed' });
        assert.equal(replay.idempotent, true);
        await store.cancelScan(workspaceId, left.id, { actorId: 'pg-admin', reason: 'stop after page' });
        assert.equal(await store.updateScan(workspaceId, left.id, { status: 'completed' }), null);
        assert.equal((await store.getScan(workspaceId, left.id)).status, 'cancelled');
    } finally {
        await cleanup(store, workspaceId);
    }
});
