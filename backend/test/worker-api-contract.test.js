const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../config');
const { createApp } = require('../app');
const { MemoryPlatformStore } = require('../platform/store');

test('API PDF export enqueues a durable worker execution instead of rendering in-process', async () => {
    const store = new MemoryPlatformStore();
    const sent = [];
    const queue = {
        async start() {},
        async work() {},
        async send(name, data, options) { sent.push({ name, data, options }); return 'job-pdf-1'; },
        async close() {}
    };
    const config = loadConfig({ NODE_ENV: 'development', PDF_EXECUTION_DISABLED: 'true', WORKER_ENABLED: 'false' });
    const workspaceId = 'ws-worker-contract';
    await store.registerUser({ id: 'development-user', email: 'worker-contract@example.test' });
    await store.ensureWorkspace(workspaceId, { entitlementOwnerUserId: 'development-user' });
    await store.assignUserPlan('development-user', 'signal', {
        actorId: 'contract-fixture', reason: 'PDF export belongs to Signal and higher', requestId: 'worker-contract-plan'
    });
    const project = await store.createProject(workspaceId, { name: 'Contract', origin: 'https://example.com', locale: 'en' });
    const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com'] });
    const report = await store.saveReport(workspaceId, scan.id, { summary: { score: 1 } });
    const app = createApp({ config, platformStore: store, platformQueue: queue });
    try {
        const response = await request(app).get(`/api/v1/reports/${report.id}/export?format=pdf`).set('x-workspace-id', workspaceId);
        assert.equal(response.status, 202);
        assert.equal(response.body.execution.status, 'queued');
        const pdfJob = sent.find((item) => item.name === 'wpa-pdf-export');
        assert.ok(pdfJob);
        assert.equal(pdfJob.data.schemaVersion, 'wpa.worker-job.v1');
        assert.equal((await store.getExecutionResult(workspaceId, response.body.execution.id)).status, 'queued');
    } finally { await app.locals.closeResources(); }
});
