const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('../job-queue');
const { abortableDelay } = require('../lib/abort');

describe('JobQueue', () => {
    it('manages queued jobs and concurrency', async () => {
        let activeRuns = 0;
        let maxObservedActive = 0;

        const fakeRunner = {
            runScan: async () => {
                activeRuns += 1;
                maxObservedActive = Math.max(maxObservedActive, activeRuns);
                await new Promise((r) => setTimeout(r, 50));
                activeRuns -= 1;
                return {
                    status: 'completed',
                    engines: { lighthouse: { status: 'completed', durationMs: 50 } },
                    findings: [],
                    summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} }
                };
            }
        };

        const queue = new JobQueue({
            runner: fakeRunner,
            concurrency: 1,
            maxQueue: 5,
            scanTimeoutMs: 5000,
            resultTtlMs: 60000
        });

        try {
            const job1 = queue.enqueue({ id: 'j1', url: 'https://example1.com' });
            const job2 = queue.enqueue({ id: 'j2', url: 'https://example2.com' });

            assert.equal(job1.id, 'j1');
            assert.equal(job1.status, 'queued');
            assert.equal(job2.id, 'j2');
            assert.equal(job2.status, 'queued');

            // Wait for both to finish
            await new Promise((r) => setTimeout(r, 200));

            assert.equal(maxObservedActive, 1, 'Concurrency must not exceed 1');
            const completed1 = queue.getJob('j1');
            const completed2 = queue.getJob('j2');
            assert.equal(completed1.status, 'completed');
            assert.equal(completed2.status, 'completed');
        } finally {
            queue.close();
        }
    });

    it('rejects with QUEUE_FULL when queue is full', () => {
        const fakeRunner = { runScan: async () => ({ status: 'completed' }) };
        const queue = new JobQueue({
            runner: fakeRunner,
            concurrency: 1,
            maxQueue: 2,
            scanTimeoutMs: 5000,
            resultTtlMs: 60000
        });

        try {
            queue.enqueue({ id: 'j1', url: 'https://site1.com' });
            queue.enqueue({ id: 'j2', url: 'https://site2.com' });

            assert.throws(() => {
                queue.enqueue({ id: 'j3', url: 'https://site3.com' });
            }, (err) => err.code === 'QUEUE_FULL' && err.status === 429);
        } finally {
            queue.close();
        }
    });

    it('deduplicates currently active URLs', () => {
        const fakeRunner = { runScan: async () => new Promise(() => {}) }; // stays running
        const queue = new JobQueue({
            runner: fakeRunner,
            concurrency: 1,
            maxQueue: 5
        });

        try {
            const first = queue.enqueue({ id: 'first-id', url: 'https://example.com/page?utm_source=test' });
            const found = queue.findActiveByUrl('https://example.com/page');

            assert.ok(found);
            assert.equal(found.id, 'first-id');
        } finally {
            queue.close();
        }
    });

    it('cleans up finished jobs after TTL', async () => {
        const fakeRunner = {
            runScan: async () => ({
                status: 'completed',
                engines: {},
                findings: [],
                summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} }
            })
        };

        const queue = new JobQueue({
            runner: fakeRunner,
            concurrency: 1,
            maxQueue: 5,
            scanTimeoutMs: 5000,
            resultTtlMs: 50 // 50ms TTL
        });

        try {
            queue.enqueue({ id: 'quick-ttl', url: 'https://quick.com' });

            // Wait for scan to run and finish
            await new Promise((r) => setTimeout(r, 20));
            assert.ok(queue.getJob('quick-ttl'));

            // Wait for TTL to expire
            await new Promise((r) => setTimeout(r, 70));
            assert.equal(queue.getJob('quick-ttl'), null, 'Job should be deleted after TTL expires');
        } finally {
            queue.close();
        }
    });

    it('prunes oldest finished jobs when MAX_STORED_RESULTS is exceeded without deleting running jobs (Revizyon 2 - d)', async () => {
        let finishRunningJob = null;
        const fakeRunner = {
            runScan: async (url) => {
                if (url.includes('stay-running')) {
                    await new Promise((resolve) => { finishRunningJob = resolve; });
                }
                return {
                    status: 'completed',
                    engines: {},
                    findings: [],
                    summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} }
                };
            }
        };

        const queue = new JobQueue({
            runner: fakeRunner,
            concurrency: 2,
            maxQueue: 5,
            scanTimeoutMs: 5000,
            resultTtlMs: 60000,
            maxStoredResults: 2
        });

        try {
            // Complete job 1
            queue.enqueue({ id: 'j1', url: 'https://site1.com' });
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(queue.getJob('j1').status, 'completed');

            // Complete job 2
            queue.enqueue({ id: 'j2', url: 'https://site2.com' });
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(queue.getJob('j2').status, 'completed');

            // Job 3 stays running
            queue.enqueue({ id: 'j3', url: 'https://stay-running.com' });
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(queue.getJob('j3').status, 'running');

            // Complete job 4 (finished jobs becomes 3 > maxStoredResults of 2)
            queue.enqueue({ id: 'j4', url: 'https://site4.com' });
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(queue.getJob('j4').status, 'completed');

            // Oldest finished job (j1) must be pruned
            assert.equal(queue.getJob('j1'), null, 'j1 (oldest completed) should be pruned');

            // Newer finished jobs (j2, j4) must still exist
            assert.ok(queue.getJob('j2'), 'j2 should be retained');
            assert.ok(queue.getJob('j4'), 'j4 should be retained');

            // Running job (j3) must NOT be deleted
            const runningJob = queue.getJob('j3');
            assert.ok(runningJob, 'Running job j3 must NOT be deleted');
            assert.equal(runningJob.status, 'running');
        } finally {
            if (finishRunningJob) finishRunningJob();
            queue.close();
        }
    });
});
