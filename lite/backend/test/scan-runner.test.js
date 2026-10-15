const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createScanRunner } = require('../scan-runner');
const { abortableDelay } = require('../lib/abort');

describe('Scan Runner (with injected fake analyzers)', () => {
    const baseConfig = {
        artifactDir: path.join(os.tmpdir(), 'wpa-lite-test-artifacts'),
        allowedPorts: [80, 443],
        proxyConnectTimeoutMs: 5000,
        engineTimeoutMs: 200 // short timeout for testing
    };

    const mockProxyFactory = () => ({
        start: async () => 'http://127.0.0.1:9999',
        stop: async () => {}
    });

    it('collects findings from all successful analyzers', async () => {
        const fakeLighthouse = async (url) => ({
            findings: [
                {
                    id: 'lh-1',
                    ruleId: 'lighthouse.lcp.desktop',
                    category: 'performance',
                    severity: 'high',
                    title: 'LCP slow',
                    engineId: 'lighthouse',
                    pageUrl: url
                }
            ]
        });

        const fakeAxe = async (url) => ({
            findings: [
                {
                    id: 'axe-1',
                    ruleId: 'axe.color-contrast.desktop',
                    category: 'accessibility',
                    severity: 'critical',
                    title: 'Color contrast insufficient',
                    engineId: 'axe',
                    pageUrl: url
                }
            ]
        });

        const fakeYellowLab = async (url) => ({
            findings: [
                {
                    id: 'yl-1',
                    ruleId: 'yellowlab.bad-dom',
                    category: 'performance',
                    severity: 'medium',
                    title: 'Too many DOM nodes',
                    engineId: 'yellowLab',
                    pageUrl: url
                }
            ]
        });

        const fakeWpaPage = async (url) => ({
            findings: [
                {
                    id: 'wpa-1',
                    ruleId: 'wpa.meta.description',
                    category: 'seo',
                    severity: 'low',
                    title: 'Missing meta description',
                    engineId: 'wpaPage',
                    pageUrl: url
                }
            ]
        });

        const fakeAdvancedBrowser = async (url) => ({
            findings: [
                {
                    id: 'adv-1',
                    ruleId: 'performance.lcp.mobile',
                    category: 'performance',
                    moduleId: 'performance_plus',
                    severity: 'high',
                    title: 'Mobile LCP slow',
                    pageUrl: url
                },
                {
                    id: 'adv-2',
                    ruleId: 'geo.jsonld.missing',
                    category: 'geo',
                    moduleId: 'advanced_geo',
                    severity: 'medium',
                    title: 'Schema.org JSON-LD missing',
                    pageUrl: url
                },
                {
                    id: 'adv-3',
                    ruleId: 'visual.cls.desktop',
                    category: 'design',
                    moduleId: 'visual_ux',
                    severity: 'low',
                    title: 'Layout shift observed',
                    pageUrl: url
                }
            ]
        });

        const runner = createScanRunner({
            config: baseConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeLighthouse,
                axe: fakeAxe,
                yellowLab: fakeYellowLab,
                wpaPage: fakeWpaPage,
                advancedBrowser: fakeAdvancedBrowser
            }
        });

        const result = await runner.runScan('https://example.com');
        assert.equal(result.status, 'completed');

        // Verify engines object
        assert.equal(result.engines.lighthouse?.status, 'completed');
        assert.equal(result.engines.axe?.status, 'completed');
        assert.equal(result.engines.yellowLab?.status, 'completed');
        assert.equal(result.engines.wpaPage?.status, 'completed');
        assert.equal(result.engines.performancePlus?.status, 'completed');
        assert.equal(result.engines.advancedGeo?.status, 'completed');
        assert.equal(result.engines.visualUx?.status, 'completed');

        // Verify findings count (1 + 1 + 1 + 1 + 3 = 7)
        assert.equal(result.findings.length, 7);

        // Verify summary
        assert.equal(result.summary.bySeverity.critical, 1);
        assert.equal(result.summary.bySeverity.high, 2);
        assert.equal(result.summary.bySeverity.medium, 2);
        assert.equal(result.summary.bySeverity.low, 2);
        assert.equal(result.summary.bySeverity.info, 0);

        assert.equal(result.summary.byCategory.performance, 3);
        assert.equal(result.summary.byCategory.accessibility, 1);
        assert.equal(result.summary.byCategory.seo, 1);
        assert.equal(result.summary.byCategory.geo, 1);
        assert.equal(result.summary.byCategory.design, 1);
    });

    it('continues when one analyzer errors and retains other engine findings', async () => {
        const fakeLighthouseFailing = async () => {
            throw new Error('Chromium crashed unexpectedly');
        };

        const fakeAxe = async (url) => ({
            findings: [
                {
                    id: 'axe-1',
                    ruleId: 'axe.contrast',
                    category: 'accessibility',
                    severity: 'medium',
                    title: 'Contrast',
                    engineId: 'axe',
                    pageUrl: url
                }
            ]
        });

        const runner = createScanRunner({
            config: baseConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeLighthouseFailing,
                axe: fakeAxe,
                yellowLab: null,
                wpaPage: null,
                advancedBrowser: null
            }
        });

        const result = await runner.runScan('https://example.com');
        // Overall scan is completed because Axe succeeded
        assert.equal(result.status, 'completed');
        assert.equal(result.engines.lighthouse.status, 'failed');
        assert.equal(result.engines.lighthouse.error?.code, 'ANALYZER_FAILED');
        assert.equal(result.engines.axe.status, 'completed');

        // Axe finding is preserved in the report
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].engineId, 'axe');
    });

    it('marks timed out analyzer as timed_out and completes others', async () => {
        const timeoutConfig = {
            ...baseConfig,
            timeouts: {
                axeMs: 100,
                lighthouseMs: 1000
            },
            axeTimeoutMs: 100,
            engineTimeoutMs: 100
        };

        const fakeHangingAxe = async (_url, { signal }) => {
            // Wait longer than 100ms
            await abortableDelay(500, signal);
            return { findings: [] };
        };

        const fakeFastLighthouse = async (url) => ({
            findings: [
                {
                    id: 'lh-1',
                    ruleId: 'lighthouse.lcp',
                    category: 'performance',
                    severity: 'low',
                    title: 'LCP fast',
                    engineId: 'lighthouse',
                    pageUrl: url
                }
            ]
        });

        const runner = createScanRunner({
            config: timeoutConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeFastLighthouse,
                axe: fakeHangingAxe,
                yellowLab: null,
                wpaPage: null,
                advancedBrowser: null
            }
        });

        const result = await runner.runScan('https://example.com');
        assert.equal(result.status, 'completed');
        assert.equal(result.engines.axe.status, 'timed_out');
        assert.equal(result.engines.lighthouse.status, 'completed');
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].id, 'lh-1');
    });

    it('marks scan as failed when all analyzers fail', async () => {
        const fakeLighthouse = async () => {
            throw new Error('Lighthouse crashed');
        };
        const fakeAxe = async () => {
            throw new Error('Axe crashed');
        };

        const runner = createScanRunner({
            config: baseConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeLighthouse,
                axe: fakeAxe,
                yellowLab: null,
                wpaPage: null,
                advancedBrowser: null
            }
        });

        const result = await runner.runScan('https://example.com');
        assert.equal(result.status, 'failed');
        assert.equal(result.engines.lighthouse.status, 'failed');
        assert.equal(result.engines.axe.status, 'failed');
        assert.equal(result.findings.length, 0);
    });

    it('applies per-engine timeout budget independently (Revizyon 1 - a)', async () => {
        const perEngineConfig = {
            ...baseConfig,
            timeouts: {
                lighthouseMs: 50,  // short timeout
                axeMs: 250        // longer timeout
            }
        };

        const fakeSlowLighthouse = async (_url, { signal }) => {
            await abortableDelay(100, signal); // exceeds 50ms
            return { findings: [] };
        };

        const fakeModerateAxe = async () => {
            await new Promise((r) => setTimeout(r, 80)); // within 250ms
            return {
                findings: [
                    { id: 'axe-1', ruleId: 'axe.test', category: 'accessibility', severity: 'low', engineId: 'axe', pageUrl: 'https://example.com' }
                ]
            };
        };

        const runner = createScanRunner({
            config: perEngineConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeSlowLighthouse,
                axe: fakeModerateAxe,
                yellowLab: null,
                wpaPage: null,
                advancedBrowser: null
            }
        });

        const result = await runner.runScan('https://example.com');
        assert.equal(result.engines.lighthouse.status, 'timed_out');
        assert.equal(result.engines.axe.status, 'completed');
        assert.equal(result.findings.length, 1);
    });

    it('sanitizes engine error messages and avoids leaking raw stack or call logs (Revizyon 1 - b)', async () => {
        const noisyError = new Error('page.goto: Timeout 45000ms exceeded.\nCall log:\n\u001b[2m  - navigating to "https://example.com/", waiting until "networkidle"\u001b[22m\n');
        noisyError.code = 'OPERATION_TIMEOUT';

        const fakeCrashingEngine = async () => {
            throw noisyError;
        };

        const runner = createScanRunner({
            config: baseConfig,
            proxyFactory: mockProxyFactory,
            analyzers: {
                lighthouse: fakeCrashingEngine,
                axe: null,
                yellowLab: null,
                wpaPage: null,
                advancedBrowser: null
            }
        });

        const result = await runner.runScan('https://example.com');
        const error = result.engines.lighthouse.error;
        assert.ok(error);
        assert.equal(error.code, 'OPERATION_TIMEOUT');
        assert.equal(error.message, 'Engine exceeded its time limit.');
        // Verify no ANSI escape codes or raw call logs
        assert.equal(error.message.includes('\u001b'), false);
        assert.equal(error.message.includes('Call log:'), false);
        assert.equal(error.message.includes('navigating to'), false);
    });
});
