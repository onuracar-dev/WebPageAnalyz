const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore, composeEffectivePlan } = require('../platform/store');
const { getPlan } = require('../domain/plans');

test('operator completion commits task, report, scan, and audit as one fail-closed unit', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws-operator');
    const scan = await store.createScan('ws-operator', 'project-operator', { urls: ['https://example.com/'] });
    await store.updateScan('ws-operator', scan.id, { status: 'awaiting_operator' });
    const report = await store.saveReport('ws-operator', scan.id, { pages: [], operatorEvidence: {} }, { status: 'automated_draft', locale: 'en' });
    const [task] = await store.createOperatorTasks('ws-operator', scan.id, ['design'], new Date(Date.now() + 60_000).toISOString());
    const realAudit = store.logAudit.bind(store);
    store.logAudit = async () => { throw new Error('audit unavailable'); };

    await assert.rejects(() => store.completeOperatorTask(task.id, {
        notes: 'Evidence checked.', reportPatch: { verdict: 'approved' }, actorId: 'operator-1', reason: 'Reviewed rendered evidence', requestId: 'req-operator-fail'
    }), /audit unavailable/);
    assert.equal((await store.listOperatorTasks('pending')).length, 1);
    assert.equal((await store.getLatestReportForScan('ws-operator', scan.id)).id, report.id);
    assert.deepEqual((await store.getLatestReportForScan('ws-operator', scan.id)).payload.operatorEvidence, {});
    assert.equal((await store.getScan('ws-operator', scan.id)).status, 'awaiting_operator');

    store.logAudit = realAudit;
    const completed = await store.completeOperatorTask(task.id, {
        notes: 'Evidence checked.', reportPatch: { verdict: 'approved' }, actorId: 'operator-1', reason: 'Reviewed rendered evidence', requestId: 'req-operator-pass'
    });
    assert.equal(completed.status, 'completed');
    assert.equal((await store.getScan('ws-operator', scan.id)).status, 'completed');
    const latest = await store.getLatestReportForScan('ws-operator', scan.id);
    assert.equal(latest.status, 'operator_completed');
    assert.equal(latest.payload.operatorEvidence.design.verdict, 'approved');
    const audit = store.auditLog.find((entry) => entry.action === 'operator_task.completed');
    assert.equal(audit.reason, 'Reviewed rendered evidence');
    assert.equal(audit.requestId, 'req-operator-pass');
    assert.equal(audit.before.status, 'pending');
    assert.equal(audit.after.status, 'completed');
});

test('Expert Review updates roll back when their audit record fails', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws-review');
    const review = await store.createExpertReview('ws-review', {
        scanId: 'scan-review', sourceReportId: 'report-review', scopePageUrls: ['https://example.com/'], requestedBy: 'customer', dueAt: '2099-01-01T00:00:00.000Z', idempotencyKey: 'review-atomic'
    });
    store.logAudit = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => store.updateExpertReview(review.id, {
        status: 'in_review', assignedTo: 'expert-1', audit: { actorId: 'expert-1', action: 'expert_review.claimed', reason: 'Assigned queue item', requestId: 'req-review' }
    }), /audit unavailable/);
    const unchanged = await store.getExpertReview(review.id);
    assert.equal(unchanged.status, 'requested');
    assert.equal(unchanged.assignedTo, undefined);
});

test('redeem creation audit preserves the submitted administrator reason', async () => {
    const store = new MemoryPlatformStore();
    const code = await store.createRedeemCode({
        code: 'AUDIT2026', maxGlobalRedemptions: 1, createdBy: 'admin-1', adminNote: 'Customer visible note', reason: 'Approved launch campaign', requestId: 'req-redeem'
    });
    const audit = store.auditLog.find((entry) => entry.entityId === code.id && entry.action === 'redeem.created');
    assert.equal(audit.reason, 'Approved launch campaign');
    assert.equal(audit.requestId, 'req-redeem');
});

test('entitlement writes and legacy effective-plan overrides reject non-executable modules fail-closed', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws-entitlement-truth');
    for (const moduleId of ['monitoring', 'white_label', 'not_a_module']) {
        await assert.rejects(() => store.grantEntitlement('ws-entitlement-truth', {
            entitlementOverrides: { [moduleId]: { executionMode: 'automated' } }
        }, { actorId: 'admin-1', reason: 'Invalid module grant', requestId: `grant-${moduleId}` }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
        await assert.rejects(() => store.createRedeemCode({
            code: `BAD${moduleId.replaceAll('_', '').toUpperCase()}2026`, maxGlobalRedemptions: 1, createdBy: 'admin-1',
            entitlementOverrides: { [moduleId]: { executionMode: 'automated' } }
        }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
        await assert.rejects(() => store.setPlanEntitlement('signal', moduleId, { executionMode: 'automated' }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
    }
    assert.equal(store.entitlementGrants.size, 0);
    assert.equal(store.redeemCodes.size, 0);

    const effective = composeEffectivePlan({
        ...structuredClone(getPlan('signal')),
        entitlements: { ...structuredClone(getPlan('signal').entitlements), monitoring: { executionMode: 'automated' } }
    }, [{
        id: 'legacy-grant', source: 'admin', createdAt: '2026-01-01T00:00:00.000Z',
        entitlementOverrides: { white_label: { executionMode: 'automated' }, not_a_module: { executionMode: 'automated' }, expert_review: { executionMode: 'operator_assisted' } }
    }]);
    assert.equal(Object.hasOwn(effective.entitlements, 'monitoring'), false);
    assert.equal(Object.hasOwn(effective.entitlements, 'white_label'), false);
    assert.equal(Object.hasOwn(effective.entitlements, 'not_a_module'), false);
    assert.equal(effective.entitlements.expert_review.executionMode, 'operator_assisted');
});

test('report and Expert Review finalize/publish mutations roll back as one unit and duplicate calls stay quiet', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws-publish');
    const scan = await store.createScan('ws-publish', 'project-publish', { urls: ['https://example.com/'] });
    const operatorReport = await store.saveReport('ws-publish', scan.id, { kind: 'operator' }, { status: 'operator_completed', locale: 'en' });
    const realAudit = store.logAudit.bind(store);

    store.logAudit = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => store.publishReportWithAudit('ws-publish', operatorReport.id, { actorId: 'admin-1', reason: 'Approve operator report', requestId: 'req-report-fail' }), /audit unavailable/);
    assert.equal([...store.reports.values()].filter((report) => report.status === 'published').length, 0);
    assert.equal(store.reports.size, 1);

    store.logAudit = realAudit;
    const publishedOperator = await store.publishReportWithAudit('ws-publish', operatorReport.id, { actorId: 'admin-1', reason: 'Approve operator report', requestId: 'req-report-pass' });
    const afterOperatorPublishCounts = { reports: store.reports.size, audits: store.auditLog.length };
    const duplicateOperatorPublish = await store.publishReportWithAudit('ws-publish', operatorReport.id, { actorId: 'admin-1', reason: 'Duplicate report publish', requestId: 'req-report-duplicate' });
    assert.equal(publishedOperator.report.status, 'published');
    assert.equal(duplicateOperatorPublish.idempotent, true);
    assert.deepEqual({ reports: store.reports.size, audits: store.auditLog.length }, afterOperatorPublishCounts);

    const source = await store.saveReport('ws-publish', scan.id, { pages: [] }, { status: 'automated_draft', locale: 'en' });
    const review = await store.createExpertReview('ws-publish', { scanId: scan.id, sourceReportId: source.id, scopePageUrls: [], requestedBy: 'customer', dueAt: '2099-01-01T00:00:00.000Z', idempotencyKey: 'review-publish' });
    await store.updateExpertReview(review.id, { status: 'in_review', assignedTo: 'expert-1' });
    const beforeFinalizeReportCount = store.reports.size;
    const expectedUpdatedAt = (await store.getExpertReview(review.id)).updatedAt;
    store.logAudit = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => store.finalizeExpertReviewWithAudit(review.id, { payload: { pages: [], expertReview: {} }, locale: 'en', actorId: 'expert-1', reason: 'All findings reviewed', requestId: 'req-finalize-fail', expectedUpdatedAt }), /audit unavailable/);
    assert.equal((await store.getExpertReview(review.id)).status, 'in_review');
    assert.equal(store.reports.size, beforeFinalizeReportCount);

    store.logAudit = realAudit;
    const finalized = await store.finalizeExpertReviewWithAudit(review.id, { payload: { pages: [], expertReview: {} }, locale: 'en', actorId: 'expert-1', reason: 'All findings reviewed', requestId: 'req-finalize-pass', expectedUpdatedAt: (await store.getExpertReview(review.id)).updatedAt });
    const afterFinalizeCounts = { reports: store.reports.size, audits: store.auditLog.length };
    const duplicateFinalize = await store.finalizeExpertReviewWithAudit(review.id, { payload: { pages: [] }, locale: 'en', actorId: 'expert-1', reason: 'Duplicate click', requestId: 'req-finalize-duplicate' });
    assert.equal(duplicateFinalize.idempotent, true);
    assert.deepEqual({ reports: store.reports.size, audits: store.auditLog.length }, afterFinalizeCounts);

    store.logAudit = async (entry) => {
        if (entry.action === 'expert_review.published') throw new Error('expert audit unavailable');
        return realAudit(entry);
    };
    await assert.rejects(() => store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Approve publication', requestId: 'req-publish-fail' }), /expert audit unavailable/);
    assert.equal((await store.getExpertReview(review.id)).status, 'ready_to_publish');
    assert.equal([...store.reports.values()].filter((report) => report.status === 'published').length, 1);
    assert.equal(store.auditLog.filter((entry) => entry.action === 'report.published').length, 1);

    store.logAudit = realAudit;
    const published = await store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Approve publication', requestId: 'req-publish-pass' });
    const afterPublishCounts = { reports: store.reports.size, audits: store.auditLog.length };
    const duplicatePublish = await store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Duplicate click', requestId: 'req-publish-duplicate' });
    assert.equal(published.report.status, 'published');
    assert.equal(duplicatePublish.idempotent, true);
    assert.deepEqual({ reports: store.reports.size, audits: store.auditLog.length }, afterPublishCounts);
});
