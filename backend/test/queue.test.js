const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PostgresQueue } = require('../platform/queue');

test('Postgres queue observes promoted pg-boss connection errors without terminating', async () => {
    const entries = [];
    class FakeBoss extends EventEmitter {
        async stop() {}
    }
    const queue = new PostgresQueue(
        'postgresql://example.invalid/db',
        FakeBoss,
        { error(message, context) { entries.push({ message, context }); } }
    );
    assert.doesNotThrow(() => queue.boss.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' })));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, 'PostgreSQL queue connection failed');
    assert.equal(entries[0].context.component, 'platform-queue');
    assert.equal(entries[0].context.errorCode, '57P01');
    await queue.close();
});

test('Postgres queue disables pg-boss runtime DDL', async () => {
    let options;
    class FakeBoss {
        constructor(input) { options = input; }
        async start() {}
        async getQueue() { return { name: 'wpa-scan' }; }
        async createQueue() {}
        async stop() {}
    }
    const queue = new PostgresQueue('postgresql://example.invalid/db', FakeBoss);
    await queue.start();
    assert.equal(options.schema, 'wpa_queue');
    assert.equal(options.migrate, false);
    await queue.close();
});

test('Postgres queue fails closed when a canonical queue was not bootstrapped', async () => {
    class FakeBoss {
        constructor() {}
        async start() {}
        async getQueue() { return null; }
        async stop() {}
    }
    const queue = new PostgresQueue('postgresql://example.invalid/db', FakeBoss);
    await assert.rejects(() => queue.send('wpa-pdf-export', { reportId: 'rpt-1' }), /not provisioned/);
    await queue.close();
});
