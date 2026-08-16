const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createPlatformService } = require('../platform/service');

function harness({ analyzers = {}, resolveTxt, analyze, crawler, validateUrl } = {}) {
    const store = new MemoryPlatformStore();
    const handlers = new Map();
    const queued = [];
    const queue = {
        async start() {},
        async work(name, next) { handlers.set(name, next); },
        async send(name, data, options = {}) { queued.push({ name, data, options, attempts: 0 }); return `job_${queued.length}`; },
        async close() {}
    };
    const config = loadConfig({ NODE_ENV: 'test', WORKER_ENABLED: 'true' });
    const service = createPlatformService({
        store,
        queue,
        config,
        logger: { info() {}, warn() {}, error() {} },
        validateUrl: validateUrl || (async (url) => ({ url, hostname: new URL(url).hostname })),
        analysisPool: { stats: { active: 0 }, run: (task) => task(new AbortController().signal) },
        analysisService: { analyze: analyze || (async (_target, _signal, options) => ({ scores: {}, categories: {}, findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: analyzers[engineId] || 'completed', coverage: { truncated: false } }])) })) },
        crawler: crawler || (async (origin) => ({ version: '1.0.0', status: 'completed', urls: [origin], pages: [{ url: origin, status: 200, discoverySource: 'root', referrer: null }], findings: [], coverage: { attemptedPages: 1, reachablePages: 1, brokenPages: 0, truncated: false } })),
        ...(resolveTxt ? { resolveTxt } : {})
    });
    const runJobs = async () => {
        let guard = 0;
        while (queued.length && guard++ < 100) {
            const job = queued.shift(); job.attempts += 1;
            try { await handlers.get(job.name)([{ data: job.data }]); }
            catch (error) { if (job.attempts <= (job.options.retryLimit || 0)) queued.push(job); else throw error; }
        }
        assert.ok(guard < 100, 'queue drain must remain bounded');
    };
    return { store, service, queued, runJob: runJobs };
}

test('plan entitlement service allows only launch-executable canonical modules', async () => {
    const { service } = harness();
    for (const moduleId of ['monitoring', 'white_label', 'not_a_module']) {
        await assert.rejects(() => service.setPlanEntitlement('signal', moduleId, { executionMode: 'automated' }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
    }
    const plan = await service.setPlanEntitlement('signal', 'expert_review', { executionMode: 'operator_assisted', limit: 1 });
    assert.deepEqual(plan.entitlements.expert_review, { executionMode: 'operator_assisted', limit: 1 });
});

test('DNS ownership verification requires the exact per-project challenge', async () => {
    let expected;
    const { store, service } = harness({ resolveTxt: async () => [[expected]] });
    await store.ensureWorkspace('ws_verify');
    const project = await service.createProject('ws_verify', { name: 'Owned', url: 'https://app.example.com/', locale: 'en' });
    assert.ok(project.verificationToken.length >= 24);
    expected = `wpa-verification=${project.verificationToken}`;
    const verified = await service.verifyProject('ws_verify', project.id, 'dns');
    assert.equal(verified.verificationMethod, 'dns');
    assert.ok(verified.verifiedAt);
});

test('reclaimed page cannot be completed by a stale lease owner', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_fence');
    const project = await store.createProject('ws_fence', { name: 'Fence', url: 'https://example.com/', locale: 'en' });
    const scan = await store.createScan('ws_fence', project.id, { urls: ['https://example.com/'] });
    const [page] = await store.createScanPages('ws_fence', scan.id, ['https://example.com/'], { maxAttempts: 3 });
    const first = await store.claimScanPage('ws_fence', scan.id, page.pageKey, { owner: 'worker-a', leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.claimScanPage('ws_fence', scan.id, page.pageKey, { owner: 'worker-b', leaseMs: 10_000 });
    assert.notEqual(first.leaseToken, second.leaseToken);
    assert.equal(await store.completeScanPage('ws_fence', scan.id, page.pageKey, { status: 'completed', leaseOwner: first.leaseOwner, leaseToken: first.leaseToken }), null);
    const current = await store.completeScanPage('ws_fence', scan.id, page.pageKey, { status: 'completed', leaseOwner: second.leaseOwner, leaseToken: second.leaseToken });
    assert.equal(current.status, 'completed');
});

test('rendered page append is race-safe, credit-bounded and merges provenance idempotently', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_append_race');
    const project = await store.createProject('ws_append_race', { name: 'Append', url: 'https://example.com/', locale: 'en' });
    const scan = await store.createScan('ws_append_race', project.id, { urls: ['https://example.com/'] });
    await store.reserveCredit('ws_append_race', scan.id, 'https://example.com/', 3);
    await store.createScanPages('ws_append_race', scan.id, ['https://example.com/'], {
        provenanceByUrl: { 'https://example.com/': { sources: [{ type: 'root', referrer: null }] } }
    });

    const [left, right] = await Promise.all([
        store.appendScanPagesWithCredits('ws_append_race', scan.id, [
            { url: 'https://example.com/a', source: { type: 'rendered_link', referrer: 'https://example.com/' } },
            { url: 'https://example.com/b', source: { type: 'rendered_link', referrer: 'https://example.com/' } }
        ], { pageLimit: 3, creditLimit: 3 }),
        store.appendScanPagesWithCredits('ws_append_race', scan.id, [
            { url: 'https://example.com/a', source: { type: 'rendered_link', referrer: 'https://example.com/other' } },
            { url: 'https://example.com/c', source: { type: 'rendered_link', referrer: 'https://example.com/other' } }
        ], { pageLimit: 3, creditLimit: 3 })
    ]);

    const pages = await store.listScanPages('ws_append_race', scan.id);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((page) => page.pageIndex), [0, 1, 2]);
    assert.equal(new Set(pages.map((page) => page.url)).size, 3);
    assert.equal(pages.find((page) => page.url === 'https://example.com/a').discovery.sources.length, 2);
    assert.equal(left.inserted.length + right.inserted.length, 2);
    assert.equal(left.rejected.length + right.rejected.length, 1);
    assert.equal((await store.getUsage('ws_append_race')).reserved, 3);

    const retry = await store.appendScanPagesWithCredits('ws_append_race', scan.id, [
        { url: 'https://example.com/a', source: { type: 'rendered_link', referrer: 'https://example.com/' } }
    ], { pageLimit: 3, creditLimit: 3 });
    assert.equal(retry.idempotent, true);
    assert.equal((await store.getUsage('ws_append_race')).reserved, 3);
});

test('workspace export omits encrypted source references and deletion is an auditable request', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_export');
    const project = await store.createProject('ws_export', { name: 'Export', url: 'https://example.com/', locale: 'en' });
    await store.createSourceInput('ws_export', project.id, { kind: 'zip', status: 'queued', encryptedReference: 'secret/path', purgeAt: new Date(Date.now() + 60_000).toISOString() });
    const exported = await store.exportWorkspace('ws_export');
    assert.equal(Object.hasOwn(exported.sourceInputs[0], 'encryptedReference'), false);
    const deletion = await store.requestWorkspaceDeletion('ws_export', 'owner-1');
    assert.equal(deletion.status, 'requested');
    assert.equal(store.auditLog[0].action, 'workspace.deletion_requested');
});

test('retention uses the active plan window and deletion stays gated by grace and authorization', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_lifecycle');
    const scan = await store.createScan('ws_lifecycle', 'project', { urls: ['https://example.com/'] });
    const report = await store.saveReport('ws_lifecycle', scan.id, { summary: {} });
    report.createdAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const dryRun = await store.executeRetentionSweep('ws_lifecycle', { dryRun: true });
    assert.equal(dryRun.retentionDays, 7);
    assert.equal(dryRun.candidateCount, 1);
    assert.equal((await store.getReport('ws_lifecycle', report.id)).id, report.id);
    const request = await store.requestWorkspaceDeletion('ws_lifecycle', 'owner-1');
    assert.equal((await store.executeWorkspaceDeletion('ws_lifecycle', { dryRun: true })).status, 'not_due');
    await store.authorizeWorkspaceDeletion('ws_lifecycle', 'admin-1');
    assert.equal((await store.executeWorkspaceDeletion('ws_lifecycle', { dryRun: true })).status, 'not_due');
    request.graceUntil = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await store.executeWorkspaceDeletion('ws_lifecycle', { dryRun: true })).status, 'ready');
});

test('DNS ownership verification rejects a mismatched challenge', async () => {
    const { store, service } = harness({ resolveTxt: async () => [['wpa-verification=someone-else']] });
    await store.ensureWorkspace('ws_verify_bad');
    const project = await service.createProject('ws_verify_bad', { name: 'Unowned', url: 'https://example.com/', locale: 'en' });
    await assert.rejects(() => service.verifyProject('ws_verify_bad', project.id, 'dns'), (error) => error.code === 'TARGET_VERIFICATION_MISMATCH');
    assert.equal((await store.getProject('ws_verify_bad', project.id)).verifiedAt, null);
});

test('expired DNS verification is revalidated and revoked before an ownership-only scan', async () => {
    let record = '';
    const { store, service } = harness({ resolveTxt: async () => [[record]] });
    await store.ensureWorkspace('ws_verify_recheck');
    const project = await service.createProject('ws_verify_recheck', { name: 'Recheck', url: 'https://example.com/', locale: 'en' });
    record = `wpa-verification=${project.verificationToken}`;
    await service.verifyProject('ws_verify_recheck', project.id, 'dns');
    const stored = await store.getProject('ws_verify_recheck', project.id);
    stored.verificationExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const scan = await service.createScan('ws_verify_recheck', { projectId: project.id, locale: 'en' });
    assert.equal(scan.manifest.project.accessMode, 'verified_origin');
    assert.ok((await store.getProject('ws_verify_recheck', project.id)).verificationExpiresAt);

    record = 'wpa-verification=removed';
    stored.verificationExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await assert.rejects(() => service.createScan('ws_verify_recheck', { projectId: project.id, modules: ['full_site_crawl'], locale: 'en' }), { code: 'TARGET_VERIFICATION_REVOKED' });
    assert.equal((await store.getProject('ws_verify_recheck', project.id)).verifiedAt, null);
});

test('queued ownership-only pages revalidate DNS immediately before execution', async () => {
    let record = '';
    const { store, service, queued } = harness({ resolveTxt: async () => [[record]] });
    await store.ensureWorkspace('ws_verify_queued');
    await service.assignPlan('ws_verify_queued', 'studio');
    const project = await service.createProject('ws_verify_queued', { name: 'Queued', url: 'https://example.com/', locale: 'en' });
    record = `wpa-verification=${project.verificationToken}`;
    await service.verifyProject('ws_verify_queued', project.id, 'dns');
    const scan = await service.createScan('ws_verify_queued', { projectId: project.id, modules: ['full_site_crawl'], urls: ['https://example.com/'], locale: 'en' });
    const page = (await store.listScanPages('ws_verify_queued', scan.id))[0];
    const current = await store.getProject('ws_verify_queued', project.id);
    current.verificationExpiresAt = new Date(Date.now() - 1_000).toISOString();
    record = 'wpa-verification=removed';
    await assert.rejects(() => service.executeScanPage(scan.id, 'ws_verify_queued', page.pageKey), { code: 'TARGET_VERIFICATION_REVOKED' });
    assert.equal((await store.getProject('ws_verify_queued', project.id)).verifiedAt, null);
    assert.equal(queued.length, 1);
});

test('report summaries use a bounded DTO, stable composite cursor and CAS updates', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_summary');
    const scan = await store.createScan('ws_summary', 'project', { urls: ['https://example.com/'] });
    const first = await store.saveReport('ws_summary', scan.id, { summary: { completedPages: 1 }, pages: [{ huge: 'not-listed' }] });
    const second = await store.saveReport('ws_summary', `${scan.id}-2`, { summary: { completedPages: 2 }, pages: [{ huge: 'not-listed' }] });
    first.createdAt = second.createdAt;
    const page = await store.listReportSummaries('ws_summary', { limit: 1 });
    assert.equal(page[0].payload, undefined);
    assert.deepEqual(page.nextCursor, { createdAt: page[0].createdAt, id: page[0].id });
    const next = await store.listReportSummaries('ws_summary', { limit: 1, cursor: page.nextCursor });
    assert.notEqual(next[0].id, page[0].id);
    assert.equal(await store.updateReport('ws_summary', first.id, { status: 'operator_completed' }, { expectedVersion: first.version }) !== null, true);
    assert.equal(await store.updateReport('ws_summary', first.id, { status: 'published' }, { expectedVersion: first.version }), null);
});

test('an unverified Signal target can run the public-link engine set', async () => {
    const { store, service, queued } = harness();
    await store.ensureWorkspace('ws_signal_link');
    const project = await service.createProject('ws_signal_link', { name: 'Public link', url: 'https://example.com/', locale: 'en' });
    const scan = await service.createScan('ws_signal_link', { projectId: project.id, locale: 'en' });
    assert.equal(project.verifiedAt, null);
    assert.equal(scan.manifest.project.accessMode, 'public_link');
    assert.deepEqual(Object.keys(scan.manifest.entitlements), ['core_audit', 'runtime', 'seo', 'geo', 'design', 'backend_surface']);
    assert.equal(queued.length, 1);
});

test('an unverified Studio target defaults to link-safe modules and omits ownership-only engines', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_studio_link');
    await service.assignPlan('ws_studio_link', 'studio');
    const project = await service.createProject('ws_studio_link', { name: 'Public link', url: 'https://example.com/', locale: 'en' });
    const scan = await service.createScan('ws_studio_link', { projectId: project.id, locale: 'en' });
    assert.equal(scan.manifest.entitlements.performance_plus.executionMode, 'automated');
    assert.equal(scan.manifest.entitlements.full_site_crawl, undefined);
    assert.equal(scan.manifest.entitlements.passive_security, undefined);
});

test('an unverified target cannot explicitly request an ownership-only module', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_studio_owned');
    await service.assignPlan('ws_studio_owned', 'studio');
    const project = await service.createProject('ws_studio_owned', { name: 'Unverified', url: 'https://example.com/', locale: 'en' });
    await assert.rejects(
        () => service.createScan('ws_studio_owned', { projectId: project.id, modules: ['core_audit', 'full_site_crawl'], locale: 'en' }),
        (error) => error.code === 'TARGET_VERIFICATION_REQUIRED' && /full_site_crawl/.test(error.message)
    );
    assert.equal((await store.listScans('ws_studio_owned')).length, 0);
});

test('platform scan snapshots entitlements and consumes one credit for desktop plus mobile', async () => {
    const { store, service, queued, runJob } = harness();
    await store.ensureWorkspace('ws_test');
    const project = await service.createProject('ws_test', { name: 'Example', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_test', project.id, 'operator');
    const scan = await service.createScan('ws_test', {
        projectId: project.id,
        urls: ['https://example.com/?utm_source=test#hero'],
        locale: 'en'
    });
    assert.equal(queued.length, 1);
    assert.deepEqual(scan.manifest.devices, ['desktop', 'mobile']);
    assert.equal(scan.manifest.entitlements.core_audit.executionMode, 'automated');
    assert.deepEqual(await store.getUsage('ws_test'), { periodStart: new Date().toISOString().slice(0, 7) + '-01', reserved: 1, consumed: 0 });
    await runJob();
    assert.equal((await service.getScan('ws_test', scan.id)).status, 'completed');
    assert.equal((await store.getUsage('ws_test')).consumed, 1);
    assert.equal((await service.listReports('ws_test')).length, 1);
});

test('customer scan progress persists engine lifecycle events with page correlation', async () => {
    const { store, service, runJob } = harness({
        analyze: async (_target, _signal, options) => {
            await options.onProgress({
                type: 'analysis.plan',
                payload: { engines: options.engineIds.map((engineId) => ({ executionId: engineId, engineIds: [engineId], resourceClass: engineId === 'yellowLab' ? 'external' : 'browser', timeoutBudgetMs: 90_000 })) }
            });
            await options.onProgress({ type: 'engine.running', payload: { executionId: 'lighthouse', engineIds: ['lighthouse'], resourceClass: 'browser', status: 'running' } });
            await options.onProgress({ type: 'engine.completed', payload: { executionId: 'lighthouse', engineIds: ['lighthouse'], resourceClass: 'browser', status: 'completed', executionMs: 1200 } });
            return { scores: {}, categories: {}, findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])) };
        }
    });
    await store.ensureWorkspace('ws_engine_progress');
    const project = await service.createProject('ws_engine_progress', { name: 'Progress', url: 'https://example.com/', locale: 'en' });
    const scan = await service.createScan('ws_engine_progress', { projectId: project.id, locale: 'en' });
    await runJob();

    const progress = await service.getScanProgress('ws_engine_progress', scan.id, { after: 0 });
    const page = progress.pages[0];
    const plan = progress.events.find((event) => event.type === 'analysis.plan');
    const running = progress.events.find((event) => event.type === 'engine.running');
    const completed = progress.events.find((event) => event.type === 'engine.completed');
    assert.ok(plan);
    assert.equal(plan.payload.pageKey, page.pageKey);
    assert.equal(plan.payload.pageIndex, 0);
    assert.equal(running.payload.pageKey, page.pageKey);
    assert.equal(completed.payload.executionMs, 1200);
    assert.equal(completed.payload.status, 'completed');
    assert.equal(completed.payload.url, undefined);
});

test('a requested engine unavailable makes the report incomplete and releases reserved credit', async () => {
    const { store, service, runJob } = harness({ analyzers: { lighthouse: 'completed', axe: 'unavailable', yellowLab: 'completed', wpaPage: 'completed' } });
    await store.ensureWorkspace('ws_test');
    const project = await service.createProject('ws_test', { name: 'Example', url: 'https://example.com/', locale: 'tr' });
    await service.verifyProject('ws_test', project.id, 'operator');
    const scan = await service.createScan('ws_test', { projectId: project.id, locale: 'tr' });
    await runJob();
    const completed = await service.getScan('ws_test', scan.id);
    assert.equal(completed.status, 'partial');
    assert.equal(completed.failureCode, 'REQUESTED_CAPABILITY_INCOMPLETE');
    assert.deepEqual(await store.getUsage('ws_test'), { periodStart: new Date().toISOString().slice(0, 7) + '-01', reserved: 0, consumed: 0 });
    const report = (await service.listReports('ws_test'))[0];
    assert.equal(report.status, 'automated_incomplete');
    assert.equal(report.payload.modules.core_audit.status, 'unavailable');
});

test('studio advanced modules are automated and do not create placeholder operator tasks', async () => {
    const { store, service, runJob } = harness();
    await store.ensureWorkspace('ws_studio');
    await service.assignPlan('ws_studio', 'studio');
    const project = await service.createProject('ws_studio', { name: 'Example', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_studio', project.id, 'operator');
    const scan = await service.createScan('ws_studio', { projectId: project.id, locale: 'en' });
    await runJob();
    assert.equal((await service.getScan('ws_studio', scan.id)).status, 'completed');
    const tasks = await service.listOperatorTasks('pending');
    assert.equal(tasks.length, 0);
    const versions = await service.listReports('ws_studio');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].status, 'automated_draft');
    await assert.rejects(service.createShareLink('ws_studio', versions[0].id), { code: 'REPORT_NOT_PUBLISHED' });
});

test('expert review is separately requested, decided and versioned by a human reviewer', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_expert');
    await service.assignPlan('ws_expert', 'enterprise');
    await service.grantEntitlement('ws_expert', {
        source: 'admin', entitlementOverrides: { expert_review: { executionMode: 'operator_assisted', limit: 1 } }, expiresAt: '2099-01-01T00:00:00.000Z'
    }, { actorId: 'admin', reason: 'Assigned review fixture', requestId: 'review-grant-1' });
    const project = await service.createProject('ws_expert', { name: 'Example', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_expert', project.id, 'operator');
    const scan = await store.createScan('ws_expert', project.id, { plan: { id: 'enterprise' }, urls: ['https://example.com/'] });
    const finding = { fingerprint: 'a'.repeat(64), title: 'Measured issue', severity: 'high', pageUrl: 'https://example.com/', evidence: [{ type: 'metric', value: 1 }], remediation: 'Fix it' };
    const report = await store.saveReport('ws_expert', scan.id, { pages: [{ url: 'https://example.com/', report: { findings: [finding] } }] }, { status: 'automated_draft', locale: 'en' });
    const review = await service.requestExpertReview('ws_expert', report.id, { pageUrls: ['https://example.com/'], idempotencyKey: 'review-1' }, 'customer');
    await service.claimExpertReview(review.id, 'expert', { reason: 'Claim assigned review', requestId: 'expert-claim-1' });
    await service.decideExpertFinding(review.id, finding.fingerprint, { decision: 'accepted', priority: 'p1', rationale: '' }, 'expert', { reason: 'Finding evidence accepted', requestId: 'expert-decision-1' });
    await assert.rejects(() => service.finalizeExpertReview(review.id, 'expert'), { code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
    const finalized = await service.finalizeExpertReview(review.id, 'expert', { reason: 'All scoped findings reviewed', requestId: 'expert-finalize-1' });
    assert.equal(finalized.status, 'ready_to_publish');
    let versions = await service.listReports('ws_expert');
    assert.equal(versions[0].status, 'expert_reviewed');
    assert.equal(versions[0].payload.pages[0].report.findings[0].expertReview.decision, 'accepted');
    await assert.rejects(() => service.publishReport('ws_expert', finalized.reportId, { actorId: 'super-admin' }), { code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
    await assert.rejects(() => service.publishExpertReview(review.id, 'super-admin'), { code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
    const publishedReview = await service.publishExpertReview(review.id, 'super-admin', { reason: 'Approved Expert Review publication', requestId: 'expert-publish-1' });
    assert.equal(publishedReview.status, 'published');
    versions = await service.listReports('ws_expert');
    const share = await service.createShareLink('ws_expert', versions[0].id, 'owner', 7);
    assert.match(share.pagePath, /^\/shared-reports\/[A-Za-z0-9_-]{43}$/);
    assert.equal(share.path, share.pagePath);
    assert.equal(share.apiPath, `/api/v1/shared-reports/${share.token}`);
    assert.equal(share.expiresInDays, 7);
    await assert.rejects(() => service.createShareLink('ws_expert', versions[0].id, 'owner', 14), { code: 'SHARE_EXPIRY_INVALID' });
    const publicReport = await service.getSharedReport(share.token);
    assert.equal(publicReport.status, 'published');
    assert.equal(publicReport.workspaceId, undefined);
    assert.equal(publicReport.scanId, undefined);
    assert.equal(publicReport.payload.pages[0].url, 'https://example.com/');
    const storedReport = await store.getReport('ws_expert', versions[0].id);
    storedReport.shareExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await assert.rejects(() => service.getSharedReport(share.token), { code: 'SHARED_REPORT_EXPIRED' });
    storedReport.shareExpiresAt = share.expiresAt;
    await service.revokeShareLink('ws_expert', versions[0].id, 'owner');
    await assert.rejects(() => service.getSharedReport(share.token), { code: 'SHARED_REPORT_NOT_FOUND' });
});

test('admin-assigned Expert Review entitlement is not coupled to the Enterprise plan name', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_assigned_review');
    await service.assignPlan('ws_assigned_review', 'studio');
    await service.grantEntitlement('ws_assigned_review', {
        source: 'admin', entitlementOverrides: { expert_review: { executionMode: 'operator_assisted', limit: 1 } }, expiresAt: '2099-01-01T00:00:00.000Z'
    }, { actorId: 'admin', reason: 'Assigned review fixture', requestId: 'review-grant-2' });
    const scan = await store.createScan('ws_assigned_review', 'project', { plan: { id: 'studio' }, urls: ['https://example.com/'] });
    const report = await store.saveReport('ws_assigned_review', scan.id, { pages: [{ url: 'https://example.com/', report: {} }] }, { status: 'automated_draft' });
    const review = await service.requestExpertReview('ws_assigned_review', report.id, { pageUrls: ['https://example.com/'], idempotencyKey: 'assigned-1' }, 'admin');
    assert.equal(review.sourceReportId, report.id);
});

test('customer findings endpoint data includes every finding from the latest report version', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_findings');
    const scan = await store.createScan('ws_findings', 'project', { plan: { id: 'signal' }, urls: ['https://example.com/'] });
    const makeFinding = (index) => ({ fingerprint: String(index).padStart(64, '0'), title: `Finding ${index}`, severity: index === 1 ? 'high' : 'low', normalizedImpact: index === 1 ? 75 : 25 });
    await store.saveReport('ws_findings', scan.id, { pages: [{ url: 'https://example.com/', report: { findings: [makeFinding(1)] } }] });
    await store.saveReport('ws_findings', scan.id, { pages: [{ url: 'https://example.com/', report: { findings: [makeFinding(2), makeFinding(3)] } }] });

    const result = await service.listFindings('ws_findings', { limit: 100, offset: 0 });
    assert.equal(result.total, 2);
    assert.deepEqual(result.findings.map((finding) => finding.title), ['Finding 2', 'Finding 3']);
});

test('page jobs retry once, settle credit once and create one report', async () => {
    let attempts = 0;
    const { store, service, runJob } = harness({ analyze: async (_target, _signal, options) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('worker interrupted'), { code: 'ANALYSIS_FAILED' });
        return { findings: [], moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])) };
    } });
    await store.ensureWorkspace('ws_retry');
    const project = await service.createProject('ws_retry', { name: 'Retry', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_retry', project.id, 'operator');
    const scan = await service.createScan('ws_retry', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' });
    await runJob();
    const pages = await store.listScanPages('ws_retry', scan.id);
    assert.equal(pages[0].attempts, 2);
    assert.equal(pages[0].status, 'completed');
    assert.equal((await store.getUsage('ws_retry')).consumed, 1);
    assert.equal((await service.listReports('ws_retry')).length, 1);
    await service.executeScanPage(scan.id, 'ws_retry', pages[0].pageKey);
    assert.equal((await service.listReports('ws_retry')).length, 1);
    assert.equal((await store.getUsage('ws_retry')).consumed, 1);
});

test('expired page lease is reclaimed and progress replay is cursor safe and bounded', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_reclaim');
    const project = await service.createProject('ws_reclaim', { name: 'Reclaim', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_reclaim', project.id, 'operator');
    const scan = await service.createScan('ws_reclaim', { projectId: project.id, urls: ['https://example.com/'], locale: 'en' });
    const page = (await store.listScanPages('ws_reclaim', scan.id))[0];
    await store.claimScanPage('ws_reclaim', scan.id, page.pageKey, { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.executeScanPage(scan.id, 'ws_reclaim', page.pageKey);
    assert.equal((await store.listScanPages('ws_reclaim', scan.id))[0].attempts, 2);
    const first = await service.getScanProgress('ws_reclaim', scan.id, { after: 0 });
    const replay = await service.getScanProgress('ws_reclaim', scan.id, { after: first.events[0].id });
    assert.ok(replay.events.every((event) => event.id > first.events[0].id));
    for (let index = 0; index < 220; index += 1) await store.appendScanEvent('ws_reclaim', scan.id, 'test.event', { index });
    const bounded = await store.listScanEvents('ws_reclaim', scan.id, { after: 0, limit: 500 });
    assert.equal(bounded.length, 200);
    assert.ok(bounded[0].id > 1);
});

test('crawler broken-route evidence survives discovery into report and customer findings', async () => {
    const broken = { fingerprint: 'b'.repeat(64), ruleId: 'crawler.page.unreachable', title: 'Discovered page is unreachable', severity: 'high', confidence: .98, kind: 'measured', moduleId: 'full_site_crawl', engineId: 'crawler', device: 'crawler', pageUrl: 'https://example.com/missing', source: { name: 'WPA Crawler', version: '1.0.0' }, evidence: [{ status: 404, discoverySource: 'internal_link', referrer: 'https://example.com/' }] };
    const { store, service, runJob } = harness({ crawler: async (origin) => ({ version: '1.0.0', status: 'completed', urls: [origin], pages: [{ url: origin, status: 200 }, { url: `${origin}missing`, status: 404, referrer: origin, discoverySource: 'internal_link' }], findings: [broken], coverage: { attemptedPages: 2, reachablePages: 1, brokenPages: 1, truncated: false } }) });
    await store.ensureWorkspace('ws_crawl'); await service.assignPlan('ws_crawl', 'studio');
    const project = await service.createProject('ws_crawl', { name: 'Crawler', url: 'https://example.com/', locale: 'en' });
    await service.verifyProject('ws_crawl', project.id, 'operator');
    await service.createScan('ws_crawl', { projectId: project.id, locale: 'en' }); await runJob();
    const report = (await service.listReports('ws_crawl'))[0];
    assert.equal(report.payload.findings[0].evidence[0].status, 404);
    assert.equal(report.payload.coverage.crawler.brokenPages, 1);
    const findings = await service.listFindings('ws_crawl', { moduleId: 'full_site_crawl' });
    assert.equal(findings.total, 1);
});

test('full-site discovery receives durable authorized origins and additive manual URL seeds', async () => {
    let crawlerCall;
    const { store, service, runJob } = harness({ crawler: async (origin, options) => {
        crawlerCall = { origin, options };
        return {
            version: '2.0.0', status: 'completed',
            urls: [origin, 'https://docs.example.com/guide'],
            pages: [
                { url: origin, status: 200, sources: [{ type: 'root', referrer: null }] },
                { url: 'https://docs.example.com/guide', status: 200, sources: [{ type: 'manual', referrer: null }] }
            ],
            findings: [],
            coverage: { attemptedPages: 2, reachablePages: 2, sources: { root: { uniqueUrls: 1 }, manual: { uniqueUrls: 1 } }, truncated: false }
        };
    } });
    await store.ensureWorkspace('ws_crawl_scope');
    await service.assignPlan('ws_crawl_scope', 'studio');
    const project = await service.createProject('ws_crawl_scope', {
        name: 'Scoped crawler', url: 'https://example.com/', locale: 'en',
        authorizationAttested: true, authorizationVersion: '1.0',
        additionalSubdomains: ['https://docs.example.com']
    }, 'user-1', 'request-1');
    await service.verifyProject('ws_crawl_scope', project.id, 'operator');
    const scan = await service.createScan('ws_crawl_scope', {
        projectId: project.id, locale: 'en',
        additionalUrls: ['https://example.com/known', 'https://docs.example.com/guide']
    });

    assert.equal(crawlerCall.origin, 'https://example.com');
    assert.deepEqual(crawlerCall.options.authorizedOrigins, ['https://example.com', 'https://docs.example.com']);
    assert.deepEqual(crawlerCall.options.additionalUrls, ['https://example.com/known', 'https://docs.example.com/guide']);
    assert.deepEqual(scan.manifest.project.authorizedOrigins, ['https://example.com', 'https://docs.example.com']);
    assert.deepEqual(scan.manifest.urls, ['https://example.com/', 'https://docs.example.com/guide']);
    await runJob();
    assert.equal((await service.getScan('ws_crawl_scope', scan.id)).status, 'completed');
    assert.equal((await service.listReports('ws_crawl_scope'))[0].payload.pages.some((page) => page.url === 'https://docs.example.com/guide'), true);
});

test('WPA rendered links append authorized pages before finalization and preserve queue provenance', async () => {
    let projectSetup = true;
    const validated = [];
    const validateUrl = async (url) => {
        const parsed = new URL(url);
        validated.push(parsed.toString());
        if (!projectSetup && parsed.hostname === 'private.example.com') {
            throw Object.assign(new Error('private DNS answer'), { code: 'PRIVATE_TARGET_BLOCKED' });
        }
        return { url: parsed.toString(), hostname: parsed.hostname };
    };
    const analyze = async (target, _signal, options) => ({
        scores: {}, categories: {}, findings: [],
        moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }])),
        ...(target.url === 'https://example.com/' ? {
            discovery: {
                renderedLinks: [
                    { url: '/spa?utm_source=dom', referrer: target.url },
                    { url: 'https://example.com/spa', referrer: target.url },
                    { url: 'https://docs.example.com/guide', referrer: target.url },
                    { url: 'https://private.example.com/secret', referrer: target.url },
                    { url: 'https://evil.example.net/out', referrer: target.url },
                    { url: '/products?page=999', referrer: target.url },
                    { url: '/account?sessionid=abcdefghijkl', referrer: target.url },
                    { url: '/robots-blocked', referrer: target.url }
                ],
                coverage: { producer: 'wpa_page_playwright_snapshot', references: 8, uniqueLinks: 8, truncated: false }
            }
        } : {})
    });
    const { store, service, runJob } = harness({
        validateUrl,
        analyze,
        crawler: async (origin, options) => ({
            version: '2.0.0', status: 'completed', urls: [`${origin}/`],
            pages: [{ url: `${origin}/`, status: 200, sources: [{ type: 'root', referrer: null }] }],
            findings: [],
            robotsByOrigin: Object.fromEntries(options.authorizedOrigins.map((authorizedOrigin) => [authorizedOrigin, { disallow: authorizedOrigin === origin ? ['/robots-blocked'] : [], allow: [], sitemaps: [] }])),
            coverage: { attemptedPages: 1, reachablePages: 1, sources: { root: { references: 1, uniqueUrls: 1 } }, truncated: false }
        })
    });
    await store.ensureWorkspace('ws_rendered_queue');
    await service.assignPlan('ws_rendered_queue', 'studio');
    const project = await service.createProject('ws_rendered_queue', {
        name: 'Rendered queue', url: 'https://example.com/', locale: 'en',
        authorizationAttested: true, authorizationVersion: '1.0',
        additionalSubdomains: ['https://docs.example.com', 'https://private.example.com']
    }, 'user-1', 'request-1');
    projectSetup = false;
    await service.verifyProject('ws_rendered_queue', project.id, 'operator');
    const scan = await service.createScan('ws_rendered_queue', { projectId: project.id, locale: 'en' });

    await runJob();

    const pages = await store.listScanPages('ws_rendered_queue', scan.id);
    assert.deepEqual(pages.map((page) => page.url), ['https://example.com/', 'https://example.com/spa', 'https://docs.example.com/guide']);
    assert.deepEqual(pages.map((page) => page.pageIndex), [0, 1, 2]);
    assert.equal(pages[1].discovery.sources[0].type, 'rendered_link');
    assert.equal(pages[1].discovery.sources[0].referrer, 'https://example.com/');
    assert.equal(validated.some((url) => url.startsWith('https://docs.example.com/guide')), true);
    assert.equal(validated.some((url) => url.startsWith('https://private.example.com/secret')), true);
    assert.equal((await store.getUsage('ws_rendered_queue')).consumed, 3);
    const report = (await service.listReports('ws_rendered_queue'))[0];
    assert.equal(report.payload.summary.requestedPages, 3);
    assert.equal(report.payload.coverage.crawler.rendered.queuedUniquePages, 2);
    assert.equal(report.payload.coverage.crawler.rendered.skipped.off_scope, 1);
    assert.equal(report.payload.coverage.crawler.rendered.skipped.private_target_blocked, 1);
    assert.equal(report.payload.coverage.crawler.rendered.skipped.robots_disallowed, 1);
    assert.equal(report.payload.coverage.crawler.rendered.truncated, false);
    assert.equal(JSON.stringify(report.payload).includes('evil.example.net'), false);
    const events = await store.listScanEvents('ws_rendered_queue', scan.id);
    const discoveryEvent = events.findIndex((event) => event.type === 'page.discovery' && event.payload.inserted === 2);
    const rootCompletedEvent = events.findIndex((event) => event.type === 'page.completed' && event.payload.pageIndex === 0);
    const scanCompletedEvent = events.findIndex((event) => event.type === 'scan.completed');
    assert.ok(discoveryEvent >= 0 && discoveryEvent < rootCompletedEvent);
    assert.ok(rootCompletedEvent < scanCompletedEvent);
});

test('explicit URL replacement scans never expand from rendered DOM links', async () => {
    const { store, service, runJob } = harness({ analyze: async (_target, _signal, options) => ({
        scores: {}, categories: {}, findings: [],
        discovery: { renderedLinks: [{ url: 'https://example.com/should-not-append' }], coverage: { references: 1, uniqueLinks: 1, truncated: false } },
        moduleRuns: Object.fromEntries(options.engineIds.map((engineId) => [engineId, { status: 'completed', coverage: { truncated: false } }]))
    }) });
    await store.ensureWorkspace('ws_rendered_explicit');
    const project = await service.createProject('ws_rendered_explicit', { name: 'Explicit', url: 'https://example.com/', locale: 'en' });
    const scan = await service.createScan('ws_rendered_explicit', { projectId: project.id, urls: ['https://example.com/explicit'], locale: 'en' });

    await runJob();

    assert.deepEqual((await store.listScanPages('ws_rendered_explicit', scan.id)).map((page) => page.url), ['https://example.com/explicit']);
    const report = (await service.listReports('ws_rendered_explicit'))[0];
    assert.equal(report.payload.pages[0].report.discovery.queue.enabled, false);
    assert.equal(JSON.stringify(report.payload).includes('should-not-append'), false);
});

test('scan discovery fails closed for unrecorded origins and explicit URLs remain replacement input', async () => {
    let crawlerCalls = 0;
    const { store, service } = harness({ crawler: async () => { crawlerCalls += 1; throw new Error('crawler should not run for explicit URLs'); } });
    await store.ensureWorkspace('ws_crawl_closed');
    await service.assignPlan('ws_crawl_closed', 'studio');
    const project = await service.createProject('ws_crawl_closed', {
        name: 'Closed scope', url: 'https://example.com/', locale: 'en',
        authorizationAttested: true, authorizationVersion: '1.0', additionalSubdomains: []
    }, 'user-1', 'request-1');
    await service.verifyProject('ws_crawl_closed', project.id, 'operator');

    await assert.rejects(() => service.createScan('ws_crawl_closed', {
        projectId: project.id, locale: 'en', additionalUrls: ['https://docs.example.com/not-authorized']
    }), { code: 'PROJECT_ORIGIN_MISMATCH' });
    assert.equal((await store.listScans('ws_crawl_closed')).length, 0);

    const scan = await service.createScan('ws_crawl_closed', {
        projectId: project.id, locale: 'en', urls: ['https://example.com/explicit'],
        additionalUrls: ['https://off-origin.example.test/ignored-by-replacement']
    });
    assert.deepEqual(scan.manifest.urls, ['https://example.com/explicit']);
    assert.equal(scan.manifest.discovery, undefined);
    assert.equal(crawlerCalls, 0);
});

test('additional authorization accepts only the project hostname or a real subdomain', async () => {
    const { store, service } = harness();
    await store.ensureWorkspace('ws_subdomain_scope');
    await assert.rejects(() => service.createProject('ws_subdomain_scope', {
        name: 'Invalid authorization', url: 'https://example.com/', locale: 'en',
        authorizationAttested: true, authorizationVersion: '1.0', additionalSubdomains: ['https://example.com.attacker.test']
    }, 'user-1', 'request-1'), { code: 'TARGET_AUTHORIZATION_SCOPE_MISMATCH' });
    assert.equal((await store.listProjects('ws_subdomain_scope')).length, 0);
    assert.equal((await store.listTargetAuthorizations('ws_subdomain_scope', { activeOnly: true })).length, 0);
});

test('admin integration health reflects configured billing provider without claiming a live connection', async () => {
    const { service } = harness();
    const overview = await service.adminOverview();
    const integrations = overview.health.find((entry) => entry.id === 'integrations');
    assert.deepEqual(integrations, { id: 'integrations', label: 'Integrations', status: 'configuration_required', value: 'Paddle configuration required' });
    assert.doesNotMatch(JSON.stringify(overview.health), /Stripe connected|Stripe optional/);
});

test('comparison rejects different projects or capability manifests', async () => {
    const { store, service } = harness(); await store.ensureWorkspace('ws_compare');
    const base = { project: { id: 'project-a' }, entitlements: { core_audit: { executionMode: 'automated' } }, devices: ['desktop', 'mobile'], capabilityContractVersion: 'v1' };
    const leftScan = await store.createScan('ws_compare', 'project-a', base); const rightScan = await store.createScan('ws_compare', 'project-a', base); const otherScan = await store.createScan('ws_compare', 'project-a', { ...base, entitlements: { core_audit: { executionMode: 'automated' }, runtime: { executionMode: 'automated' } } });
    const finding = (fingerprint) => ({ fingerprint, title: fingerprint, severity: 'low' });
    const left = await store.saveReport('ws_compare', leftScan.id, { manifest: base, findings: [finding('crawl-old')], pages: [{ url: 'https://example.com/', report: { findings: [finding('a')] } }] });
    const right = await store.saveReport('ws_compare', rightScan.id, { manifest: base, findings: [finding('crawl-new')], pages: [{ url: 'https://example.com/', report: { findings: [finding('b')] } }] });
    const otherManifest = { ...base, entitlements: { ...base.entitlements, runtime: { executionMode: 'automated' } } };
    const other = await store.saveReport('ws_compare', otherScan.id, { manifest: otherManifest, pages: [] });
    const comparison = await service.compareReports('ws_compare', left.id, right.id);
    assert.deepEqual(new Set(comparison.newFindings), new Set(['crawl-new', 'b']));
    assert.deepEqual(new Set(comparison.fixedFindings), new Set(['crawl-old', 'a']));
    await assert.rejects(service.compareReports('ws_compare', left.id, other.id), { code: 'REPORTS_NOT_COMPARABLE' });
});
