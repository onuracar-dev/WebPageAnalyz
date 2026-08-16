const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { PostgresPlatformStore } = require('../platform/store');
const { startWorker } = require('../platform/worker-handler');

class GuardedQueue {
    constructor() { this.handlers = new Map(); this.jobs = []; }
    async start() {}
    async work(name, handler) { this.handlers.set(name, handler); }
    async send(name, data, options = {}) { this.jobs.push({ name, data, options }); return `pg-job-${this.jobs.length}`; }
    async close() {}
}

test('PostgreSQL worker registers and completes scan/page envelopes only with an explicit test database', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not configured' }, async (t) => {
    const store = new PostgresPlatformStore(process.env.TEST_DATABASE_URL);
    const queue = new GuardedQueue();
    const workspaceId = `ws_pg_worker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker', DATABASE_URL: process.env.TEST_DATABASE_URL, WORKER_ENABLED: 'true' }), artifactDir: require('node:os').tmpdir(), retentionPollMs: 60_000, sourceArtifactJanitorMs: 60_000 };
    t.after(async () => { await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {}); await store.close(); });
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
        await store.ensureWorkspace(workspaceId);
        const project = await runtime.platformService.createProject(workspaceId, { name: 'PostgreSQL worker', url: 'https://example.com/', locale: 'en' });
        const scan = await runtime.platformService.createScan(workspaceId, { projectId: project.id, urls: ['https://example.com/'], locale: 'en' });
        const scanJob = queue.jobs.find((job) => job.name === 'wpa-scan' && job.data.workspaceId === workspaceId && job.data.scanId === scan.id);
        assert.ok(scanJob);
        await queue.handlers.get('wpa-scan')([{ data: scanJob.data }]);
        for (const pageJob of queue.jobs.filter((job) => job.name === 'wpa-scan-page' && job.data.workspaceId === workspaceId && job.data.scanId === scan.id)) await queue.handlers.get('wpa-scan-page')([{ data: pageJob.data }]);
        const finalScan = await store.getScan(workspaceId, scan.id);
        assert.equal(finalScan.status, 'completed');
        assert.equal((await store.getLatestReportForScan(workspaceId, scan.id)).status, 'automated_draft');
    } finally { await runtime.close(); }
});
