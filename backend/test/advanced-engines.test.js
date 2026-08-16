const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performanceFindings, geoFindings, visualFindings, runJourney } = require('../analyzers/advanced-browser');
const { normalizeAlert, redact } = require('../analyzers/zap-baseline');
const { normalizeOsv } = require('../source/osv-runner');
const { encrypt, decrypt } = require('../source/service');

test('Performance Plus produces measured budget evidence', () => {
    const findings = performanceFindings({ lcp: 4200, cls: .3, longTaskMs: 800, longTaskCount: 4, transferBytes: 6_000_000, requestCount: 140, domNodes: 3400 }, 'https://example.com/', 'mobile');
    assert.ok(findings.length >= 6);
    assert.ok(findings.every((finding) => finding.kind === 'measured' && finding.moduleId === 'performance_plus'));
});

test('Advanced GEO is explicitly heuristic and does not promise visibility', () => {
    const findings = geoFindings({ validJsonLd: false, schemaTypes: [], entitySignals: false, citations: 0, wordCount: 900, dateSignals: false, articleLike: true, directAnswers: 0, questionHeadings: 2, aiBotsBlocked: ['GPTBot'], llmsTxt: false }, 'https://example.com/');
    assert.ok(findings.length >= 6);
    assert.ok(findings.every((finding) => finding.kind === 'heuristic' && finding.confidence < 1));
});

test('Visual UX records overlap and contrast evidence per device', () => {
    const element = { selector: 'header:nth-of-type(1)', tag: 'header', role: null, rect: { x: 0, y: 0, width: 390, height: 60 } };
    const findings = visualFindings({ viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, overlaps: 1, overlapPairs: [{ first: element, second: { ...element, selector: 'div:nth-of-type(1)' }, intersection: { width: 100, height: 40, area: 4000 } }], clippedText: 1, clippedElements: [element], lowContrast: 1, lowContrastElements: [{ ...element, ratio: 2.4, threshold: 4.5 }], spacingOutliers: 9, formsWithoutFeedback: 1, primaryCtas: 0 }, 'https://example.com/', 'mobile');
    const overlap = findings.find((finding) => finding.ruleId === 'visual.overlap.mobile');
    const contrast = findings.find((finding) => finding.ruleId === 'visual.contrast.mobile');
    assert.equal(overlap.device, 'mobile');
    assert.deepEqual(overlap.evidence[0].value, { width: 390, height: 844, deviceScaleFactor: 2 });
    assert.deepEqual(overlap.evidence[1].value[0].first.rect, { x: 0, y: 0, width: 390, height: 60 });
    assert.equal(overlap.kind, 'heuristic');
    assert.equal(contrast.evidence[1].value[0].ratio, 2.4);
});

test('ZAP passive alerts are normalized and secrets are redacted', () => {
    const finding = normalizeAlert({ pluginId: '10020', risk: 'High', confidence: 'High', name: 'Header missing', url: 'https://example.com/?token=secret', description: 'cookie: abc', method: 'GET', solution: 'Add header' }, 'https://example.com/');
    assert.equal(finding.severity, 'high');
    assert.equal(finding.pageUrl, 'https://example.com/');
    assert.doesNotMatch(redact('Authorization: Bearer secret'), /Bearer secret/);
});

test('OSV results become dependency findings with fixed-version guidance', () => {
    const output = { results: [{ source: { path: 'package-lock.json' }, packages: [{ package: { name: 'demo', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'OSV-1', summary: 'Known issue', affected: [{ ranges: [{ events: [{ fixed: '1.0.1' }] }] }] }] }] }] };
    const result = normalizeOsv(output, 'https://example.com/');
    assert.equal(result.findings[0].ruleId, 'osv:OSV-1');
    assert.match(result.findings[0].remediation, /1\.0\.1/);
    assert.equal(result.coverage.manifests, 1);
});

test('source encryption fails closed after GCM tampering', () => {
    const key = crypto.randomBytes(32); const ciphertext = encrypt(Buffer.from('safe source'), key);
    assert.equal(decrypt(ciphertext, key).toString(), 'safe source');
    ciphertext[ciphertext.length - 1] ^= 1;
    assert.throws(() => decrypt(ciphertext, key), { code: 'SOURCE_CIPHERTEXT_INVALID' });
});

test('Journey Test executes assertions and blocks cross-origin navigation', async () => {
    const page = { route: async () => {}, goto: async () => {}, url: () => 'https://example.com/account', locator: () => ({ first: () => ({ waitFor: async () => {} }) }), waitForTimeout: async () => {}, close: async () => {} };
    const context = { newPage: async () => page };
    const passed = await runJourney(context, 'https://example.com/', { name: 'Smoke', steps: [{ action: 'expectVisible', selector: 'body' }] });
    assert.equal(passed.status, 'passed');
    assert.equal(passed.coverage.executedSteps, 1);
    const blocked = await runJourney(context, 'https://example.com/', { name: 'Scope', steps: [{ action: 'goto', path: 'https://evil.example/' }] });
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.error, /Cross-origin/);
    assert.deepEqual(blocked.failureLocation, { index: 0, action: 'goto', target: 'https://evil.example/' });
});
