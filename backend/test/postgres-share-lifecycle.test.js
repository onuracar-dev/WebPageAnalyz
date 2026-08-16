const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');
const { createPlatformService } = require('../platform/service');
const { loadConfig } = require('../config');

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL share lifecycle keeps the hash projection and fail-closed public states', { skip: !connectionString && 'TEST_DATABASE_URL is not configured' }, async () => {
    const workspaceId = `ws_share_${crypto.randomUUID()}`;
    const store = new PostgresPlatformStore(connectionString);
    const service = createPlatformService({
        store,
        queue: {},
        analysisPool: {},
        analysisService: {},
        validateUrl: async (value) => value,
        config: loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:5000', WORKER_ENABLED: 'false' }),
        logger: { warn() {}, info() {} }
    });
    try {
        await store.ensureWorkspace(workspaceId);
        const project = await store.createProject(workspaceId, { name: 'Share lifecycle proof', origin: 'https://example.com/', locale: 'en' });
        const scan = await store.createScan(workspaceId, project.id, { schemaVersion: 2, project: { id: project.id, origin: 'https://example.com/' }, plan: { id: 'signal' }, entitlements: {}, urls: ['https://example.com/'] });
        const report = await store.saveReport(workspaceId, scan.id, { summary: {}, modules: {}, pages: [] }, { status: 'published' });

        const share = await service.createShareLink(workspaceId, report.id, 'postgres-proof', 7);
        const detail = await store.getReport(workspaceId, report.id);
        assert.equal(typeof detail.shareTokenHash, 'string');
        assert.equal((await service.getSharedReport(share.token)).id, report.id);

        await store.setReportShareToken(workspaceId, report.id, detail.shareTokenHash, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
        await assert.rejects(() => service.getSharedReport(share.token), (error) => error.code === 'SHARED_REPORT_EXPIRED' && error.status === 410);

        const renewed = await service.createShareLink(workspaceId, report.id, 'postgres-proof', 30);
        const revoked = await service.revokeShareLink(workspaceId, report.id, 'postgres-proof');
        assert.equal(revoked.status, 'revoked');
        await assert.rejects(() => service.getSharedReport(renewed.token), (error) => error.code === 'SHARED_REPORT_NOT_FOUND' && error.status === 404);
    } finally {
        await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await store.close();
    }
});
