const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createRetentionArtifactCleanup, createRetentionExecutor } = require('../platform/worker-handler');

test('retention removes only eligible rows and managed artifacts with plan counts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-retention-'));
    const sourceRoot = path.join(root, 'source-inputs');
    const resultRoot = path.join(root, 'worker-results');
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(resultRoot, { recursive: true });
    try {
        const store = new MemoryPlatformStore();
        const workspaceId = 'ws-retention-disposable';
        await store.ensureWorkspace(workspaceId);
        const project = await store.createProject(workspaceId, { name: 'Retention', url: 'https://example.com/' });
        const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com/'] });
        const report = await store.saveReport(workspaceId, scan.id, { summary: {} });
        const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
        report.createdAt = old;
        const sourcePath = path.join(sourceRoot, 'old.enc');
        const resultPath = path.join(resultRoot, 'old.pdf');
        await fs.writeFile(sourcePath, 'source');
        await fs.writeFile(resultPath, 'pdf');
        const source = await store.createSourceInput(workspaceId, project.id, { kind: 'zip', status: 'completed', encryptedReference: sourcePath, purgeAt: old });
        source.createdAt = old;
        const execution = await store.createExecutionResult({ jobKey: 'pdf:retention-disposable', workspaceId, kind: 'pdf', input: {} });
        Object.assign(store.executionResults.get(execution.jobKey), { status: 'completed', artifactPath: resultPath, completedAt: old, updatedAt: old });
        const cleanup = createRetentionArtifactCleanup({ config: { sourceArtifactDir: sourceRoot, workerResultDir: resultRoot }, store });
        const run = await store.executeRetentionSweep(workspaceId, { now: new Date(), dryRun: false, actorId: 'test-retention', artifactCleanup: cleanup });
        assert.equal(run.status, 'completed');
        assert.equal(run.deletedCount, 1);
        assert.equal(run.deletedSourceInputs, 1);
        assert.equal(run.deletedExecutions, 1);
        assert.equal(await store.getReport(workspaceId, report.id), null);
        assert.equal(await store.getSourceInput(workspaceId, source.id), null);
        assert.equal(await fs.stat(sourcePath).catch(() => null), null);
        assert.equal(await fs.stat(resultPath).catch(() => null), null);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('retention rejects artifact paths outside worker-managed roots', async () => {
    const store = new MemoryPlatformStore();
    const cleanup = createRetentionArtifactCleanup({ config: { sourceArtifactDir: path.join(os.tmpdir(), 'wpa-source-root'), workerResultDir: path.join(os.tmpdir(), 'wpa-result-root') }, store });
    await assert.rejects(() => cleanup(path.join(os.tmpdir(), 'outside-secret.txt')), { code: 'RETENTION_PATH_REJECTED' });
    assert.equal(store.auditLog[0].action, 'retention.artifact_path_rejected');
});

test('worker retention lifecycle dry-runs due deletion and actual deletion is explicit and idempotent', async () => {
    const store = new MemoryPlatformStore();
    const workspaceId = 'ws-deletion-disposable';
    await store.ensureWorkspace(workspaceId);
    const project = await store.createProject(workspaceId, { name: 'Delete', url: 'https://example.com/' });
    const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com/'] });
    await store.saveReport(workspaceId, scan.id, { summary: {} });
    const request = await store.requestWorkspaceDeletion(workspaceId, 'owner');
    await store.authorizeWorkspaceDeletion(workspaceId, 'admin');
    request.graceUntil = new Date(Date.now() - 1_000).toISOString();
    const config = { ...loadConfig({ NODE_ENV: 'test', EXECUTION_ROLE: 'worker' }), sourceArtifactDir: path.join(os.tmpdir(), 'wpa-source-root'), workerResultDir: path.join(os.tmpdir(), 'wpa-result-root'), retentionPollMs: 60_000 };
    const executor = createRetentionExecutor({ config, store, logger: { warn() {} } });
    const dryResults = await executor.runOnce();
    assert.ok(dryResults.some((result) => result?.status === 'ready'));
    assert.ok(await store.getWorkspace(workspaceId));
    await executor.close();
    const completed = await store.executeWorkspaceDeletion(workspaceId, { now: new Date(), dryRun: false, actorId: 'test-admin', artifactCleanup: async () => {} });
    assert.equal(completed.status, 'completed');
    assert.equal((await store.executeWorkspaceDeletion(workspaceId, { now: new Date(), dryRun: false })).idempotent, true);
    assert.equal(await store.getWorkspace(workspaceId), null);
    assert.equal(store.deletionRuns.get(completed.runId).status, 'completed');
});
