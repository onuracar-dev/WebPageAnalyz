const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { runWithTimeout } = require('../lib/abort');
const { SafeBrowserProxy } = require('../security/safe-proxy');
const { runLighthouse } = require('../analyzers/lighthouse');
const { runYellowLab } = require('../analyzers/yellowlab');
const { runAxe } = require('../analyzers/axe');
const { runWpaPage } = require('../analyzers/wpa-page');
const { runAdvancedBrowser } = require('../analyzers/advanced-browser');
const { runZapBaseline } = require('../analyzers/zap-baseline');
const { parseLogs } = require('../utils/parser');
const { ENGINE_CAPABILITIES, classifyErrorCode, remediationFor } = require('../domain/analysis-contract');
const { readJson, lighthouseFindings, axeFindings, yellowLabFindings, coverageFor } = require('../domain/analysis-normalization');
const { normalizePageUrl } = require('../domain/url-normalization');

const ANALYZER_CLEANUP_GRACE_MS = 10_000;
const PROGRESS_FLUSH_GRACE_MS = 2_000;
const ADVANCED_MODULE_ENGINES = Object.freeze({
    performance_plus: 'performancePlus',
    advanced_geo: 'advancedGeo',
    visual_ux: 'visualUx',
    journey_test: 'journey'
});

const safeAnalyzerCodes = new Set([
    'OPERATION_TIMEOUT',
    'YELLOWLAB_UPSTREAM_ERROR',
    'YELLOWLAB_INVALID_RESPONSE',
    'YELLOWLAB_ANALYSIS_FAILED',
    'YELLOWLAB_TIMEOUT',
    'CHROME_NOT_FOUND',
    'ANALYZER_UNAVAILABLE',
    'ZAP_UNAVAILABLE',
    'OSV_ISOLATION_UNAVAILABLE',
    'EXTERNAL_PROVIDER_CONSENT_REQUIRED',
    'OPERATION_ABORTED'
]);

function analyzerErrorCode(result) {
    if (result.status === 'fulfilled') return null;
    return safeAnalyzerCodes.has(result.reason?.code) ? result.reason.code : 'ANALYZER_FAILED';
}

function waitForOperationCleanup(operation, milliseconds = ANALYZER_CLEANUP_GRACE_MS) {
    if (!operation) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), milliseconds);
        timer.unref?.();
        Promise.resolve(operation).then(() => finish(true), () => finish(true));
    });
}

function createAnalysisService({
    config,
    logger,
    analyzers = { lighthouse: runLighthouse, yellowLab: runYellowLab, axe: runAxe, wpaPage: runWpaPage, advancedBrowser: runAdvancedBrowser, zapBaseline: runZapBaseline },
    parse = parseLogs,
    proxyFactory,
    zapLock = null
}) {
    const createProxy = proxyFactory || ((target) => new SafeBrowserProxy({
        allowedPorts: config.allowedTargetPorts,
        allowedOrigins: [new URL(target.url).origin],
        readOnly: false,
        logger,
        connectTimeoutMs: config.timeouts.proxyConnectMs,
        ...config.proxyLimits
    }));

    async function removeArtifacts(paths, directory) {
        if (config.keepArtifacts) return;
        await Promise.all(paths.filter(Boolean).map((file) => fs.unlink(file).catch(() => {})));
        if (directory && directory !== config.artifactDir) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }

    return {
        async analyze(target, signal, options = {}) {
            const proxy = createProxy(target, options);
            const artifacts = [];
            const analyzerTasks = [];
            const analyzerExecutions = {};
            let progressChain = Promise.resolve();
            const emitProgress = (type, payload) => {
                if (typeof options.onProgress !== 'function') return;
                progressChain = progressChain
                    .then(() => options.onProgress({ type, payload }))
                    .catch((error) => logger.warn('Analyzer progress event could not be persisted', {
                        eventType: type,
                        errorCode: error?.code || 'PROGRESS_EVENT_FAILED',
                        workerPid: process.pid
                    }));
            };
            const artifactDir = config.keepArtifacts
                ? config.artifactDir
                : path.join(config.artifactDir, `analysis_${crypto.randomUUID()}`);
            const runAnalyzer = async ({ name, engineIds, task, timeoutMs, label, resourceClass, queuedAtMs }) => {
                const execution = analyzerExecutions[name];
                const startedAtMs = Date.now();
                execution.startedAt = new Date(startedAtMs).toISOString();
                execution.queueWaitMs = Math.max(0, startedAtMs - queuedAtMs);
                execution.status = 'running';
                emitProgress('engine.running', { executionId: name, engineIds, ...execution });
                let operation;
                let rejectedAtMs = null;
                try {
                    const value = await runWithTimeout((analyzerSignal) => {
                        operation = Promise.resolve().then(() => task(analyzerSignal));
                        analyzerTasks.push(operation);
                        return operation;
                    }, timeoutMs, label, signal);
                    execution.status = 'completed';
                    return { status: 'fulfilled', value };
                } catch (reason) {
                    rejectedAtMs = Date.now();
                    const cleanupCompleted = await waitForOperationCleanup(operation);
                    execution.cleanupMs = Math.max(0, Date.now() - rejectedAtMs);
                    execution.cleanupCompleted = cleanupCompleted;
                    const errorCode = analyzerErrorCode({ status: 'rejected', reason });
                    execution.status = errorCode === 'OPERATION_TIMEOUT'
                        ? 'timeout'
                        : ['OPERATION_ABORTED', 'REQUEST_CANCELLED'].includes(errorCode) ? 'cancelled' : 'failed';
                    execution.errorCode = errorCode;
                    if (!cleanupCompleted) {
                        logger.warn('Analyzer cleanup exceeded its grace period', {
                            analyzer: name,
                            hostname: target.hostname,
                            cleanupGraceMs: ANALYZER_CLEANUP_GRACE_MS,
                            workerPid: process.pid
                        });
                    }
                    return { status: 'rejected', reason };
                } finally {
                    const finishedAtMs = Date.now();
                    execution.finishedAt = new Date(finishedAtMs).toISOString();
                    execution.executionMs = Math.max(0, finishedAtMs - startedAtMs);
                    logger.info('Analyzer execution finished', {
                        analyzer: name,
                        hostname: target.hostname,
                        resourceClass,
                        queueWaitMs: execution.queueWaitMs,
                        executionMs: execution.executionMs,
                        timeoutBudgetMs: timeoutMs,
                        status: execution.status,
                        errorCode: execution.errorCode,
                        workerPid: process.pid
                    });
                    emitProgress(`engine.${execution.status}`, { executionId: name, engineIds, ...execution });
                }
            };
            try {
                const proxyUrl = await proxy.start();
                signal?.throwIfAborted();
                const analyzerOptions = { artifactDir, proxyUrl, config, authorizedOrigins: options.authorizedOrigins };
                const advancedModules = Array.isArray(options.advancedModules) ? options.advancedModules : [];
                const advancedEngineIds = advancedModules.map((moduleId) => ADVANCED_MODULE_ENGINES[moduleId]).filter(Boolean);
                const requested = new Set(Array.isArray(options.engineIds) && options.engineIds.length
                    ? options.engineIds
                    : ['lighthouse', 'yellowLab', 'axe', 'wpaPage', ...advancedModules.map((moduleId) => ({ performance_plus: 'performancePlus', advanced_geo: 'advancedGeo', visual_ux: 'visualUx', journey_test: 'journey' })[moduleId]).filter(Boolean), ...(options.passiveSecurity ? ['zapBaseline'] : [])]);
                const advancedRequested = advancedModules.length > 0
                    && ['performancePlus', 'advancedGeo', 'visualUx', 'journey'].some((engine) => requested.has(engine));
                const unavailable = (message) => async () => {
                    throw Object.assign(new Error(message), { code: 'ANALYZER_UNAVAILABLE' });
                };
                const plans = [
                    {
                        name: 'lighthouse', engineIds: ['lighthouse'], resourceClass: 'browser', enabled: requested.has('lighthouse'), timeoutMs: config.timeouts.lighthouseMs, label: 'Lighthouse analysis',
                        task: (analyzerSignal) => analyzers.lighthouse(target.url, { ...analyzerOptions, signal: analyzerSignal })
                    },
                    {
                        name: 'yellowLab', engineIds: ['yellowLab'], resourceClass: 'external', enabled: requested.has('yellowLab'), timeoutMs: config.timeouts.yellowLabMs, label: 'YellowLab analysis',
                        task: (analyzerSignal) => {
                            if (config.requireExternalProviderConsent && options.externalProviderConsent !== true) throw Object.assign(new AppError('External analyzer consent is required.', { status: 409, code: 'EXTERNAL_PROVIDER_CONSENT_REQUIRED' }));
                            return analyzers.yellowLab(target.url, {
                                ...analyzerOptions,
                                signal: analyzerSignal,
                                maxPollAttempts: config.yellowLabMaxPollAttempts,
                                providerDisclosure: { provider: 'YellowLab.tools', external: true, consentRecorded: options.externalProviderConsent === true, targetOriginVerified: options.targetOriginVerified === true }
                            });
                        }
                    },
                    {
                        name: 'axe', engineIds: ['axe'], resourceClass: 'browser', enabled: requested.has('axe'), timeoutMs: config.timeouts.axeMs, label: 'Axe analysis',
                        task: (analyzerSignal) => analyzers.axe(target.url, { ...analyzerOptions, signal: analyzerSignal })
                    },
                    {
                        name: 'wpaPage', engineIds: ['wpaPage'], resourceClass: 'browser', enabled: requested.has('wpaPage'), timeoutMs: config.timeouts.wpaPageMs || config.timeouts.axeMs, label: 'WPA page intelligence',
                        task: typeof analyzers.wpaPage === 'function'
                            ? (analyzerSignal) => analyzers.wpaPage(target.url, { ...analyzerOptions, signal: analyzerSignal })
                            : unavailable('WPA page analyzer is unavailable.')
                    },
                    {
                        name: 'advancedBrowser', engineIds: advancedEngineIds, resourceClass: 'browser', enabled: advancedRequested, timeoutMs: config.timeouts.advancedBrowserMs || config.timeouts.wpaPageMs || config.timeouts.axeMs, label: 'WPA advanced browser analysis',
                        task: typeof analyzers.advancedBrowser === 'function'
                            ? (analyzerSignal) => analyzers.advancedBrowser(target.url, { ...analyzerOptions, signal: analyzerSignal, modules: advancedModules, journey: options.journey })
                            : unavailable('WPA advanced browser analyzer is unavailable.')
                    },
                    {
                        name: 'zapBaseline', engineIds: ['zapBaseline'], resourceClass: 'external', enabled: requested.has('zapBaseline'), timeoutMs: config.timeouts.zapMs || config.timeouts.analysisMs, label: 'OWASP ZAP passive baseline',
                        task: typeof analyzers.zapBaseline === 'function'
                            ? (analyzerSignal) => analyzers.zapBaseline(target.url, { signal: analyzerSignal, config, logger, distributedLock: options.zapLock || zapLock })
                            : unavailable('OWASP ZAP passive analyzer is unavailable.')
                    }
                ];
                const settledByName = new Map(plans.filter((plan) => !plan.enabled).map((plan) => [plan.name, { status: 'fulfilled', value: null }]));
                for (const plan of plans.filter((candidate) => candidate.enabled)) {
                    plan.queuedAtMs = Date.now();
                    analyzerExecutions[plan.name] = {
                        queuedAt: new Date(plan.queuedAtMs).toISOString(),
                        timeoutBudgetMs: plan.timeoutMs,
                        resourceClass: plan.resourceClass,
                        status: 'queued'
                    };
                }
                emitProgress('analysis.plan', {
                    engines: plans.filter((plan) => plan.enabled).map((plan) => ({
                        executionId: plan.name,
                        engineIds: plan.engineIds,
                        resourceClass: plan.resourceClass,
                        timeoutBudgetMs: plan.timeoutMs
                    }))
                });
                const executePlan = async (plan) => settledByName.set(plan.name, await runAnalyzer(plan));
                const browserLane = (async () => {
                    for (const plan of plans.filter((candidate) => candidate.enabled && candidate.resourceClass === 'browser')) {
                        await executePlan(plan);
                    }
                })();
                const externalLane = Promise.all(plans
                    .filter((candidate) => candidate.enabled && candidate.resourceClass === 'external')
                    .map((plan) => executePlan(plan)));
                await Promise.all([browserLane, externalLane]);
                const analyzerOrder = ['lighthouse', 'yellowLab', 'axe', 'wpaPage', 'advancedBrowser', 'zapBaseline'];
                const results = analyzerOrder.map((name) => settledByName.get(name));
                signal?.throwIfAborted();

                const [lighthouseResult, yellowLabResult, axeResult, wpaPageResult, advancedBrowserResult, zapResult] = results;
                const value = (result) => result.status === 'fulfilled' ? result.value : null;
                const lighthouse = value(lighthouseResult);
                const yellowLab = value(yellowLabResult);
                const axe = value(axeResult);
                const wpaPage = value(wpaPageResult);
                const advancedBrowser = value(advancedBrowserResult);
                const zap = value(zapResult);
                artifacts.push(
                    lighthouse?.desktopPath,
                    lighthouse?.mobilePath,
                    yellowLab?.logPath,
                    axe?.logPath,
                    ...(wpaPage?.artifactPaths || []),
                    ...(advancedBrowser?.artifactPaths || [])
                );

                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        logger.warn('Analyzer failed', {
                            analyzer: ['lighthouse', 'yellowLab', 'axe', 'wpaPage', 'advancedBrowser', 'zapBaseline'][index],
                            hostname: target.hostname,
                            errorName: result.reason?.name,
                            errorCode: result.reason?.code
                        });
                    }
                });

                if ([...requested].length && !lighthouse && !yellowLab && !axe && !wpaPage && !advancedBrowser && !zap) {
                    throw new AppError('No analyzer could complete the audit.', {
                        status: 502,
                        code: 'ANALYSIS_FAILED',
                        expose: true
                    });
                }

                const report = await parse({
                    lighthouseDesktop: lighthouse?.desktopPath,
                    lighthouseMobile: lighthouse?.mobilePath,
                    yellowlab: yellowLab?.logPath,
                    axe: axe?.logPath,
                    wpaPage: wpaPage?.logPath,
                    advancedBrowser: advancedBrowser?.logPath
                });
                const [lighthouseDesktop, lighthouseMobile, yellowLabData, axeData, wpaData, advancedData] = await Promise.all([
                    readJson(lighthouse?.desktopPath), readJson(lighthouse?.mobilePath), readJson(yellowLab?.logPath), readJson(axe?.logPath), readJson(wpaPage?.logPath), readJson(advancedBrowser?.logPath)
                ]);
                report.findings ||= [];
                report.modules ||= {};
                report.sharedCategories ||= { performance: [], seo: [], accessibility: [], bestPractices: [] };
                report.categories ||= { performance: [], seo: [], accessibility: [], bestPractices: [] };
                report.findings.push(
                    ...lighthouseFindings(lighthouseDesktop, 'desktop'),
                    ...lighthouseFindings(lighthouseMobile, 'mobile'),
                    ...axeFindings(axeData, target.url),
                    ...yellowLabFindings(yellowLabData, target.url)
                );
                if (zap?.findings?.length) {
                    report.findings.push(...zap.findings);
                    report.sharedCategories.bestPractices.push(...zap.findings.map((finding) => ({
                        id: finding.ruleId, title: finding.title, description: finding.description,
                        source: `OWASP ZAP ${zap.version}`, normalizedImpact: finding.normalizedImpact,
                        severity: finding.severity, confidence: finding.confidence, kind: finding.kind,
                        pageUrl: finding.pageUrl, fingerprint: finding.fingerprint, evidence: finding.evidence,
                        remediation: finding.remediation, score: 0, displayValue: `${finding.severity} · ${Math.round(finding.confidence * 100)}% confidence`, snippet: null
                    })));
                    report.categories.bestPractices.push(...report.sharedCategories.bestPractices.slice(-zap.findings.length));
                }
                if (requested.has('zapBaseline')) report.modules.passive_security = { status: zap ? 'completed' : 'failed', version: zap?.version || '2.17.0', findingCount: zap?.findings?.length || 0, coverage: zap?.coverage || null };
                const analyzerErrors = Object.fromEntries(
                    [
                        ['lighthouse', lighthouseResult],
                        ['yellowLab', yellowLabResult],
                        ['axe', axeResult],
                        ['wpaPage', wpaPageResult],
                        ['advancedBrowser', advancedBrowserResult],
                        ['zapBaseline', zapResult]
                    ]
                        .map(([name, result]) => [name, analyzerErrorCode(result)])
                        .filter(([, code]) => code)
                );
                report.meta = {
                    analyzedAt: new Date().toISOString(),
                    providers: yellowLab?.providerDisclosure ? [yellowLab.providerDisclosure] : [],
                    analyzers: {
                        lighthouse: requested.has('lighthouse') ? (lighthouse ? 'completed' : 'unavailable') : 'not_requested',
                        yellowLab: requested.has('yellowLab') ? (yellowLab ? 'completed' : 'unavailable') : 'not_requested',
                        axe: requested.has('axe') ? (axe ? 'completed' : 'unavailable') : 'not_requested',
                        wpaPage: requested.has('wpaPage') ? (wpaPage ? 'completed' : 'unavailable') : 'not_requested',
                        advancedBrowser: ['performancePlus', 'advancedGeo', 'visualUx', 'journey'].some((engine) => requested.has(engine)) ? (advancedBrowser ? 'completed' : 'unavailable') : 'not_requested',
                        zapBaseline: requested.has('zapBaseline') ? (zap ? 'completed' : 'unavailable') : 'not_requested'
                    },
                    analyzerErrors,
                    engineExecutions: analyzerExecutions
                };
                if (Array.isArray(wpaData?.renderedLinks)) {
                    let renderedReferrer = null;
                    try { renderedReferrer = normalizePageUrl(wpaData.url || target.url); } catch { /* Validated targets normally make this unreachable. */ }
                    const renderedScope = new Set();
                    for (const value of options.authorizedOrigins?.length ? options.authorizedOrigins : [new URL(target.url).origin]) {
                        try { renderedScope.add(new URL(value).origin); } catch { /* Invalid entries never widen the report scope. */ }
                    }
                    const scopedRenderedLinks = wpaData.renderedLinks.filter((url) => {
                        try { return renderedScope.has(new URL(url).origin); } catch { return false; }
                    }).slice(0, 500);
                    report.discovery = {
                        renderedLinks: scopedRenderedLinks.map((url) => ({
                            url,
                            referrer: renderedReferrer,
                            source: 'rendered_link'
                        })),
                        coverage: {
                            ...(wpaData.renderedLinkCoverage || {}),
                            producer: 'wpa_page_playwright_snapshot',
                            uniqueLinks: scopedRenderedLinks.length
                        }
                    };
                }
                const resultByEngine = {
                    lighthouse: [lighthouseResult, lighthouse], yellowLab: [yellowLabResult, yellowLab], axe: [axeResult, axe], wpaPage: [wpaPageResult, wpaPage],
                    performancePlus: [advancedBrowserResult, advancedBrowser], advancedGeo: [advancedBrowserResult, advancedBrowser], visualUx: [advancedBrowserResult, advancedBrowser], journey: [advancedBrowserResult, advancedBrowser],
                    zapBaseline: [zapResult, zap]
                };
                const dataByEngine = { lighthouse: { desktop: lighthouseDesktop, mobile: lighthouseMobile }, yellowLab: yellowLabData, axe: axeData, wpaPage: wpaData, performancePlus: advancedData, advancedGeo: advancedData, visualUx: advancedData, journey: advancedData, zapBaseline: zap };
                report.moduleRuns = Object.fromEntries([...requested].map((engineId) => {
                    const [settled, engineValue] = resultByEngine[engineId] || [];
                    const errorCode = settled?.status === 'rejected' ? analyzerErrorCode(settled) : null;
                    const status = engineValue ? 'completed' : classifyErrorCode(errorCode || 'ANALYZER_UNAVAILABLE');
                    const advancedModuleId = ({ performancePlus: 'performance_plus', advancedGeo: 'advanced_geo', visualUx: 'visual_ux', journey: 'journey_test' })[engineId];
                    const findingCount = engineId === 'wpaPage' ? (wpaData?.findings?.length || 0)
                        : advancedModuleId ? (advancedData?.findings || []).filter((finding) => finding.moduleId === advancedModuleId).length
                            : engineId === 'zapBaseline' ? (zap?.findings?.length || 0)
                                : report.findings.filter((finding) => finding.engineId === engineId).length;
                    const executionKey = advancedModuleId ? 'advancedBrowser' : engineId;
                    return [engineId, {
                        contractVersion: 'wpa.analysis-capabilities.v1', status, required: true,
                        executionMode: 'automated', dependency: ENGINE_CAPABILITIES[engineId]?.dependency,
                        devices: ENGINE_CAPABILITIES[engineId]?.devices || [], kind: ENGINE_CAPABILITIES[engineId]?.kind,
                        outputSchema: ENGINE_CAPABILITIES[engineId]?.outputSchema, findingCount,
                        coverage: coverageFor(engineId, dataByEngine[engineId], engineValue),
                        ...(analyzerExecutions[executionKey] ? { execution: analyzerExecutions[executionKey] } : {}),
                        ...(engineId === 'yellowLab' && engineValue?.providerDisclosure ? { providerDisclosure: engineValue.providerDisclosure } : {}),
                        ...(errorCode ? { errorCode, remediation: remediationFor(errorCode, engineId) } : {})
                    }];
                }));
                return report;
            } finally {
                await proxy.stop().catch((error) => logger.warn('Failed to stop the safe browser proxy', { error }));
                await removeArtifacts(artifacts, artifactDir);
                const progressFlushed = await waitForOperationCleanup(progressChain, PROGRESS_FLUSH_GRACE_MS);
                if (!progressFlushed) logger.warn('Analyzer progress events exceeded their flush grace period', {
                    progressFlushGraceMs: PROGRESS_FLUSH_GRACE_MS,
                    workerPid: process.pid
                });
                if (!config.keepArtifacts && analyzerTasks.length) {
                    void Promise.allSettled(analyzerTasks).then(() => removeArtifacts([], artifactDir)).catch(() => {});
                }
            }
        }
    };
}

module.exports = { createAnalysisService };
