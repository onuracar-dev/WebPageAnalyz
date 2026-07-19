const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { createAnalysisService } = require('../services/analysis-service');

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
