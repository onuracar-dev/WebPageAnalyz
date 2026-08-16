const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPlatformStore } = require('../platform/store');

test('idle PostgreSQL client errors are observed without terminating the process', async () => {
    const entries = [];
    const store = new PostgresPlatformStore('postgresql://unused.example/wpa', {
        executionRole: 'worker',
        logger: { error(message, context) { entries.push({ message, context }); } }
    });
    try {
        assert.doesNotThrow(() => store.pool.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' })));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].message, 'PostgreSQL idle client connection failed');
        assert.equal(entries[0].context.component, 'platform-store');
        assert.equal(entries[0].context.errorCode, '57P01');
    } finally {
        await store.close();
    }
});

test('worker audit logging is append-only and does not require audit-table SELECT', async () => {
    const store = new PostgresPlatformStore('postgresql://unused.example/wpa', { executionRole: 'worker' });
    const originalPool = store.pool;
    let statement = '';
    store.pool = {
        async query(sql) {
            statement = sql;
            return { rows: [] };
        }
    };
    try {
        const record = await store.logAudit({
            actorId: 'worker-1',
            action: 'engine_lab.run_requested',
            entityType: 'engine_lab_run',
            entityId: 'lab_11111111-1111-4111-8111-111111111111',
            metadata: { status: 'queued' }
        });
        assert.match(statement, /^INSERT INTO wpa_audit_log/);
        assert.doesNotMatch(statement, /RETURNING/i);
        assert.equal(record.action, 'engine_lab.run_requested');
        assert.equal(record.actorId, 'worker-1');
    } finally {
        await originalPool.end();
    }
});

test('API audit logging retains the canonical database-returned record', async () => {
    const store = new PostgresPlatformStore('postgresql://unused.example/wpa', { executionRole: 'api' });
    const originalPool = store.pool;
    let statement = '';
    store.pool = {
        async query(sql) {
            statement = sql;
            return { rows: [{ id: 'audit-db', action: 'admin.test', createdAt: '2026-08-15T00:00:00.000Z' }] };
        }
    };
    try {
        const record = await store.logAudit({ action: 'admin.test', entityType: 'test' });
        assert.match(statement, /RETURNING/i);
        assert.equal(record.id, 'audit-db');
    } finally {
        await originalPool.end();
    }
});
