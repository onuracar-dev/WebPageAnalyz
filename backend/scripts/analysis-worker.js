require('dotenv').config({ quiet: true });

const fs = require('node:fs').promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { loadConfig, databasePoolOptions } = require('../config');
const { logger } = require('../lib/logger');
const { validatePublicUrl } = require('../security/url-safety');
const { createZapDistributedLock } = require('../analyzers/zap-lock');
const { createEngineLabService } = require('../admin/engine-lab');
const { createEngineLabHttpService } = require('../admin/engine-lab-http-service');

const FORBIDDEN_WORKER_SECRETS = Object.freeze([
    'BETTER_AUTH_SECRET', 'GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'GITHUB_CLIENT_SECRET', 'GITLAB_CLIENT_SECRET', 'BITBUCKET_CLIENT_SECRET',
    'GOOGLE_CLIENT_SECRET', 'ADMIN_API_KEYS', 'API_KEYS', 'EMAIL_PROVIDER_API_KEY',
    'POSTGRES_PASSWORD', 'POSTGRES_ADMIN_PASSWORD', 'POSTGRES_OWNER_PASSWORD',
    'POSTGRES_RUNTIME_PASSWORD', 'POSTGRES_MIGRATOR_PASSWORD', 'POSTGRES_WORKER_PASSWORD',
    'POSTGRES_QUEUE_PASSWORD', 'DATABASE_ADMIN_PASSWORD', 'DATABASE_MIGRATOR_PASSWORD',
    'QUEUE_DATABASE_URL'
]);
const SANDBOX_PROBE_TIMEOUT_MS = 15_000;

function truthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function probeChromiumSandbox(executable, { spawnImpl = spawn, timeoutMs = SANDBOX_PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let stderr = '';
        let child;
        let timer;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        try {
            child = spawnImpl(executable, [
                '--headless=new',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                `--user-data-dir=/tmp/wpa-sandbox-probe-${process.pid}`,
                '--dump-dom',
                'about:blank'
            ], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
            finish(error);
            return;
        }
        child.stderr?.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-2_000);
        });
        child.once('error', (error) => finish(Object.assign(new Error(`WORKER_SANDBOX_UNAVAILABLE: ${error.message}`), { code: 'WORKER_SANDBOX_UNAVAILABLE', cause: error })));
        child.once('close', (code, signal) => {
            if (code === 0) return finish();
            const detail = stderr.trim() ? ` ${stderr.trim()}` : '';
            finish(Object.assign(new Error(`WORKER_SANDBOX_UNAVAILABLE: Chromium probe exited ${code ?? 'without a code'}${signal ? ` (${signal})` : ''}.${detail}`), { code: 'WORKER_SANDBOX_UNAVAILABLE' }));
        });
        timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(Object.assign(new Error(`WORKER_SANDBOX_UNAVAILABLE: Chromium probe exceeded ${timeoutMs}ms.`), { code: 'WORKER_SANDBOX_UNAVAILABLE' }));
        }, timeoutMs);
        timer.unref?.();
    });
}

async function assertChromiumSandbox(env = process.env, fsImpl = fs, spawnImpl = spawn) {
    if (truthy(env.CHROME_NO_SANDBOX)) {
        throw Object.assign(new Error('WORKER_SANDBOX_REQUIRED: CHROME_NO_SANDBOX bypass is forbidden.'), { code: 'WORKER_SANDBOX_DISABLED' });
    }
    const executable = env.CHROME_PATH || '/usr/bin/chromium';
    try {
        await fsImpl.access(executable);
        const helperPath = env.CHROME_SANDBOX_PATH || '/usr/lib/chromium/chrome-sandbox';
        const helper = await fsImpl.stat(helperPath);
        // Chromium's Debian setuid helper must remain root-owned and setuid.
        // no-new-privileges and the container seccomp profile are still runtime
        // boundaries; this metadata check is not a full sandbox certification.
        if (helper.uid !== 0 || (helper.mode & 0o4000) !== 0o4000) {
            throw Object.assign(new Error('WORKER_SANDBOX_UNAVAILABLE: Chromium sandbox helper is not root-owned and setuid.'), { code: 'WORKER_SANDBOX_UNAVAILABLE' });
        }
        await probeChromiumSandbox(executable, { spawnImpl });
    } catch (error) {
        if (error.code === 'WORKER_SANDBOX_UNAVAILABLE' || error.code === 'WORKER_SANDBOX_DISABLED') throw error;
        throw Object.assign(new Error(`WORKER_SANDBOX_UNAVAILABLE: ${error.message}`), { code: 'WORKER_SANDBOX_UNAVAILABLE', cause: error });
    }
}

function assertWorkerBoundary(env = process.env) {
    if (env.EXECUTION_ROLE !== 'worker') throw Object.assign(new Error('WORKER_ROLE_REQUIRED: EXECUTION_ROLE must be worker.'), { code: 'WORKER_ROLE_REQUIRED' });
    if (!env.DATABASE_URL) throw Object.assign(new Error('WORKER_DATABASE_REQUIRED: DATABASE_URL is required.'), { code: 'WORKER_DATABASE_REQUIRED' });
    if (env.DATABASE_EXPECTED_ROLE && env.DATABASE_EXPECTED_ROLE !== 'wpa_worker') {
        throw Object.assign(new Error('WORKER_DATABASE_ROLE_REQUIRED: production workers must expect wpa_worker.'), { code: 'WORKER_DATABASE_ROLE_REQUIRED' });
    }
    const leaked = FORBIDDEN_WORKER_SECRETS.filter((name) => String(env[name] || '').length > 0);
    if (leaked.length) throw Object.assign(new Error(`WORKER_SECRET_BOUNDARY_VIOLATION: forbidden secret(s): ${leaked.join(', ')}.`), { code: 'WORKER_SECRET_BOUNDARY_VIOLATION' });
}

function workerDatabasePoolOptions(env = process.env) {
    // Validate every security-relevant connection property before a Pool (and
    // therefore before a socket) can be created. Compose puts these startup
    // parameters in the URL so pg applies them to every connection in the
    // pool, not only this role-check query.
    assertWorkerBoundary(env);
    const expectedRole = env.DATABASE_EXPECTED_ROLE || '';
    if (expectedRole !== 'wpa_worker') {
        if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
            throw Object.assign(new Error('WORKER_DATABASE_ROLE_REQUIRED: production workers must expect wpa_worker.'), { code: 'WORKER_DATABASE_ROLE_REQUIRED' });
        }
        return null;
    }
    let parsed;
    try { parsed = new URL(env.DATABASE_URL); } catch (error) {
        throw Object.assign(new Error('WORKER_DATABASE_INVALID: DATABASE_URL must be a valid PostgreSQL URL.'), { code: 'WORKER_DATABASE_INVALID', cause: error });
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw Object.assign(new Error('WORKER_DATABASE_INVALID: DATABASE_URL must use postgres:// or postgresql://.'), { code: 'WORKER_DATABASE_INVALID' });
    }
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const sslmode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
    if (production && !['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
        throw Object.assign(new Error('WORKER_DATABASE_TLS_REQUIRED: production worker DATABASE_URL must use sslmode=require, verify-ca, or verify-full.'), { code: 'WORKER_DATABASE_TLS_REQUIRED' });
    }
    if (production && String(env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() === 'false') {
        throw Object.assign(new Error('WORKER_DATABASE_TLS_REQUIRED: certificate verification cannot be disabled.'), { code: 'WORKER_DATABASE_TLS_REQUIRED' });
    }
    const timeoutParameters = ['connect_timeout', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'];
    if (production) {
        for (const name of timeoutParameters) {
            const value = Number(parsed.searchParams.get(name));
            if (!Number.isInteger(value) || value <= 0) {
                throw Object.assign(new Error(`WORKER_DATABASE_TIMEOUT_REQUIRED: DATABASE_URL must include a positive ${name}.`), { code: 'WORKER_DATABASE_TIMEOUT_REQUIRED' });
            }
        }
    }
    const config = loadConfig(env);
    const options = databasePoolOptions(config, { max: 1, applicationName: 'webpage-analyzer-worker-role-check' });
    const connectTimeoutSeconds = Number(parsed.searchParams.get('connect_timeout'));
    if (Number.isInteger(connectTimeoutSeconds) && connectTimeoutSeconds > 0) options.connectionTimeoutMillis = connectTimeoutSeconds * 1000;
    return options;
}

async function assertDatabaseRole(env = process.env, PoolClass = Pool) {
    const expectedRole = env.DATABASE_EXPECTED_ROLE || '';
    const options = workerDatabasePoolOptions(env);
    if (!options) return;
    const pool = new PoolClass(options);
    try {
        const actualRole = (await pool.query('SELECT current_user AS role')).rows[0]?.role;
        if (actualRole !== expectedRole) {
            throw Object.assign(new Error(`WORKER_DATABASE_ROLE_MISMATCH: expected ${expectedRole}, received ${actualRole || 'unknown'}.`), { code: 'WORKER_DATABASE_ROLE_MISMATCH' });
        }
    } finally {
        await pool.end().catch(() => {});
    }
}

function configuredHandler() {
    const moduleName = process.env.WORKER_HANDLER_MODULE;
    if (!moduleName) return null;
    const modulePath = path.isAbsolute(moduleName) ? moduleName : path.resolve(process.cwd(), moduleName);
    // The handler is an explicit application-owned contract. This infra
    // entrypoint does not guess at job/result schemas or copy auth context.
    const loaded = require(modulePath);
    const start = loaded.startWorker || loaded.start;
    if (typeof start !== 'function') throw new Error(`WORKER_HANDLER_INVALID: ${moduleName} must export startWorker({ config, logger }).`);
    return { modulePath, start };
}

async function startLegacyAnalysisWorker(config, workerLogger) {
    // Compatibility path for the existing durable page queue. The application
    // owner can set WORKER_HANDLER_MODULE once source/PDF/OSV job contracts are
    // registered; the API never imports this entrypoint.
    const { TaskPool } = require('../lib/task-pool');
    const { createAnalysisService } = require('../services/analysis-service');
    const { createPlatformStore } = require('../platform/store');
    const { createPlatformQueue } = require('../platform/queue');
    const { createPlatformService } = require('../platform/service');
    const store = createPlatformStore(config);
    const queue = createPlatformQueue(config);
    const analysisPool = new TaskPool({ maxConcurrent: config.maxConcurrentAnalyses, maxQueue: config.maxQueuedAnalyses });
    const analysisService = createAnalysisService({ config, logger: workerLogger });
    const validateUrl = (url) => validatePublicUrl(url, { allowedPorts: config.allowedTargetPorts });
    const service = createPlatformService({ store, queue, analysisPool, analysisService, validateUrl, config, logger: workerLogger });
    await service.start();
    return {
        async close() {
            await service.close();
            analysisPool.close();
            await Promise.allSettled([store.close()]);
        }
    };
}

async function startEngineLabEndpoint({ config, runtime, workerLogger = logger } = {}) {
    if (!config?.engineLab?.enabled) return null;
    if (!runtime?.store || typeof runtime.store.logAudit !== 'function') {
        throw Object.assign(new Error('ENGINE_LAB_WORKER_STORE_REQUIRED: the isolated service requires the worker platform store.'), { code: 'ENGINE_LAB_WORKER_STORE_REQUIRED' });
    }
    const validateUrl = (url) => validatePublicUrl(url, { allowedPorts: config.allowedTargetPorts });
    const zapLock = createZapDistributedLock({ pool: runtime.store.pool, required: config.nodeEnv === 'production' && Boolean(config.zap?.url) });
    const engineLabService = createEngineLabService({
        config,
        logger: workerLogger,
        validateUrl,
        zapLock,
        audit: ({ action, actorId, entityId, reason, requestId, before, after, metadata }) => runtime.store.logAudit({
            workspaceId: null,
            actorId,
            action,
            entityType: 'engine_lab_run',
            entityId,
            reason,
            requestId,
            before,
            after,
            metadata
        })
    });
    const endpoint = createEngineLabHttpService({ engineLabService, config, logger: workerLogger });
    const address = await endpoint.listen();
    workerLogger.info('Internal Engine Lab service started', {
        host: config.engineLab.host,
        port: typeof address === 'object' ? address.port : config.engineLab.port,
        executionRole: config.executionRole
    });
    return endpoint;
}

async function startWorker({ env = process.env, workerLogger = logger, fsImpl = fs } = {}) {
    assertWorkerBoundary(env);
    await assertDatabaseRole(env);
    const config = loadConfig(env);
    // A worker cannot opt out of the browser sandbox through configuration.
    // WORKER_SANDBOX_REQUIRED remains a descriptive contract for deployment
    // manifests; unsupported kernels must fail before any job is consumed.
    await assertChromiumSandbox(env, fsImpl);
    const handler = configuredHandler();
    const runtime = handler
        ? await handler.start({ config, logger: workerLogger, workerKind: env.WORKER_KIND || 'analysis' })
        : await startLegacyAnalysisWorker(config, workerLogger);
    let engineLabEndpoint = null;
    try {
        engineLabEndpoint = await startEngineLabEndpoint({ config, runtime, workerLogger });
    } catch (error) {
        await Promise.resolve(runtime?.close?.()).catch(() => {});
        throw error;
    }
    const effectiveRuntime = engineLabEndpoint ? {
        ...runtime,
        async close() {
            try { await engineLabEndpoint.close(); }
            finally { await runtime?.close?.(); }
        }
    } : runtime;
    await fsImpl.writeFile('/tmp/wpa-worker.ready', JSON.stringify({
        schemaVersion: 'wpa.worker-readiness.v2',
        role: env.EXECUTION_ROLE,
        kind: env.WORKER_KIND || 'analysis',
        handler: handler?.modulePath || 'legacy-platform-page-worker',
        engineLabService: Boolean(engineLabEndpoint),
        pid: process.pid,
        readyAt: new Date().toISOString()
    }), { mode: 0o600 });
    return { config, runtime: effectiveRuntime || {}, handler: handler?.modulePath || null };
}

async function main() {
    const running = await startWorker();
    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info('Analysis worker shutdown initiated', { signal });
        await running.runtime?.close?.();
        process.exitCode = 0;
    };
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
    await new Promise(() => {});
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { FORBIDDEN_WORKER_SECRETS, assertChromiumSandbox, assertDatabaseRole, assertWorkerBoundary, probeChromiumSandbox, startEngineLabEndpoint, startWorker, truthy, workerDatabasePoolOptions };
