require('dotenv').config({ quiet: true });

const { PgBoss } = require('pg-boss');
const { Pool } = require('pg');
const { QUEUE_DEFINITIONS } = require('../platform/execution-boundary');

function probePoolOptions(connectionString) {
    let ssl;
    try {
        const mode = String(new URL(connectionString).searchParams.get('sslmode') || '').toLowerCase();
        if (['require', 'verify-ca', 'verify-full'].includes(mode)) ssl = { rejectUnauthorized: true };
    } catch { /* PgBoss will report malformed URLs with its normal error. */ }
    return { connectionString, max: 1, application_name: 'webpage-analyzer-queue-probe', ...(ssl ? { ssl } : {}) };
}

async function queueAlreadyMigrated({ connectionString, schema, PoolClass = Pool } = {}) {
    const pool = new PoolClass(probePoolOptions(connectionString));
    try {
        // Inspect catalogs instead of resolving schema.job: after the first
        // bootstrap wpa_queue intentionally has no schema USAGE/CREATE, while
        // its objects are owned by the NOLOGIN wpa_owner role.
        const { rows } = await pool.query(
            'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2) AS present',
            [schema, 'job']
        );
        return rows[0]?.present === true;
    } finally {
        await pool.end().catch(() => {});
    }
}

async function bootstrapQueue({ env = process.env, BossClass = PgBoss, PoolClass = Pool } = {}) {
    const connectionString = env.QUEUE_DATABASE_URL || env.DATABASE_URL;
    if (!connectionString) throw new Error('QUEUE_DATABASE_URL or DATABASE_URL is required.');
    const schema = env.QUEUE_SCHEMA || 'wpa_queue';
    // db-migrate is safely repeatable after db-grants transfers pg-boss
    // ownership to wpa_owner. Only the first bootstrap may run pg-boss DDL as
    // wpa_queue; subsequent checks must not attempt ALTER/CREATE as runtime.
    const migrated = !(await queueAlreadyMigrated({ connectionString, schema, PoolClass }));
    const boss = new BossClass({
        connectionString,
        schema,
        application_name: 'webpage-analyzer-queue-migrator',
        migrate: migrated
    });
    try {
        await boss.start();
        // Queue rows are deliberately created by this one-shot bootstrap. The
        // operation is idempotent in pg-boss and works after ownership has
        // moved to wpa_owner because it is a bounded queue-row/function call,
        // not schema DDL. This also repairs an interrupted first bootstrap.
        for (const [name, options] of Object.entries(QUEUE_DEFINITIONS)) {
            await boss.createQueue(name, options);
        }
    } finally {
        await boss.stop({ graceful: true, timeout: 10_000 });
    }
    return { schema, migrated };
}

if (require.main === module) {
    bootstrapQueue().then(({ schema }) => process.stdout.write(`Queue schema verified: ${schema}.\n`)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { bootstrapQueue };
