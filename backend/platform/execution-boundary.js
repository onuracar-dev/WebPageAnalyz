const { AppError } = require('../lib/errors');

// Source audits include the OSV pass in the same fenced source execution.  Keeping
// one queue avoids a second producer/consumer lifecycle and duplicate scans.
const EXECUTION_JOBS = Object.freeze({ scan: 'wpa-scan', page: 'wpa-scan-page', source: 'wpa-source-audit', pdf: 'wpa-pdf-export' });

// Queue rows are part of the release/bootstrap contract. Runtime processes use
// pg-boss with migrate:false and may only consume these pre-registered names;
// keeping the definitions here prevents the API, worker and migrator from
// drifting into different queue policies.
const QUEUE_DEFINITIONS = Object.freeze(Object.fromEntries(Object.values(EXECUTION_JOBS).map((name) => [name, Object.freeze({
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 1_000,
    retryBackoff: true,
    notify: true
})])));
const JOB_SCHEMA = 'wpa.worker-job.v1';

async function enqueueWorkerJob(queue, kind, data, { singletonKey, retryLimit = 2 } = {}) {
    const name = EXECUTION_JOBS[kind];
    if (!name || typeof queue?.send !== 'function') throw new AppError('The isolated worker queue is unavailable.', { status: 503, code: 'WORKER_QUEUE_UNAVAILABLE' });
    return queue.send(name, { schemaVersion: JOB_SCHEMA, kind, ...data }, { singletonKey, retryLimit, retryDelay: 1_000, retryBackoff: true });
}

function assertWorkerJob(value, kind) {
    if (!value || value.schemaVersion !== JOB_SCHEMA || value.kind !== kind) throw new AppError('The worker job contract is invalid.', { status: 400, code: 'WORKER_JOB_INVALID' });
    return value;
}

module.exports = { EXECUTION_JOBS, QUEUE_DEFINITIONS, JOB_SCHEMA, enqueueWorkerJob, assertWorkerJob };
