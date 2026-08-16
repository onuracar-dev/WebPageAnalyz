const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { PostgresPlatformStore } = require('../platform/store');

const maintenanceUrl = process.env.TEST_MAINTENANCE_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const seedUrl = process.env.TEST_DATABASE_SEED_URL || process.env.TEST_DATABASE_URL;

test('dedicated PostgreSQL maintenance role owns lifecycle deletion without queue access', { skip: !maintenanceUrl && 'TEST_MAINTENANCE_DATABASE_URL is not configured' }, async () => {
    const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
    try {
        const { rows } = await pool.query(`
            SELECT current_user AS role,
                   has_table_privilege(current_user, 'public.wpa_workspaces', 'DELETE') AS can_delete_workspace,
                   has_table_privilege(current_user, 'public.wpa_reports', 'DELETE') AS can_delete_reports,
                   has_table_privilege(current_user, 'public.wpa_source_inputs', 'DELETE') AS can_delete_source_inputs,
                   has_table_privilege(current_user, 'public.wpa_worker_execution_results', 'DELETE') AS can_delete_execution_results,
                   has_table_privilege(current_user, 'public.wpa_scan_events', 'DELETE') AS can_delete_scan_events,
                   has_table_privilege(current_user, 'public.wpa_retention_runs', 'INSERT') AS can_record_retention,
                   has_schema_privilege(current_user, 'wpa_queue', 'USAGE') AS can_use_queue
        `);
        assert.equal(rows[0].role, 'wpa_maintenance');
        assert.equal(rows[0].can_delete_workspace, true);
        assert.equal(rows[0].can_delete_reports, true);
        assert.equal(rows[0].can_delete_source_inputs, true);
        assert.equal(rows[0].can_delete_execution_results, true);
        assert.equal(rows[0].can_delete_scan_events, false);
        assert.equal(rows[0].can_record_retention, true);
        assert.equal(rows[0].can_use_queue, false);
    } finally { await pool.end(); }
});

test('dedicated PostgreSQL analysis role cannot perform account deletion or retention writes', { skip: !workerUrl && 'TEST_WORKER_DATABASE_URL is not configured' }, async () => {
    const pool = new Pool({ connectionString: workerUrl, max: 1 });
    try {
        const { rows } = await pool.query(`
            SELECT current_user AS role,
                   has_table_privilege(current_user, 'public.wpa_workspaces', 'DELETE') AS can_delete_workspace,
                   has_table_privilege(current_user, 'public.wpa_reports', 'DELETE') AS can_delete_reports,
                   has_table_privilege(current_user, 'public.wpa_source_inputs', 'DELETE') AS can_delete_source_inputs,
                   has_table_privilege(current_user, 'public.wpa_worker_execution_results', 'DELETE') AS can_delete_execution_results,
                   has_table_privilege(current_user, 'public.wpa_scan_events', 'DELETE') AS can_delete_scan_events,
                   has_table_privilege(current_user, 'public.wpa_reports', 'INSERT') AS can_insert_reports,
                   has_table_privilege(current_user, 'public.wpa_worker_execution_results', 'INSERT') AS can_insert_execution_results,
                   has_table_privilege(current_user, 'public.wpa_worker_execution_results', 'UPDATE') AS can_update_execution_results,
                   has_table_privilege(current_user, 'public.wpa_retention_runs', 'INSERT') AS can_record_retention,
                   has_schema_privilege(current_user, 'wpa_queue', 'USAGE') AS can_use_queue
        `);
        assert.equal(rows[0].role, 'wpa_worker');
        assert.equal(rows[0].can_delete_workspace, false);
        assert.equal(rows[0].can_delete_reports, false);
        assert.equal(rows[0].can_delete_source_inputs, false);
        assert.equal(rows[0].can_delete_execution_results, false);
        assert.equal(rows[0].can_delete_scan_events, false);
        assert.equal(rows[0].can_insert_reports, true);
        assert.equal(rows[0].can_insert_execution_results, true);
        assert.equal(rows[0].can_update_execution_results, true);
        assert.equal(rows[0].can_record_retention, false);
        assert.equal(rows[0].can_use_queue, true);
    } finally { await pool.end(); }
});

test('dedicated PostgreSQL analysis role can maintain the bounded durable heartbeat', { skip: !workerUrl || !seedUrl ? 'TEST_WORKER_DATABASE_URL and TEST_DATABASE_SEED_URL are required' : false }, async () => {
    const worker = new PostgresPlatformStore(workerUrl);
    const seed = new PostgresPlatformStore(seedUrl);
    const workerId = `analysis-${crypto.randomUUID()}`;
    try {
        const heartbeat = await worker.recordWorkerHeartbeat('analysis', workerId, {
            startedAt: new Date(), metadata: { executionRole: 'worker', proof: 'disposable-postgres' }
        });
        assert.equal(heartbeat.workerId, workerId);
        const health = await seed.workerHealth('analysis', { maxAgeMs: 90_000 });
        assert.equal(health.status, 'operational');
        assert.equal(health.workerId, workerId);
    } finally {
        await seed.pool.query('DELETE FROM wpa_worker_heartbeats WHERE kind=$1 AND worker_id=$2', ['analysis', workerId]).catch(() => {});
        await worker.close();
        await seed.close();
    }
});

test('maintenance role selects only due requests and completes confirmed deletion', { skip: !maintenanceUrl || !seedUrl ? 'TEST_MAINTENANCE_DATABASE_URL and TEST_DATABASE_SEED_URL are required' : false }, async () => {
    const seed = new Pool({ connectionString: seedUrl, max: 1 });
    const maintenance = new PostgresPlatformStore(maintenanceUrl);
    const dueWorkspaceId = `ws_due_${crypto.randomUUID()}`;
    const futureWorkspaceId = `ws_future_${crypto.randomUUID()}`;
    try {
        for (const [workspaceId, graceUntil] of [[dueWorkspaceId, new Date(Date.now() - 60_000)], [futureWorkspaceId, new Date(Date.now() + 86_400_000)]]) {
            await seed.query('INSERT INTO wpa_workspaces(id,name,plan_id) VALUES($1,$2,$3)', [workspaceId, workspaceId, 'signal']);
            await seed.query('INSERT INTO wpa_workspace_deletion_requests(id,workspace_id,requested_by,status,grace_until,confirmed_at,authorized_by,authorized_at) VALUES($1,$2,$3,\'requested\',$4,now(),\'admin\',now())', [`deletion_${crypto.randomUUID()}`, workspaceId, 'customer', graceUntil]);
        }
        const due = await maintenance.listDueWorkspaceDeletions({ now: new Date(), limit: 10 });
        assert.ok(due.some((request) => request.workspaceId === dueWorkspaceId));
        assert.equal(due.some((request) => request.workspaceId === futureWorkspaceId), false);
        const result = await maintenance.executeWorkspaceDeletion(dueWorkspaceId, { now: new Date(), dryRun: false, actorId: 'maintenance-test', artifactCleanup: async () => {} });
        assert.equal(result.status, 'completed');
        assert.equal(await maintenance.getWorkspace(dueWorkspaceId), null);
        const notDue = await maintenance.executeWorkspaceDeletion(futureWorkspaceId, { now: new Date(), dryRun: false, actorId: 'maintenance-test', artifactCleanup: async () => {} });
        assert.equal(notDue.status, 'not_due');
        assert.ok(await maintenance.getWorkspace(futureWorkspaceId));
    } finally {
        await seed.query('DELETE FROM wpa_workspaces WHERE id = ANY($1::text[])', [[dueWorkspaceId, futureWorkspaceId]]).catch(() => {});
        await maintenance.close();
        await seed.end();
    }
});
