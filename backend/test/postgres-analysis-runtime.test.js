const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');
const { PostgresQueue } = require('../platform/queue');

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL page lease, retry, event replay and idempotent credit/report contracts', { skip: !connectionString && 'TEST_DATABASE_URL is not configured' }, async () => {
    const store = new PostgresPlatformStore(connectionString);
    let activeStore = store;
    const suffix = crypto.randomUUID();
    const workspaceId = `ws_pg_${suffix}`; const projectId = `prj_pg_${suffix}`;
    try {
        await store.ensureWorkspace(workspaceId);
        await store.pool.query(`INSERT INTO wpa_projects(id,workspace_id,name,origin,verified_at,verification_method,verification_token,locale) VALUES($1,$2,'PG test','https://example.com/',now(),'operator',$3,'en')`, [projectId, workspaceId, crypto.randomBytes(24).toString('base64url')]);
        const scan = await store.createScan(workspaceId, projectId, { schemaVersion: 2, project: { id: projectId, origin: 'https://example.com/' }, plan: { id: 'signal' }, entitlements: {}, urls: ['https://example.com/'] });
        const pages = await store.createScanPages(workspaceId, scan.id, ['https://example.com/'], { maxAttempts: 3 });
        await store.reserveCredit(workspaceId, scan.id, 'https://example.com/', 25);
        await Promise.all([
            store.appendScanPagesWithCredits(workspaceId, scan.id, [
                { url: 'https://example.com/a', source: { type: 'rendered_link', referrer: 'https://example.com/' } },
                { url: 'https://example.com/b', source: { type: 'rendered_link', referrer: 'https://example.com/' } }
            ], { pageLimit: 3, creditLimit: 25 }),
            store.appendScanPagesWithCredits(workspaceId, scan.id, [
                { url: 'https://example.com/a', source: { type: 'rendered_link', referrer: 'https://example.com/other' } },
                { url: 'https://example.com/c', source: { type: 'rendered_link', referrer: 'https://example.com/other' } }
            ], { pageLimit: 3, creditLimit: 25 })
        ]);
        const appendedPages = await store.listScanPages(workspaceId, scan.id);
        assert.equal(appendedPages.length, 3);
        assert.deepEqual(appendedPages.map((page) => page.pageIndex), [0, 1, 2]);
        assert.equal(appendedPages.find((page) => page.url === 'https://example.com/a').discovery.sources.length, 2);
        const first = await store.claimScanPage(workspaceId, scan.id, pages[0].pageKey, { leaseMs: 5 });
        assert.equal(first.attempts, 1);
        await store.pool.query(`UPDATE wpa_scan_pages SET lease_expires_at=now()-interval '1 second' WHERE scan_id=$1`, [scan.id]);
        await store.close();
        activeStore = new PostgresPlatformStore(connectionString);
        const reclaimed = await activeStore.claimScanPage(workspaceId, scan.id, pages[0].pageKey, { leaseMs: 5_000 });
        assert.equal(reclaimed.attempts, 2);
        await activeStore.completeScanPage(workspaceId, scan.id, pages[0].pageKey, { status: 'completed', report: { moduleRuns: {} } });
        await activeStore.reserveCredit(workspaceId, scan.id, 'page-key', 25);
        await Promise.all([activeStore.settleCredit(workspaceId, scan.id, 'page-key', 'consumed'), activeStore.settleCredit(workspaceId, scan.id, 'page-key', 'consumed')]);
        assert.equal((await activeStore.getUsage(workspaceId)).consumed, 1);
        const payload = { schemaVersion: 'wpa.report.v2', pages: [] };
        const [left, right] = await Promise.all([activeStore.saveReportOnce(workspaceId, scan.id, payload), activeStore.saveReportOnce(workspaceId, scan.id, payload)]);
        assert.equal(left.id, right.id);
        for (let index = 0; index < 205; index += 1) await activeStore.appendScanEvent(workspaceId, scan.id, 'pg.event', { index });
        const events = await activeStore.listScanEvents(workspaceId, scan.id, { after: 0, limit: 200 });
        assert.equal(events.length, 200);
        assert.ok(Number(events[0].id) > 1);
    } finally {
        await activeStore.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]);
        await activeStore.close();
    }
});

test('pg-boss delivers a singleton page job on PostgreSQL', { skip: !connectionString && 'TEST_DATABASE_URL is not configured' }, async () => {
    const queue = new PostgresQueue(connectionString);
    // Runtime queue rows are intentionally bootstrap-owned. Use a canonical
    // queue here so this proof exercises the production registration contract.
    const queueName = 'wpa-scan-page';
    let resolveDelivery; const delivered = new Promise((resolve) => { resolveDelivery = resolve; });
    try {
        await queue.work(queueName, async (jobs) => { resolveDelivery(jobs[0].data); });
        const singletonKey = `scan:page-1:${crypto.randomUUID()}`;
        const first = await queue.send(queueName, { pageKey: 'page-1' }, { singletonKey });
        const second = await queue.send(queueName, { pageKey: 'page-1' }, { singletonKey });
        const value = await Promise.race([delivered, new Promise((_, reject) => setTimeout(() => reject(new Error('pg-boss delivery timed out')), 10_000))]);
        assert.equal(value.pageKey, 'page-1');
        assert.ok(first || second);
    } finally { await queue.close(); }
});
