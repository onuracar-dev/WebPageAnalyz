const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { MemoryPlatformStore } = require('../platform/store');
const { createSourceService } = require('../source/service');
const { runOsv } = require('../source/osv-runner');

async function sourceHarness(scanner) {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_source'); await store.setWorkspacePlan('ws_source', 'studio');
    const project = await store.createProject('ws_source', { name: 'Source', origin: 'https://example.com/', locale: 'en' });
    const config = { nodeEnv: 'test', artifactDir: path.join(os.tmpdir(), `wpa-source-test-${process.pid}`), sourceEncryptionKey: '', osv: { executable: 'missing-osv' }, timeouts: { osvMs: 1_000 } };
    const service = createSourceService({ config, store, scanner, inspect: async () => ({ entries: 2, uncompressedBytes: 128 }), extract: async () => ({ files: ['package-lock.json', 'package.json'] }) });
    return { store, project, service, artifactDir: config.artifactDir };
}

test('Source Audit exposes a versioned customer result only after OSV completion', async () => {
    const { project, service } = await sourceHarness(async () => ({ version: '2.3.8', status: 'completed', findings: [{ ruleId: 'osv:demo', moduleId: 'source_audit' }], coverage: { manifests: 1, scannedManifests: ['package-lock.json'], sourceCodeTransmitted: false } }));
    assert.equal(project.verifiedAt, null);
    const buffer = Buffer.from('fixture zip bytes');
    const result = await service.acceptZip('ws_source', { projectId: project.id, buffer });
    assert.equal(result.sourceInput.status, 'completed');
    assert.equal(result.sourceInput.result.schemaVersion, 'wpa.source-audit.v1');
    assert.equal(result.sourceInput.result.module.findingCount, 1);
    assert.equal(result.sourceInput.result.coverage.extractedFiles, 2);
    assert.ok(buffer.every((byte) => byte === 0));
});

test('missing OSV executable is an explicit unavailable result with remediation', async () => {
    const { store, project, service } = await sourceHarness(async () => { throw Object.assign(new Error('missing'), { code: 'OSV_UNAVAILABLE' }); });
    const result = await service.acceptZip('ws_source', { projectId: project.id, buffer: Buffer.from('fixture zip bytes') });
    assert.equal(result.sourceInput.status, 'unavailable');
    assert.equal(result.sourceInput.failureCode, 'OSV_UNAVAILABLE');
    assert.match(result.sourceInput.result.module.remediation, /Install/);
    assert.deepEqual(result.sourceInput.result.findings, []);
    assert.equal((await store.getSourceInput('ws_source', result.sourceInput.id)).status, 'unavailable');
});

test('OSV refuses direct execution when an isolation runner is absent', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-osv-isolation-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), '{}');
    await assert.rejects(() => runOsv(directory, { executable: 'osv-scanner' }), { code: 'OSV_ISOLATION_UNAVAILABLE' });
});

test('source persistence failure removes ciphertext and clears the upload buffer', async () => {
    const { store, project, service, artifactDir } = await sourceHarness(async () => ({ version: '2.3.8', findings: [], coverage: {} }));
    store.createSourceInput = async () => { throw new Error('database unavailable'); };
    const buffer = Buffer.from('sensitive source bytes');
    await assert.rejects(() => service.acceptZip('ws_source', { projectId: project.id, buffer }), /database unavailable/);
    assert.equal(buffer.every((byte) => byte === 0), true);
    const sourceDirectory = path.join(artifactDir, 'source-inputs');
    assert.deepEqual(await fs.readdir(sourceDirectory).catch(() => []), []);
});

test('startup cleanup removes only expired source ciphertext artifacts', async () => {
    const { service, artifactDir } = await sourceHarness(async () => ({ version: '2.3.8', findings: [], coverage: {} }));
    const sourceDirectory = path.join(artifactDir, 'source-inputs');
    await fs.mkdir(sourceDirectory, { recursive: true });
    const expired = path.join(sourceDirectory, '00000000-0000-0000-0000-000000000000.wpaenc');
    const fresh = path.join(sourceDirectory, '11111111-1111-1111-1111-111111111111.wpaenc');
    const unrelated = path.join(sourceDirectory, 'keep.txt');
    await Promise.all([fs.writeFile(expired, 'old'), fs.writeFile(fresh, 'new'), fs.writeFile(unrelated, 'keep')]);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(expired, old, old);
    assert.equal(await service.purgeExpiredArtifacts(), 1);
    assert.equal(await fs.stat(expired).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(fresh).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(unrelated).then(() => true).catch(() => false), true);
    await Promise.all([fs.unlink(fresh), fs.unlink(unrelated)]);
});

test('startup cleanup removes abandoned plaintext upload staging files by TTL', async () => {
    const { service, artifactDir } = await sourceHarness(async () => ({ version: '2.3.8', findings: [], coverage: {} }));
    const staging = path.join(artifactDir, 'upload-staging');
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    const expired = path.join(staging, 'abandoned.zip');
    const fresh = path.join(staging, 'active.zip');
    await Promise.all([fs.writeFile(expired, 'old'), fs.writeFile(fresh, 'new')]);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(expired, old, old);
    assert.equal(await service.purgeExpiredStaging({ maxAgeMs: 60 * 60 * 1000 }), 1);
    assert.equal(await fs.stat(expired).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(fresh).then(() => true).catch(() => false), true);
    await fs.unlink(fresh);
});
