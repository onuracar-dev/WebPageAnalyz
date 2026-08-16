const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const { validateEngineLabEndpoint, validateWorkerMarker } = require('../scripts/worker-healthcheck');
const { MemoryPlatformStore } = require('../platform/store');

test('worker health uses process liveness instead of expiring a healthy long-running worker', () => {
    const old = '2020-01-01T00:00:00.000Z';
    const marker = { schemaVersion: 'wpa.worker-readiness.v2', role: 'worker', kind: 'analysis', pid: 42, readyAt: old };
    assert.equal(validateWorkerMarker(marker, { now: () => Date.parse('2030-01-01T00:00:00.000Z'), isProcessAlive: (pid) => pid === 42 }), true);
});

test('worker health fails closed for dead processes and invalid role-kind markers', () => {
    const base = { role: 'worker', kind: 'analysis', pid: 42, readyAt: new Date().toISOString() };
    assert.equal(validateWorkerMarker(base, { isProcessAlive: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } }), false);
    assert.equal(validateWorkerMarker({ ...base, role: 'maintenance', kind: 'analysis' }, { isProcessAlive: () => true }), false);
    assert.equal(validateWorkerMarker({ ...base, pid: null }, { isProcessAlive: () => true }), false);
});

test('worker health includes its Engine Lab control endpoint when enabled', async () => {
    const marker = { engineLabService: true };
    assert.equal(await validateEngineLabEndpoint(marker, { port: 5030, fetchImpl: async (url) => ({ ok: url === 'http://127.0.0.1:5030/healthz' }) }), true);
    assert.equal(await validateEngineLabEndpoint(marker, { port: 5030, fetchImpl: async () => ({ ok: false }) }), false);
    assert.equal(await validateEngineLabEndpoint(marker, { port: 'invalid', fetchImpl: async () => ({ ok: true }) }), false);
    assert.equal(await validateEngineLabEndpoint(marker, { port: 5030, fetchImpl: async () => { throw new Error('down'); } }), false);
    assert.equal(await validateEngineLabEndpoint({ engineLabService: false }, { port: 'invalid' }), true);
});

test('both worker entrypoints persist pid-based readiness markers', async () => {
    const analysis = await fs.readFile(path.join(__dirname, '..', 'scripts', 'analysis-worker.js'), 'utf8');
    const maintenance = await fs.readFile(path.join(__dirname, '..', 'scripts', 'maintenance-worker.js'), 'utf8');
    for (const source of [analysis, maintenance]) {
        assert.match(source, /schemaVersion: 'wpa\.worker-readiness\.v2'/);
        assert.match(source, /pid: process\.pid/);
        assert.match(source, /readyAt: new Date\(\)\.toISOString\(\)/);
    }
    assert.match(maintenance, /const keepAlive = setInterval/);
    assert.match(maintenance, /clearInterval\(keepAlive\)/);
});

test('durable worker heartbeat is operational only inside the bounded freshness window', async () => {
    const store = new MemoryPlatformStore();
    const startedAt = new Date('2026-08-15T10:00:00.000Z');
    assert.deepEqual(await store.workerHealth('analysis', { now: startedAt }), {
        kind: 'analysis', status: 'unavailable', heartbeatAt: null, ageMs: null
    });
    await store.recordWorkerHeartbeat('analysis', 'analysis-fixture', { startedAt, now: startedAt, metadata: { executionRole: 'worker' } });
    const fresh = await store.workerHealth('analysis', { now: new Date('2026-08-15T10:01:29.000Z'), maxAgeMs: 90_000 });
    assert.equal(fresh.status, 'operational');
    assert.equal(fresh.ageMs, 89_000);
    const stale = await store.workerHealth('analysis', { now: new Date('2026-08-15T10:01:31.000Z'), maxAgeMs: 90_000 });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.ageMs, 91_000);
});
