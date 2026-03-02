const chromeLauncher = require('chrome-launcher');
const lighthouse = require('lighthouse');
const fs = require('fs').promises;
const path = require('path');

async function runLighthouse(url) {
    try {
        const lighthouseParams = (await import('lighthouse')).default;

        // --- Run Desktop ---
        let chromeDesktop;
        let desktopRunnerResult, desktopReport, desktopPath;
        try {
            chromeDesktop = await chromeLauncher.launch({ chromeFlags: ['--headless'] });
            const optionsDesktop = {
                logLevel: 'info',
                output: 'json',
                onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
                port: chromeDesktop.port,
                strategy: 'desktop'
            };

            desktopRunnerResult = await lighthouseParams(url, optionsDesktop);
            desktopReport = desktopRunnerResult.report;
            desktopPath = path.join(__dirname, '..', `lighthouse_desktop_log_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
            await fs.writeFile(desktopPath, desktopReport);
        } finally {
            if (chromeDesktop) {
                try { await chromeDesktop.kill(); } catch (e) { }
            }
        }

        // --- Run Mobile ---
        let chromeMobile;
        let mobileRunnerResult, mobileReport, mobilePath;
        try {
            chromeMobile = await chromeLauncher.launch({ chromeFlags: ['--headless'] });
            const optionsMobile = {
                logLevel: 'info',
                output: 'json',
                onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
                port: chromeMobile.port,
                strategy: 'mobile'
            };

            mobileRunnerResult = await lighthouseParams(url, optionsMobile);
            mobileReport = mobileRunnerResult.report;
            mobilePath = path.join(__dirname, '..', `lighthouse_mobile_log_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
            await fs.writeFile(mobilePath, mobileReport);
        } finally {
            if (chromeMobile) {
                try { await chromeMobile.kill(); } catch (e) { }
            }
        }

        return {
            desktopPath,
            mobilePath,
            desktopScore: desktopRunnerResult.lhr.categories?.performance ? desktopRunnerResult.lhr.categories.performance.score * 100 : 0,
            mobileScore: mobileRunnerResult.lhr.categories?.performance ? mobileRunnerResult.lhr.categories.performance.score * 100 : 0
        };
    } catch (err) {
        console.error("Lighthouse Failed", err);
        throw err;
    }
}

module.exports = { runLighthouse };
