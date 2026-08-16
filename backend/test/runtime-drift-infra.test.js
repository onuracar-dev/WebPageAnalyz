const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareManifests, hashTree, runtimeManifest } = require('../scripts/runtime-drift');

test('runtime drift compares deterministic source and runtime hashes', async (t) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-source-'));
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-runtime-'));
    t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(runtime, { recursive: true, force: true })]));
    await fs.mkdir(path.join(source, 'db', 'migrations'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'db', 'migrations'), { recursive: true });
    await fs.writeFile(path.join(source, 'server.js'), 'source');
    await fs.writeFile(path.join(runtime, 'server.js'), 'runtime');
    await fs.writeFile(path.join(source, 'db', 'migrations', '001_test.sql'), 'select 1');
    await fs.writeFile(path.join(runtime, 'db', 'migrations', '001_test.sql'), 'select 1');
    const mismatches = compareManifests(await hashTree(source), await hashTree(runtime));
    assert.deepEqual(mismatches.map((item) => item.path), ['server.js']);
    assert.equal(mismatches[0].status, 'hash-mismatch');
});

test('runtime drift image-root fixture classifies Docker-excluded source files and still catches deployable omissions', async (t) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-image-source-'));
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-image-root-'));
    t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(runtime, { recursive: true, force: true })]));

    await fs.mkdir(path.join(source, 'test'), { recursive: true });
    await fs.mkdir(path.join(source, 'db', 'migrations'), { recursive: true });
    await fs.writeFile(path.join(source, '.dockerignore'), 'test\n');
    await fs.writeFile(path.join(source, 'Dockerfile'), 'FROM node');
    await fs.writeFile(path.join(source, '.env.example'), 'DATABASE_URL=local-only');
    await fs.writeFile(path.join(source, 'test', 'fixture.test.js'), 'test-only');
    await fs.writeFile(path.join(source, 'server.js'), 'server');
    await fs.writeFile(path.join(source, 'platform.js'), 'platform');
    await fs.writeFile(path.join(source, 'db', 'migrations', '001_test.sql'), 'select 1');

    // This is the production image root: npm-installed dependencies and
    // Docker-excluded source-only files are absent, deployable files remain.
    await fs.mkdir(path.join(runtime, 'db', 'migrations'), { recursive: true });
    await fs.writeFile(path.join(runtime, '.dockerignore'), 'test\n');
    await fs.writeFile(path.join(runtime, 'Dockerfile'), 'FROM node');
    await fs.writeFile(path.join(runtime, 'server.js'), 'server');
    await fs.writeFile(path.join(runtime, 'platform.js'), 'platform');
    await fs.writeFile(path.join(runtime, 'db', 'migrations', '001_test.sql'), 'select 1');

    const sourceRuntime = await runtimeManifest(source);
    assert.deepEqual(sourceRuntime.manifest.map((entry) => entry.path), ['.dockerignore', 'db/migrations/001_test.sql', 'Dockerfile', 'platform.js', 'server.js']);
    assert.deepEqual(sourceRuntime.exclusions.map((entry) => ({ path: entry.path, rule: entry.rule })), [
        { path: '.env.example', rule: 'local-environment' },
        { path: 'test', rule: 'test-code' },
    ]);
    assert.deepEqual(compareManifests(sourceRuntime.manifest, await hashTree(runtime)), []);

    await fs.rm(path.join(runtime, 'platform.js'));
    assert.deepEqual(compareManifests(sourceRuntime.manifest, await hashTree(runtime)), [
        { path: 'platform.js', status: 'missing-in-runtime' },
    ]);
});

test('runtime drift is explicitly UNPROVEN and nonzero without a runtime root', async (t) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-source-only-'));
    t.after(() => fs.rm(source, { recursive: true, force: true }));
    const script = path.join(__dirname, '..', 'scripts', 'runtime-drift.js');
    const result = spawnSync(process.execPath, [script, '--source-root', source, '--skip-database'], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'UNPROVEN');
    assert.equal(report.runtimeRoot, null);
    assert.match(report.runtime.reason, /runtime root is required/i);
});

test('runtime drift source-only mode never claims PASS with null runtime or migrations', async (t) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-drift-source-only-explicit-'));
    t.after(() => fs.rm(source, { recursive: true, force: true }));
    const script = path.join(__dirname, '..', 'scripts', 'runtime-drift.js');
    const result = spawnSync(process.execPath, [script, '--source-root', source, '--source-only', '--skip-database'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'UNPROVEN');
    assert.equal(report.mode, 'source-only');
    assert.equal(report.runtimeRoot, null);
    assert.equal(report.migration.status, 'UNPROVEN');
});
