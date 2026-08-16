const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createPlatformService } = require('../platform/service');

function serviceHarness({ store = new MemoryPlatformStore(), send, work, analyze } = {}) {
    const sent = [];
    const handlers = new Map();
    const queue = {
        async start() {},
        async close() {},
        async work(name, handler) {
            if (work) return work(name, handler, handlers);
            handlers.set(name, handler);
        },
        async send(name, data, options = {}) {
            sent.push({ name, data, options });
            if (send) return send(name, data, options, sent);
            return `job_${sent.length}`;
        }
    };
    const config = loadConfig({ NODE_ENV: 'test', WORKER_ENABLED: 'true', SCAN_RECOVERY_INTERVAL_MS: '600000' });
    const service = createPlatformService({
        store,
        queue,
        config,
        logger: { info() {}, warn() {}, error() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname }),
        analysisPool: { stats: { active: 0 }, run: (task) => task(new AbortController().signal) },
        analysisService: { analyze: analyze || (async (_target, _signal, options) => ({ scores: {}, categories: {}, findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])) })) },
        crawler: async (origin) => ({ version: '1.0.0', status: 'completed', urls: [origin], pages: [{ url: origin, status: 200, discoverySource: 'root', referrer: null }], findings: [], coverage: { attemptedPages: 1, reachablePages: 1, brokenPages: 0, truncated: false } })
    });
    return { store, service, queue, sent, handlers };
}

test('project limit and same-key replay serialize atomically in memory', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_project_atomic');
    const options = { limit: 1, idempotencyKey: 'project-key-0001', requestFingerprint: 'project-body-v1' };
    const [left, right] = await Promise.all([
        store.createProject('ws_project_atomic', { name: 'One', origin: 'https://one.example', locale: 'en' }, options),
        store.createProject('ws_project_atomic', { name: 'One', origin: 'https://one.example', locale: 'en' }, options)
    ]);
    assert.equal(left.id, right.id);
    assert.equal([left, right].filter((item) => item.idempotent).length, 1);
    assert.equal((await store.listProjects('ws_project_atomic')).length, 1);
    await assert.rejects(
        () => store.createProject('ws_project_atomic', { name: 'Two', origin: 'https://two.example', locale: 'en' }, { limit: 1, idempotencyKey: 'project-key-0002', requestFingerprint: 'project-body-v2' }),
        { code: 'PROJECT_LIMIT_REACHED' }
    );
    await assert.rejects(
        () => store.createProject('ws_project_atomic', { name: 'Different', origin: 'https://one.example', locale: 'en' }, { limit: 1, idempotencyKey: options.idempotencyKey, requestFingerprint: 'different-body' }),
        { code: 'IDEMPOTENCY_KEY_REUSED' }
    );
});

test('same-key scan replay skips credit, page, queue and audit side effects', async () => {
    const { store, service, sent } = serviceHarness();
    await store.ensureWorkspace('ws_scan_replay');
    const project = await service.createProject('ws_scan_replay', { name: 'Replay', url: 'https://example.com/', locale: 'en' });
    const options = { idempotencyKey: 'scan-key-0001', requestFingerprint: 'scan-body-v1' };
    const first = await service.createScan('ws_scan_replay', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' }, options);
    const second = await service.createScan('ws_scan_replay', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' }, options);
    assert.equal(first.id, second.id);
    assert.equal(sent.filter((job) => job.name === 'wpa-scan').length, 1);
    assert.equal((await store.listScanPages('ws_scan_replay', first.id)).length, 1);
    assert.equal((await store.getUsage('ws_scan_replay')).reserved, 1);
    assert.equal((await store.listScanEvents('ws_scan_replay', first.id)).filter((event) => event.type === 'scan.queued').length, 1);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'scan.queued' && entry.entityId === first.id).length, 1);
    await assert.rejects(
        () => service.createScan('ws_scan_replay', { projectId: project.id, urls: ['https://example.com/'], locale: 'tr' }, { ...options, requestFingerprint: 'different-body' }),
        { code: 'IDEMPOTENCY_KEY_REUSED' }
    );
});

test('same-key project replay skips authorization and audit writes', async () => {
    const { store, service } = serviceHarness();
    await store.ensureWorkspace('ws_project_replay');
    const options = { idempotencyKey: 'project-key-0101', requestFingerprint: 'project-body-v1' };
    const first = await service.createProject('ws_project_replay', { name: 'Replay', url: 'https://example.com/', locale: 'en' }, 'user-1', 'request-1', options);
    const second = await service.createProject('ws_project_replay', { name: 'Replay', url: 'https://example.com/', locale: 'en' }, 'user-1', 'request-2', options);
    assert.equal(first.id, second.id);
    assert.equal(second.idempotent, true);
    assert.equal((await store.listTargetAuthorizations('ws_project_replay', { projectId: first.id, activeOnly: true })).length, 1);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'project.created' && entry.entityId === first.id).length, 1);
});

test('cancelled scan is terminal and page completion settles its credit atomically', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_terminal');
    const project = await store.createProject('ws_terminal', { name: 'Terminal', origin: 'https://example.com', locale: 'en' });
    const scan = await store.createScan('ws_terminal', project.id, { urls: ['https://example.com'] });
    await store.updateScan('ws_terminal', scan.id, { status: 'running' }, { expectedStatus: 'queued' });
    const [page] = await store.createScanPages('ws_terminal', scan.id, ['https://example.com']);
    await store.reserveCredit('ws_terminal', scan.id, 'https://example.com', 2);
    const claimed = await store.claimScanPage('ws_terminal', scan.id, page.pageKey, { owner: 'worker-a' });
    const result = await store.completeScanPageAndSettleCredit('ws_terminal', scan.id, page.pageKey, {
        status: 'completed',
        report: { findings: [] },
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
        creditKey: 'https://example.com',
        creditState: 'consumed'
    });
    assert.equal(result.page.status, 'completed');
    assert.equal(result.credit.state, 'consumed');
    assert.equal((await store.getUsage('ws_terminal')).reserved, 0);
    const replay = await store.completeScanPageAndSettleCredit('ws_terminal', scan.id, page.pageKey, { status: 'completed', creditKey: 'https://example.com', creditState: 'consumed' });
    assert.equal(replay.idempotent, true);
    await store.cancelScan('ws_terminal', scan.id, { actorId: 'admin', reason: 'stop' });
    assert.equal((await store.updateScan('ws_terminal', scan.id, { status: 'completed' })), null);
    assert.equal((await store.getScan('ws_terminal', scan.id)).status, 'cancelled');

    const cancelledScan = await store.createScan('ws_terminal', project.id, { urls: ['https://example.com/cancelled'] });
    const [cancelledPage] = await store.createScanPages('ws_terminal', cancelledScan.id, ['https://example.com/cancelled']);
    await store.reserveCredit('ws_terminal', cancelledScan.id, 'https://example.com/cancelled', 3);
    await store.cancelScan('ws_terminal', cancelledScan.id, { actorId: 'admin', reason: 'stop before work' });
    const cancelledResult = await store.completeScanPageAndSettleCredit('ws_terminal', cancelledScan.id, cancelledPage.pageKey, { status: 'completed', creditKey: 'https://example.com/cancelled', creditState: 'consumed' });
    assert.equal(cancelledResult.page.status, 'cancelled');
    assert.equal(cancelledResult.credit.state, 'released');
});

test('unknown queue outcome keeps scan queued and credits reserved; setup failure leaves queued pages retryable', async () => {
    const unknown = serviceHarness({ send: async () => { throw Object.assign(new Error('ack outcome unknown'), { code: 'QUEUE_ACK_UNKNOWN' }); } });
    await unknown.store.ensureWorkspace('ws_queue_unknown');
    const project = await unknown.service.createProject('ws_queue_unknown', { name: 'Queue', url: 'https://example.com/', locale: 'en' });
    await assert.rejects(() => unknown.service.createScan('ws_queue_unknown', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' }), { code: 'QUEUE_ACK_UNKNOWN' });
    const [scan] = await unknown.store.listScans('ws_queue_unknown');
    assert.equal(scan.status, 'queued');
    assert.equal((await unknown.store.getUsage('ws_queue_unknown')).reserved, 1);
    assert.equal((await unknown.store.listScanPages('ws_queue_unknown', scan.id))[0].status, 'queued');

    const setup = serviceHarness({ work: async () => { throw Object.assign(new Error('worker registration failed'), { code: 'QUEUE_SETUP_FAILED' }); } });
    await setup.store.ensureWorkspace('ws_queue_setup');
    const setupProject = await setup.service.createProject('ws_queue_setup', { name: 'Setup', url: 'https://example.com/', locale: 'en' });
    await assert.rejects(() => setup.service.createScan('ws_queue_setup', { projectId: setupProject.id, urls: ['https://example.com/'], locale: 'en' }), { code: 'QUEUE_SETUP_FAILED' });
    const [failed] = await setup.store.listScans('ws_queue_setup');
    assert.equal(failed.status, 'failed');
    assert.equal((await setup.store.getUsage('ws_queue_setup')).reserved, 0);
    assert.equal((await setup.store.listScanPages('ws_queue_setup', failed.id))[0].status, 'queued');
    const retried = await setup.store.retryScan('ws_queue_setup', failed.id, { actorId: 'admin', reason: 'retry queue setup', creditLimit: 3 });
    assert.equal(retried.requeuedPages, 1);
    assert.equal((await setup.store.listScanPages('ws_queue_setup', failed.id))[0].status, 'retrying');
    assert.equal((await setup.store.getUsage('ws_queue_setup')).reserved, 1);
});

test('recovery redelivers the stable scan singleton and suspended work does not claim or commit', async () => {
    let sends = 0;
    const recovered = serviceHarness({ send: async () => { sends += 1; if (sends === 1) throw Object.assign(new Error('unknown send result'), { code: 'QUEUE_ACK_UNKNOWN' }); return `job_${sends}`; } });
    await recovered.store.ensureWorkspace('ws_recovery');
    const project = await recovered.service.createProject('ws_recovery', { name: 'Recovery', url: 'https://example.com/', locale: 'en' });
    await assert.rejects(() => recovered.service.createScan('ws_recovery', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' }), { code: 'QUEUE_ACK_UNKNOWN' });
    const [scan] = await recovered.store.listScans('ws_recovery');
    await recovered.service.start();
    assert.equal(recovered.sent.at(-1).options.singletonKey, scan.id);
    await recovered.service.close();

    await recovered.store.setWorkspaceState('ws_recovery', 'suspended', { actorId: 'admin', reason: 'billing hold' });
    await assert.rejects(() => recovered.service.executeScan(scan.id, 'ws_recovery'), { code: 'WORKSPACE_EXECUTION_BLOCKED' });
    assert.equal((await recovered.store.getScan('ws_recovery', scan.id)).status, 'queued');
});

test('workspace suspension immediately before terminal page commit leaves the lease retryable', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_commit_gate');
    let service;
    service = serviceHarness({ store, analyze: async (_target, _signal, options) => {
        await store.setWorkspaceState('ws_commit_gate', 'suspended', { actorId: 'admin', reason: 'pause' });
        return { scores: {}, categories: {}, findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])) };
    } }).service;
    const project = await service.createProject('ws_commit_gate', { name: 'Gate', url: 'https://example.com/', locale: 'en' });
    await store.setWorkspaceState('ws_commit_gate', 'active', { actorId: 'admin', reason: 'allow initial queue' });
    const scan = await service.createScan('ws_commit_gate', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' });
    const [page] = await store.listScanPages('ws_commit_gate', scan.id);
    await assert.rejects(() => service.executeScanPage(scan.id, 'ws_commit_gate', page.pageKey), { code: 'WORKSPACE_EXECUTION_BLOCKED' });
    assert.equal((await store.listScanPages('ws_commit_gate', scan.id))[0].status, 'retrying');
    assert.equal((await store.getUsage('ws_commit_gate')).reserved, 1);
});
