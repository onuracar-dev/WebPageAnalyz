const crypto = require('node:crypto');
const { AppError } = require('./lib/errors');
const { normalizePageUrl } = require('./domain/url-normalization');

const INCLUDED_ENGINE_IDS = Object.freeze([
    'lighthouse',
    'axe',
    'yellowLab',
    'wpaPage',
    'performancePlus',
    'advancedGeo',
    'visualUx'
]);

function createInitialEngines() {
    const engines = {};
    for (const id of INCLUDED_ENGINE_IDS) {
        engines[id] = { status: 'pending' };
    }
    return engines;
}

class JobQueue {
    constructor({
        runner,
        concurrency = 1,
        maxQueue = 5,
        scanTimeoutMs = 4 * 60 * 1000,
        resultTtlMs = 30 * 60 * 1000,
        maxStoredResults = 100,
        logger = null
    } = {}) {
        this.runner = runner;
        this.concurrency = concurrency;
        this.maxQueue = maxQueue;
        this.scanTimeoutMs = scanTimeoutMs;
        this.resultTtlMs = resultTtlMs;
        this.maxStoredResults = maxStoredResults;
        this.logger = logger;

        this.jobs = new Map();
        this.waitingQueue = [];
        this.runningJobs = new Map();
        this.ttlTimers = new Map();
        this.isClosed = false;
    }

    normalizeUrl(url) {
        try {
            return normalizePageUrl(url);
        } catch {
            return url;
        }
    }

    findActiveByUrl(url) {
        const normalized = this.normalizeUrl(url);
        // Check running jobs
        for (const job of this.runningJobs.values()) {
            if (job.normalizedUrl === normalized) {
                return {
                    id: job.id,
                    status: job.status,
                    position: 0
                };
            }
        }
        // Check waiting jobs
        for (let i = 0; i < this.waitingQueue.length; i += 1) {
            const job = this.waitingQueue[i];
            if (job.normalizedUrl === normalized) {
                return {
                    id: job.id,
                    status: job.status,
                    position: i + 1
                };
            }
        }
        return null;
    }

    findCompletedByUrl(url) {
        const normalized = this.normalizeUrl(url);
        let latest = null;
        for (const job of this.jobs.values()) {
            if (job.status === 'completed' && job.normalizedUrl === normalized) {
                if (!latest || new Date(job.finishedAt || 0) > new Date(latest.finishedAt || 0)) {
                    latest = job;
                }
            }
        }
        return latest ? { ...latest } : null;
    }

    isFull() {
        return (this.runningJobs.size + this.waitingQueue.length) >= this.maxQueue;
    }

    enqueue({ id = crypto.randomUUID(), url, requestedUrl }) {
        if (this.isClosed) {
            throw new AppError('Queue is closed', { status: 503, code: 'QUEUE_CLOSED' });
        }

        if (this.isFull()) {
            throw new AppError('Scan queue is currently full.', { status: 429, code: 'QUEUE_FULL' });
        }

        const normalizedUrl = this.normalizeUrl(url);

        const job = {
            id,
            url,
            requestedUrl: requestedUrl || url,
            normalizedUrl,
            status: 'queued',
            queuedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            engines: createInitialEngines(),
            findings: [],
            summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} },
            error: null
        };

        this.jobs.set(id, job);
        this.waitingQueue.push(job);

        const position = this.waitingQueue.length;

        // Process next tick
        setImmediate(() => this.processNext());

        return {
            id: job.id,
            status: job.status,
            position,
            url: job.url,
            requestedUrl: job.requestedUrl
        };
    }

    getJob(id) {
        const job = this.jobs.get(id);
        if (!job) return null;

        if (job.status === 'queued') {
            const index = this.waitingQueue.findIndex((j) => j.id === id);
            return {
                ...job,
                position: index >= 0 ? index + 1 : 1
            };
        }

        return { ...job };
    }

    getStats() {
        return {
            running: this.runningJobs.size,
            waiting: this.waitingQueue.length
        };
    }

    async processNext() {
        if (this.isClosed) return;
        if (this.runningJobs.size >= this.concurrency) return;
        if (this.waitingQueue.length === 0) return;

        const job = this.waitingQueue.shift();
        if (!job) return;

        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.runningJobs.set(job.id, job);

        const abortController = new AbortController();
        const timeoutTimer = setTimeout(() => {
            abortController.abort(new AppError('Scan exceeded total time limit.', { status: 504, code: 'SCAN_TIMEOUT' }));
        }, this.scanTimeoutMs);
        timeoutTimer.unref?.();

        try {
            const result = await this.runner.runScan(job.url, {
                signal: abortController.signal,
                requestedUrl: job.requestedUrl,
                onEngineUpdate: (engineId, patch) => {
                    if (!job.engines[engineId]) {
                        job.engines[engineId] = {};
                    }
                    Object.assign(job.engines[engineId], patch);
                }
            });
            job.status = result.status;
            job.engines = { ...job.engines, ...(result.engines || {}) };
            job.findings = result.findings || [];
            job.summary = result.summary || { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} };
            job.finishedAt = new Date().toISOString();
        } catch (error) {
            job.status = 'failed';
            job.finishedAt = new Date().toISOString();
            job.error = {
                code: error?.code || 'SCAN_FAILED',
                message: error?.message || 'Scan execution failed'
            };
        } finally {
            clearTimeout(timeoutTimer);
            this.runningJobs.delete(job.id);
            this.scheduleTtl(job.id);
            this.pruneStoredResults();
            // Process next in line
            setImmediate(() => this.processNext());
        }
    }

    pruneStoredResults() {
        if (!this.maxStoredResults || this.maxStoredResults <= 0) return;
        const finishedJobs = [];
        for (const job of this.jobs.values()) {
            if (job.status === 'completed' || job.status === 'failed') {
                finishedJobs.push(job);
            }
        }
        if (finishedJobs.length <= this.maxStoredResults) return;

        finishedJobs.sort((a, b) => {
            const timeA = new Date(a.finishedAt || a.queuedAt || 0).getTime();
            const timeB = new Date(b.finishedAt || b.queuedAt || 0).getTime();
            return timeA - timeB;
        });

        const overflow = finishedJobs.length - this.maxStoredResults;
        for (let i = 0; i < overflow; i += 1) {
            const toRemove = finishedJobs[i];
            this.jobs.delete(toRemove.id);
            const timer = this.ttlTimers.get(toRemove.id);
            if (timer) {
                clearTimeout(timer);
                this.ttlTimers.delete(toRemove.id);
            }
        }
    }

    scheduleTtl(id) {
        if (this.resultTtlMs <= 0) return;
        const timer = setTimeout(() => {
            this.jobs.delete(id);
            this.ttlTimers.delete(id);
        }, this.resultTtlMs);
        timer.unref?.();
        this.ttlTimers.set(id, timer);
    }

    close() {
        this.isClosed = true;
        for (const timer of this.ttlTimers.values()) {
            clearTimeout(timer);
        }
        this.ttlTimers.clear();
    }
}

module.exports = { JobQueue, INCLUDED_ENGINE_IDS, createInitialEngines };
