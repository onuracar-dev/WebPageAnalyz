const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { MemoryPlatformStore, PostgresPlatformStore } = require('../platform/store');
const { createSourceService } = require('../source/service');

function sourceConfig(artifactDir) {
    return {
        nodeEnv: 'test',
        artifactDir,
        sourceEncryptionKey: '',
        osv: { executable: 'test-osv' },
        timeouts: { osvMs: 1_000 }
    };
}

async function sourceFixture(t) {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-business-source-'));
    t.after(() => fs.rm(artifactDir, { recursive: true, force: true }));
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws-source-idempotency');
    await store.setWorkspacePlan('ws-source-idempotency', 'studio');
    const project = await store.createProject('ws-source-idempotency', { name: 'Source', origin: 'https://example.com/', locale: 'en' });
    return { artifactDir, store, project };
}

test('source input idempotency passes quota/fingerprint options and skips duplicate processing', async (t) => {
    const { artifactDir, store, project } = await sourceFixture(t);
    const originalCreate = store.createSourceInput.bind(store);
    const createCalls = [];
    let existing = null;
    store.createSourceInput = async (...args) => {
        createCalls.push(args);
        if (!existing) {
            existing = await originalCreate(...args.slice(0, 3));
            return existing;
        }
        return { ...existing, idempotent: true };
    };
    let scans = 0;
    const service = createSourceService({
        config: sourceConfig(artifactDir),
        store,
        scanner: async () => {
            scans += 1;
            return { version: 'test', findings: [], coverage: {} };
        },
        inspect: async () => ({ entries: 1, uncompressedBytes: 16 }),
        extract: async () => ({ files: ['package.json'] })
    });

    const first = await service.acceptZip('ws-source-idempotency', {
        projectId: project.id,
        buffer: Buffer.from('first source bytes'),
        idempotencyKey: 'source-retry-1'
    });
    const second = await service.acceptZip('ws-source-idempotency', {
        projectId: project.id,
        buffer: Buffer.from('first source bytes'),
        idempotencyKey: 'source-retry-1'
    });

    assert.equal(first.sourceInput.id, existing.id);
    assert.equal(second.sourceInput.id, first.sourceInput.id);
    assert.equal(second.idempotent, true);
    assert.equal(scans, 1);
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0][3].idempotencyKey, 'source-retry-1');
    assert.match(createCalls[0][3].requestFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(createCalls[0][3].limit > 0, true);
    assert.deepEqual(createCalls[0][3].quota, { kind: 'source_audit', limit: createCalls[0][3].limit, period: 'month' });
    assert.equal(await store.countSourceInputs('ws-source-idempotency'), 1);
});

test('queued source replay redelivers the same queue singleton without creating a second source row', async (t) => {
    const { artifactDir, store, project } = await sourceFixture(t);
    const originalCreate = store.createSourceInput.bind(store);
    let existing = null;
    store.createSourceInput = async (...args) => {
        if (!existing) {
            existing = await originalCreate(...args.slice(0, 3));
            return existing;
        }
        return { ...existing, idempotent: true };
    };
    const jobs = [];
    const service = createSourceService({
        config: sourceConfig(artifactDir),
        store,
        queue: { send: async (...args) => { jobs.push(args); return `job-${jobs.length}`; } },
        inspectFile: async () => ({ entries: 1, uncompressedBytes: 16 })
    });
    const firstFile = path.join(artifactDir, 'first.zip');
    const secondFile = path.join(artifactDir, 'second.zip');
    await fs.writeFile(firstFile, 'first source bytes');
    await fs.writeFile(secondFile, 'first source bytes');
    await service.acceptZipFile('ws-source-idempotency', { projectId: project.id, filePath: firstFile, idempotencyKey: 'source-file-retry-1' });
    const replay = await service.acceptZipFile('ws-source-idempotency', { projectId: project.id, filePath: secondFile, idempotencyKey: 'source-file-retry-1' });

    assert.equal(jobs.length, 2);
    assert.equal(replay.idempotent, true);
    assert.equal(await fs.stat(secondFile).then(() => true).catch(() => false), false);
    assert.equal(jobs[0][0], 'wpa-source-audit');
    assert.equal(jobs[0][2].singletonKey, existing.id);
    assert.equal(jobs[1][2].singletonKey, existing.id);
});

test('unknown source queue outcome preserves ciphertext and recovers with the same operation and singleton', async (t) => {
    const { artifactDir, store, project } = await sourceFixture(t);
    const jobs = [];
    const queue = {
        send: async (...args) => {
            jobs.push(args);
            if (jobs.length === 1) throw Object.assign(new Error('response lost after send'), { code: 'SOURCE_QUEUE_CONNECTION_LOST' });
            return 'job-recovered';
        }
    };
    const service = createSourceService({
        config: sourceConfig(artifactDir),
        store,
        queue,
        inspectFile: async () => ({ entries: 1, uncompressedBytes: 16 })
    });
    const firstFile = path.join(artifactDir, 'unknown-first.zip');
    const retryFile = path.join(artifactDir, 'unknown-retry.zip');
    await fs.writeFile(firstFile, 'stable source bytes');
    await fs.writeFile(retryFile, 'stable source bytes');

    await assert.rejects(() => service.acceptZipFile('ws-source-idempotency', {
        projectId: project.id,
        filePath: firstFile,
        idempotencyKey: 'source-unknown-outcome-1'
    }), { code: 'SOURCE_QUEUE_CONNECTION_LOST' });
    const [persisted] = await store.listSourceInputs('ws-source-idempotency');
    assert.equal(persisted.status, 'queued');
    assert.equal(await fs.stat(persisted.encryptedReference).then(() => true).catch(() => false), true);

    const recovered = await service.acceptZipFile('ws-source-idempotency', {
        projectId: project.id,
        filePath: retryFile,
        idempotencyKey: 'source-unknown-outcome-1'
    });
    assert.equal(recovered.idempotent, true);
    assert.equal(recovered.jobId, 'job-recovered');
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0][2].singletonKey, persisted.id);
    assert.equal(jobs[1][2].singletonKey, persisted.id);
    assert.equal(await store.countSourceInputs('ws-source-idempotency'), 1);
    assert.equal(await fs.stat(persisted.encryptedReference).then(() => true).catch(() => false), true);
});

async function sourceStoreContract(store, suffix) {
    const workspaceId = `ws_source_store_${suffix}`;
    await store.ensureWorkspace(workspaceId);
    const project = await store.createProject(workspaceId, { name: 'Source store', origin: 'https://example.com/', locale: 'en' });
    const input = { kind: 'zip', status: 'queued', encryptedReference: `cipher-${suffix}`, purgeAt: '2030-01-01T00:00:00.000Z' };
    const options = { limit: 1, idempotencyKey: `source-store-${suffix}-0001`, requestFingerprint: 'source-store-fingerprint-a' };
    const [left, right] = await Promise.all([
        store.createSourceInput(workspaceId, project.id, input, options),
        store.createSourceInput(workspaceId, project.id, input, options)
    ]);
    const leftRecord = left.sourceInput || left;
    const rightRecord = right.sourceInput || right;
    assert.equal(leftRecord.id, rightRecord.id);
    assert.equal(await store.countSourceInputs(workspaceId), 1);
    await assert.rejects(() => store.createSourceInput(workspaceId, project.id, input, {
        ...options,
        requestFingerprint: 'source-store-fingerprint-b'
    }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    await assert.rejects(() => store.createSourceInput(workspaceId, project.id, input, {
        limit: 1,
        idempotencyKey: `source-store-${suffix}-0002`,
        requestFingerprint: 'source-store-fingerprint-c'
    }), { code: 'SOURCE_AUDIT_LIMIT_REACHED' });
}

test('Memory source store serializes idempotency and monthly quota', async () => {
    await sourceStoreContract(new MemoryPlatformStore(), 'memory');
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL source store serializes idempotency and monthly quota', { skip: !databaseUrl }, async () => {
    const store = new PostgresPlatformStore(databaseUrl);
    try { await sourceStoreContract(store, `pg-${Date.now()}`); }
    finally { await store.close(); }
});
