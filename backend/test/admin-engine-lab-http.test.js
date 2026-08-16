const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineLabHttpService } = require('../admin/engine-lab-http-service');
const { createEngineLabServiceClient } = require('../admin/engine-lab-client');
const { loadConfig } = require('../config');
const { startEngineLabEndpoint } = require('../scripts/analysis-worker');

const logger = { info() {}, warn() {}, error() {} };

async function harness(t, { token = 't'.repeat(48) } = {}) {
    const calls = { creates: [], cancels: [] };
    let receivedSource = null;
    const run = { id: 'lab-1', status: 'queued', targetOrigin: 'https://example.com', engines: [] };
    const engineLabService = {
        catalog: () => [{ id: 'lighthouse', label: 'Lighthouse' }],
        listRuns: () => [run],
        getRun: (id) => ({ ...run, id }),
        async createRun(input) {
            receivedSource = input.sourceBuffer;
            calls.creates.push({ ...input, sourceBuffer: input.sourceBuffer ? Buffer.from(input.sourceBuffer) : null });
            return run;
        },
        async cancelRun(id, actorId, context) {
            calls.cancels.push({ id, actorId, context });
            return { ...run, id, status: 'cancelled' };
        },
        async getArtifact(id, engineId, filename) {
            assert.equal(id, 'lab-1');
            assert.equal(engineId, 'wpaPage');
            assert.equal(filename, 'desktop.png');
            return { buffer: Buffer.from('png-bytes'), mimeType: 'image/png' };
        },
        close() {}
    };
    const config = {
        sourceUploadMaxBytes: 1024 * 1024,
        engineLab: {
            internalToken: token,
            host: '127.0.0.1',
            port: 0,
            requestTimeoutMs: 5_000,
            maxBodyBytes: 2 * 1024 * 1024,
            maxResponseBytes: 1024 * 1024,
            maxArtifactBytes: 1024 * 1024,
            maxConcurrentRequests: 4
        }
    };
    const endpoint = createEngineLabHttpService({ engineLabService, config, logger });
    const address = await endpoint.listen(0, '127.0.0.1');
    t.after(() => endpoint.close());
    const client = createEngineLabServiceClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        internalToken: token,
        allowedHosts: ['127.0.0.1'],
        timeoutMs: 5_000,
        maxRequestBytes: 2 * 1024 * 1024,
        maxResponseBytes: 1024 * 1024,
        maxArtifactBytes: 1024 * 1024
    });
    return { address, calls, client, getReceivedSource: () => receivedSource, token };
}

test('API client delegates the complete Engine Lab contract to the isolated HTTP service', async (t) => {
    const { calls, client, getReceivedSource } = await harness(t);
    assert.equal((await client.catalog())[0].id, 'lighthouse');
    assert.equal((await client.listRuns())[0].id, 'lab-1');
    assert.equal((await client.getRun('lab-1')).id, 'lab-1');

    const source = Buffer.from('PK\x03\x04fixture');
    const created = await client.createRun({
        targetUrl: 'https://example.com/',
        engineIds: ['osvScanner'],
        crawlerLimit: 25,
        sourceBuffer: source,
        actorId: 'admin-1',
        requestId: 'request-1',
        idempotencyKey: 'engine-lab-request-0001',
        requestFingerprint: 'a'.repeat(64)
    });
    assert.equal(created.id, 'lab-1');
    assert.deepEqual(calls.creates[0].sourceBuffer, source);
    assert.equal(calls.creates[0].actorId, 'admin-1');
    assert.equal(calls.creates[0].idempotencyKey, 'engine-lab-request-0001');
    assert.equal(calls.creates[0].requestFingerprint, 'a'.repeat(64));
    assert.ok(getReceivedSource().every((byte) => byte === 0), 'worker request buffer must be zeroed after the service clones it');

    const cancelled = await client.cancelRun('lab-1', 'admin-1', { reason: 'Stop bounded diagnostic run', requestId: 'request-2' });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(calls.cancels[0], {
        id: 'lab-1', actorId: 'admin-1', context: { reason: 'Stop bounded diagnostic run', requestId: 'request-2' }
    });

    const artifact = await client.getArtifact('lab-1', 'wpaPage', 'desktop.png');
    assert.equal(artifact.mimeType, 'image/png');
    assert.deepEqual(artifact.buffer, Buffer.from('png-bytes'));
});

test('Engine Lab internal endpoint rejects missing credentials and unsupported fields', async (t) => {
    const { address, token } = await harness(t);
    const root = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${root}/v1/catalog`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, 'ENGINE_LAB_SERVICE_UNAUTHORIZED');

    const invalid = await fetch(`${root}/v1/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'https://example.com', engineIds: ['lighthouse'], actorId: 'admin-1', unexpected: true })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'ENGINE_LAB_INPUT_INVALID');

    const invalidMediaType = await fetch(`${root}/v1/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/jsonp' },
        body: '{}'
    });
    assert.equal(invalidMediaType.status, 415);
    assert.equal((await invalidMediaType.json()).error.code, 'ENGINE_LAB_CONTENT_TYPE_INVALID');
});

test('Engine Lab internal endpoint closes and recovers cleanly from an oversized request body', async (t) => {
    const token = 'b'.repeat(48);
    const endpoint = createEngineLabHttpService({
        engineLabService: { catalog: () => [], listRuns: () => [], close() {} },
        config: {
            sourceUploadMaxBytes: 1024,
            engineLab: { internalToken: token, maxBodyBytes: 1024, maxResponseBytes: 64 * 1024, maxConcurrentRequests: 2, requestTimeoutMs: 5_000 }
        },
        logger
    });
    const address = await endpoint.listen(0, '127.0.0.1');
    t.after(() => endpoint.close());
    const root = `http://127.0.0.1:${address.port}`;
    const oversized = await fetch(`${root}/v1/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(2_000) })
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('connection'), 'close');
    assert.equal((await oversized.json()).error.code, 'ENGINE_LAB_SERVICE_REQUEST_TOO_LARGE');
    assert.equal((await fetch(`${root}/healthz`)).status, 200);
});

test('Engine Lab HTTP shutdown awaits the bounded service drain', async () => {
    const token = 'c'.repeat(48);
    let releaseClose;
    let closed = false;
    const endpoint = createEngineLabHttpService({
        engineLabService: {
            catalog: () => [],
            listRuns: () => [],
            close: () => new Promise((resolve) => { releaseClose = () => { closed = true; resolve(); }; })
        },
        config: { engineLab: { internalToken: token, requestTimeoutMs: 5_000 } },
        logger
    });
    await endpoint.listen(0, '127.0.0.1');
    const closing = endpoint.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseClose();
    await closing;
    assert.equal(closed, true);
});

test('Engine Lab service client fails closed for a non-allowlisted host', async () => {
    const client = createEngineLabServiceClient({ baseUrl: 'http://not-allowed.internal:5030', internalToken: 'x'.repeat(48), allowedHosts: ['analysis-worker'] });
    await assert.rejects(() => client.catalog(), (error) => error.code === 'ENGINE_LAB_SERVICE_NOT_CONFIGURED' && error.expose === true);
});

test('analysis worker starts and owns the private Engine Lab endpoint', async (t) => {
    const config = loadConfig({
        NODE_ENV: 'test',
        EXECUTION_ROLE: 'worker',
        ENGINE_LAB_SERVICE_ENABLED: 'true',
        ENGINE_LAB_SERVICE_TOKEN: 'w'.repeat(48),
        ENGINE_LAB_SERVICE_HOST: '127.0.0.1',
        ENGINE_LAB_SERVICE_PORT: '1'
    });
    // Port zero is intentionally injected after config validation so the test
    // can bind an ephemeral listener without weakening deployment validation.
    const endpoint = await startEngineLabEndpoint({
        config: { ...config, engineLab: { ...config.engineLab, port: 0 } },
        runtime: { store: { pool: null, async logAudit() {} } },
        workerLogger: logger
    });
    t.after(() => endpoint.close());
    const address = endpoint.server.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', configured: true });
});
