const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { startWorker, writePdfArtifact } = require('../platform/worker-handler');

class FakeQueue {
    constructor() { this.handlers = new Map(); this.jobs = []; }
    async start() {}
    async work(name, handler) { this.handlers.set(name, handler); }
    async send(name, data, options = {}) { this.jobs.push({ name, data, options }); return `job-${this.jobs.length}`; }
    async close() {}
}

test('application worker registers each canonical queue once; source owns OSV', async () => {
    const queue = new FakeQueue();
    const store = new MemoryPlatformStore();
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker' }), artifactDir: require('node:os').tmpdir(), retentionPollMs: 60_000, sourceArtifactJanitorMs: 60_000 };
    const runtime = await startWorker({ config, queue, store, logger: { warn() {} } });
    assert.deepEqual([...queue.handlers.keys()].sort(), ['wpa-pdf-export', 'wpa-scan', 'wpa-scan-page', 'wpa-source-audit']);
    await runtime.close();
});

test('maintenance worker owns retention without registering analysis queues', async () => {
    const store = new MemoryPlatformStore();
    const config = {
        ...loadConfig({
            NODE_ENV: 'test', EXECUTION_ROLE: 'maintenance',
            BROWSER_EXECUTION_DISABLED: 'true', PDF_EXECUTION_DISABLED: 'true',
            SOURCE_EXECUTION_DISABLED: 'true', OSV_EXECUTION_DISABLED: 'true'
        }),
        artifactDir: require('node:os').tmpdir(),
        sourceArtifactDir: require('node:os').tmpdir(),
        workerResultDir: require('node:os').tmpdir(),
        retentionPollMs: 60_000
    };
    const runtime = await startWorker({ config, store, logger: { warn() {} } , workerKind: 'maintenance' });
    try {
        assert.equal(runtime.store, store);
        assert.equal(runtime.queue, undefined);
        assert.equal(typeof runtime.platformService, 'undefined');
    } finally { await runtime.close(); }
});

test('worker page and scan handlers complete a full fenced scan lifecycle', async () => {
    const queue = new FakeQueue();
    const store = new MemoryPlatformStore();
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker', WORKER_ENABLED: 'true' }), artifactDir: require('node:os').tmpdir(), retentionPollMs: 60_000, sourceArtifactJanitorMs: 60_000 };
    const runtime = await startWorker({
        config,
        queue,
        store,
        logger: { warn() {}, info() {} },
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname }),
        analysisPool: { run: (task) => task(new AbortController().signal) },
        analysisService: { async analyze(_target, _signal, options) { return { scores: {}, categories: {}, findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])) }; } }
    });
    try {
        await store.ensureWorkspace('ws-page-worker');
        const project = await runtime.platformService.createProject('ws-page-worker', { name: 'Page worker', url: 'https://example.com/', locale: 'en' });
        const scan = await runtime.platformService.createScan('ws-page-worker', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' });
        const scanJob = queue.jobs.find((job) => job.name === 'wpa-scan');
        assert.ok(scanJob);
        await queue.handlers.get('wpa-scan')([{ data: scanJob.data }]);
        for (const pageJob of queue.jobs.filter((job) => job.name === 'wpa-scan-page')) await queue.handlers.get('wpa-scan-page')([{ data: pageJob.data }]);
        const finalScan = await store.getScan('ws-page-worker', scan.id);
        const report = await store.getLatestReportForScan('ws-page-worker', scan.id);
        assert.equal(finalScan.status, 'completed');
        assert.equal(report.status, 'automated_draft');
        assert.equal((await store.listScanPages('ws-page-worker', scan.id))[0].status, 'completed');
        assert.equal((await store.getUsage('ws-page-worker')).consumed, 1);
        assert.ok((await store.listScanEvents('ws-page-worker', scan.id)).some((event) => event.type === 'page.completed'));
        await queue.handlers.get('wpa-scan-page')([{ data: queue.jobs.find((job) => job.name === 'wpa-scan-page').data }]);
        assert.equal((await store.getLatestReportForScan('ws-page-worker', scan.id)).id, report.id);
        assert.equal((await store.getUsage('ws-page-worker')).consumed, 1);
    } finally { await runtime.close(); }
});

test('application worker turns WPA rendered-link output into singleton page work', async () => {
    const queue = new FakeQueue();
    const store = new MemoryPlatformStore();
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker', WORKER_ENABLED: 'true' }), artifactDir: require('node:os').tmpdir(), retentionPollMs: 60_000, sourceArtifactJanitorMs: 60_000 };
    const runtime = await startWorker({
        config,
        queue,
        store,
        logger: { warn() {}, info() {} },
        validateUrl: async (url) => ({ url: new URL(url).toString(), hostname: new URL(url).hostname }),
        analysisPool: { run: (task) => task(new AbortController().signal) },
        analysisService: { async analyze(target, _signal, options) {
            return {
                scores: {}, categories: {}, findings: [],
                ...(target.url === 'https://example.com/' ? { discovery: { renderedLinks: [{ url: '/spa', referrer: target.url }], coverage: { references: 1, uniqueLinks: 1, truncated: false } } } : {}),
                moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }]))
            };
        } }
    });
    try {
        const workspaceId = 'ws-rendered-worker';
        await store.ensureWorkspace(workspaceId);
        const project = await store.createProject(workspaceId, { name: 'Rendered worker', origin: 'https://example.com', locale: 'en' });
        await store.verifyProject(workspaceId, project.id, 'operator');
        const manifest = {
            schemaVersion: 2,
            project: { id: project.id, origin: 'https://example.com', authorizedOrigins: ['https://example.com'], verifiedAt: new Date().toISOString() },
            plan: { id: 'studio', limits: { pageCredits: 3 } },
            entitlements: { runtime: { executionMode: 'automated' }, full_site_crawl: { executionMode: 'automated' } },
            urls: ['https://example.com/'], locale: 'en',
            discovery: {
                status: 'completed',
                pages: [{ url: 'https://example.com/', sources: [{ type: 'root', referrer: null }] }],
                robotsByOrigin: { 'https://example.com': { disallow: [], allow: [], sitemaps: [] } },
                coverage: { truncated: false }
            }
        };
        const scan = await store.createScan(workspaceId, project.id, manifest);
        await store.reserveCredit(workspaceId, scan.id, 'https://example.com/', 3);
        await store.createScanPages(workspaceId, scan.id, manifest.urls);
        await runtime.platformService.executeScan(scan.id, workspaceId);
        let cursor = 0;
        while (cursor < queue.jobs.length) {
            const job = queue.jobs[cursor++];
            if (job.name === 'wpa-scan-page') await queue.handlers.get(job.name)([{ data: job.data }]);
        }

        const pages = await store.listScanPages(workspaceId, scan.id);
        assert.deepEqual(pages.map((page) => page.url), ['https://example.com/', 'https://example.com/spa']);
        assert.equal((await store.getLatestReportForScan(workspaceId, scan.id)).payload.coverage.crawler.rendered.queuedUniquePages, 1);
        assert.equal(queue.jobs.filter((job) => job.name === 'wpa-scan-page' && job.data.pageKey === pages[1].pageKey).length, 1);
    } finally { await runtime.close(); }
});

test('execution result claim is idempotent and stale workers cannot settle a reclaimed lease', async () => {
    const store = new MemoryPlatformStore();
    const created = await store.createExecutionResult({ jobKey: 'pdf:one', workspaceId: 'ws-1', kind: 'pdf', input: { reportId: 'r-1' } });
    assert.equal((await store.createExecutionResult({ jobKey: 'pdf:one', workspaceId: 'ws-1', kind: 'pdf', input: {} })).id, created.id);
    const first = await store.claimExecutionResult('pdf:one', { owner: 'worker-a', leaseMs: 10 });
    assert.equal((await store.claimExecutionResult('pdf:one', { owner: 'worker-b', leaseMs: 100_000 })), null);
    first.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    store.executionResults.get('pdf:one').leaseExpiresAt = first.leaseExpiresAt;
    const reclaimed = await store.claimExecutionResult('pdf:one', { owner: 'worker-b', leaseMs: 100_000 });
    assert.notEqual(reclaimed.leaseToken, first.leaseToken);
    assert.equal(await store.settleExecutionResult('pdf:one', { owner: 'worker-a', leaseToken: first.leaseToken, status: 'completed' }), null);
    assert.equal((await store.settleExecutionResult('pdf:one', { owner: 'worker-b', leaseToken: reclaimed.leaseToken, status: 'completed' })).status, 'completed');
});

test('worker handler rejects sandbox bypass values and disabled execution flags', async () => {
    const base = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker' }), artifactDir: require('node:os').tmpdir() };
    await assert.rejects(() => startWorker({ config: { ...base, chromeNoSandbox: true }, queue: new FakeQueue(), store: new MemoryPlatformStore() }), { code: 'WORKER_SANDBOX_DISABLED' });
    await assert.rejects(() => startWorker({ config: { ...base, pdfExecutionDisabled: true }, queue: new FakeQueue(), store: new MemoryPlatformStore() }), { code: 'WORKER_EXECUTION_DISABLED' });
});

test('PDF worker settles a durable result and writes a bounded artifact', async () => {
    const fs = require('node:fs').promises;
    const os = require('node:os');
    const artifactDir = await fs.mkdtemp(require('node:path').join(os.tmpdir(), 'wpa-worker-test-'));
    const queue = new FakeQueue();
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws-pdf-worker';
    await store.ensureWorkspace(workspaceId);
    const project = await store.createProject(workspaceId, { name: 'PDF', origin: 'https://example.com', locale: 'en' });
    const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com'] });
    const report = await store.saveReport(workspaceId, scan.id, { summary: { score: 1 } });
    const execution = await store.createExecutionResult({ jobKey: 'pdf:worker-test', workspaceId, kind: 'pdf', input: { reportId: report.id } });
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker' }), artifactDir, retentionPollMs: 60_000, sourceArtifactJanitorMs: 60_000 };
    const runtime = await require('../platform/worker-handler').startWorker({ config, queue, store, pdfRenderer: async () => Buffer.from('%PDF-1.7\n%PDF-test') });
    try {
        await queue.handlers.get('wpa-pdf-export')([{ data: { schemaVersion: 'wpa.worker-job.v1', kind: 'pdf', workspaceId, reportId: report.id, executionId: execution.id, jobKey: 'pdf:worker-test' } }]);
        const settled = await store.getExecutionResult(workspaceId, execution.id);
        assert.equal(settled.status, 'completed');
        assert.equal(await fs.readFile(settled.artifactPath, 'utf8'), '%PDF-1.7\n%PDF-test');
    } finally { await runtime.close(); await fs.rm(artifactDir, { recursive: true, force: true }); }
});

test('PDF artifact writer rejects traversal/invalid output and commits atomically', async () => {
    const fs = require('node:fs').promises;
    const os = require('node:os');
    const path = require('node:path');
    const workerResultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-pdf-artifact-'));
    try {
        await assert.rejects(() => writePdfArtifact({ workerResultDir }, '../escape', Buffer.from('%PDF-1.7')), { code: 'WORKER_ARTIFACT_ID_INVALID' });
        await assert.rejects(() => writePdfArtifact({ workerResultDir }, 'exec-invalid', Buffer.from('not-a-pdf')), { code: 'PDF_OUTPUT_INVALID' });
        const target = await writePdfArtifact({ workerResultDir }, 'exec-valid', Buffer.from('%PDF-1.7\nvalid'));
        if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
        assert.equal(await fs.readFile(target, 'utf8'), '%PDF-1.7\nvalid');
        assert.equal((await fs.readdir(path.join(workerResultDir, 'pdf'))).filter((name) => name.endsWith('.tmp')).length, 0);
    } finally { await fs.rm(workerResultDir, { recursive: true, force: true }); }
});
