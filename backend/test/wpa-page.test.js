const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_RENDERED_LINKS, analyzeSnapshot, normalizeConsoleEntry, normalizePageError, normalizeRenderedLinks, sanitizeDiagnosticText } = require('../analyzers/wpa-page');

function snapshot(extra = {}) {
    return {
        title: '', description: '', canonical: '', lang: '', h1Count: 0, wordCount: 500,
        questionHeadings: 0, structuredDataTypes: [], authorSignals: false,
        horizontalOverflow: 30, smallTextCount: 2, fontFamilies: ['a', 'b', 'c', 'd', 'e'],
        colors: Array.from({ length: 41 }, (_, index) => `rgb(${index},0,0)`),
        smallTouchTargets: 2, unlabeledControls: 1, consoleErrors: 1, consoleErrorEntries: [], pageErrors: 0, pageErrorEntries: [], failedRequests: 1,
        failedRequestUrls: ['https://example.com/missing.js'], badResponses: 1,
        badResponseUrls: ['https://example.com/404'], thirdPartyBytes: 600_000,
        headers: {},
        ...extra
    };
}

test('WPA analyzer emits measured and explicitly heuristic findings', () => {
    const findings = analyzeSnapshot(snapshot(), 'https://example.com/', 'mobile');
    const rules = new Set(findings.map((finding) => finding.ruleId));
    assert.ok(rules.has('seo.title.missing.mobile'));
    assert.ok(rules.has('design.horizontal-overflow.mobile'));
    assert.ok(rules.has('runtime.console-errors.mobile'));
    assert.ok(rules.has('backend.csp.missing.mobile'));
    const geo = findings.find((finding) => finding.ruleId === 'geo.answer-structure.weak.mobile');
    assert.equal(geo.kind, 'heuristic');
    assert.ok(geo.confidence < 0.8);
});

test('WPA runtime finding retains bounded, redacted console and page-error evidence', () => {
    const findings = analyzeSnapshot(snapshot({
        consoleErrors: 1,
        pageErrors: 1,
        consoleErrorEntries: [{
            type: 'error',
            text: 'Fetch failed https://example.com/app.js?token=top-secret',
            location: { url: 'https://example.com/app.js?token=top-secret#source', lineNumber: 12, columnNumber: 8 }
        }],
        pageErrorEntries: [{ message: 'Unhandled password=secret', stack: 'Error: password=secret' }]
    }), 'https://example.com/', 'desktop');
    const runtime = findings.find((finding) => finding.ruleId === 'runtime.console-errors.desktop');
    assert.equal(runtime.description, '2 browser runtime errors were observed during page load.');
    assert.deepEqual(runtime.evidence[2].value, [{
        type: 'error', text: 'Fetch failed https://example.com/app.js',
        location: { url: 'https://example.com/app.js', lineNumber: 12, columnNumber: 8 }
    }]);
    assert.equal(runtime.evidence[3].value[0].message, 'Unhandled password=[REDACTED]');
    assert.equal(runtime.evidence[3].value[0].stack, 'Error: password=[REDACTED]');
});

test('WPA runtime diagnostic helpers sanitize source locations and bound text', () => {
    const consoleEntry = normalizeConsoleEntry({
        type: () => 'error',
        text: () => `token=abc ${'x'.repeat(600)}`,
        location: () => ({ url: 'https://example.com/chunk.js?api_key=abc#trace', lineNumber: 3, columnNumber: 4 })
    });
    assert.equal(consoleEntry.text.startsWith('token=[REDACTED]'), true);
    assert.equal(consoleEntry.text.length, 500);
    assert.deepEqual(consoleEntry.location, { url: 'https://example.com/chunk.js', lineNumber: 3, columnNumber: 4 });
    assert.deepEqual(normalizePageError({ message: 'cookie=abc', stack: '' }), { message: 'cookie=[REDACTED]', stack: null });
    assert.equal(sanitizeDiagnosticText('https://example.com/a?secret=abc#x'), 'https://example.com/a');
});

test('WPA analyzer does not report already satisfied baseline rules', () => {
    const findings = analyzeSnapshot(snapshot({
        title: 'Example', description: 'A useful page', canonical: 'https://example.com/', lang: 'en', h1Count: 1,
        structuredDataTypes: ['WebPage'], authorSignals: true, questionHeadings: 2, horizontalOverflow: 0,
        smallTextCount: 0, fontFamilies: ['system-ui'], colors: ['rgb(0,0,0)'], smallTouchTargets: 0,
        unlabeledControls: 0, consoleErrors: 0, failedRequests: 0, failedRequestUrls: [], badResponses: 0,
        badResponseUrls: [], thirdPartyBytes: 0,
        headers: {
            'content-security-policy': "default-src 'self'", 'strict-transport-security': 'max-age=31536000',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
            'content-encoding': 'br', 'cache-control': 'no-cache'
        }
    }), 'https://example.com/', 'mobile');
    assert.equal(findings.length, 0);
});

test('rendered anchor adapter normalizes, redacts, deduplicates and bounds passive DOM links', () => {
    const many = Array.from({ length: MAX_RENDERED_LINKS + 20 }, (_, index) => `/route/${index}`);
    const links = normalizeRenderedLinks([
        '/account?utm_source=test&token=secret#panel',
        'https://example.com/account',
        'https://docs.example.com/guide?utm_campaign=test',
        'https://example.com/account?sessionid=secret',
        'javascript:alert(1)',
        'mailto:owner@example.com',
        'https://user:password@example.com/private',
        ...many
    ], 'https://example.com/start');

    assert.equal(links[0], 'https://example.com/account');
    assert.equal(links[1], 'https://docs.example.com/guide');
    assert.equal(links.length, MAX_RENDERED_LINKS);
    assert.equal(new Set(links).size, links.length);
    assert.equal(JSON.stringify(links).includes('secret'), false);
    assert.equal(links.some((url) => /javascript:|mailto:|user:password/.test(url)), false);
});
