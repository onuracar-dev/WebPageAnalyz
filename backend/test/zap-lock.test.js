const test = require('node:test');
const assert = require('node:assert/strict');
const { createZapDistributedLock } = require('../analyzers/zap-lock');

test('distributed ZAP lock holds a PostgreSQL session until release and retries busy replicas', async () => {
    const clients = [];
    const pool = { connect: async () => {
        const client = { released: false, release() { this.released = true; }, async query(sql) {
            if (sql.includes('try_advisory_lock')) {
                const acquired = clients.every((item) => item.released);
                clients.push(this);
                return { rows: [{ acquired }] };
            }
            return { rows: [{ unlocked: true }] };
        } };
        return client;
    } };
    const lock = createZapDistributedLock({ pool, retryMs: 1, acquireTimeoutMs: 100 });
    const release = await lock.acquire();
    const waiting = lock.acquire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clients.length >= 2, true);
    await release();
    const releaseSecond = await waiting;
    assert.equal(typeof releaseSecond, 'function');
    await releaseSecond();
});

test('production ZAP configuration fails closed without a distributed pool', () => {
    assert.throws(() => createZapDistributedLock({ required: true }), { code: 'ZAP_DISTRIBUTED_LOCK_UNAVAILABLE' });
});
