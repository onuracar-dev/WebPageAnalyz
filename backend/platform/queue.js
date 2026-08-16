const { PgBoss } = require('pg-boss');
const { databasePoolOptions } = require('../config');
const { QUEUE_DEFINITIONS } = require('./execution-boundary');
const { logger: defaultLogger } = require('../lib/logger');

class InProcessQueue {
    constructor() { this.handlers = new Map(); this.closed = false; this.jobs = new Map(); this.singletons = new Map(); }
    async start() {}
    async work(name, handler) { this.handlers.set(name, handler); }
    async send(name, data, options = {}) {
        const handler = this.handlers.get(name);
        if (!handler || this.closed) throw new Error(`No worker registered for ${name}.`);
        const singleton = options.singletonKey ? `${name}:${options.singletonKey}` : null;
        if (singleton && this.singletons.has(singleton)) return this.singletons.get(singleton);
        const id = `local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const job = { id, data, attempts: 0, retryLimit: Math.max(0, Number(options.retryLimit) || 0), retryDelay: Math.max(0, Math.min(30_000, Number(options.retryDelay) || 0)), singleton };
        this.jobs.set(id, job); if (singleton) this.singletons.set(singleton, id);
        const finish = () => { this.jobs.delete(id); if (singleton) this.singletons.delete(singleton); };
        const dispatch = () => setImmediate(async () => {
            if (this.closed) { finish(); return; }
            job.attempts += 1;
            try { await handler([{ id, data, retryCount: job.attempts - 1 }]); finish(); }
            catch {
                if (job.attempts <= job.retryLimit) setTimeout(dispatch, job.retryDelay);
                else finish();
            }
        });
        dispatch();
        return id;
    }
    async close() { this.closed = true; }
}

class PostgresQueue {
    constructor(connectionOrConfig, BossClass = PgBoss, queueLogger = defaultLogger) {
        // Queue schema DDL is an explicit release/migration operation. The API
        // process must never create or alter tables on a customer database.
        const connection = typeof connectionOrConfig === 'string'
            ? { connectionString: connectionOrConfig, connectionTimeoutMillis: 10_000 }
            : databasePoolOptions(connectionOrConfig, { max: 1, applicationName: 'webpage-analyzer-queue' });
        this.boss = new BossClass({ ...connection, schema: 'wpa_queue', application_name: 'webpage-analyzer-queue', migrate: false });
        this.boss.on?.('error', (error) => {
            // pg-boss promotes its underlying idle Pool error to the PgBoss
            // EventEmitter. It must have an application listener or a planned
            // PostgreSQL restart becomes an uncaught process-fatal event.
            try {
                queueLogger?.error?.('PostgreSQL queue connection failed', {
                    component: 'platform-queue',
                    errorCode: error?.code || 'POSTGRES_QUEUE_ERROR',
                    error
                });
            } catch {
                // A logger failure cannot make a recoverable queue connection
                // event terminate the API or worker process.
            }
        });
        this.started = null;
        this.queues = new Set();
    }
    async start() {
        if (!this.started) this.started = this.boss.start();
        await this.started;
    }
    async ensureQueue(name) {
        if (!Object.prototype.hasOwnProperty.call(QUEUE_DEFINITIONS, name)) {
            throw new Error(`Queue ${name} is not a canonical worker queue.`);
        }
        await this.start();
        if (this.queues.has(name)) return;
        // Queue schema/rows are provisioned by the release/bootstrap job. The
        // API and workers must not create queue rows opportunistically: a typo
        // or an incomplete deployment must fail closed and remain observable.
        const queue = await this.boss.getQueue(name);
        if (!queue) {
            throw new Error(`Queue ${name} is not provisioned.`);
        }
        this.queues.add(name);
    }
    async work(name, handler) { await this.ensureQueue(name); return this.boss.work(name, handler); }
    async send(name, data, options = {}) { await this.ensureQueue(name); return this.boss.send(name, data, options); }
    async close() { if (this.started) await this.boss.stop({ graceful: true, timeout: 10_000 }); }
}

function createPlatformQueue(config) {
    return config.databaseUrl ? new PostgresQueue(config) : new InProcessQueue();
}

module.exports = { InProcessQueue, PostgresQueue, createPlatformQueue };
