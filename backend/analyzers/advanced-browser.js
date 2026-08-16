/* global document, getComputedStyle, location, window */
const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const { chromeExecutable, chromeFlags } = require('./browser-options');
const { createFinding } = require('../domain/findings');

const VERSION = '1.0.0';
const PROFILES = Object.freeze({
    desktop: { width: 1440, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
    mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
});

function impact(severity) {
    return { critical: 100, high: 75, medium: 50, low: 25, info: 5 }[severity] || 25;
}

function makeFinding(moduleId, pageUrl, input) {
    const engineId = ({ performance_plus: 'performancePlus', advanced_geo: 'advancedGeo', visual_ux: 'visualUx', journey_test: 'journey' })[moduleId];
    const value = createFinding({
        source: `WPA ${moduleId.replaceAll('_', ' ')}`,
        sourceVersion: VERSION,
        pageUrl, moduleId, engineId,
        ...input
    });
    return { ...value, moduleId, engineId, normalizedImpact: impact(value.severity) };
}

function performanceFindings(snapshot, pageUrl, device) {
    const findings = [];
    const add = (ruleId, title, description, severity, remediation, evidence, confidence = 0.94) => findings.push(makeFinding('performance_plus', pageUrl, {
            ruleId: `${ruleId}.${device}`, category: 'performance', title, description, severity, remediation, evidence, confidence, evidenceKey: device, device
    }));
    if (snapshot.lcp > 2500) add('performance.lcp', 'Largest Contentful Paint is slow', `The measured ${device} LCP was ${Math.round(snapshot.lcp)} ms.`, snapshot.lcp > 4000 ? 'high' : 'medium', 'Prioritize the LCP resource, remove render-blocking work and preload only the winning asset.', [{ type: 'metric', name: 'lcpMs', value: Math.round(snapshot.lcp) }]);
    if (snapshot.cls > 0.1) add('performance.cls', 'Layout instability exceeds the recommended budget', `The measured ${device} CLS was ${snapshot.cls.toFixed(3)}.`, snapshot.cls > 0.25 ? 'high' : 'medium', 'Reserve dimensions for media and dynamic regions; avoid inserting content above rendered content.', [{ type: 'metric', name: 'cls', value: snapshot.cls }]);
    if (snapshot.longTaskMs > 200) add('performance.long-tasks', 'Long main-thread tasks delay interaction', `${Math.round(snapshot.longTaskMs)} ms of long-task time was observed on ${device}.`, snapshot.longTaskMs > 600 ? 'high' : 'medium', 'Split long JavaScript tasks, defer non-critical code and reduce hydration work.', [{ type: 'metric', name: 'longTaskMs', value: Math.round(snapshot.longTaskMs) }, { type: 'metric', name: 'longTaskCount', value: snapshot.longTaskCount }]);
    if (snapshot.transferBytes > 2_000_000) add('performance.transfer-budget', 'Page transfer exceeds the performance budget', `${Math.round(snapshot.transferBytes / 1024)} KB was transferred on ${device}.`, snapshot.transferBytes > 5_000_000 ? 'high' : 'medium', 'Compress and resize media, remove unused assets and apply durable caching.', [{ type: 'metric', name: 'transferBytes', value: snapshot.transferBytes }]);
    if (snapshot.requestCount > 100) add('performance.request-budget', 'Request count is high', `${snapshot.requestCount} network resources loaded on ${device}.`, 'medium', 'Bundle small first-party assets selectively and remove redundant third-party requests.', [{ type: 'metric', name: 'requestCount', value: snapshot.requestCount }]);
    if (snapshot.domNodes > 1500) add('performance.dom-size', 'Rendered DOM is unusually large', `${snapshot.domNodes} elements were rendered on ${device}.`, snapshot.domNodes > 3000 ? 'high' : 'medium', 'Flatten unnecessary wrappers and virtualize repeated off-screen collections.', [{ type: 'metric', name: 'domNodes', value: snapshot.domNodes }]);
    return findings;
}

function geoFindings(snapshot, pageUrl) {
    const findings = [];
    const add = (ruleId, title, description, severity, remediation, evidence, confidence) => findings.push(makeFinding('advanced_geo', pageUrl, {
        ruleId, category: 'geo', title, description, severity, remediation, evidence, confidence, kind: 'heuristic'
    }));
    if (!snapshot.validJsonLd) add('geo.jsonld.invalid-or-missing', 'Machine-readable entity data is missing or invalid', 'No parseable JSON-LD graph with a typed entity was found.', 'medium', 'Publish valid Schema.org JSON-LD that identifies the page, publisher and primary entity.', [{ type: 'list', name: 'schemaTypes', value: snapshot.schemaTypes }], 0.85);
    if (!snapshot.entitySignals) add('geo.entity.identity', 'Primary entity identity is weak', 'The page has no clear Organization, Person, Product or Article identity signal.', 'medium', 'Connect the primary entity to a stable name, description, URL and sameAs references.', [], 0.74);
    if (snapshot.citations === 0 && snapshot.wordCount > 400) add('geo.sources.missing', 'Long-form claims lack visible source links', 'A substantial page contains no citation-like external references.', 'low', 'Link important factual claims to primary sources and label references clearly.', [{ type: 'metric', name: 'wordCount', value: snapshot.wordCount }], 0.66);
    if (!snapshot.dateSignals && snapshot.articleLike) add('geo.freshness.missing', 'Article freshness is not machine-readable', 'Article-like content exposes no publication or modification date.', 'low', 'Add visible dates and matching datePublished/dateModified structured data.', [], 0.72);
    if (snapshot.directAnswers === 0 && snapshot.questionHeadings > 0) add('geo.answers.indirect', 'Questions are not followed by concise answers', 'Question headings were found, but no short answer-first blocks followed them.', 'low', 'Place a direct, self-contained answer immediately after each important question.', [{ type: 'metric', name: 'questionHeadings', value: snapshot.questionHeadings }], 0.62);
    if (snapshot.aiBotsBlocked.length) add('geo.ai-bot-access', 'Declared AI crawlers are blocked', `robots.txt blocks: ${snapshot.aiBotsBlocked.join(', ')}.`, 'info', 'Review whether these crawler blocks match your content distribution policy.', [{ type: 'list', name: 'blockedBots', value: snapshot.aiBotsBlocked }], 0.95);
    if (!snapshot.llmsTxt) add('geo.llms-txt.missing', 'No llms.txt discovery file was found', 'The optional llms.txt endpoint did not return usable text.', 'info', 'If AI-oriented discovery is part of your strategy, publish a concise llms.txt index; this is optional and not a ranking guarantee.', [], 0.55);
    return findings;
}

function visualFindings(snapshot, pageUrl, device) {
    const findings = [];
    const add = (ruleId, title, description, severity, remediation, evidence, confidence = 0.88) => findings.push(makeFinding('visual_ux', pageUrl, {
        ruleId: `${ruleId}.${device}`, category: 'design', title, description, severity, remediation, evidence, confidence, evidenceKey: device, device, kind: 'heuristic'
    }));
    const viewport = { type: 'viewport', name: device, value: snapshot.viewport };
    if (snapshot.overlaps > 0) add('visual.overlap', 'Visible interface elements overlap', `${snapshot.overlaps} likely content collisions were detected on ${device}.`, 'high', 'Inspect the recorded element pairs at this viewport and correct stacking, fixed positioning or responsive sizing.', [viewport, { type: 'element-pairs', name: 'overlaps', value: snapshot.overlapPairs }]);
    if (snapshot.clippedText > 0) add('visual.text-clipping', 'Text appears clipped', `${snapshot.clippedText} visible text elements have clipped overflow on ${device}.`, 'medium', 'Allow content-driven height or provide an intentional accessible truncation treatment.', [viewport, { type: 'elements', name: 'clipped', value: snapshot.clippedElements }]);
    if (snapshot.lowContrast > 0) add('visual.contrast', 'Text contrast is likely insufficient', `${snapshot.lowContrast} sampled text elements fall below WCAG-oriented contrast thresholds.`, 'high', 'Increase foreground/background contrast and verify all interactive states.', [viewport, { type: 'elements', name: 'lowContrast', value: snapshot.lowContrastElements }], 0.82);
    if (snapshot.spacingOutliers > 8) add('visual.spacing-system', 'Spacing rhythm is inconsistent', `${snapshot.spacingOutliers} sampled gaps do not align with the dominant spacing rhythm.`, 'low', 'Consolidate layout gaps into a small spacing-token scale.', [{ type: 'metric', name: 'outliers', value: snapshot.spacingOutliers }], 0.67);
    if (snapshot.formsWithoutFeedback > 0) add('visual.form-feedback', 'Forms lack visible validation or status hooks', `${snapshot.formsWithoutFeedback} forms expose no live status or error container.`, 'medium', 'Add accessible inline validation and a live submission status region.', [{ type: 'metric', name: 'forms', value: snapshot.formsWithoutFeedback }], 0.72);
    if (snapshot.primaryCtas === 0) add('visual.cta.missing', 'No clear primary action was detected', 'The page has no prominent button or action-styled link.', 'low', 'Use one visually dominant, accurately labelled primary action where the page requires conversion.', [], 0.61);
    return findings;
}

async function collect(page, url, { navigate = true } = {}) {
    await page.addInitScript(() => {
        globalThis.__wpaPerf = { cls: 0, lcp: 0, longTasks: [] };
        try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) globalThis.__wpaPerf.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* metric unsupported */ }
        try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) globalThis.__wpaPerf.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* metric unsupported */ }
        try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) globalThis.__wpaPerf.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true }); } catch { /* metric unsupported */ }
    });
    if (navigate) await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForTimeout(350);
    return page.evaluate(() => {
        const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0; };
        const rect = (el) => { const value = el.getBoundingClientRect(); return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) }; };
        const selector = (el) => { const tag = el.tagName.toLowerCase(); const id = String(el.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80); if (id) return `${tag}#${id}`; const role = el.getAttribute('role'); const parent = el.parentElement; const index = parent ? [...parent.children].filter((item) => item.tagName === el.tagName).indexOf(el) + 1 : 1; return `${tag}${role ? `[role="${String(role).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}"]` : ''}:nth-of-type(${Math.max(1, index)})`; };
        const elementEvidence = (el) => ({ selector: selector(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, rect: rect(el) });
        const sampled = [...document.querySelectorAll('body *')].filter(visible).slice(0, 900);
        const textEls = sampled.filter((el) => (el.textContent || '').trim() && el.children.length === 0);
        const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = (value) => { const c = rgb(value).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * (c[0] || 0) + .7152 * (c[1] || 0) + .0722 * (c[2] || 0); };
        const lowContrastElements = [];
        let lowContrast = 0;
        for (const el of textEls.slice(0, 300)) { const s = getComputedStyle(el); const fg = lum(s.color); let bg = s.backgroundColor; let parent = el; while (rgb(bg).length < 3 && parent.parentElement) { parent = parent.parentElement; bg = getComputedStyle(parent).backgroundColor; } const bl = lum(bg); const ratio = (Math.max(fg, bl) + .05) / (Math.min(fg, bl) + .05); const threshold = Number.parseFloat(s.fontSize) >= 24 ? 3 : 4.5; if (ratio < threshold) { lowContrast++; if (lowContrastElements.length < 12) lowContrastElements.push({ ...elementEvidence(el), ratio: Number(ratio.toFixed(2)), threshold, fontSizePx: Number.parseFloat(s.fontSize) }); } }
        const positioned = sampled.filter((el) => ['fixed', 'sticky', 'absolute'].includes(getComputedStyle(el).position)).slice(0, 80);
        const overlapPairs = [];
        for (let i = 0; i < positioned.length; i++) for (let j = i + 1; j < positioned.length; j++) { const a = positioned[i].getBoundingClientRect(); const b = positioned[j].getBoundingClientRect(); const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); const area = width * height; if (area > 400 && !positioned[i].contains(positioned[j]) && !positioned[j].contains(positioned[i])) overlapPairs.push({ first: elementEvidence(positioned[i]), second: elementEvidence(positioned[j]), intersection: { width: Math.round(width), height: Math.round(height), area: Math.round(area) } }); if (overlapPairs.length >= 12) break; }
        const schemaTypes = []; let validJsonLd = false;
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) { try { const raw = JSON.parse(script.textContent || 'null'); const roots = Array.isArray(raw) ? raw : [raw, ...(Array.isArray(raw?.['@graph']) ? raw['@graph'] : [])]; for (const node of roots) { const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']]; for (const type of types.filter(Boolean)) schemaTypes.push(type); } if (schemaTypes.length) validJsonLd = true; } catch { /* invalid JSON-LD is a finding */ } }
        const questions = [...document.querySelectorAll('h1,h2,h3')].filter((el) => /\?$/.test((el.textContent || '').trim()));
        const perf = globalThis.__wpaPerf || { cls: 0, lcp: 0, longTasks: [] };
        const resources = performance.getEntriesByType('resource');
        const gaps = sampled.slice(0, 300).flatMap((el) => { const s = getComputedStyle(el); return [s.gap, s.marginTop, s.marginBottom, s.paddingTop, s.paddingBottom].map(Number.parseFloat).filter((n) => n > 0); });
        const clipped = textEls.filter((el) => { const s = getComputedStyle(el); return ['hidden', 'clip'].includes(s.overflow) && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2); });
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio }, sampledElements: sampled.length,
            lcp: perf.lcp || performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime || 0,
            cls: perf.cls || 0, longTaskMs: perf.longTasks.reduce((a, b) => a + b, 0), longTaskCount: perf.longTasks.length,
            transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0), requestCount: resources.length, domNodes: document.getElementsByTagName('*').length,
            schemaTypes: [...new Set(schemaTypes)].slice(0, 40), validJsonLd,
            entitySignals: schemaTypes.some((type) => ['Organization', 'Person', 'Product', 'Article', 'NewsArticle', 'WebSite'].includes(type)) || Boolean(document.querySelector('[itemtype*="schema.org"]')),
            citations: [...document.querySelectorAll('a[href^="http"]')].filter((a) => { try { return new URL(a.href).origin !== location.origin && /source|reference|citation|kaynak|doi/i.test(`${a.textContent} ${a.rel}`); } catch { return false; } }).length,
            wordCount: (document.body?.innerText || '').trim().split(/\s+/).filter(Boolean).length,
            dateSignals: Boolean(document.querySelector('time[datetime],meta[property="article:published_time"],meta[property="article:modified_time"]')) || schemaTypes.some((type) => /Article/.test(type)),
            articleLike: Boolean(document.querySelector('article')) || schemaTypes.some((type) => /Article/.test(type)),
            questionHeadings: questions.length,
            directAnswers: questions.filter((q) => (q.nextElementSibling?.textContent || '').trim().split(/\s+/).length >= 5 && (q.nextElementSibling?.textContent || '').trim().split(/\s+/).length <= 80).length,
            overlaps: overlapPairs.length, overlapPairs,
            clippedText: clipped.length, clippedElements: clipped.slice(0, 12).map((el) => ({ ...elementEvidence(el), scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight })),
            lowContrast, lowContrastElements,
            spacingOutliers: gaps.filter((n) => Math.abs(n / 4 - Math.round(n / 4)) > .12).length,
            formsWithoutFeedback: [...document.forms].filter((form) => !form.querySelector('[role="alert"],[aria-live],.error,[class*="error"],[class*="status"]')).length,
            primaryCtas: [...document.querySelectorAll('button,a')].filter((el) => visible(el) && (/primary|cta/i.test(el.className) || getComputedStyle(el).fontWeight >= 600)).length
        };
    });
}

function robotsBlocked(text) {
    const bots = ['GPTBot', 'Google-Extended', 'ClaudeBot'];
    return bots.filter((bot) => new RegExp(`user-agent:\\s*${bot}[\\s\\S]{0,500}?disallow:\\s*/(?:\\s|$)`, 'i').test(text));
}

async function fetchTextWithPage(context, url) {
    const page = await context.newPage();
    try { const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }); return response?.ok() ? (await page.locator('body').innerText()).slice(0, 100_000) : ''; }
    catch { return ''; }
    finally { await page.close().catch(() => {}); }
}

async function runJourney(context, baseUrl, journey) {
    if (!journey?.steps?.length) return null;
    const page = await context.newPage();
    const origin = new URL(baseUrl).origin;
    const steps = [];
    const blockedRequests = [];
    const started = Date.now();
    await page.route('**/*', async (route) => {
        const request = route.request();
        let allowed = request.method() === 'GET' || request.method() === 'HEAD' || request.method() === 'OPTIONS';
        try { allowed = allowed && new URL(request.url()).origin === origin; } catch { allowed = false; }
        if (allowed) await route.continue(); else { if (blockedRequests.length < 20) blockedRequests.push({ method: request.method(), url: (() => { try { const parsed = new URL(request.url()); return `${parsed.origin}${parsed.pathname}`; } catch { return ''; } })() }); await route.abort('blockedbyclient'); }
    });
    try {
        await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 45_000 });
        for (const [index, step] of journey.steps.entries()) {
            const before = Date.now();
            if (step.action === 'goto') { const next = new URL(step.path, origin); if (next.origin !== origin) throw new Error('Cross-origin journey navigation blocked.'); await page.goto(next.href, { waitUntil: 'networkidle', timeout: step.timeoutMs || 15_000 }); }
            else if (step.action === 'click') { const target = page.locator(step.selector).first(); const safe = await target.evaluate((el) => el.tagName === 'A' ? new URL(el.href).origin === location.origin : el.tagName === 'BUTTON' && (el.type || 'submit') === 'button'); if (!safe) throw new Error('Only same-origin links and non-submit buttons are allowed.'); await target.click({ timeout: step.timeoutMs || 10_000 }); }
            else if (step.action === 'expectVisible') await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: step.timeoutMs || 10_000 });
            else if (step.action === 'expectText') { const value = await page.locator(step.selector).first().innerText({ timeout: step.timeoutMs || 10_000 }); if (!value.includes(step.value)) throw new Error(`Expected text was not found at step ${index + 1}.`); }
            else if (step.action === 'waitFor') await page.waitForTimeout(Math.min(step.timeoutMs || 250, 2_000));
            steps.push({ index, action: step.action, status: 'passed', target: step.selector || step.path || null, location: (() => { try { return typeof page.url === 'function' ? new URL(page.url()).pathname : ''; } catch { return ''; } })(), durationMs: Date.now() - before });
        }
        return { status: 'passed', name: journey.name, durationMs: Date.now() - started, steps, coverage: { declaredSteps: journey.steps.length, executedSteps: steps.length, blockedRequests } };
    } catch (error) {
        const failedIndex = steps.length;
        const failedStep = journey.steps[failedIndex] || null;
        if (failedStep) steps.push({ index: failedIndex, action: failedStep.action, status: 'failed', target: failedStep.selector || failedStep.path || null, errorCode: error.code || 'JOURNEY_STEP_FAILED' });
        return { status: 'failed', name: journey.name, durationMs: Date.now() - started, steps, failureLocation: { index: failedIndex, action: failedStep?.action || null, target: failedStep?.selector || failedStep?.path || null }, coverage: { declaredSteps: journey.steps.length, executedSteps: steps.filter((step) => step.status === 'passed').length, blockedRequests }, error: String(error.message || error).slice(0, 500) };
    } finally { await page.close().catch(() => {}); }
}

async function runAdvancedBrowser(url, { artifactDir, proxyUrl, signal, config = {}, modules = [], journey } = {}) {
    let browser; const paths = [];
    const enabled = new Set(modules);
    const abort = () => browser?.close().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    try {
        await fs.mkdir(artifactDir, { recursive: true });
        browser = await chromium.launch({ headless: true, ...(chromeExecutable(config) ? { executablePath: chromeExecutable(config) } : {}), args: chromeFlags(proxyUrl, config) });
        const findings = []; const devices = {};
        for (const [device, profile] of Object.entries(PROFILES)) {
            const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, isMobile: profile.isMobile, hasTouch: profile.hasTouch, deviceScaleFactor: profile.deviceScaleFactor });
            const page = await context.newPage();
            try {
                const snapshot = await collect(page, url);
                const screenshot = path.join(artifactDir, `advanced_${device}_${crypto.randomUUID()}.png`);
                await page.screenshot({ path: screenshot, fullPage: true }); paths.push(screenshot);
                if (enabled.has('performance_plus')) findings.push(...performanceFindings(snapshot, url, device));
                if (enabled.has('visual_ux')) findings.push(...visualFindings(snapshot, url, device));
                if (enabled.has('advanced_geo') && device === 'desktop') {
                    const origin = new URL(url).origin;
                    const [robots, llms] = await Promise.all([fetchTextWithPage(context, `${origin}/robots.txt`), fetchTextWithPage(context, `${origin}/llms.txt`)]);
                    findings.push(...geoFindings({ ...snapshot, aiBotsBlocked: robotsBlocked(robots), llmsTxt: Boolean(llms.trim()) }, url));
                }
                devices[device] = snapshot;
            } finally { await context.close().catch(() => {}); }
        }
        let journeyResult = null;
        if (enabled.has('journey_test') && journey) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            try { journeyResult = await runJourney(context, url, journey); }
            finally { await context.close().catch(() => {}); }
            if (journeyResult?.status === 'failed') findings.push(makeFinding('journey_test', url, { ruleId: 'journey.failed', category: 'runtime', title: `Journey failed: ${journey.name}`, description: journeyResult.error, severity: 'high', confidence: 1, remediation: 'Reproduce the failed read-only step and repair the affected navigation or UI contract.', evidence: [{ type: 'journey', name: journey.name, value: { steps: journeyResult.steps, failureLocation: journeyResult.failureLocation, coverage: journeyResult.coverage } }] }));
        }
        const logPath = path.join(artifactDir, `advanced_browser_${crypto.randomUUID()}.json`);
        await fs.writeFile(logPath, JSON.stringify({ version: VERSION, url, modules: [...enabled], devices, journey: journeyResult, findings }), { mode: 0o600 }); paths.push(logPath);
        return { logPath, artifactPaths: paths, modules: [...enabled], journey: journeyResult };
    } catch (error) { await Promise.all(paths.map((file) => fs.unlink(file).catch(() => {}))); throw error; }
    finally { signal?.removeEventListener('abort', abort); if (browser) await browser.close().catch(() => {}); }
}

module.exports = { VERSION, performanceFindings, geoFindings, visualFindings, collect, runJourney, runAdvancedBrowser };
