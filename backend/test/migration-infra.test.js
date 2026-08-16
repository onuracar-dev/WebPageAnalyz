const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const { migrationChecksum, migrationConnectionOptions, readMigrationFiles, verifyMigrationLedger } = require('../scripts/migrate');
const { checkMigrations } = require('../scripts/check-migrations');
const { bootstrapQueue } = require('../scripts/bootstrap-queue');

test('migration source inventory is deterministic and contiguous', async () => {
    const files = await readMigrationFiles();
    assert.ok(files.length >= 17);
    assert.equal(files[0].filename, '001_platform.sql');
    assert.match(files.at(-1).filename, /^\d{3}_[a-z0-9_-]+\.sql$/i);
    assert.equal(migrationChecksum(Buffer.from('wpa')), 'c53d10da311d46334d3ba0f5318cf23669a15741766752f74078b27ae6f632a5');
    assert.equal((await checkMigrations()).length, files.length);
});

test('migration connection policy requires TLS when requested', () => {
    assert.throws(() => migrationConnectionOptions({ DATABASE_URL: 'postgresql://db/wpa', MIGRATION_REQUIRE_TLS: 'true' }), /MIGRATION_TLS_REQUIRED/);
    const options = migrationConnectionOptions({ DATABASE_URL: 'postgresql://db/wpa?sslmode=require', MIGRATION_REQUIRE_TLS: 'true' });
    assert.equal(options.ssl.rejectUnauthorized, true);
});

test('migration ledger rejects drift and unverified legacy rows', async () => {
    const files = [{ filename: '001_test.sql', checksum: 'expected' }];
    const fakeClient = (rows) => ({ async query() { return { rows }; } });
    await assert.rejects(() => verifyMigrationLedger(fakeClient([{ filename: '001_test.sql', checksum: 'wrong' }]), files), /MIGRATION_DRIFT/);
    await assert.rejects(() => verifyMigrationLedger(fakeClient([{ filename: '001_test.sql', checksum: null }]), files), /MIGRATION_LEDGER_UNVERIFIED/);
    await assert.doesNotReject(() => verifyMigrationLedger(fakeClient([{ filename: '001_test.sql', checksum: 'expected' }]), files));
});

test('queue DDL is one-shot and ownership is transferred before runtime', async () => {
    const scripts = path.join(__dirname, '..', 'scripts');
    const bootstrap = await fs.readFile(path.join(scripts, 'bootstrap-roles.sql'), 'utf8');
    const grants = await fs.readFile(path.join(scripts, 'apply-runtime-grants.sql'), 'utf8');
    assert.match(bootstrap, /GRANT CREATE ON DATABASE/);
    assert.match(bootstrap, /GRANT TEMPORARY ON DATABASE %I TO %I[\s\S]*:'migrator_role'/);
    assert.match(bootstrap, /GRANT USAGE, CREATE ON SCHEMA wpa_queue/);
    assert.match(bootstrap, /GRANT USAGE ON SCHEMA wpa_queue TO :"queue_role"/);
    assert.match(grants, /REVOKE CREATE ON DATABASE/);
    assert.match(grants, /ALTER SCHEMA wpa_queue OWNER TO/);
    assert.match(grants, /GRANT USAGE ON SCHEMA wpa_queue TO :"queue_role"/);
    assert.match(grants, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wpa_queue TO :"queue_role"/);
    assert.match(grants, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA wpa_queue TO :"queue_role"/);
    assert.match(grants, /ALTER FUNCTION/);
});

test('analysis worker cannot delete workspaces; maintenance role owns lifecycle deletion', async () => {
    const grants = await fs.readFile(path.join(__dirname, '..', 'scripts', 'apply-runtime-grants.sql'), 'utf8');
    const workerGrants = grants.slice(grants.indexOf("'wpa_workspaces', 'wpa_projects'"), grants.indexOf('-- The analysis worker never owns retention'));
    assert.match(grants, /wpa_worker_execution_results/);
    assert.doesNotMatch(workerGrants.slice(0, workerGrants.indexOf('] LOOP')), /'wpa_audit_log'/);
    assert.match(workerGrants, /'wpa_audit_log'[\s\S]*GRANT INSERT ON TABLE public\.%I TO %I', table_name, 'wpa_worker'/);
    assert.match(workerGrants, /REVOKE SELECT ON TABLE public\.wpa_audit_log FROM wpa_worker/);
    assert.doesNotMatch(grants, /GRANT DELETE ON TABLE public\.%I TO wpa_worker/);
    assert.doesNotMatch(grants, /GRANT DELETE ON TABLE wpa_scan_events TO wpa_worker/);
    assert.match(grants, /GRANT UPDATE ON TABLE public\.%I TO %I', table_name, 'wpa_worker'/);
    assert.match(grants, /GRANT INSERT ON TABLE public\.%I TO %I', table_name, 'wpa_worker'/);
    assert.match(grants, /'wpa_scan_pages', 'wpa_scan_events', 'wpa_credit_entries'/);
    assert.equal((grants.match(/'wpa_worker_heartbeats'/g) || []).length, 3);
    assert.match(grants, /wpa_scan_events_id_seq/);
    assert.doesNotMatch(grants, /GRANT .* ON ALL TABLES IN SCHEMA public TO wpa_worker/);
    assert.match(grants, /maintenance_role 'wpa_maintenance'/);
    assert.match(grants, /wpa_workspaces', 'wpa_reports', 'wpa_source_inputs',[\s\S]*GRANT DELETE ON TABLE public\.%I TO %I', table_name, 'wpa_maintenance'/);
    assert.match(grants, /REVOKE ALL ON SCHEMA wpa_queue FROM :"maintenance_role"/);
    assert.doesNotMatch(grants, /GRANT DELETE ON TABLE public\.wpa_workspaces TO wpa_worker/);
});

test('launch hardening migrations align legal types, durable worker health, and executable plan claims', async () => {
    const migrations = path.join(__dirname, '..', 'db', 'migrations');
    const legal = await fs.readFile(path.join(migrations, '029_legal_acceptance_consistency.sql'), 'utf8');
    const heartbeat = await fs.readFile(path.join(migrations, '030_worker_heartbeats.sql'), 'utf8');
    const plans = await fs.readFile(path.join(migrations, '031_plan_catalog_truth_sync.sql'), 'utf8');
    assert.match(legal, /UPDATE wpa_legal_acceptances[\s\S]*SET document_type = 'acceptable_use'[\s\S]*WHERE document_type = 'aup'/);
    assert.match(legal, /document_type IN \('terms','acceptable_use','refund','target_authorization'\)/);
    assert.match(heartbeat, /CREATE TABLE IF NOT EXISTS wpa_worker_heartbeats/);
    assert.match(heartbeat, /heartbeat_at timestamptz NOT NULL/);
    assert.doesNotMatch(plans, /"monitoring"\s*:/i);
    assert.doesNotMatch(plans, /white-label reports/i);
    assert.doesNotMatch(plans, /priority support/i);
    assert.doesNotMatch(plans, /"expert_review"\s*:/i);
    assert.match(plans, /signed report webhooks/i);
});

test('queue bootstrap does not replay pg-boss DDL after ownership transfer', async () => {
    let bossConstructed = 0;
    const created = [];
    class FakePool {
        constructor() {}
        async query() { return { rows: [{ present: true }] }; }
        async end() {}
    }
    class FakeBoss {
        constructor() { bossConstructed += 1; }
        async start() {}
        async createQueue(name) { created.push(name); }
        async stop() {}
    }
    const result = await bootstrapQueue({
        env: { QUEUE_DATABASE_URL: 'postgresql://queue@db/wpa?sslmode=disable' },
        PoolClass: FakePool,
        BossClass: FakeBoss
    });
    assert.deepEqual(result, { schema: 'wpa_queue', migrated: false });
    assert.equal(bossConstructed, 1);
    assert.deepEqual(created.sort(), ['wpa-pdf-export', 'wpa-scan', 'wpa-scan-page', 'wpa-source-audit']);
});

test('queue bootstrap registers canonical queues after a fresh pg-boss migration', async () => {
    const created = [];
    class FakePool {
        constructor() {}
        async query() { return { rows: [{ present: false }] }; }
        async end() {}
    }
    class FakeBoss {
        constructor(options) { this.options = options; }
        async start() {}
        async createQueue(name, options) { created.push({ name, options }); }
        async stop() {}
    }
    const result = await bootstrapQueue({
        env: { QUEUE_DATABASE_URL: 'postgresql://queue@db/wpa?sslmode=disable' },
        PoolClass: FakePool,
        BossClass: FakeBoss
    });
    assert.deepEqual(result, { schema: 'wpa_queue', migrated: true });
    assert.equal(created.length, 4);
    assert.ok(created.every(({ options }) => options.policy === 'standard' && options.notify === true));
});
