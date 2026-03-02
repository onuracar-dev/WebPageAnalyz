const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const AxeBuilder = require('axe-puppeteer');

async function runAxe(url) {
    const chromePath = require('chrome-launcher').Launcher.getInstallations()[0];

    // Fallback to puppeteer's default if chrome-launcher doesn't find it
    const launchOptions = { headless: 'new' };
    if (chromePath) {
        launchOptions.executablePath = chromePath;
    }

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle2' });

        let BuilderClass = AxeBuilder;
        if (typeof AxeBuilder !== 'function') {
            BuilderClass = AxeBuilder.default || AxeBuilder.AxePuppeteer || AxeBuilder.AxeBuilder;
        }

        const results = await new BuilderClass(page).analyze();

        const logPath = path.join(__dirname, '..', `axe_log_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
        await fs.writeFile(logPath, JSON.stringify(results, null, 2));

        return {
            logPath,
            violationsCount: results.violations.length
        };
    } catch (error) {
        console.error("Axe DevTools Failed:", error.message);
        throw error;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
}

module.exports = { runAxe };
