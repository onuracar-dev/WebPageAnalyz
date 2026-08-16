require('dotenv').config({ quiet: true });

const fs = require('node:fs').promises;
const path = require('node:path');
const { Pool } = require('pg');
const { migrationChecksum, readMigrationFiles } = require('./migrate');

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', 'logs', 'test-results', 'worker-artifacts', 'source-inputs']);

// Keep this list aligned with backend/.dockerignore. These are source-only
// inputs that are deliberately absent from the production image, not runtime
// drift. The reason is carried into the report so an operator can distinguish
// an intentional image boundary from a missing deployable module.
const RUNTIME_EXCLUSION_RULES = Object.freeze([
    { name: 'dependency-tree', test: (relative) => relative === 'node_modules' || relative.startsWith('node_modules/'), reason: 'installed in the image by npm ci' },
    { name: 'test-code', test: (relative) => relative === 'test' || relative.startsWith('test/'), reason: 'test code excluded by backend/.dockerignore' },
    { name: 'test-results', test: (relative) => relative === 'test-results' || relative.startsWith('test-results/'), reason: 'test output excluded by backend/.dockerignore' },
    { name: 'local-environment', test: (relative) => /^\.env(?:$|\.)/.test(relative), reason: 'local environment or secret file excluded by backend/.dockerignore' },
    { name: 'coverage', test: (relative) => relative === 'coverage' || relative.startsWith('coverage/'), reason: 'coverage output excluded from production images' },
    { name: 'runtime-logs', test: (relative) => relative === 'logs' || relative.startsWith('logs/'), reason: 'runtime-owned log directory is mounted separately' },
    { name: 'worker-artifacts', test: (relative) => relative === 'worker-artifacts' || relative.startsWith('worker-artifacts/'), reason: 'worker artifact directory is mounted separately' },
    { name: 'source-inputs', test: (relative) => relative === 'source-inputs' || relative.startsWith('source-inputs/'), reason: 'encrypted source staging directory is mounted separately' },
    { name: 'npm-debug-log', test: (relative) => /^npm-debug\.log(?:$|\.)/.test(relative), reason: 'local package-manager log excluded by backend/.dockerignore' },
]);

function classifyRuntimeExclusion(relativePath) {
    const relative = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
    return RUNTIME_EXCLUSION_RULES.find((rule) => rule.test(relative)) || null;
}

async function walk(root, current = root, fsImpl = fs, exclusions = []) {
    const entries = await fsImpl.readdir(current, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        const exclusion = classifyRuntimeExclusion(relative);
        if (exclusion) {
            if (entry.isDirectory()) exclusions.push({ path: relative, rule: exclusion.name, reason: exclusion.reason });
            else exclusions.push({ path: relative, rule: exclusion.name, reason: exclusion.reason });
            continue;
        }
        // Keep these historical generated-directory exclusions for source
        // trees that do not have a .dockerignore. They are also classified so
        // the report never silently hides a source/runtime boundary.
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
            exclusions.push({ path: relative, rule: entry.name, reason: 'generated or mounted runtime directory excluded from the image manifest' });
            continue;
        }
        if (entry.isDirectory()) result.push(...await walk(root, absolute, fsImpl, exclusions));
        else if (entry.isFile()) {
            const contents = await fsImpl.readFile(absolute);
            result.push({ path: relative, bytes: contents.length, sha256: migrationChecksum(contents) });
        }
    }
    return result;
}

async function hashTree(root, fsImpl = fs) {
    return walk(path.resolve(root), path.resolve(root), fsImpl);
}

async function runtimeManifest(root, fsImpl = fs) {
    const exclusions = [];
    const manifest = await walk(path.resolve(root), path.resolve(root), fsImpl, exclusions);
    return { manifest, exclusions };
}

function compareManifests(source, runtime) {
    const sourceMap = new Map(source.map((entry) => [entry.path, entry]));
    const runtimeMap = new Map(runtime.map((entry) => [entry.path, entry]));
    const mismatches = [];
    for (const [relative, sourceEntry] of sourceMap) {
        const runtimeEntry = runtimeMap.get(relative);
        if (!runtimeEntry) mismatches.push({ path: relative, status: 'missing-in-runtime' });
        else if (runtimeEntry.sha256 !== sourceEntry.sha256 || runtimeEntry.bytes !== sourceEntry.bytes) mismatches.push({ path: relative, status: 'hash-mismatch', source: sourceEntry, runtime: runtimeEntry });
    }
    for (const [relative, runtimeEntry] of runtimeMap) {
        if (!sourceMap.has(relative)) mismatches.push({ path: relative, status: 'runtime-only', runtime: runtimeEntry });
    }
    return mismatches.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyMigrationVersion({ databaseUrl, migrationDirectory, expectedLatest = null, expectedRole = null, PoolClass = Pool } = {}) {
    if (!databaseUrl) return { status: 'UNPROVEN', reason: 'DATABASE_URL was not supplied.' };
    const pool = new PoolClass({ connectionString: databaseUrl, max: 1, application_name: 'webpage-analyzer-runtime-drift' });
    try {
        if (expectedRole) {
            const role = (await pool.query('SELECT current_user AS role')).rows[0]?.role;
            if (role !== expectedRole) return { status: 'FAIL', reason: `Expected role ${expectedRole}, received ${role || 'unknown'}.` };
        }
        const files = await readMigrationFiles(migrationDirectory);
        const rows = (await pool.query('SELECT filename,checksum FROM wpa_schema_migrations ORDER BY filename')).rows;
        const source = new Map(files.map((file) => [file.filename, file.checksum]));
        const mismatches = [];
        for (const row of rows) {
            if (!source.has(row.filename)) mismatches.push({ filename: row.filename, status: 'ledger-only' });
            else if (!row.checksum || row.checksum !== source.get(row.filename)) mismatches.push({ filename: row.filename, status: 'checksum-mismatch', expected: source.get(row.filename), actual: row.checksum || null });
        }
        for (const file of files) if (!rows.some((row) => row.filename === file.filename)) mismatches.push({ filename: file.filename, status: 'source-not-applied' });
        const latest = rows.at(-1)?.filename || null;
        if (expectedLatest && latest !== expectedLatest) mismatches.push({ filename: expectedLatest, status: 'latest-version-mismatch', actual: latest });
        return { status: mismatches.length ? 'FAIL' : 'PASS', latest, migrationCount: rows.length, mismatches };
    } finally {
        await pool.end();
    }
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2).replaceAll('-', '_');
        args[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
    }
    return args;
}

function isTruthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

async function main(argv = process.argv.slice(2), fsImpl = fs) {
    const args = parseArgs(argv);
    const sourceRoot = path.resolve(String(args.source_root || process.cwd()));
    const runtimeRoot = args.runtime_root ? path.resolve(String(args.runtime_root)) : null;
    const sourceOnly = args.source_only === true || isTruthy(args.source_only);
    const sourceRuntime = await runtimeManifest(sourceRoot, fsImpl);
    const sourceManifest = sourceRuntime.manifest;
    const runtimeHashManifest = runtimeRoot ? await hashTree(runtimeRoot, fsImpl) : null;
    const mismatches = runtimeHashManifest ? compareManifests(sourceManifest, runtimeHashManifest) : [];
    const migrationDirectory = args.migration_directory
        ? path.resolve(String(args.migration_directory))
        : path.join(sourceRoot, 'db', 'migrations');
    const migration = args.skip_database
        ? { status: 'UNPROVEN', reason: 'Database verification was explicitly skipped.' }
        : await verifyMigrationVersion({
            databaseUrl: args.database_url || process.env.DATABASE_URL,
            migrationDirectory,
            expectedLatest: args.expected_migration || null,
            expectedRole: args.expected_role || process.env.DRIFT_EXPECTED_ROLE || null,
        });
    const runtimeVerification = runtimeRoot
        ? { status: mismatches.length ? 'FAIL' : 'PASS' }
        : { status: 'UNPROVEN', reason: sourceOnly ? 'Source-only mode was explicitly selected; no runtime root was supplied.' : 'A runtime root is required unless --source-only is explicitly selected.' };
    const status = mismatches.length || migration.status === 'FAIL'
        ? 'FAIL'
        : runtimeVerification.status === 'UNPROVEN' || migration.status === 'UNPROVEN'
            ? 'UNPROVEN'
            : 'PASS';
    const result = {
        status,
        mode: sourceOnly ? 'source-only' : 'runtime-and-database',
        sourceRoot,
        runtimeRoot,
        sourceFileCount: sourceManifest.length,
        runtimeFileCount: runtimeHashManifest?.length ?? null,
        sourceIntentionalExclusions: sourceRuntime.exclusions,
        mismatches,
        runtime: runtimeVerification,
        migration
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'FAIL') process.exitCode = 1;
    else if (result.status === 'UNPROVEN' && !sourceOnly) process.exitCode = 2;
    return result;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { IGNORED_DIRECTORIES, RUNTIME_EXCLUSION_RULES, classifyRuntimeExclusion, compareManifests, hashTree, runtimeManifest, isTruthy, parseArgs, verifyMigrationVersion };
