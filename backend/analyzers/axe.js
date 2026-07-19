const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('node:crypto');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const { chromeExecutable, chromeFlags } = require('./browser-options');

async function runAxe(url, { artifactDir, proxyUrl, signal, config = {} } = {}) {
    let browser;
    const abortBrowser = () => browser?.close().catch(() => {});
    signal?.addEventListener('abort', abortBrowser, { once: true });
    try {
        await fs.mkdir(artifactDir, { recursive: true });
        browser = await puppeteer.launch({
            headless: true,
            executablePath: chromeExecutable(config) || undefined,
            args: chromeFlags(proxyUrl, config)
        });
        signal?.throwIfAborted();
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(45_000);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
        signal?.throwIfAborted();
        const results = await new AxePuppeteer(page).analyze();

        const logPath = path.join(artifactDir, `axe_${crypto.randomUUID()}.json`);
        await fs.writeFile(logPath, JSON.stringify(results), { mode: 0o600 });

        return {
            logPath,
            violationsCount: results.violations.length
        };
    } finally {
        signal?.removeEventListener('abort', abortBrowser);
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { runAxe };
