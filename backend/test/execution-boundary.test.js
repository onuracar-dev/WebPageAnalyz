const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueWorkerJob, assertWorkerJob, JOB_SCHEMA, EXECUTION_JOBS } = require('../platform/execution-boundary');

test('source is the only OSV producer/consumer contract', () => {
    assert.deepEqual(Object.keys(EXECUTION_JOBS).sort(), ['page', 'pdf', 'scan', 'source']);
    assert.equal(EXECUTION_JOBS.source, 'wpa-source-audit');
    assert.equal(EXECUTION_JOBS.osv, undefined);
});

test('worker execution jobs have an explicit schema, kind and idempotent key', async () => {
    let sent;
    const queue = { async send(name, data, options) { sent = { name, data, options }; return 'job-1'; } };
    const jobId = await enqueueWorkerJob(queue, 'source', { workspaceId: 'ws-1', sourceInputId: 'src-1' }, { singletonKey: 'src-1' });
    assert.equal(jobId, 'job-1');
    assert.equal(sent.name, 'wpa-source-audit');
    assert.deepEqual(assertWorkerJob(sent.data, 'source'), sent.data);
    assert.equal(sent.data.schemaVersion, JOB_SCHEMA);
    assert.equal(sent.options.singletonKey, 'src-1');
    assert.throws(() => assertWorkerJob({ schemaVersion: JOB_SCHEMA, kind: 'pdf' }, 'source'), { code: 'WORKER_JOB_INVALID' });
});

test('scan and page queues use the same validated worker envelope', async () => {
    const sent = [];
    const queue = { async send(name, data, options) { sent.push({ name, data, options }); return name; } };
    await enqueueWorkerJob(queue, 'scan', { scanId: 'scan-1', workspaceId: 'ws-1' }, { singletonKey: 'scan-1' });
    await enqueueWorkerJob(queue, 'page', { scanId: 'scan-1', workspaceId: 'ws-1', pageKey: 'page-1' }, { singletonKey: 'page-1' });
    assert.deepEqual(sent.map((item) => item.name), ['wpa-scan', 'wpa-scan-page']);
    assert.equal(assertWorkerJob(sent[0].data, 'scan').scanId, 'scan-1');
    assert.equal(assertWorkerJob(sent[1].data, 'page').pageKey, 'page-1');
});
