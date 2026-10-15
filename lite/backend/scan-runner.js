const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { runWithTimeout } = require('./lib/abort');
const { AppError } = require('./lib/errors');
const { SafeBrowserProxy } = require('./security/safe-proxy');
const { runLighthouse } = require('./engines/lighthouse');
const { runAxe } = require('./engines/axe');
const { runYellowLab } = require('./engines/yellowlab');
const { runWpaPage } = require('./engines/wpa-page');
const { runAdvancedBrowser } = require('./engines/advanced-browser');
const { readJson, lighthouseFindings, axeFindings, yellowLabFindings } = require('./domain/analysis-normalization');

const SANITIZED_ENGINE_MESSAGES = {
    OPERATION_TIMEOUT: 'Engine exceeded its time limit.',
    ANALYZER_FAILED: 'Engine encountered an error during analysis.',
    YELLOWLAB_UPSTREAM_ERROR: 'YellowLab upstream service failed.',
    YELLOWLAB_INVALID_RESPONSE: 'YellowLab returned an invalid response.',
    YELLOWLAB_ANALYSIS_FAILED: 'YellowLab could not analyze the target.',
    YELLOWLAB_TIMEOUT: 'YellowLab did not finish before the polling limit.',
    CHROME_NOT_FOUND: 'Chromium binary could not be found.',
    ANALYZER_UNAVAILABLE: 'Engine is temporarily unavailable.',
    OPERATION_ABORTED: 'Engine execution was cancelled.'
};

function sanitizeEngineError(error, isTimeout) {
    const code = isTimeout ? 'OPERATION_TIMEOUT' : (error?.code || 'ANALYZER_FAILED');
    return {
        code,
        message: SANITIZED_ENGINE_MESSAGES[code] || 'Engine encountered an error during analysis.'
    };
}

function enrichWpaFinding(finding, pageUrl) {
    return {
        ...finding,
        pageUrl: finding.pageUrl || pageUrl,
        engineId: 'wpaPage',
        category: finding.category || 'runtime'
    };
}

function enrichAdvancedFinding(finding, pageUrl) {
    const engineId = ({
        performance_plus: 'performancePlus',
        advanced_geo: 'advancedGeo',
        visual_ux: 'visualUx'
    })[finding.moduleId] || finding.engineId || 'performancePlus';
    return {
        ...finding,
        pageUrl: finding.pageUrl || pageUrl,
        engineId,
        category: finding.category || (engineId === 'performancePlus' ? 'performance' : engineId === 'advancedGeo' ? 'geo' : 'design')
    };
}

function buildSummary(findings) {
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const byCategory = {};
    for (const finding of findings) {
        const sev = String(finding.severity || 'medium').toLowerCase();
        if (bySeverity[sev] !== undefined) {
            bySeverity[sev] += 1;
        } else {
            bySeverity[sev] = 1;
        }
        const cat = String(finding.category || 'other');
        byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    return { bySeverity, byCategory };
}

function createScanRunner({
    config,
    logger,
    proxyFactory,
    analyzers = {}
} = {}) {
    const activeAnalyzers = {
        lighthouse: runLighthouse,
        axe: runAxe,
        yellowLab: runYellowLab,
        wpaPage: runWpaPage,
        advancedBrowser: runAdvancedBrowser,
        ...analyzers
    };

    const createProxy = proxyFactory || ((targetUrl) => new SafeBrowserProxy({
        allowedPorts: config.allowedPorts,
        allowedOrigins: [new URL(targetUrl).origin],
        readOnly: false,
        logger,
        connectTimeoutMs: config.proxyConnectTimeoutMs
    }));

    async function runSingleEngine(engineId, taskFn, timeoutMs, parentSignal) {
        const start = Date.now();
        try {
            const result = await runWithTimeout(
                (engineSignal) => taskFn(engineSignal),
                timeoutMs,
                engineId,
                parentSignal
            );
            return {
                status: 'completed',
                durationMs: Math.max(0, Date.now() - start),
                result
            };
        } catch (error) {
            const isTimeout = error?.name === 'TimeoutError' || error?.code === 'OPERATION_TIMEOUT';
            logger?.warn?.(`Engine ${engineId} failed`, {
                engineId,
                isTimeout,
                code: error?.code,
                message: error?.message,
                stack: error?.stack
            });
            return {
                status: isTimeout ? 'timed_out' : 'failed',
                durationMs: Math.max(0, Date.now() - start),
                error: sanitizeEngineError(error, isTimeout)
            };
        }
    }

    return {
        async runScan(targetUrl, { signal } = {}) {
            const scanArtifactDir = path.join(config.artifactDir, `scan_${crypto.randomUUID()}`);
            await fs.mkdir(scanArtifactDir, { recursive: true });

            let proxy = null;
            let proxyUrl = null;

            try {
                // Set up SSRF-safe proxy for browser engines
                proxy = createProxy(targetUrl);
                if (proxy?.start) {
                    proxyUrl = await proxy.start();
                }

                signal?.throwIfAborted();

                const engineOptions = {
                    artifactDir: scanArtifactDir,
                    proxyUrl,
                    signal,
                    config
                };

                const engineResults = {};
                const collectedFindings = [];

                // Per-engine timeout budgets
                const yellowLabTimeoutMs = config.timeouts?.yellowLabMs || config.yellowLabTimeoutMs || 150_000;
                const lighthouseTimeoutMs = config.timeouts?.lighthouseMs || config.lighthouseTimeoutMs || 180_000;
                const axeTimeoutMs = config.timeouts?.axeMs || config.axeTimeoutMs || 90_000;
                const wpaPageTimeoutMs = config.timeouts?.wpaPageMs || config.wpaPageTimeoutMs || 120_000;
                const advancedBrowserTimeoutMs = config.timeouts?.advancedBrowserMs || config.advancedBrowserTimeoutMs || 150_000;

                // 1. External lane: YellowLab
                const yellowLabPromise = (async () => {
                    const engineId = 'yellowLab';
                    const fn = activeAnalyzers.yellowLab;
                    if (typeof fn !== 'function') return;

                    const run = await runSingleEngine(
                        engineId,
                        (s) => fn(targetUrl, {
                            ...engineOptions,
                            signal: s,
                            maxPollAttempts: config.yellowLabMaxPollAttempts || 24
                        }),
                        yellowLabTimeoutMs,
                        signal
                    );
                    engineResults.yellowLab = {
                        status: run.status,
                        durationMs: run.durationMs,
                        ...(run.error ? { error: run.error } : {})
                    };

                    if (run.status === 'completed' && run.result) {
                        if (Array.isArray(run.result.findings)) {
                            collectedFindings.push(...run.result.findings);
                        } else if (Array.isArray(run.result)) {
                            collectedFindings.push(...run.result);
                        } else if (run.result.logPath) {
                            const data = await readJson(run.result.logPath);
                            collectedFindings.push(...yellowLabFindings(data, targetUrl));
                        }
                    }
                })();

                // 2. Browser lane: Sequential execution to prevent Chromium memory spikes
                const browserLanePromise = (async () => {
                    // Lighthouse
                    if (typeof activeAnalyzers.lighthouse === 'function') {
                        const run = await runSingleEngine(
                            'lighthouse',
                            (s) => activeAnalyzers.lighthouse(targetUrl, { ...engineOptions, signal: s }),
                            lighthouseTimeoutMs,
                            signal
                        );
                        engineResults.lighthouse = {
                            status: run.status,
                            durationMs: run.durationMs,
                            ...(run.error ? { error: run.error } : {})
                        };
                        if (run.status === 'completed' && run.result) {
                            if (Array.isArray(run.result.findings)) {
                                collectedFindings.push(...run.result.findings);
                            } else if (Array.isArray(run.result)) {
                                collectedFindings.push(...run.result);
                            } else {
                                if (run.result.desktopPath) {
                                    const desktopData = await readJson(run.result.desktopPath);
                                    collectedFindings.push(...lighthouseFindings(desktopData, 'desktop'));
                                }
                                if (run.result.mobilePath) {
                                    const mobileData = await readJson(run.result.mobilePath);
                                    collectedFindings.push(...lighthouseFindings(mobileData, 'mobile'));
                                }
                            }
                        }
                    }

                    // Axe
                    if (typeof activeAnalyzers.axe === 'function') {
                        const run = await runSingleEngine(
                            'axe',
                            (s) => activeAnalyzers.axe(targetUrl, { ...engineOptions, signal: s }),
                            axeTimeoutMs,
                            signal
                        );
                        engineResults.axe = {
                            status: run.status,
                            durationMs: run.durationMs,
                            ...(run.error ? { error: run.error } : {})
                        };
                        if (run.status === 'completed' && run.result) {
                            if (Array.isArray(run.result.findings)) {
                                collectedFindings.push(...run.result.findings);
                            } else if (Array.isArray(run.result)) {
                                collectedFindings.push(...run.result);
                            } else if (run.result.logPath) {
                                const data = await readJson(run.result.logPath);
                                collectedFindings.push(...axeFindings(data, targetUrl));
                            }
                        }
                    }

                    // WPA Page
                    if (typeof activeAnalyzers.wpaPage === 'function') {
                        const run = await runSingleEngine(
                            'wpaPage',
                            (s) => activeAnalyzers.wpaPage(targetUrl, { ...engineOptions, signal: s }),
                            wpaPageTimeoutMs,
                            signal
                        );
                        engineResults.wpaPage = {
                            status: run.status,
                            durationMs: run.durationMs,
                            ...(run.error ? { error: run.error } : {})
                        };
                        if (run.status === 'completed' && run.result) {
                            if (Array.isArray(run.result.findings)) {
                                collectedFindings.push(...run.result.findings.map((f) => enrichWpaFinding(f, targetUrl)));
                            } else if (Array.isArray(run.result)) {
                                collectedFindings.push(...run.result.map((f) => enrichWpaFinding(f, targetUrl)));
                            } else if (run.result.logPath) {
                                const data = await readJson(run.result.logPath);
                                for (const raw of data?.findings || []) {
                                    collectedFindings.push(enrichWpaFinding(raw, targetUrl));
                                }
                            }
                        }
                    }

                    // Advanced browser engines: performancePlus, advancedGeo, visualUx
                    const hasSeparateAdvanced = typeof activeAnalyzers.performancePlus === 'function' ||
                        typeof activeAnalyzers.advancedGeo === 'function' ||
                        typeof activeAnalyzers.visualUx === 'function';

                    if (hasSeparateAdvanced) {
                        for (const [engineId, fn] of [
                            ['performancePlus', activeAnalyzers.performancePlus],
                            ['advancedGeo', activeAnalyzers.advancedGeo],
                            ['visualUx', activeAnalyzers.visualUx]
                        ]) {
                            if (typeof fn === 'function') {
                                const run = await runSingleEngine(
                                    engineId,
                                    (s) => fn(targetUrl, { ...engineOptions, signal: s }),
                                    advancedBrowserTimeoutMs,
                                    signal
                                );
                                engineResults[engineId] = {
                                    status: run.status,
                                    durationMs: run.durationMs,
                                    ...(run.error ? { error: run.error } : {})
                                };
                                if (run.status === 'completed' && run.result) {
                                    const findings = Array.isArray(run.result.findings) ? run.result.findings
                                        : Array.isArray(run.result) ? run.result : [];
                                    collectedFindings.push(...findings.map((f) => enrichAdvancedFinding(f, targetUrl)));
                                }
                            }
                        }
                    } else if (typeof activeAnalyzers.advancedBrowser === 'function') {
                        const run = await runSingleEngine(
                            'advancedBrowser',
                            (s) => activeAnalyzers.advancedBrowser(targetUrl, {
                                ...engineOptions,
                                signal: s,
                                modules: ['performance_plus', 'advanced_geo', 'visual_ux']
                            }),
                            advancedBrowserTimeoutMs,
                            signal
                        );

                        const advancedEngines = ['performancePlus', 'advancedGeo', 'visualUx'];
                        for (const id of advancedEngines) {
                            engineResults[id] = {
                                status: run.status,
                                durationMs: run.durationMs,
                                ...(run.error ? { error: run.error } : {})
                            };
                        }

                        if (run.status === 'completed' && run.result) {
                            let rawFindings = [];
                            if (Array.isArray(run.result.findings)) {
                                rawFindings = run.result.findings;
                            } else if (Array.isArray(run.result)) {
                                rawFindings = run.result;
                            } else if (run.result.logPath) {
                                const data = await readJson(run.result.logPath);
                                rawFindings = data?.findings || [];
                            }
                            for (const f of rawFindings) {
                                collectedFindings.push(enrichAdvancedFinding(f, targetUrl));
                            }
                        }
                    }
                })();

                await Promise.all([yellowLabPromise, browserLanePromise]);

                // Determine overall scan status
                const statuses = Object.values(engineResults).map((e) => e.status);
                const hasCompleted = statuses.some((s) => s === 'completed');
                const status = hasCompleted ? 'completed' : 'failed';

                return {
                    status,
                    engines: engineResults,
                    findings: collectedFindings,
                    summary: buildSummary(collectedFindings)
                };
            } finally {
                if (proxy?.stop) {
                    await proxy.stop().catch(() => {});
                }
                await fs.rm(scanArtifactDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    };
}

module.exports = {
    createScanRunner,
    buildSummary,
    enrichWpaFinding,
    enrichAdvancedFinding,
    sanitizeEngineError,
    SANITIZED_ENGINE_MESSAGES
};
