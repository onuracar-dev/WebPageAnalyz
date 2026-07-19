const fs = require('node:fs').promises;
const { AppError } = require('../lib/errors');
const { runWithTimeout } = require('../lib/abort');
const { SafeBrowserProxy } = require('../security/safe-proxy');
const { runLighthouse } = require('../analyzers/lighthouse');
const { runYellowLab } = require('../analyzers/yellowlab');
const { runAxe } = require('../analyzers/axe');
const { parseLogs } = require('../utils/parser');

function createAnalysisService({
    config,
    logger,
    analyzers = { lighthouse: runLighthouse, yellowLab: runYellowLab, axe: runAxe },
    parse = parseLogs,
    proxyFactory
}) {
    const createProxy = proxyFactory || (() => new SafeBrowserProxy({
        allowedPorts: config.allowedTargetPorts,
        logger,
        connectTimeoutMs: config.timeouts.proxyConnectMs,
        ...config.proxyLimits
    }));

    async function removeArtifacts(paths) {
        if (config.keepArtifacts) return;
        await Promise.all(paths.filter(Boolean).map((file) => fs.unlink(file).catch(() => {})));
    }

    return {
        async analyze(target, signal) {
            const proxy = createProxy();
            const artifacts = [];
            try {
                const proxyUrl = await proxy.start();
                signal?.throwIfAborted();
                const analyzerOptions = { artifactDir: config.artifactDir, proxyUrl, config };
                const results = await Promise.allSettled([
                    runWithTimeout(
                        (analyzerSignal) => analyzers.lighthouse(target.url, { ...analyzerOptions, signal: analyzerSignal }),
                        config.timeouts.lighthouseMs,
                        'Lighthouse analysis',
                        signal
                    ),
                    runWithTimeout(
                        (analyzerSignal) => analyzers.yellowLab(target.url, {
                            ...analyzerOptions,
                            signal: analyzerSignal,
                            maxPollAttempts: config.yellowLabMaxPollAttempts
                        }),
                        config.timeouts.yellowLabMs,
                        'YellowLab analysis',
                        signal
                    ),
                    runWithTimeout(
                        (analyzerSignal) => analyzers.axe(target.url, { ...analyzerOptions, signal: analyzerSignal }),
                        config.timeouts.axeMs,
                        'Axe analysis',
                        signal
                    )
                ]);
                signal?.throwIfAborted();

                const [lighthouseResult, yellowLabResult, axeResult] = results;
                const value = (result) => result.status === 'fulfilled' ? result.value : null;
                const lighthouse = value(lighthouseResult);
                const yellowLab = value(yellowLabResult);
                const axe = value(axeResult);
                artifacts.push(lighthouse?.desktopPath, lighthouse?.mobilePath, yellowLab?.logPath, axe?.logPath);

                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        logger.warn('Analyzer failed', {
                            analyzer: ['lighthouse', 'yellowLab', 'axe'][index],
                            hostname: target.hostname,
                            errorName: result.reason?.name,
                            errorCode: result.reason?.code
                        });
                    }
                });

                if (!lighthouse && !yellowLab && !axe) {
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
                    axe: axe?.logPath
                });
                report.meta = {
                    analyzedAt: new Date().toISOString(),
                    analyzers: {
                        lighthouse: lighthouse ? 'completed' : 'unavailable',
                        yellowLab: yellowLab ? 'completed' : 'unavailable',
                        axe: axe ? 'completed' : 'unavailable'
                    }
                };
                return report;
            } finally {
                await proxy.stop().catch((error) => logger.warn('Failed to stop the safe browser proxy', { error }));
                await removeArtifacts(artifacts);
            }
        }
    };
}

module.exports = { createAnalysisService };
