const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL retention sweep has one cross-process winner per workspace', { skip: !databaseUrl }, async () => {
    const store = new PostgresPlatformStore(databaseUrl);
    const workspaceId = `ws_retention_lock_${crypto.randomUUID()}`;
    let releaseCleanup;
    let cleanupStartedResolve;
    const cleanupStarted = new Promise((resolve) => { cleanupStartedResolve = resolve; });
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    try {
        await store.ensureWorkspace(workspaceId);
        const project = await store.createProject(workspaceId, { name: 'Retention lock', origin: 'https://example.com/', locale: 'en' });
        const source = await store.createSourceInput(workspaceId, project.id, { kind: 'zip', status: 'completed', encryptedReference: 'retention-lock-artifact', purgeAt: '2020-01-01T00:00:00.000Z' });
        await store.pool.query(`UPDATE wpa_source_inputs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=$1`, [source.id]);

        const first = store.executeRetentionSweep(workspaceId, {
            now: new Date('2026-01-01T00:00:00.000Z'),
            dryRun: false,
            actorId: 'retention-a',
            artifactCleanup: async () => {
                cleanupStartedResolve();
                await cleanupGate;
            }
        });
        await cleanupStarted;
        const second = await store.executeRetentionSweep(workspaceId, {
            now: new Date('2026-01-01T00:00:00.000Z'),
            dryRun: false,
            actorId: 'retention-b',
            artifactCleanup: async () => {}
        });
        assert.deepEqual({ status: second.status, skipped: second.skipped, reason: second.reason }, { status: 'active', skipped: true, reason: 'RETENTION_SWEEP_ACTIVE' });
        releaseCleanup();
        const completed = await first;
        assert.equal(completed.status, 'completed');
        assert.equal(completed.deletedSourceInputs, 1);
    } finally {
        releaseCleanup?.();
        await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await store.close();
    }
});
