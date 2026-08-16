const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { EventEmitter } = require('node:events');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { createAnalysisService } = require('../services/analysis-service');
const { clearArtifacts } = require('../services/artifact-service');
const { killChrome } = require('../analyzers/lighthouse');
const { SafeBrowserProxy } = require('../security/safe-proxy');

const silentLogger = { info() {}, warn() {}, error() {} };
const target = { url: 'https://example.com/', hostname: 'example.com' };

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('Chrome launcher cleanup errors from the child close event stay contained', async () => {
    const child = new EventEmitter();
    const chrome = {
        chromeProcess: child,
        destroyTmp() { throw Object.assign(new Error('temporary profile is still locked'), { code: 'EPERM' }); },
        kill() {
            this.chromeProcess.once('close', () => this.destroyTmp());
            setImmediate(() => this.chromeProcess.emit('close'));
        }
    };
    await assert.doesNotReject(() => killChrome(chrome));
    await delay(10);
});

test('safe proxy stop waits for an in-flight start and leaves no listener behind', async () => {
    const proxy = new SafeBrowserProxy({ logger: silentLogger });
    const starting = proxy.start();
    await proxy.stop();
    await starting;
    assert.equal(proxy.server.listening, false);
});

test('the local backend env example uses the in-process development store by default', async (t) => {
    const example = dotenv.parse(await fs.readFile(path.join(__dirname, '..', '.env.example'), 'utf8'));
    const config = loadConfig({ ...example, WORKER_ENABLED: 'true' });
    assert.equal(config.databaseUrl, '');
    assert.equal(config.workerEnabled, true);

    const app = createApp({ config, logger: silentLogger });
    t.after(() => app.locals.closeResources());
    await request(app).get('/readyz').expect(200).expect(({ body }) => {
        assert.deepEqual(body, { status: 'ready' });
    });
    await request(app).get('/api/v1/plans').expect(200);
});

test('the backend container healthcheck waits for platform readiness', async () => {
    const dockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /fetch\('http:\/\/127\.0\.0\.1:5000\/readyz'\)/);
});

test('the backend Compose service is non-root and container-isolated', async () => {
    const compose = await fs.readFile(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    const backend = compose.slice(compose.indexOf('  backend:'), compose.indexOf('  zap:'));
    assert.match(backend, /read_only:\s*true/);
    assert.match(backend, /cap_drop:\s*\n\s*- ALL/);
    assert.match(backend, /no-new-privileges:true/);
    assert.match(backend, /tmpfs:/);
    const dockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /USER node/);
});

test('artifact cleanup removes every analyzer artifact family but preserves unrelated files', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-artifacts-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const suffix = `${crypto.randomUUID()}`;
    const analyzerFiles = [
        `lighthouse_desktop_${suffix}.json`,
        `yellowlab_${suffix}.json`,
        `axe_${suffix}.json`,
        `wpa_page_${suffix}.json`,
        `advanced_browser_${suffix}.json`,
        `wpa_mobile_${suffix}.png`,
        `advanced_desktop_${suffix}.png`
    ];
    await Promise.all([...analyzerFiles, 'unrelated.txt'].map((name) => fs.writeFile(path.join(directory, name), 'fixture')));

    assert.equal(await clearArtifacts(directory), analyzerFiles.length);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['unrelated.txt']);
});

test('a timed-out analyzer cannot leave a late artifact behind', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-timeout-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const config = loadConfig({
        NODE_ENV: 'test',
        ARTIFACT_DIR: directory,
        LIGHTHOUSE_TIMEOUT_MS: '10',
        AXE_TIMEOUT_MS: '1000',
        YELLOWLAB_TIMEOUT_MS: '1000',
        KEEP_ANALYZER_ARTIFACTS: 'false'
    });
    const service = createAnalysisService({
        config,
        logger: silentLogger,
        analyzers: {
            lighthouse: async (_url, { artifactDir }) => {
                await delay(40);
                await fs.mkdir(artifactDir, { recursive: true });
                await fs.writeFile(path.join(artifactDir, 'late.json'), 'late');
                return { desktopPath: path.join(artifactDir, 'late.json') };
            },
            yellowLab: async () => ({ logPath: 'yellowlab.json' }),
            axe: async () => ({ logPath: 'axe.json' })
        },
        parse: async () => ({ scores: {}, categories: {}, sharedCategories: {}, findings: [] }),
        proxyFactory: () => ({ start: async () => 'http://127.0.0.1:1234', stop: async () => {} })
    });

    await service.analyze(target, new AbortController().signal);
    await delay(100);
    assert.deepEqual(await fs.readdir(directory), []);
});
