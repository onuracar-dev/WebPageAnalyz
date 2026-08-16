const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { createEngineLabService, ENGINE_CATALOG } = require('../admin/engine-lab');

const logger = { info() {}, warn() {}, error() {} };
const target = { url: 'https://example.com/', hostname: 'example.com', port: 443, address: '8.8.8.8' };
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
};

async function terminal(service, id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = service.getRun(id);
        if (['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) return run;
        await wait(5);
    }
    throw new Error('Engine Lab run did not reach a terminal state.');
}

test('admin engine lab runs exactly the selected engines without plan or workspace input', async (t) => {
    const calls = [];
    const runners = Object.fromEntries(ENGINE_CATALOG.map((engine) => [engine.id, async (context) => {
        calls.push({ id: engine.id, url: context.target.url });
        return { findingsCount: engine.id === 'axe' ? 3 : 0, evidence: [{ kind: 'coverage', label: engine.label }] };
    }]));
    const service = createEngineLabService({ config: { engineLabConcurrency: 3 }, logger, validateUrl: async () => target, runners });
    t.after(() => service.close());
    const created = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse', 'axe'], actorId: 'admin-1', requestId: 'req-1' });
    const run = await terminal(service, created.id);
    assert.equal(run.status, 'completed');
    assert.deepEqual(calls.map((call) => call.id).sort(), ['axe', 'lighthouse']);
    assert.equal(run.engines.length, 2);
    assert.ok(run.engines.every((engine) => engine.status === 'completed' && engine.progress === 100));
    assert.equal(run.engines.find((engine) => engine.engineId === 'axe').findingsCount, 3);
    assert.equal(Object.hasOwn(run, 'workspaceId'), false);
    assert.equal(Object.hasOwn(run, 'planId'), false);
});

test('one unavailable external engine produces partial without stopping successful engines', async (t) => {
    const service = createEngineLabService({
        config: { engineLabConcurrency: 2 }, logger, validateUrl: async () => target,
        runners: {
            lighthouse: async () => ({ findingsCount: 0 }),
            zapBaseline: async () => { throw Object.assign(new Error('not configured'), { code: 'ZAP_UNAVAILABLE' }); }
        }
    });
    t.after(() => service.close());
    const run = await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse', 'zapBaseline'], actorId: 'admin-1' })).id);
    assert.equal(run.status, 'partial');
    assert.equal(run.engines.find((engine) => engine.engineId === 'lighthouse').status, 'completed');
    const zap = run.engines.find((engine) => engine.engineId === 'zapBaseline');
    assert.equal(zap.status, 'unavailable');
    assert.equal(zap.error.code, 'ZAP_UNAVAILABLE');
    assert.equal(zap.progress, 100);
});

test('catalog rejects unknown engines and required special inputs fail closed', async (t) => {
    const service = createEngineLabService({ config: {}, logger, validateUrl: async () => target, runners: {} });
    t.after(() => service.close());
    await assert.rejects(() => service.createRun({ targetUrl: target.url, engineIds: ['unknown'], actorId: 'admin' }), (error) => error.code === 'ENGINE_LAB_ENGINE_INVALID');
    await assert.rejects(() => service.createRun({ targetUrl: target.url, engineIds: ['journey'], actorId: 'admin' }), (error) => error.code === 'ENGINE_LAB_JOURNEY_REQUIRED');
    await assert.rejects(() => service.createRun({ targetUrl: target.url, engineIds: ['osvScanner'], actorId: 'admin' }), (error) => error.code === 'ENGINE_LAB_SOURCE_REQUIRED');
    assert.equal(service.catalog().find((engine) => engine.id === 'osvScanner').configured, false);
});

test('global scheduler bounds concurrent runs independently from per-run engine concurrency', async (t) => {
    const gates = [deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const service = createEngineLabService({
        config: { engineLabConcurrency: 3, engineLab: { maxConcurrentRuns: 1, maxQueuedRuns: 2 } }, logger, validateUrl: async () => target,
        runners: { lighthouse: async () => {
            const gate = gates[started++];
            active += 1;
            maxActive = Math.max(maxActive, active);
            await gate.promise;
            active -= 1;
            return { findingsCount: 0 };
        } }
    });
    t.after(() => service.close());
    const first = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    const second = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    while (started < 1) await wait(2);
    assert.equal(service.getRun(second.id).status, 'queued');
    assert.equal(maxActive, 1);
    gates[0].resolve();
    await terminal(service, first.id);
    while (started < 2) await wait(2);
    assert.equal(maxActive, 1);
    gates[1].resolve();
    assert.equal((await terminal(service, second.id)).status, 'completed');
    assert.equal(maxActive, 1);
});

test('process-local idempotency coalesces concurrent duplicate run requests', async (t) => {
    let starts = 0;
    const service = createEngineLabService({
        config: {}, logger, validateUrl: async (value) => ({ ...target, url: value }),
        runners: { lighthouse: async () => { starts += 1; return { findingsCount: 0 }; } }
    });
    t.after(() => service.close());
    const input = {
        targetUrl: target.url,
        engineIds: ['lighthouse'],
        actorId: 'admin',
        idempotencyKey: 'engine-lab-idempotency-0001'
    };
    const [first, replay] = await Promise.all([service.createRun(input), service.createRun(input)]);
    assert.equal(replay.id, first.id);
    assert.equal(service.listRuns().length, 1);
    assert.equal((await terminal(service, first.id)).status, 'completed');
    assert.equal(starts, 1);
    await assert.rejects(
        () => service.createRun({ ...input, targetUrl: 'https://different.example/' }),
        (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
    );
});

test('queued cancellation never starts its runner and queue capacity fails closed', async (t) => {
    const gate = deferred();
    let osvStarts = 0;
    const service = createEngineLabService({
        config: { engineLabConcurrency: 1, engineLab: { maxConcurrentRuns: 1, maxQueuedRuns: 1 } }, logger, validateUrl: async () => target,
        runners: {
            lighthouse: async () => { await gate.promise; return { findingsCount: 0 }; },
            osvScanner: async () => { osvStarts += 1; return { findingsCount: 0 }; }
        }
    });
    t.after(() => service.close());
    const first = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    const source = Buffer.from('PK\x03\x04bounded');
    const queued = await service.createRun({ targetUrl: target.url, engineIds: ['osvScanner'], sourceBuffer: source, actorId: 'admin' });
    await assert.rejects(() => service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' }), (error) => error.code === 'ENGINE_LAB_QUEUE_FULL' && error.status === 429);
    const cancelled = await service.cancelRun(queued.id, 'admin', { reason: 'Cancel queued source audit', requestId: 'req-queued-cancel' });
    assert.equal(cancelled.status, 'cancelled');
    gate.resolve();
    await terminal(service, first.id);
    await wait(20);
    assert.equal(osvStarts, 0);
});

test('run completion wins a cancellation audit race', async (t) => {
    const runnerGate = deferred();
    const auditGate = deferred();
    const service = createEngineLabService({
        config: { engineLabConcurrency: 1 }, logger, validateUrl: async () => target,
        audit: async (entry) => { if (entry.action === 'engine_lab.run_cancelled') await auditGate.promise; },
        runners: { lighthouse: async () => { await runnerGate.promise; return { findingsCount: 0 }; } }
    });
    t.after(() => service.close());
    const created = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    while (service.getRun(created.id).status !== 'running') await wait(2);
    const cancellation = service.cancelRun(created.id, 'admin', { reason: 'Exercise cancellation race', requestId: 'req-cancel-race' });
    runnerGate.resolve();
    assert.equal((await terminal(service, created.id)).status, 'completed');
    auditGate.resolve();
    assert.equal((await cancellation).status, 'completed');
});

test('shutdown is idempotent, aborts queued work and uses a bounded drain', async () => {
    const never = new Promise(() => {});
    const service = createEngineLabService({
        config: { engineLabConcurrency: 1, engineLab: { shutdownDrainMs: 1_000 } }, logger, validateUrl: async () => target,
        audit: async (entry) => { if (entry.action === 'engine_lab.run_terminal') await never; },
        runners: { lighthouse: async () => ({ findingsCount: 0 }) }
    });
    await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    await wait(10);
    const startedAt = Date.now();
    const firstClose = service.close();
    assert.equal(service.close(), firstClose);
    await firstClose;
    assert.ok(Date.now() - startedAt >= 900 && Date.now() - startedAt < 1_600);
});

test('run history uses a bounded summary while detail retains evidence', async (t) => {
    const service = createEngineLabService({
        config: {}, logger, validateUrl: async () => target,
        runners: { lighthouse: async () => ({ findingsCount: 1, evidence: [{ kind: 'coverage', payload: 'x'.repeat(2 * 1024 * 1024) }] }) }
    });
    t.after(() => service.close());
    const run = await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' })).id);
    assert.ok(service.getRun(run.id).engines[0].evidence[0].payload.length > 1_000_000);
    const listed = service.listRuns()[0];
    assert.equal(Object.hasOwn(listed.engines[0], 'evidence'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 10_000);
});

test('terminal history eviction removes only its managed artifact directory', async (t) => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-lab-eviction-test-'));
    const sibling = path.join(artifactDir, 'preserve.txt');
    await fs.writeFile(sibling, 'preserve');
    const service = createEngineLabService({
        config: { artifactDir, engineLab: { historyLimit: 1 } }, logger, validateUrl: async () => target,
        runners: { wpaPage: async (context) => {
            await fs.mkdir(context.artifactDir, { recursive: true });
            await fs.writeFile(path.join(context.artifactDir, 'desktop.png'), 'image');
            return { findingsCount: 0, evidence: [{ kind: 'screenshot', filename: 'desktop.png', device: 'desktop' }] };
        } }
    });
    t.after(async () => { await service.close(); await fs.rm(artifactDir, { recursive: true, force: true }); });
    const first = await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['wpaPage'], actorId: 'admin' })).id);
    await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['wpaPage'], actorId: 'admin' })).id);
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try { service.getRun(first.id); } catch (error) { if (error.code === 'ENGINE_LAB_RUN_NOT_FOUND') break; }
        await wait(5);
    }
    assert.throws(() => service.getRun(first.id), (error) => error.code === 'ENGINE_LAB_RUN_NOT_FOUND');
    const evictedDirectory = path.join(artifactDir, 'engine-lab', first.id);
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try { await fs.stat(evictedDirectory); } catch (error) { if (error.code === 'ENOENT') break; }
        await wait(5);
    }
    await assert.rejects(() => fs.stat(evictedDirectory), (error) => error.code === 'ENOENT');
    assert.equal(await fs.readFile(sibling, 'utf8'), 'preserve');
});

test('startup janitor removes only expired generated run directories', async (t) => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-lab-janitor-test-'));
    const root = path.join(artifactDir, 'engine-lab');
    const expired = path.join(root, 'lab_11111111-1111-4111-8111-111111111111');
    const recent = path.join(root, 'lab_22222222-2222-4222-8222-222222222222');
    const unrelated = path.join(root, 'customer-data');
    await Promise.all([expired, recent, unrelated].map((directory) => fs.mkdir(directory, { recursive: true })));
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(expired, old, old);
    const service = createEngineLabService({ config: { artifactDir, engineLab: { artifactTtlMs: 60_000 } }, logger, validateUrl: async () => target, runners: {} });
    t.after(async () => { await service.close(); await fs.rm(artifactDir, { recursive: true, force: true }); });
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try { await fs.stat(expired); } catch (error) { if (error.code === 'ENOENT') break; }
        await wait(5);
    }
    await assert.rejects(() => fs.stat(expired), (error) => error.code === 'ENOENT');
    assert.equal((await fs.stat(recent)).isDirectory(), true);
    assert.equal((await fs.stat(unrelated)).isDirectory(), true);
});

test('cancelling a running lab run is terminal and prevents late completion', async (t) => {
    const service = createEngineLabService({
        config: { engineLabConcurrency: 1 }, logger, validateUrl: async () => target,
        runners: { lighthouse: ({ signal }) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ findingsCount: 0 }), 100);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        }) }
    });
    t.after(() => service.close());
    const created = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin' });
    await wait(10);
    const cancelled = await service.cancelRun(created.id, 'admin', { reason: 'Stop bounded test run', requestId: 'req-cancel-1' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.engines[0].status, 'cancelled');
    await wait(120);
    assert.equal(service.getRun(created.id).status, 'cancelled');
});

test('cancellation is fail-closed when its audit record cannot be persisted', async (t) => {
    const service = createEngineLabService({
        config: { engineLabConcurrency: 1 }, logger, validateUrl: async () => target,
        audit: async (entry) => { if (entry.action === 'engine_lab.run_cancelled') throw new Error('audit unavailable'); },
        runners: { lighthouse: ({ signal }) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ findingsCount: 0 }), 500);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        }) }
    });
    t.after(() => service.close());
    const created = await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin', requestId: 'req-create' });
    await wait(10);
    await assert.rejects(() => service.cancelRun(created.id, 'admin', { reason: 'Stop bounded run', requestId: 'req-cancel' }), /audit unavailable/);
    assert.notEqual(service.getRun(created.id).status, 'cancelled');
});

test('terminal audit failures are surfaced to the logger without changing engine evidence', async (t) => {
    const errors = [];
    const service = createEngineLabService({
        config: {}, logger: { info() {}, warn() {}, error(message, context) { errors.push({ message, context }); } }, validateUrl: async () => target,
        audit: async (entry) => { if (entry.action === 'engine_lab.run_terminal') throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_DOWN' }); },
        runners: { lighthouse: async () => ({ findingsCount: 1 }) }
    });
    t.after(() => service.close());
    const run = await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['lighthouse'], actorId: 'admin', requestId: 'req-terminal' })).id);
    assert.equal(run.status, 'completed');
    await wait(5);
    assert.deepEqual(errors.map((entry) => [entry.message, entry.context.errorCode]), [['Engine Lab terminal audit failed', 'AUDIT_DOWN']]);
});

test('target is revalidated before execution and query secrets are absent from snapshots', async (t) => {
    let validations = 0;
    const service = createEngineLabService({
        config: {}, logger,
        validateUrl: async (value) => {
            validations += 1;
            return { ...target, url: value };
        },
        runners: { lighthouse: async () => ({ findingsCount: 0 }) }
    });
    t.after(() => service.close());
    const created = await service.createRun({ targetUrl: 'https://example.com/audit?token=private#result', engineIds: ['lighthouse'], actorId: 'admin' });
    assert.equal(created.targetUrl, 'https://example.com/audit');
    assert.equal(JSON.stringify(created).includes('private'), false);
    const run = await terminal(service, created.id);
    assert.equal(run.status, 'completed');
    assert.equal(validations, 2);
});

test('Lab screenshots are retrievable only when declared by the engine evidence', async (t) => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-lab-artifact-test-'));
    const service = createEngineLabService({
        config: { artifactDir }, logger, validateUrl: async () => target,
        runners: { wpaPage: async (context) => {
            await fs.mkdir(context.artifactDir, { recursive: true });
            await fs.writeFile(path.join(context.artifactDir, 'desktop.png'), Buffer.from('safe-image'));
            await fs.writeFile(path.join(context.artifactDir, 'private.json'), Buffer.from('{"secret":true}'));
            return { findingsCount: 1, evidence: [
                { kind: 'screenshot', filename: 'desktop.png', device: 'desktop' },
                { kind: 'finding', samples: [{ ruleId: 'runtime.console-errors.desktop', title: 'Console error' }] }
            ] };
        } }
    });
    t.after(async () => { await service.close(); await fs.rm(artifactDir, { recursive: true, force: true }); });
    const run = await terminal(service, (await service.createRun({ targetUrl: target.url, engineIds: ['wpaPage'], actorId: 'admin' })).id);
    const image = await service.getArtifact(run.id, 'wpaPage', 'desktop.png');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.buffer.toString(), 'safe-image');
    assert.equal(run.engines[0].evidence.find((item) => item.kind === 'finding').samples[0].artifactUrl, `/api/v1/admin/engine-lab/runs/${run.id}/artifacts/wpaPage/desktop.png`);
    await assert.rejects(() => service.getArtifact(run.id, 'wpaPage', 'private.json'), (error) => error.code === 'ENGINE_LAB_ARTIFACT_NOT_FOUND');
    await assert.rejects(() => service.getArtifact(run.id, 'wpaPage', '../desktop.png'), (error) => error.code === 'ENGINE_LAB_ARTIFACT_NOT_FOUND');
    await assert.rejects(() => service.getArtifact(run.id, 'wpaPage', '..\\desktop.png'), (error) => error.code === 'ENGINE_LAB_ARTIFACT_NOT_FOUND');
    await assert.rejects(() => service.getArtifact(run.id, 'wpaPage', 'C:\\lab\\desktop.png'), (error) => error.code === 'ENGINE_LAB_ARTIFACT_NOT_FOUND');
});
