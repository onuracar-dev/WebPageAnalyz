const chromeLauncher = require('chrome-launcher');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('node:crypto');
const { chromeExecutable, chromeFlags } = require('./browser-options');

async function killChrome(chrome) {
    if (!chrome) return;
    try {
        await chrome.kill();
    } catch {
        // chrome-launcher can throw synchronously while cleaning its temporary
        // profile on Windows even after the Chrome process has been stopped.
    }
}

async function runLighthouse(url, { artifactDir, proxyUrl, signal, config = {} } = {}) {
    const createdPaths = [];
    try {
        const lighthouseModule = await import('lighthouse');
        const lighthouseParams = lighthouseModule.default;
        await fs.mkdir(artifactDir, { recursive: true });

        const run = async (strategy) => {
            signal?.throwIfAborted();
            let chrome;
            let killPromise;
            const stopChrome = () => {
                if (!chrome) return Promise.resolve();
                if (!killPromise) killPromise = killChrome(chrome);
                return killPromise;
            };
            const abortChrome = () => { void stopChrome(); };
            signal?.addEventListener('abort', abortChrome, { once: true });
            try {
                chrome = await chromeLauncher.launch({
                    chromePath: chromeExecutable(config) || undefined,
                    chromeFlags: chromeFlags(proxyUrl, config)
                });
                signal?.throwIfAborted();
                const result = await lighthouseParams(url, {
                    logLevel: 'error',
                    output: 'json',
                    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
                    port: chrome.port,
                    maxWaitForLoad: 45_000
                }, strategy === 'desktop' ? lighthouseModule.desktopConfig : undefined);
                signal?.throwIfAborted();
                const reportPath = path.join(artifactDir, `lighthouse_${strategy}_${crypto.randomUUID()}.json`);
                await fs.writeFile(reportPath, result.report, { mode: 0o600 });
                createdPaths.push(reportPath);
                return { result, reportPath };
            } finally {
                signal?.removeEventListener('abort', abortChrome);
                await stopChrome();
            }
        };

        const desktop = await run('desktop');
        const mobile = await run('mobile');

        return {
            desktopPath: desktop.reportPath,
            mobilePath: mobile.reportPath,
            desktopScore: (desktop.result.lhr.categories?.performance?.score || 0) * 100,
            mobileScore: (mobile.result.lhr.categories?.performance?.score || 0) * 100
        };
    } catch (err) {
        await Promise.all(createdPaths.map((file) => fs.unlink(file).catch(() => {})));
        throw err;
    }
}

module.exports = { killChrome, runLighthouse };
