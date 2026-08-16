const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { loadConfig } = require('../config');
const { createApp } = require('../app');
const { PostgresPlatformStore } = require('../platform/store');
const { PostgresQueue } = require('../platform/queue');
const { startWorker } = require('../platform/worker-handler');
const os = require('node:os');
const fs = require('node:fs').promises;
const path = require('node:path');

const connectionString = process.env.TEST_DATABASE_URL;
const workerConnectionString = process.env.TEST_WORKER_DATABASE_URL || connectionString;
const seedConnectionString = process.env.TEST_DATABASE_SEED_URL || connectionString;
const TEST_TIMEOUT_MS = 45_000;
const OPERATION_TIMEOUT_MS = 10_000;

function withTimeout(label, operation, timeoutMs = OPERATION_TIMEOUT_MS) {
    let timer;
    const work = Promise.resolve().then(operation);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(label, operation, { timeoutMs = TEST_TIMEOUT_MS, intervalMs = 50 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = await operation();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

test('PostgreSQL API PDF export enqueues the canonical durable queue', { skip: !connectionString && 'TEST_DATABASE_URL is not configured', timeout: TEST_TIMEOUT_MS }, async () => {
    const workspaceId = `ws_pdf_queue_${crypto.randomUUID()}`;
    const store = new PostgresPlatformStore(connectionString);
    const queue = new PostgresQueue(connectionString);
    const config = loadConfig({
        NODE_ENV: 'test',
        EXECUTION_ROLE: 'api',
        DATABASE_URL: connectionString,
        WORKER_ENABLED: 'false',
        BROWSER_EXECUTION_DISABLED: 'true',
        PDF_EXECUTION_DISABLED: 'true',
        SOURCE_EXECUTION_DISABLED: 'true',
        OSV_EXECUTION_DISABLED: 'true',
        APP_URL: 'http://localhost:5000',
        CORS_ORIGINS: 'http://localhost:5173'
    });
    let jobId;
    const platformService = {
        async start() {},
        async close() {},
        // This fixture proves only the PostgreSQL queue boundary. Commercial
        // plan enforcement has its own focused API/service regression suite.
        async assertCommercialCapability() {},
        async getReport(scope, reportId) { return store.getReport(scope, reportId); }
    };
    const app = createApp({ config, platformStore: store, platformQueue: queue, platformService });
    let cleanupError;
    try {
        await withTimeout('workspace creation', () => store.ensureWorkspace(workspaceId));
        const project = await withTimeout('project creation', () => store.createProject(workspaceId, { name: 'PDF queue proof', origin: 'https://example.com/', locale: 'en' }));
        const scan = await withTimeout('scan creation', () => store.createScan(workspaceId, project.id, { urls: ['https://example.com/'] }));
        const report = await withTimeout('report creation', () => store.saveReport(workspaceId, scan.id, { summary: { score: 1 }, modules: {}, pages: [] }));
        const response = await withTimeout('PDF export request', () => request(app).get(`/api/v1/reports/${report.id}/export?format=pdf`).set('x-workspace-id', workspaceId).expect(202));
        assert.equal(response.body.execution.status, 'queued');
        assert.equal(response.body.execution.kind, 'pdf');
        jobId = response.body.jobId;
        assert.ok(jobId);
        assert.equal((await withTimeout('execution lookup', () => store.getExecutionResult(workspaceId, response.body.execution.id))).status, 'queued');
        const queued = await withTimeout('canonical queue lookup', () => queue.boss.getQueue('wpa-pdf-export'));
        assert.equal(queued.name, 'wpa-pdf-export');
    } finally {
        const cleanupErrors = [];
        if (jobId) await withTimeout('PDF queue cleanup', () => store.pool.query('DELETE FROM wpa_queue.job_common WHERE name=$1 AND id=$2', ['wpa-pdf-export', jobId])).catch((error) => cleanupErrors.push(error));
        await withTimeout('workspace cleanup', () => store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId])).catch((error) => cleanupErrors.push(error));
        await withTimeout('queue shutdown', () => queue.close()).catch((error) => cleanupErrors.push(error));
        await withTimeout('app resource shutdown', () => app.locals.closeResources()).catch((error) => cleanupErrors.push(error));
        if (cleanupErrors.length) cleanupError = new Error(`PDF queue proof cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
    }
    if (cleanupError) throw cleanupError;
});

test('PostgreSQL PDF worker consumes the canonical queue and persists a verified artifact', { skip: !connectionString && 'TEST_DATABASE_URL is not configured', timeout: TEST_TIMEOUT_MS }, async (t) => {
    const workspaceId = `ws_pdf_worker_${crypto.randomUUID()}`;
    const resultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-pdf-worker-'));
    const store = new PostgresPlatformStore(workerConnectionString);
    const seedStore = new PostgresPlatformStore(seedConnectionString);
    const queue = new PostgresQueue(workerConnectionString);
    const config = loadConfig({
        NODE_ENV: 'test',
        EXECUTION_ROLE: 'worker',
        DATABASE_URL: workerConnectionString,
        DATABASE_EXPECTED_ROLE: 'wpa_worker',
        WORKER_ENABLED: 'false',
        BROWSER_EXECUTION_DISABLED: 'false',
        PDF_EXECUTION_DISABLED: 'false',
        SOURCE_EXECUTION_DISABLED: 'false',
        OSV_EXECUTION_DISABLED: 'false',
        ARTIFACT_DIR: resultRoot,
        WORKER_RESULT_DIR: resultRoot,
        APP_URL: 'http://localhost:5000'
    });
    let runtime;
    t.after(async () => {
        const cleanupErrors = [];
        await withTimeout('worker runtime shutdown', () => runtime?.close?.()).catch((error) => cleanupErrors.push(error));
        await withTimeout('queue shutdown', () => queue.close()).catch((error) => cleanupErrors.push(error));
        await withTimeout('workspace cleanup', () => seedStore.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId])).catch((error) => cleanupErrors.push(error));
        await withTimeout('store shutdown', () => store.close()).catch((error) => cleanupErrors.push(error));
        await withTimeout('seed store shutdown', () => seedStore.close()).catch((error) => cleanupErrors.push(error));
        await fs.rm(resultRoot, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
        if (cleanupErrors.length) throw new Error(`PDF worker cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
    });

    await withTimeout('worker startup', async () => {
        runtime = await startWorker({
            config,
            queue,
            store,
            logger: { warn() {}, info() {} },
            pdfRenderer: async () => Buffer.from('%PDF-1.7\nWPA durable export\n', 'ascii'),
            platformService: { async start() {}, async close() {} }
        });
    });

    await withTimeout('workspace creation', () => seedStore.ensureWorkspace(workspaceId));
    const project = await withTimeout('project creation', () => seedStore.createProject(workspaceId, { name: 'PDF worker proof', origin: 'https://example.com/', locale: 'en' }));
    const scan = await withTimeout('scan creation', () => seedStore.createScan(workspaceId, project.id, { urls: ['https://example.com/'] }));
    const report = await withTimeout('report creation', () => seedStore.saveReport(workspaceId, scan.id, { summary: { score: 1 }, modules: {}, pages: [] }));
    const jobKey = `pdf:${workspaceId}:${report.id}`;
    const execution = await withTimeout('execution creation', () => store.createExecutionResult({ jobKey, workspaceId, kind: 'pdf', input: { reportId: report.id } }));
    const jobId = await withTimeout('PDF worker enqueue', () => queue.send('wpa-pdf-export', { schemaVersion: 'wpa.worker-job.v1', kind: 'pdf', workspaceId, reportId: report.id, executionId: execution.id, jobKey }));
    assert.ok(jobId);

    const completed = await waitFor('PDF execution completion', async () => {
        const current = await withTimeout('execution status lookup', () => store.getExecutionResult(workspaceId, execution.id));
        return ['completed', 'failed', 'unavailable'].includes(current?.status) ? current : null;
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.contentType, 'application/pdf');
    assert.ok(completed.artifactPath);
    const artifact = await fs.readFile(completed.artifactPath);
    assert.equal(artifact.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.equal(artifact.length, Number(completed.bytes));
});
