const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { chromeExecutable } = require('../analyzers/browser-options');
const { collect, visualFindings } = require('../analyzers/advanced-browser');
const { collectSnapshot } = require('../analyzers/wpa-page');

const runRealChrome = process.env.RUN_REAL_CHROME === '1';

test('real Chrome desktop/mobile fixtures produce viewport and coordinate evidence', { skip: !runRealChrome && 'RUN_REAL_CHROME is not enabled' }, async () => {
    const executablePath = chromeExecutable({});
    assert.ok(executablePath, 'Chrome executable must be discoverable');
    const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-background-networking', '--no-first-run'] });
    try {
        for (const profile of [{ device: 'desktop', width: 1440, height: 1000, scale: 1 }, { device: 'mobile', width: 390, height: 844, scale: 2 }]) {
            const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.scale });
            const page = await context.newPage();
            await page.setContent(`<!doctype html><main><div id="fixed-a">OVERLAP A</div><div id="fixed-b">OVERLAP B</div><p id="clip">This text is intentionally clipped and cannot fit.</p></main><style>body{margin:0;background:#fff;color:#eee}#fixed-a,#fixed-b{position:fixed;left:10px;top:10px;width:180px;height:80px;background:#eee;color:#fff}#fixed-b{left:40px;top:30px}#clip{width:40px;height:12px;overflow:hidden;white-space:nowrap}</style>`);
            const snapshot = await collect(page, 'about:blank', { navigate: false });
            const findings = visualFindings(snapshot, 'https://fixture.invalid/', profile.device);
            const overlap = findings.find((finding) => finding.ruleId === `visual.overlap.${profile.device}`);
            const contrast = findings.find((finding) => finding.ruleId === `visual.contrast.${profile.device}`);
            assert.deepEqual(overlap.evidence[0].value, { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale });
            assert.ok(overlap.evidence[1].value[0].first.rect.width > 0);
            assert.ok(contrast.evidence[1].value[0].rect.width > 0);
            await context.close();
        }
    } finally { await browser.close(); }
});

test('real Chrome WPA snapshot captures rendered anchors without following them', { skip: !runRealChrome && 'RUN_REAL_CHROME is not enabled' }, async () => {
    const executablePath = chromeExecutable({});
    assert.ok(executablePath, 'Chrome executable must be discoverable');
    const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-background-networking', '--no-first-run'] });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const html = '<!doctype html><title>Rendered fixture</title><body><a href="https://example.com/static">Static</a><script>const a=document.createElement("a");a.href="https://example.com/spa?utm_source=fixture";a.textContent="SPA";document.body.append(a)</script></body>';
        const snapshot = await collectSnapshot(page, `data:text/html,${encodeURIComponent(html)}`, 'desktop');
        assert.deepEqual(snapshot.renderedLinks, ['https://example.com/static', 'https://example.com/spa']);
        assert.equal(snapshot.renderedLinkCount, 2);
        await context.close();
    } finally { await browser.close(); }
});
