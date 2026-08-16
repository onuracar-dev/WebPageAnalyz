const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PostgresPlatformStore } = require('../platform/store');
const { setPlanEntitlementWithAudit } = require('../auth/security');

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL central admin mutations enforce grant truth and transactional audit persistence', {
    skip: !connectionString && 'TEST_DATABASE_URL is not configured'
}, async () => {
    const store = new PostgresPlatformStore(connectionString);
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_admin_audit_${suffix}`;
    const rejectedRequestId = `reject_${suffix}`;
    const secondAuditRejectedId = `reject_second_${suffix}`;
    const triggerName = `wpa_test_audit_reject_${suffix}`;
    const functionName = `wpa_test_audit_reject_fn_${suffix}`;
    try {
        await store.ensureWorkspace(workspaceId);
        for (const moduleId of ['monitoring', 'white_label', 'not_a_module']) {
            await assert.rejects(() => store.grantEntitlement(workspaceId, {
                entitlementOverrides: { [moduleId]: { executionMode: 'automated' } }
            }, { actorId: 'super-admin', reason: 'Invalid module grant', requestId: `grant_${moduleId}_${suffix}` }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
            await assert.rejects(() => store.createRedeemCode({
                code: `BAD${moduleId.replaceAll('_', '').toUpperCase()}${suffix.slice(0, 8)}`,
                maxGlobalRedemptions: 1, createdBy: 'super-admin',
                entitlementOverrides: { [moduleId]: { executionMode: 'automated' } }
            }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
            await assert.rejects(() => store.setPlanEntitlement('signal', moduleId, { executionMode: 'automated' }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
            await assert.rejects(() => setPlanEntitlementWithAudit({
                store, planId: 'signal', moduleId, entitlement: { executionMode: 'automated' }, actorId: 'super-admin', reason: 'Invalid plan module', requestId: `plan_${moduleId}_${suffix}`
            }), (error) => error.code === 'ENTITLEMENT_MODULE_NOT_GRANTABLE');
        }
        assert.equal(Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_entitlement_grants WHERE workspace_id=$1', [workspaceId])).rows[0].count), 0);
        const project = await store.createProject(workspaceId, { name: 'Admin audit transaction', origin: 'https://example.com', locale: 'en' });
        const scan = await store.createScan(workspaceId, project.id, { urls: ['https://example.com/'] });
        await store.createScanPages(workspaceId, scan.id, ['https://example.com/']);
        await store.reserveCredit(workspaceId, scan.id, 'https://example.com/', 10);
        await store.cancelScan(workspaceId, scan.id, { actorId: 'admin-1', reason: 'Stop stuck scan', requestId: `cancel_request_${suffix}`, idempotencyKey: `cancel_click_${suffix}` });
        await store.retryScan(workspaceId, scan.id, { actorId: 'admin-1', reason: 'Provider recovered', requestId: `retry_request_${suffix}`, idempotencyKey: `retry_click_${suffix}`, creditLimit: 10 });
        const { rows: scanAuditRows } = await store.pool.query('SELECT action,request_id AS "requestId",metadata FROM wpa_audit_log WHERE workspace_id=$1 AND action IN ($2,$3) ORDER BY created_at', [workspaceId, 'scan.cancelled', 'scan.retried']);
        assert.deepEqual(scanAuditRows.map((entry) => [entry.action, entry.requestId, entry.metadata.idempotencyKey]), [
            ['scan.cancelled', `cancel_request_${suffix}`, `cancel_click_${suffix}`],
            ['scan.retried', `retry_request_${suffix}`, `retry_click_${suffix}`]
        ]);
        await store.updateScan(workspaceId, scan.id, { status: 'awaiting_operator' });
        const report = await store.saveReport(workspaceId, scan.id, { pages: [], operatorEvidence: {} }, { status: 'automated_draft', locale: 'en' });
        const [task] = await store.createOperatorTasks(workspaceId, scan.id, ['design'], new Date(Date.now() + 60_000).toISOString());
        const review = await store.createExpertReview(workspaceId, {
            scanId: scan.id, sourceReportId: report.id, scopePageUrls: ['https://example.com/'], requestedBy: 'customer', dueAt: '2099-01-01T00:00:00.000Z', idempotencyKey: `review_${suffix}`
        });

        await store.pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = '${rejectedRequestId}' OR (NEW.request_id = '${secondAuditRejectedId}' AND NEW.action = 'expert_review.published') THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`);
        await store.pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON wpa_audit_log FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

        await assert.rejects(() => store.updateExpertReview(review.id, {
            status: 'in_review', assignedTo: 'expert-1', audit: { actorId: 'expert-1', action: 'expert_review.claimed', reason: 'Test rollback', requestId: rejectedRequestId }
        }), /forced audit failure/);
        assert.equal((await store.getExpertReview(review.id)).status, 'requested');

        await assert.rejects(() => store.completeOperatorTask(task.id, {
            notes: 'Must roll back.', reportPatch: { verdict: 'rejected' }, actorId: 'operator-1', reason: 'Test rollback', requestId: rejectedRequestId
        }), /forced audit failure/);
        assert.equal((await store.listOperatorTasks('pending')).some((item) => item.id === task.id), true);
        assert.deepEqual((await store.getLatestReportForScan(workspaceId, scan.id)).payload.operatorEvidence, {});
        assert.equal((await store.getScan(workspaceId, scan.id)).status, 'awaiting_operator');

        await store.updateExpertReview(review.id, {
            status: 'in_review', assignedTo: 'expert-1', audit: { actorId: 'expert-1', action: 'expert_review.claimed', reason: 'Assigned reviewed queue item', requestId: `review_${suffix}` }
        });
        await store.completeOperatorTask(task.id, {
            notes: 'Evidence complete.', reportPatch: { verdict: 'approved' }, actorId: 'operator-1', reason: 'Rendered evidence approved', requestId: `task_${suffix}`
        });
        assert.equal((await store.getExpertReview(review.id)).status, 'in_review');
        assert.equal((await store.getScan(workspaceId, scan.id)).status, 'completed');
        assert.equal((await store.getLatestReportForScan(workspaceId, scan.id)).payload.operatorEvidence.design.verdict, 'approved');
        const { rows: auditRows } = await store.pool.query('SELECT action,reason,request_id AS "requestId" FROM wpa_audit_log WHERE workspace_id=$1 AND action IN ($2,$3) ORDER BY created_at', [workspaceId, 'expert_review.claimed', 'operator_task.completed']);
        assert.deepEqual(auditRows.map((entry) => [entry.action, entry.reason, entry.requestId]), [
            ['expert_review.claimed', 'Assigned reviewed queue item', `review_${suffix}`],
            ['operator_task.completed', 'Rendered evidence approved', `task_${suffix}`]
        ]);

        const operatorReport = await store.getLatestReportForScan(workspaceId, scan.id);
        const reportCountBeforePublish = Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count);
        await assert.rejects(() => store.publishReportWithAudit(workspaceId, operatorReport.id, { actorId: 'super-admin', reason: 'Test report publish rollback', requestId: rejectedRequestId }), /forced audit failure/);
        assert.equal(Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count), reportCountBeforePublish);
        assert.equal(Number((await store.pool.query("SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1 AND status='published'", [workspaceId])).rows[0].count), 0);

        const claimedReview = await store.getExpertReview(review.id);
        const finalizePayload = { pages: [], operatorEvidence: { design: { verdict: 'approved' } }, expertReview: { reviewId: review.id } };
        await assert.rejects(() => store.finalizeExpertReviewWithAudit(review.id, { payload: finalizePayload, locale: 'en', actorId: 'expert-1', reason: 'Test finalize rollback', requestId: rejectedRequestId, expectedUpdatedAt: claimedReview.updatedAt }), /forced audit failure/);
        assert.equal((await store.getExpertReview(review.id)).status, 'in_review');
        assert.equal(Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count), reportCountBeforePublish);

        const finalized = await store.finalizeExpertReviewWithAudit(review.id, { payload: finalizePayload, locale: 'en', actorId: 'expert-1', reason: 'All scoped findings reviewed', requestId: `finalize_${suffix}`, expectedUpdatedAt: claimedReview.updatedAt });
        const afterFinalize = {
            reports: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count),
            audits: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_audit_log WHERE workspace_id=$1', [workspaceId])).rows[0].count)
        };
        const duplicateFinalize = await store.finalizeExpertReviewWithAudit(review.id, { payload: finalizePayload, locale: 'en', actorId: 'expert-1', reason: 'Duplicate finalize click', requestId: `finalize_duplicate_${suffix}` });
        assert.equal(duplicateFinalize.idempotent, true);
        assert.deepEqual({
            reports: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count),
            audits: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_audit_log WHERE workspace_id=$1', [workspaceId])).rows[0].count)
        }, afterFinalize);

        await assert.rejects(() => store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Test second-audit rollback', requestId: secondAuditRejectedId }), /forced audit failure/);
        assert.equal((await store.getExpertReview(review.id)).status, 'ready_to_publish');
        assert.equal(Number((await store.pool.query("SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1 AND status='published'", [workspaceId])).rows[0].count), 0);
        assert.equal(Number((await store.pool.query("SELECT count(*)::int AS count FROM wpa_audit_log WHERE workspace_id=$1 AND action='report.published'", [workspaceId])).rows[0].count), 0);

        const published = await store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Approved Expert Review publication', requestId: `publish_${suffix}` });
        const afterPublish = {
            reports: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count),
            audits: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_audit_log WHERE workspace_id=$1', [workspaceId])).rows[0].count)
        };
        const duplicatePublish = await store.publishExpertReviewWithAudit(review.id, finalized.report.id, { actorId: 'super-admin', reason: 'Duplicate publish click', requestId: `publish_duplicate_${suffix}` });
        assert.equal(published.report.status, 'published');
        assert.equal(duplicatePublish.idempotent, true);
        assert.deepEqual({
            reports: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId])).rows[0].count),
            audits: Number((await store.pool.query('SELECT count(*)::int AS count FROM wpa_audit_log WHERE workspace_id=$1', [workspaceId])).rows[0].count)
        }, afterPublish);
    } finally {
        await store.pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON wpa_audit_log`).catch(() => {});
        await store.pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
        await store.pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await store.close();
    }
});
