const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config');
const { createAnalysisService } = require('../services/analysis-service');
const { killChrome } = require('../analyzers/lighthouse');

const target = { url: 'https://example.com/', hostname: 'example.com' };
const silentLogger = { info() {}, warn() {}, error() {} };

function config() {
    return loadConfig({
        NODE_ENV: 'test',
        KEEP_ANALYZER_ARTIFACTS: 'true',
        LIGHTHOUSE_TIMEOUT_MS: '1000',
        AXE_TIMEOUT_MS: '1000',
        YELLOWLAB_TIMEOUT_MS: '1000'
    });
}

test('Lighthouse cleanup tolerates synchronous and asynchronous launcher failures', async () => {
    await assert.doesNotReject(() => killChrome({ kill: () => { throw new Error('EPERM'); } }));
    await assert.doesNotReject(() => killChrome({ kill: async () => { throw new Error('EPERM'); } }));
});

test('analysis service returns a partial report and always closes its proxy', async () => {
    let stopped = false;
    let parsedPaths;
    const service = createAnalysisService({
        config: config(),
        logger: silentLogger,
        analyzers: {
            lighthouse: async () => { throw new Error('mocked failure'); },
            yellowLab: async () => ({ logPath: 'yellowlab.json' }),
            axe: async () => ({ logPath: 'axe.json' })
        },
        parse: async (paths) => {
            parsedPaths = paths;
            return { scores: {}, categories: {} };
        },
        proxyFactory: () => ({
            start: async () => 'http://127.0.0.1:1234',
            stop: async () => { stopped = true; }
        })
    });

    const result = await service.analyze(target, new AbortController().signal);
    assert.equal(parsedPaths.lighthouseDesktop, undefined);
    assert.equal(parsedPaths.yellowlab, 'yellowlab.json');
    assert.equal(result.meta.analyzers.lighthouse, 'unavailable');
    assert.equal(result.meta.analyzerErrors.lighthouse, 'ANALYZER_FAILED');
    assert.equal(result.meta.analyzerErrors.axe, undefined);
    assert.equal(result.meta.analyzers.axe, 'completed');
    assert.equal(stopped, true);
});

test('analysis service fails safely when every analyzer fails', async () => {
    let stopped = false;
    const failure = async () => { throw new Error('mocked upstream detail'); };
    const service = createAnalysisService({
        config: config(),
        logger: silentLogger,
        analyzers: { lighthouse: failure, yellowLab: failure, axe: failure },
        parse: async () => { throw new Error('parser should not run'); },
        proxyFactory: () => ({
            start: async () => 'http://127.0.0.1:1234',
            stop: async () => { stopped = true; }
        })
    });
    await assert.rejects(() => service.analyze(target), { code: 'ANALYSIS_FAILED' });
    assert.equal(stopped, true);
});

test('production external analyzer requires explicit provider consent', async () => {
    const service = createAnalysisService({
        config: { ...config(), requireExternalProviderConsent: true, timeouts: { ...config().timeouts } },
        logger: silentLogger,
        analyzers: { lighthouse: async () => ({ desktopPath: null, mobilePath: null }), yellowLab: async () => ({ logPath: 'must-not-run' }), axe: async () => ({ logPath: null }) },
        parse: async () => ({ scores: {}, categories: {} }),
        proxyFactory: () => ({ start: async () => 'http://127.0.0.1:1234', stop: async () => {} })
    });
    const result = await service.analyze(target, new AbortController().signal);
    assert.equal(result.meta.analyzerErrors.yellowLab, 'EXTERNAL_PROVIDER_CONSENT_REQUIRED');
});

test('analysis service exposes bounded WPA rendered links through the internal discovery contract', async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-rendered-contract-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const logPath = path.join(directory, 'wpa.json');
    await fs.writeFile(logPath, JSON.stringify({
        version: '1.0.0', devices: { desktop: {}, mobile: {} }, findings: [],
        renderedLinks: ['https://example.com/spa', 'https://docs.example.com/guide'],
        renderedLinkCoverage: { limit: 500, references: 3, uniqueLinks: 2, truncated: false }
    }));
    const service = createAnalysisService({
        config: config(),
        logger: silentLogger,
        analyzers: { wpaPage: async () => ({ logPath, artifactPaths: [logPath] }) },
        parse: async () => ({ scores: {}, categories: {} }),
        proxyFactory: () => ({ start: async () => 'http://127.0.0.1:1234', stop: async () => {} })
    });

    const result = await service.analyze(target, new AbortController().signal, { engineIds: ['wpaPage'], authorizedOrigins: ['https://example.com', 'https://docs.example.com'] });

    assert.deepEqual(result.discovery.renderedLinks, [
        { url: 'https://example.com/spa', referrer: target.url, source: 'rendered_link' },
        { url: 'https://docs.example.com/guide', referrer: target.url, source: 'rendered_link' }
    ]);
    assert.equal(result.discovery.coverage.uniqueLinks, 2);
    assert.equal(result.moduleRuns.wpaPage.coverage.renderedLinks, 2);
});

test('analysis service serializes browser-heavy analyzers while preserving external work and timing evidence', async () => {
    const events = [];
    const progressEvents = [];
    let activeBrowserHeavy = 0;
    let peakBrowserHeavy = 0;
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const browserHeavy = (name, value) => async () => {
        activeBrowserHeavy += 1;
        peakBrowserHeavy = Math.max(peakBrowserHeavy, activeBrowserHeavy);
        events.push(`start:${name}`);
        await delay(20);
        events.push(`finish:${name}`);
        activeBrowserHeavy -= 1;
        return value;
    };
    const service = createAnalysisService({
        config: config(),
        logger: silentLogger,
        analyzers: {
            lighthouse: browserHeavy('lighthouse', { desktopPath: null, mobilePath: null }),
            yellowLab: async () => {
                events.push('start:yellowLab');
                await delay(10);
                events.push('finish:yellowLab');
                return { logPath: null };
            },
            axe: browserHeavy('axe', { logPath: null }),
            wpaPage: browserHeavy('wpaPage', { logPath: null, artifactPaths: [] }),
            advancedBrowser: browserHeavy('advancedBrowser', { logPath: null, artifactPaths: [] })
        },
        parse: async () => ({ scores: {}, categories: {} }),
        proxyFactory: () => ({ start: async () => 'http://127.0.0.1:1234', stop: async () => {} })
    });

    const result = await service.analyze(target, new AbortController().signal, {
        engineIds: ['lighthouse', 'yellowLab', 'axe', 'wpaPage', 'performancePlus'],
        advancedModules: ['performance_plus'],
        externalProviderConsent: true,
        onProgress: async (event) => { progressEvents.push(event); }
    });

    assert.equal(peakBrowserHeavy, 1);
    assert.deepEqual(events.filter((event) => !event.includes('yellowLab')), [
        'start:lighthouse', 'finish:lighthouse',
        'start:axe', 'finish:axe',
        'start:wpaPage', 'finish:wpaPage',
        'start:advancedBrowser', 'finish:advancedBrowser'
    ]);
    assert.equal(result.meta.engineExecutions.yellowLab.resourceClass, 'external');
    assert.equal(result.meta.engineExecutions.advancedBrowser.resourceClass, 'browser');
    assert.equal(result.meta.engineExecutions.advancedBrowser.status, 'completed');
    assert.ok(result.meta.engineExecutions.axe.queueWaitMs >= 10);
    assert.ok(result.meta.engineExecutions.advancedBrowser.executionMs >= 10);
    assert.deepEqual(result.moduleRuns.performancePlus.execution, result.meta.engineExecutions.advancedBrowser);
    assert.equal(progressEvents[0].type, 'analysis.plan');
    assert.deepEqual(progressEvents[0].payload.engines.map((engine) => engine.engineIds), [
        ['lighthouse'], ['yellowLab'], ['axe'], ['wpaPage'], ['performancePlus']
    ]);
    for (const executionId of ['lighthouse', 'yellowLab', 'axe', 'wpaPage', 'advancedBrowser']) {
        assert.ok(progressEvents.some((event) => event.type === 'engine.running' && event.payload.executionId === executionId));
        assert.ok(progressEvents.some((event) => event.type === 'engine.completed' && event.payload.executionId === executionId));
    }
    assert.deepEqual(progressEvents.find((event) => event.type === 'engine.completed' && event.payload.executionId === 'advancedBrowser').payload.engineIds, ['performancePlus']);
});

test('browser-heavy lane waits for timed-out analyzer cleanup before starting the next browser', async () => {
    let cleanupFinishedAt = 0;
    let wpaStartedAt = 0;
    const baseConfig = config();
    const localConfig = { ...baseConfig, timeouts: { ...baseConfig.timeouts, axeMs: 20, wpaPageMs: 500 } };
    const service = createAnalysisService({
        config: localConfig,
        logger: silentLogger,
        analyzers: {
            axe: async (_url, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    setTimeout(() => {
                        cleanupFinishedAt = Date.now();
                        reject(signal.reason);
                    }, 30);
                }, { once: true });
            }),
            wpaPage: async () => {
                wpaStartedAt = Date.now();
                return { logPath: null, artifactPaths: [] };
            }
        },
        parse: async () => ({ scores: {}, categories: {} }),
        proxyFactory: () => ({ start: async () => 'http://127.0.0.1:1234', stop: async () => {} })
    });

    const result = await service.analyze(target, new AbortController().signal, { engineIds: ['axe', 'wpaPage'] });

    assert.ok(cleanupFinishedAt > 0);
    assert.ok(wpaStartedAt >= cleanupFinishedAt);
    assert.equal(result.meta.analyzerErrors.axe, 'OPERATION_TIMEOUT');
    assert.equal(result.meta.engineExecutions.axe.status, 'timeout');
    assert.equal(result.meta.engineExecutions.axe.cleanupCompleted, true);
    assert.equal(result.meta.engineExecutions.wpaPage.status, 'completed');
});
