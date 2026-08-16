require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATION_LOCK_KEY = '826366509737';
const MIGRATION_DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

function positiveInteger(value, fallback, max = 600_000) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function isTrue(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function migrationChecksum(contents) {
    return crypto.createHash('sha256').update(contents).digest('hex');
}

async function readMigrationFiles(directory = MIGRATION_DIRECTORY, fsImpl = fs) {
    const names = (await fsImpl.readdir(directory))
        .filter((filename) => filename.endsWith('.sql'))
        .sort((left, right) => left.localeCompare(right));
    const files = [];
    for (const filename of names) {
        const contents = await fsImpl.readFile(path.join(directory, filename));
        files.push({ filename, contents, checksum: migrationChecksum(contents) });
    }
    return files;
}

function migrationConnectionOptions(env) {
    const connectionString = env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required.');
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const requireTls = isTrue(env.MIGRATION_REQUIRE_TLS) || (production && env.MIGRATION_REQUIRE_TLS !== 'false');
    const tlsInConnectionString = /(?:^|[?&])sslmode=(?:require|verify-ca|verify-full)(?:&|$)/i.test(connectionString);
    if (requireTls && !tlsInConnectionString && !isTrue(env.PGSSL_REQUIRE)) {
        throw new Error('MIGRATION_TLS_REQUIRED: DATABASE_URL must request sslmode=require (or stronger).');
    }
    const options = {
        connectionString,
        max: 1,
        application_name: env.MIGRATION_APPLICATION_NAME || 'webpage-analyzer-migrator'
    };
    if (tlsInConnectionString || isTrue(env.PGSSL_REQUIRE)) {
        options.ssl = { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
    }
    return options;
}

function migrationError(code, message, details = {}) {
    return Object.assign(new Error(`${code}: ${message}`), { code, ...details });
}

async function ensureLedger(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS wpa_schema_migrations (
            filename text PRIMARY KEY,
            checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    // Existing installations created by the pre-checksum runner can be read,
    // but are not silently upgraded: a missing checksum is an evidence gap.
    await client.query('ALTER TABLE wpa_schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    await client.query('ALTER TABLE wpa_schema_migrations ADD COLUMN IF NOT EXISTS applied_at timestamptz NOT NULL DEFAULT now()');
}

async function verifyMigrationLedger(client, files) {
    const { rows } = await client.query('SELECT filename, checksum FROM wpa_schema_migrations ORDER BY filename');
    const expected = new Map(files.map((file) => [file.filename, file.checksum]));
    for (const row of rows) {
        if (!expected.has(row.filename)) throw migrationError('MIGRATION_LEDGER_RESIDUE', `Ledger entry ${row.filename} has no source migration.`);
        if (!row.checksum) throw migrationError('MIGRATION_LEDGER_UNVERIFIED', `Ledger entry ${row.filename} has no checksum.`);
        if (row.checksum !== expected.get(row.filename)) {
            throw migrationError('MIGRATION_DRIFT', `Migration ${row.filename} checksum differs from the applied ledger.`, {
                filename: row.filename,
                expectedChecksum: expected.get(row.filename),
                appliedChecksum: row.checksum
            });
        }
    }
    return rows;
}

async function assertExpectedRole(client, env) {
    const expectedRole = env.MIGRATION_EXPECTED_ROLE || '';
    if (!expectedRole) return;
    const { rows } = await client.query('SELECT current_user AS role');
    const actualRole = rows[0]?.role;
    if (actualRole !== expectedRole) throw migrationError('MIGRATION_ROLE_MISMATCH', `Expected database role ${expectedRole}, received ${actualRole || 'unknown'}.`);
}

async function setSessionTimeouts(client, env) {
    const statementTimeoutMs = positiveInteger(env.MIGRATION_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS);
    const lockTimeoutMs = positiveInteger(env.MIGRATION_LOCK_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS);
    const idleTimeoutMs = positiveInteger(env.MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
    await client.query('SELECT set_config($1, $2, false)', ['statement_timeout', `${statementTimeoutMs}ms`]);
    await client.query('SELECT set_config($1, $2, false)', ['lock_timeout', `${lockTimeoutMs}ms`]);
    await client.query('SELECT set_config($1, $2, false)', ['idle_in_transaction_session_timeout', `${idleTimeoutMs}ms`]);
    return { statementTimeoutMs, lockTimeoutMs, idleTimeoutMs };
}

async function runMigrations({
    env = process.env,
    pool: suppliedPool,
    migrationDirectory = MIGRATION_DIRECTORY,
    fsImpl = fs,
    logger = console
} = {}) {
    const pool = suppliedPool || new Pool(migrationConnectionOptions(env));
    const ownsPool = !suppliedPool;
    const files = await readMigrationFiles(migrationDirectory, fsImpl);
    const client = await pool.connect();
    let lockHeld = false;
    try {
        await setSessionTimeouts(client, env);
        await assertExpectedRole(client, env);
        await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
        lockHeld = true;
        await ensureLedger(client);
        await verifyMigrationLedger(client, files);
        const applied = new Set((await client.query('SELECT filename FROM wpa_schema_migrations')).rows.map((row) => row.filename));
        for (const file of files) {
            if (applied.has(file.filename)) continue;
            try {
                await client.query('BEGIN');
                await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', `${positiveInteger(env.MIGRATION_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS)}ms`]);
                await client.query('SELECT set_config($1, $2, true)', ['lock_timeout', `${positiveInteger(env.MIGRATION_LOCK_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS)}ms`]);
                await client.query(file.contents.toString('utf8'));
                await client.query('INSERT INTO wpa_schema_migrations(filename, checksum) VALUES($1, $2)', [file.filename, file.checksum]);
                await client.query('COMMIT');
                logger.info?.(`Applied ${file.filename} (${file.checksum.slice(0, 12)})`);
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw migrationError('MIGRATION_APPLY_FAILED', `${file.filename}: ${error.message}`, { cause: error, filename: file.filename });
            }
        }
        await verifyMigrationLedger(client, files);
        return {
            applied: files.filter((file) => !applied.has(file.filename)).map((file) => file.filename),
            latest: files.at(-1)?.filename || null,
            migrationCount: files.length
        };
    } finally {
        if (lockHeld) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => {});
        client.release();
        if (ownsPool) await pool.end();
    }
}

async function main() {
    const result = await runMigrations();
    process.stdout.write(`Migration ledger verified: ${result.migrationCount} migration(s), latest ${result.latest || 'none'}.\n`);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    MIGRATION_DIRECTORY,
    MIGRATION_LOCK_KEY,
    migrationChecksum,
    migrationConnectionOptions,
    readMigrationFiles,
    verifyMigrationLedger,
    runMigrations
};
