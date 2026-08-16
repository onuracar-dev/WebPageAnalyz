/* global document, location, getComputedStyle, CSS */
const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const { chromeExecutable, chromeFlags } = require('./browser-options');
const { createFinding } = require('../domain/findings');
const { normalizePageUrl } = require('../domain/url-normalization');

const VERSION = '1.1.0';
const DEVICE_PROFILES = Object.freeze({
    desktop: { width: 1440, height: 1000, deviceScaleFactor: 1, isMobile: false },
    mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
});
const MAX_RUNTIME_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_TEXT = 500;
const MAX_DIAGNOSTIC_STACK = 2_000;
const MAX_RENDERED_LINKS = 500;
const MAX_RENDERED_LINK_REFERENCES = 1_000;
const RENDERED_LINK_SENSITIVE_PARAMETER = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|signature|auth(?:orization)?|credential|session|code)/i;

function safeUrl(value) {
    try {
        const parsed = new URL(value);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().slice(0, 2_048);
    } catch {
        return '';
    }
}

function normalizeRenderedLinks(values, baseUrl, limit = MAX_RENDERED_LINKS) {
    const bounded = Math.max(0, Math.min(MAX_RENDERED_LINK_REFERENCES, Number.isInteger(limit) ? limit : MAX_RENDERED_LINKS));
    if (bounded === 0) return [];
    const links = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values.slice(0, MAX_RENDERED_LINK_REFERENCES) : []) {
        let normalized;
        try {
            const parsed = new URL(value, baseUrl);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.toString().length > 2_048) continue;
            if ([...parsed.searchParams.keys()].some((name) => RENDERED_LINK_SENSITIVE_PARAMETER.test(name))) continue;
            normalized = normalizePageUrl(parsed.toString());
        } catch { continue; }
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        links.push(normalized);
        if (links.length >= bounded) break;
    }
    return links;
}

function sanitizeDiagnosticText(value, limit = MAX_DIAGNOSTIC_TEXT) {
    return String(value || '')
        .replace(/https?:\/\/[^\s'"<>]+/gi, (url) => safeUrl(url) || '[REDACTED_URL]')
        .replace(/\b(authorization|cookie|set-cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .slice(0, limit);
}

function normalizeConsoleEntry(message) {
    const location = typeof message?.location === 'function' ? message.location() : null;
    return {
        type: String(typeof message?.type === 'function' ? message.type() : 'error').slice(0, 40),
        text: sanitizeDiagnosticText(typeof message?.text === 'function' ? message.text() : ''),
        location: {
            url: safeUrl(location?.url),
            lineNumber: Number.isInteger(location?.lineNumber) && location.lineNumber >= 0 ? location.lineNumber : null,
            columnNumber: Number.isInteger(location?.columnNumber) && location.columnNumber >= 0 ? location.columnNumber : null
        }
    };
}

function normalizePageError(error) {
    return {
        message: sanitizeDiagnosticText(error?.message || error),
        stack: sanitizeDiagnosticText(error?.stack || '', MAX_DIAGNOSTIC_STACK) || null
    };
}

function sanitizeConsoleEntries(entries) {
    return (Array.isArray(entries) ? entries : []).slice(0, MAX_RUNTIME_DIAGNOSTICS).map((entry) => ({
        type: String(entry?.type || 'error').slice(0, 40),
        text: sanitizeDiagnosticText(entry?.text),
        location: {
            url: safeUrl(entry?.location?.url),
            lineNumber: Number.isInteger(entry?.location?.lineNumber) && entry.location.lineNumber >= 0 ? entry.location.lineNumber : null,
            columnNumber: Number.isInteger(entry?.location?.columnNumber) && entry.location.columnNumber >= 0 ? entry.location.columnNumber : null
        }
    }));
}

function sanitizePageErrorEntries(entries) {
    return (Array.isArray(entries) ? entries : []).slice(0, MAX_RUNTIME_DIAGNOSTICS).map((entry) => ({
        message: sanitizeDiagnosticText(entry?.message),
        stack: sanitizeDiagnosticText(entry?.stack || '', MAX_DIAGNOSTIC_STACK) || null
    }));
}

function severityImpact(severity) {
    return { critical: 100, high: 75, medium: 50, low: 25, info: 5 }[severity] || 25;
}

function finding(input) {
    const result = createFinding({ source: 'WPA', sourceVersion: VERSION, ...input });
    return { ...result, normalizedImpact: severityImpact(result.severity) };
}

function analyzeSnapshot(snapshot, pageUrl, device) {
    const results = [];
    const add = (ruleId, category, title, description, severity, remediation, evidence = [], kind = 'measured', confidence = 0.9) => {
        results.push(finding({
            ruleId: `${ruleId}.${device}`,
            category,
            title,
            description,
            severity,
            remediation,
            evidence,
            kind,
            confidence,
            pageUrl,
            evidenceKey: device
        }));
    };

    if (!snapshot.title) add('seo.title.missing', 'seo', 'Page title is missing', 'The document has no non-empty title element.', 'high', 'Add a unique, descriptive title for this page.');
    if (!snapshot.description) add('seo.description.missing', 'seo', 'Meta description is missing', 'Search and answer engines have no explicit summary for this page.', 'medium', 'Add a concise page-specific meta description.');
    if (!snapshot.canonical) add('seo.canonical.missing', 'seo', 'Canonical URL is not declared', 'The page does not identify its preferred public URL.', 'medium', 'Add an absolute rel="canonical" link that points to the preferred URL.');
    if (snapshot.h1Count !== 1) add('seo.h1.count', 'seo', 'Heading-one structure needs attention', `The page exposes ${snapshot.h1Count} H1 elements.`, snapshot.h1Count === 0 ? 'high' : 'medium', 'Use one descriptive H1 for the primary page topic.', [{ type: 'metric', name: 'h1Count', value: snapshot.h1Count }]);
    if (!snapshot.lang) add('seo.language.missing', 'seo', 'Document language is missing', 'The html element has no lang attribute.', 'medium', 'Declare the primary content language on the html element.');
    if (!snapshot.structuredDataTypes.length) add('geo.structured-data.missing', 'geo', 'No structured entity data was found', 'No valid JSON-LD @type was detected, reducing machine-readable context.', 'medium', 'Add accurate Schema.org JSON-LD for the organization, page and primary content.', [], 'heuristic', 0.75);
    if (!snapshot.authorSignals) add('geo.author.missing', 'geo', 'Authorship signals are weak', 'No author metadata or visible author relationship was detected.', 'low', 'Identify the responsible author or organization and link to a credible profile.', [], 'heuristic', 0.7);
    if (snapshot.questionHeadings === 0 && snapshot.wordCount > 250) add('geo.answer-structure.weak', 'geo', 'Answer-oriented structure is limited', 'A longer page contains no question-led headings that clearly frame user intent.', 'low', 'Where appropriate, add descriptive question headings followed by direct, evidence-backed answers.', [], 'heuristic', 0.62);

    if (snapshot.horizontalOverflow > 2) add('design.horizontal-overflow', 'design', `Horizontal overflow on ${device}`, `The rendered page is ${snapshot.horizontalOverflow}px wider than the viewport.`, 'high', 'Find the overflowing element and constrain its width, transforms or unbroken content.', [{ type: 'metric', name: 'overflowPx', value: snapshot.horizontalOverflow }]);
    if (snapshot.smallTextCount > 0) add('design.small-text', 'design', `Small text detected on ${device}`, `${snapshot.smallTextCount} visible text elements render below 12px.`, device === 'mobile' ? 'medium' : 'low', 'Increase body and control text sizes while preserving a clear type scale.', [{ type: 'metric', name: 'elements', value: snapshot.smallTextCount }]);
    if (snapshot.fontFamilies.length > 4) add('design.font-fragmentation', 'design', 'Font system is fragmented', `${snapshot.fontFamilies.length} distinct computed font families were detected.`, 'low', 'Consolidate typography into a small documented set of font tokens.', [{ type: 'list', name: 'fontFamilies', value: snapshot.fontFamilies.slice(0, 10) }]);
    if (snapshot.colors.length > 40) add('design.color-fragmentation', 'design', 'Color palette is difficult to govern', `${snapshot.colors.length} distinct rendered text/background colors were detected.`, 'low', 'Map recurring colors to semantic design tokens and remove accidental variants.', [{ type: 'metric', name: 'distinctColors', value: snapshot.colors.length }], 'heuristic', 0.7);
    if (snapshot.smallTouchTargets > 0 && device === 'mobile') add('design.touch-targets', 'design', 'Small mobile touch targets detected', `${snapshot.smallTouchTargets} interactive elements are smaller than 44px in both dimensions.`, 'medium', 'Increase the clickable area and spacing of mobile controls.', [{ type: 'metric', name: 'elements', value: snapshot.smallTouchTargets }]);
    if (snapshot.unlabeledControls > 0) add('design.controls.unlabeled', 'accessibility', 'Interactive controls lack accessible names', `${snapshot.unlabeledControls} visible controls have no discernible label.`, 'high', 'Add programmatic labels or accessible names that describe each control.');

    if (snapshot.consoleErrors > 0 || snapshot.pageErrors > 0) {
        const count = Number(snapshot.consoleErrors || 0) + Number(snapshot.pageErrors || 0);
        add('runtime.console-errors', 'runtime', 'Browser console errors occurred', `${count} browser runtime error${count === 1 ? '' : 's'} were observed during page load.`, 'high', 'Reproduce the errors in development, fix the earliest root cause and retest.', [
            { type: 'metric', name: 'consoleErrors', value: snapshot.consoleErrors },
            { type: 'metric', name: 'pageErrors', value: snapshot.pageErrors || 0 },
            ...(snapshot.consoleErrorEntries?.length ? [{ type: 'runtime', name: 'consoleErrors', value: sanitizeConsoleEntries(snapshot.consoleErrorEntries) }] : []),
            ...(snapshot.pageErrorEntries?.length ? [{ type: 'runtime', name: 'pageErrors', value: sanitizePageErrorEntries(snapshot.pageErrorEntries) }] : [])
        ]);
    }
    if (snapshot.failedRequests > 0) add('runtime.failed-requests', 'runtime', 'Network requests failed', `${snapshot.failedRequests} resources failed to load.`, 'high', 'Inspect failed request URLs and status causes; remove or repair broken dependencies.', [{ type: 'list', name: 'requests', value: snapshot.failedRequestUrls.slice(0, 10) }]);
    if (snapshot.badResponses > 0) add('runtime.bad-responses', 'runtime', 'Resources returned error responses', `${snapshot.badResponses} page resources returned HTTP 4xx or 5xx responses.`, 'high', 'Repair the referenced resources or stop requesting them.', [{ type: 'list', name: 'responses', value: snapshot.badResponseUrls.slice(0, 10) }]);
    if (snapshot.thirdPartyBytes > 500_000) add('runtime.third-party-weight', 'performance', 'Third-party transfer weight is high', `Observed third-party transfer size is approximately ${Math.round(snapshot.thirdPartyBytes / 1024)} KB.`, 'medium', 'Remove unnecessary vendors, defer non-critical scripts and load integrations after consent or interaction.', [{ type: 'metric', name: 'bytes', value: snapshot.thirdPartyBytes }]);

    const headers = snapshot.headers;
    if (!headers['content-security-policy']) add('backend.csp.missing', 'security', 'Content Security Policy is missing', 'The main document response does not include a Content-Security-Policy header.', 'high', 'Deploy a restrictive CSP in report-only mode first, then enforce it after reviewing violations.');
    if (pageUrl.startsWith('https:') && !headers['strict-transport-security']) add('backend.hsts.missing', 'security', 'HSTS is missing', 'The HTTPS response does not instruct browsers to require future secure connections.', 'medium', 'Add Strict-Transport-Security after confirming every required subdomain supports HTTPS.');
    if (!headers['x-content-type-options']) add('backend.nosniff.missing', 'security', 'MIME sniffing protection is missing', 'X-Content-Type-Options was not present.', 'low', 'Return X-Content-Type-Options: nosniff.');
    if (!headers['referrer-policy']) add('backend.referrer-policy.missing', 'security', 'Referrer policy is not explicit', 'The page does not define how referrer data is shared.', 'low', 'Set an explicit Referrer-Policy suitable for the application.');
    if (!headers['content-encoding'] && Number(headers['content-length'] || 0) > 20_000) add('backend.compression.missing', 'backend', 'Large document may be uncompressed', 'The response is larger than 20 KB and exposes no Content-Encoding header.', 'medium', 'Enable Brotli or gzip for compressible text responses.');
    if (!headers['cache-control']) add('backend.cache.missing', 'backend', 'Cache policy is missing', 'The main document does not expose an explicit Cache-Control policy.', 'low', 'Define cache behavior explicitly and use long immutable caching for versioned assets.');
    if (headers.server || headers['x-powered-by']) add('backend.fingerprint.disclosure', 'security', 'Server technology is disclosed', 'Response headers reveal implementation details that are not required by clients.', 'low', 'Remove unnecessary Server and X-Powered-By disclosures.', [{ type: 'list', name: 'headers', value: ['server', 'x-powered-by'].filter((name) => headers[name]) }]);

    return results;
}

async function collectSnapshot(page, targetUrl, device) {
    const consoleErrors = [];
    const pageErrors = [];
    let consoleErrorCount = 0;
    let pageErrorCount = 0;
    const failedRequests = [];
    const badResponses = [];
    const onConsole = (message) => {
        if (message.type() !== 'error') return;
        consoleErrorCount += 1;
        if (consoleErrors.length < MAX_RUNTIME_DIAGNOSTICS) consoleErrors.push(normalizeConsoleEntry(message));
    };
    const onPageError = (error) => {
        pageErrorCount += 1;
        if (pageErrors.length < MAX_RUNTIME_DIAGNOSTICS) pageErrors.push(normalizePageError(error));
    };
    const onRequestFailed = (request) => failedRequests.push(safeUrl(request.url()));
    const onResponse = (response) => { if (response.status() >= 400) badResponses.push(safeUrl(response.url())); };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);
    await page.setViewportSize({ width: DEVICE_PROFILES[device].width, height: DEVICE_PROFILES[device].height });
    const mainResponse = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45_000 });
    const headers = mainResponse ? await mainResponse.headers() : {};
    const dom = await page.evaluate((renderedLinkReferenceLimit) => {
        const visible = (element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
        };
        const sampled = [...document.querySelectorAll('body *')].filter(visible).slice(0, 800);
        const textElements = sampled.filter((element) => (element.textContent || '').trim().length > 0);
        const interactive = sampled.filter((element) => element.matches('a,button,input,select,textarea,[role="button"],[tabindex]'));
        const fontFamilies = [...new Set(textElements.map((element) => getComputedStyle(element).fontFamily).filter(Boolean))];
        const colors = [...new Set(textElements.flatMap((element) => {
            const style = getComputedStyle(element);
            return [style.color, style.backgroundColor].filter((value) => value && value !== 'rgba(0, 0, 0, 0)');
        }))];
        const resources = performance.getEntriesByType('resource').map((entry) => ({
            name: entry.name,
            bytes: entry.transferSize || entry.encodedBodySize || 0
        }));
        const origin = location.origin;
        let thirdPartyBytes = 0;
        for (const resource of resources) {
            try { if (new URL(resource.name).origin !== origin) thirdPartyBytes += resource.bytes; } catch { /* ignore invalid browser entries */ }
        }
        const structuredDataTypes = [];
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const parsed = JSON.parse(script.textContent || '{}');
                const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed['@graph']) ? parsed['@graph'] : [])];
                for (const node of nodes) {
                    const type = node?.['@type'];
                    if (Array.isArray(type)) structuredDataTypes.push(...type);
                    else if (type) structuredDataTypes.push(type);
                }
            } catch { /* invalid JSON-LD is reported by dedicated structured-data rules later */ }
        }
        const words = (document.body?.innerText || '').trim().split(/\s+/).filter(Boolean);
        const anchorElements = [...document.querySelectorAll('a[href]')];
        return {
            title: document.title.trim(),
            description: document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '',
            canonical: document.querySelector('link[rel="canonical"]')?.href || '',
            lang: document.documentElement.lang || '',
            h1Count: document.querySelectorAll('h1').length,
            wordCount: words.length,
            questionHeadings: [...document.querySelectorAll('h1,h2,h3')].filter((heading) => /\?$/.test((heading.textContent || '').trim())).length,
            structuredDataTypes: [...new Set(structuredDataTypes)].slice(0, 30),
            authorSignals: Boolean(document.querySelector('[rel="author"],meta[name="author"],[itemprop="author"],.author,[class*="byline"]')),
            horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            smallTextCount: textElements.filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 12).length,
            fontFamilies: fontFamilies.slice(0, 30),
            colors: colors.slice(0, 100),
            smallTouchTargets: interactive.filter((element) => {
                const box = element.getBoundingClientRect();
                return box.width < 44 && box.height < 44;
            }).length,
            unlabeledControls: interactive.filter((element) => {
                if (!element.matches('button,input,select,textarea,[role="button"]')) return false;
                const id = element.id;
                const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
                return !((element.getAttribute('aria-label') || '').trim() || element.getAttribute('aria-labelledby') || (element.textContent || '').trim() || label?.textContent?.trim() || element.getAttribute('title'));
            }).length,
            thirdPartyBytes,
            renderedLinkCount: anchorElements.length,
            renderedLinks: anchorElements.slice(0, renderedLinkReferenceLimit).map((element) => element.href),
            renderedLinksTruncated: anchorElements.length > renderedLinkReferenceLimit
        };
    }, MAX_RENDERED_LINK_REFERENCES);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
    return {
        ...dom,
        renderedLinks: normalizeRenderedLinks(dom.renderedLinks, targetUrl, MAX_RENDERED_LINK_REFERENCES),
        renderedLinksTruncated: dom.renderedLinksTruncated === true || dom.renderedLinkCount > MAX_RENDERED_LINK_REFERENCES,
        headers,
        consoleErrors: consoleErrorCount,
        consoleErrorEntries: consoleErrors,
        pageErrors: pageErrorCount,
        pageErrorEntries: pageErrors,
        failedRequests: failedRequests.length,
        failedRequestUrls: [...new Set(failedRequests)].slice(0, 20),
        badResponses: badResponses.length,
        badResponseUrls: [...new Set(badResponses)].slice(0, 20)
    };
}

async function runWpaPage(url, { artifactDir, proxyUrl, signal, config = {}, authorizedOrigins = [] } = {}) {
    let browser;
    const createdPaths = [];
    const abortBrowser = () => browser?.close().catch(() => {});
    signal?.addEventListener('abort', abortBrowser, { once: true });
    try {
        await fs.mkdir(artifactDir, { recursive: true });
        const executablePath = chromeExecutable(config);
        browser = await chromium.launch({
            headless: true,
            ...(executablePath ? { executablePath } : {}),
            args: chromeFlags(proxyUrl, config)
        });
        const devices = {};
        const findings = [];
        const renderedLinkCandidates = [];
        let renderedLinkReferences = 0;
        let renderedLinksTruncated = false;
        for (const device of Object.keys(DEVICE_PROFILES)) {
            signal?.throwIfAborted();
            const profile = DEVICE_PROFILES[device];
            const context = await browser.newContext({
                viewport: { width: profile.width, height: profile.height },
                deviceScaleFactor: profile.deviceScaleFactor,
                isMobile: profile.isMobile,
                hasTouch: profile.hasTouch || false
            });
            const page = await context.newPage();
            try {
                page.setDefaultNavigationTimeout(45_000);
                const snapshot = await collectSnapshot(page, url, device);
                const { renderedLinks, ...storedSnapshot } = snapshot;
                renderedLinkCandidates.push(...renderedLinks);
                renderedLinkReferences += snapshot.renderedLinkCount || 0;
                renderedLinksTruncated ||= snapshot.renderedLinksTruncated === true;
                const screenshotPath = path.join(artifactDir, `wpa_${device}_${crypto.randomUUID()}.png`);
                await page.screenshot({ path: screenshotPath, fullPage: true });
                createdPaths.push(screenshotPath);
                devices[device] = { ...storedSnapshot, screenshot: path.basename(screenshotPath) };
                findings.push(...analyzeSnapshot(snapshot, safeUrl(url), device));
            } finally {
                await context.close().catch(() => {});
            }
        }
        const renderedScope = new Set([new URL(url).origin]);
        for (const value of authorizedOrigins || []) {
            try { renderedScope.add(new URL(value).origin); } catch { /* Invalid entries never widen the producer scope. */ }
        }
        const scopedRenderedLinkCandidates = renderedLinkCandidates.filter((candidate) => {
            try { return renderedScope.has(new URL(candidate).origin); } catch { return false; }
        });
        const uniqueRenderedLinkCandidates = new Set(scopedRenderedLinkCandidates);
        const renderedLinks = normalizeRenderedLinks(scopedRenderedLinkCandidates, url);
        const renderedLinkCoverage = {
            producer: 'wpa_page_playwright_snapshot',
            limit: MAX_RENDERED_LINKS,
            references: renderedLinkReferences,
            uniqueLinks: renderedLinks.length,
            truncated: renderedLinksTruncated || uniqueRenderedLinkCandidates.size > MAX_RENDERED_LINKS
        };
        const logPath = path.join(artifactDir, `wpa_page_${crypto.randomUUID()}.json`);
        await fs.writeFile(logPath, JSON.stringify({ version: VERSION, url: safeUrl(url), devices, findings, renderedLinks, renderedLinkCoverage }), { mode: 0o600 });
        createdPaths.push(logPath);
        return { logPath, artifactPaths: createdPaths };
    } catch (error) {
        await Promise.all(createdPaths.map((file) => fs.unlink(file).catch(() => {})));
        throw error;
    } finally {
        signal?.removeEventListener('abort', abortBrowser);
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { MAX_RENDERED_LINKS, VERSION, analyzeSnapshot, collectSnapshot, normalizeConsoleEntry, normalizePageError, normalizeRenderedLinks, runWpaPage, safeUrl, sanitizeConsoleEntries, sanitizeDiagnosticText, sanitizePageErrorEntries };
