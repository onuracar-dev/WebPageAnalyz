const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskPool } = require('../lib/task-pool');

test('TaskPool enforces active and queued job bounds', async () => {
    const pool = new TaskPool({ maxConcurrent: 1, maxQueue: 1 });
    let release;
    const first = pool.run(() => new Promise((resolve) => { release = resolve; }));
    await new Promise(setImmediate);
    const second = pool.run(async () => 'second');
    await assert.rejects(() => pool.run(async () => 'third'), { code: 'ANALYSIS_QUEUE_FULL' });
    assert.deepEqual(pool.stats, { active: 1, queued: 1 });
    release('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    pool.close();
});

test('TaskPool aborts a timed out task and reports a stable error', async () => {
    const pool = new TaskPool({ maxConcurrent: 1, maxQueue: 0 });
    await assert.rejects(() => pool.run((signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { timeoutMs: 20 }), { code: 'OPERATION_TIMEOUT' });
    pool.close();
});
