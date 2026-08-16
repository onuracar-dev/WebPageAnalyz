require('dotenv').config({ quiet: true });

const fs = require('node:fs').promises;
const path = require('node:path');
const { Pool } = require('pg');
const { loadConfig, databasePoolOptions } = require('../config');
const { logger } = require('../lib/logger');

// The maintenance process is deliberately a separate boundary from the
// analysis worker. It has no browser/source/provider credentials and may only
// execute the retention/deletion lifecycle in the application handler.
const FORBIDDEN_MAINTENANCE_SECRETS = Object.freeze([
    'BETTER_AUTH_SECRET', 'GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'GITHUB_CLIENT_SECRET', 'GITLAB_CLIENT_SECRET', 'BITBUCKET_CLIENT_SECRET',
    'GOOGLE_CLIENT_SECRET', 'ADMIN_API_KEYS', 'API_KEYS', 'EMAIL_PROVIDER_API_KEY',
    'SOURCE_ENCRYPTION_KEY', 'ZAP_API_KEY', 'ZAP_URL', 'CHROME_PATH', 'CHROME_SANDBOX_PATH',
    'CHROME_NO_SANDBOX', 'OSV_SCANNER_PATH', 'OSV_ISOLATION_RUNNER',
    'POSTGRES_PASSWORD', 'POSTGRES_ADMIN_PASSWORD', 'POSTGRES_OWNER_PASSWORD',
    'POSTGRES_RUNTIME_PASSWORD', 'POSTGRES_MIGRATOR_PASSWORD', 'POSTGRES_WORKER_PASSWORD',
    'POSTGRES_QUEUE_PASSWORD', 'DATABASE_ADMIN_PASSWORD', 'DATABASE_MIGRATOR_PASSWORD',
    'QUEUE_DATABASE_URL'
]);
const REQUIRED_DISABLED_FLAGS = Object.freeze(['BROWSER_EXECUTION_DISABLED', 'PDF_EXECUTION_DISABLED', 'SOURCE_EXECUTION_DISABLED', 'OSV_EXECUTION_DISABLED']);

function truthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function assertMaintenanceBoundary(env = process.env) {
    if (env.EXECUTION_ROLE !== 'maintenance') throw Object.assign(new Error('MAINTENANCE_ROLE_REQUIRED: EXECUTION_ROLE must be maintenance.'), { code: 'MAINTENANCE_ROLE_REQUIRED' });
    if (!env.DATABASE_URL) throw Object.assign(new Error('MAINTENANCE_DATABASE_REQUIRED: DATABASE_URL is required.'), { code: 'MAINTENANCE_DATABASE_REQUIRED' });
    if ((env.DATABASE_EXPECTED_ROLE || 'wpa_maintenance') !== 'wpa_maintenance') throw Object.assign(new Error('MAINTENANCE_DATABASE_ROLE_REQUIRED: production maintenance must expect wpa_maintenance.'), { code: 'MAINTENANCE_DATABASE_ROLE_REQUIRED' });
    if (!['platform/worker-handler.js', '/app/platform/worker-handler.js'].includes(env.WORKER_HANDLER_MODULE || '')) throw Object.assign(new Error('MAINTENANCE_HANDLER_REQUIRED: WORKER_HANDLER_MODULE must point to platform/worker-handler.js.'), { code: 'MAINTENANCE_HANDLER_REQUIRED' });
    const disabled = REQUIRED_DISABLED_FLAGS.filter((name) => !truthy(env[name]));
    if (disabled.length) throw Object.assign(new Error(`MAINTENANCE_EXECUTION_DISABLED_REQUIRED: ${disabled.join(', ')} must be true.`), { code: 'MAINTENANCE_EXECUTION_DISABLED_REQUIRED' });
    const leaked = FORBIDDEN_MAINTENANCE_SECRETS.filter((name) => String(env[name] || '').length > 0);
    if (leaked.length) throw Object.assign(new Error(`MAINTENANCE_SECRET_BOUNDARY_VIOLATION: forbidden secret(s): ${leaked.join(', ')}.`), { code: 'MAINTENANCE_SECRET_BOUNDARY_VIOLATION' });
}

function maintenanceDatabasePoolOptions(env = process.env) {
    assertMaintenanceBoundary(env);
    let parsed;
    try { parsed = new URL(env.DATABASE_URL); } catch (cause) { throw Object.assign(new Error('MAINTENANCE_DATABASE_INVALID: DATABASE_URL must be a valid PostgreSQL URL.'), { code: 'MAINTENANCE_DATABASE_INVALID', cause }); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw Object.assign(new Error('MAINTENANCE_DATABASE_INVALID: DATABASE_URL must use postgres:// or postgresql://.'), { code: 'MAINTENANCE_DATABASE_INVALID' });
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const sslmode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
    if (production && !['require', 'verify-ca', 'verify-full'].includes(sslmode)) throw Object.assign(new Error('MAINTENANCE_DATABASE_TLS_REQUIRED: production maintenance DATABASE_URL must use TLS.'), { code: 'MAINTENANCE_DATABASE_TLS_REQUIRED' });
    if (production && String(env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() === 'false') throw Object.assign(new Error('MAINTENANCE_DATABASE_TLS_REQUIRED: certificate verification cannot be disabled.'), { code: 'MAINTENANCE_DATABASE_TLS_REQUIRED' });
    if (production) {
        for (const name of ['connect_timeout', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout']) {
            const value = Number(parsed.searchParams.get(name));
            if (!Number.isInteger(value) || value <= 0) throw Object.assign(new Error(`MAINTENANCE_DATABASE_TIMEOUT_REQUIRED: DATABASE_URL must include a positive ${name}.`), { code: 'MAINTENANCE_DATABASE_TIMEOUT_REQUIRED' });
        }
    }
    const config = loadConfig(env);
    const options = databasePoolOptions(config, { max: 2, applicationName: 'webpage-analyzer-maintenance-role-check' });
    const connectTimeoutSeconds = Number(parsed.searchParams.get('connect_timeout'));
    if (Number.isInteger(connectTimeoutSeconds) && connectTimeoutSeconds > 0) options.connectionTimeoutMillis = connectTimeoutSeconds * 1000;
    return options;
}

async function assertMaintenanceDatabaseRole(env = process.env, PoolClass = Pool) {
    const options = maintenanceDatabasePoolOptions(env);
    const pool = new PoolClass(options);
    try {
        const actualRole = (await pool.query('SELECT current_user AS role')).rows[0]?.role;
        if (actualRole !== 'wpa_maintenance') throw Object.assign(new Error(`MAINTENANCE_DATABASE_ROLE_MISMATCH: expected wpa_maintenance, received ${actualRole || 'unknown'}.`), { code: 'MAINTENANCE_DATABASE_ROLE_MISMATCH' });
    } finally { await pool.end().catch(() => {}); }
}

function configuredHandler(env = process.env) {
    const moduleName = env.WORKER_HANDLER_MODULE;
    const modulePath = path.isAbsolute(moduleName) ? moduleName : path.resolve(process.cwd(), moduleName);
    const loaded = require(modulePath);
    if (typeof loaded.startWorker !== 'function') throw new Error('MAINTENANCE_HANDLER_INVALID: platform/worker-handler.js must export startWorker.');
    return { modulePath, start: loaded.startWorker };
}

async function startWorker({ env = process.env, workerLogger = logger, fsImpl = fs } = {}) {
    assertMaintenanceBoundary(env);
    await assertMaintenanceDatabaseRole(env);
    const config = loadConfig(env);
    const handler = configuredHandler(env);
    const runtime = await handler.start({ config, logger: workerLogger, workerKind: 'maintenance' });
    await fsImpl.writeFile('/tmp/wpa-worker.ready', JSON.stringify({
        schemaVersion: 'wpa.worker-readiness.v2',
        role: env.EXECUTION_ROLE,
        kind: 'maintenance',
        handler: handler.modulePath,
        pid: process.pid,
        readyAt: new Date().toISOString()
    }), { mode: 0o600 });
    return { config, runtime, handler: handler.modulePath };
}

async function main() {
    const running = await startWorker();
    let stopping = false;
    let finish;
    const stopped = new Promise((resolve) => { finish = resolve; });
    // An unresolved Promise does not keep Node's event loop alive. The
    // maintenance timers are deliberately unref'ed, so retain one explicit
    // process-lifetime handle until SIGTERM/SIGINT completes graceful close.
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info('Maintenance worker shutdown initiated', { signal });
        try {
            await running.runtime?.close?.();
            process.exitCode = 0;
        } catch (error) {
            logger.error('Maintenance worker shutdown failed', { signal, error });
            process.exitCode = 1;
        } finally {
            clearInterval(keepAlive);
            finish();
        }
    };
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
    await stopped;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { FORBIDDEN_MAINTENANCE_SECRETS, assertMaintenanceBoundary, assertMaintenanceDatabaseRole, maintenanceDatabasePoolOptions, startWorker, truthy };
