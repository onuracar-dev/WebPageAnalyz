const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_LAB_FINDINGS, lighthouseFindings, portableBasename, resultSummary, samples } = require('../admin/engine-runners');

test('Engine Lab retains the complete normalized finding contract', () => {
    const finding = {
        id: 'finding-1', fingerprint: 'f'.repeat(64), ruleId: 'runtime.console-errors.desktop', category: 'runtime',
        title: 'Browser console errors occurred', description: 'One browser error was observed.', severity: 'high', confidence: 0.91,
        kind: 'measured', pageUrl: 'https://example.com/page?token=private#location', source: { name: 'WPA', version: '1.0.0' },
        normalizedImpact: 75, evidence: [{ type: 'console-errors', count: 1, entries: [{ text: 'ReferenceError: x is not defined', lineNumber: 12, columnNumber: 4 }] }],
        remediation: 'Fix the earliest root cause.'
    };
    const summary = resultSummary({ findings: [finding] }, null, 'C:\\work\\lab');
    const stored = summary.evidence.find((item) => item.kind === 'finding').samples[0];
    assert.deepEqual(stored, { ...finding, pageUrl: 'https://example.com/page', source: { name: 'WPA', version: '1.0.0' } });
    assert.notEqual(stored.evidence, finding.evidence);
});

test('Engine Lab caps stored findings explicitly instead of silently using a 12-item sample', () => {
    const findings = Array.from({ length: MAX_LAB_FINDINGS + 1 }, (_, index) => ({ ruleId: `rule-${index}`, title: `Finding ${index}`, severity: 'low' }));
    const summary = resultSummary({ findings }, null, 'lab');
    const evidence = summary.evidence.find((item) => item.kind === 'finding');
    assert.equal(summary.findingsCount, MAX_LAB_FINDINGS + 1);
    assert.equal(evidence.totalFindings, MAX_LAB_FINDINGS + 1);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.samples.length, MAX_LAB_FINDINGS);
    assert.equal(evidence.samples.at(-1).ruleId, `rule-${MAX_LAB_FINDINGS - 1}`);
});

test('Engine Lab redacts secret values and local paths from finding details', () => {
    const [stored] = samples([{
        ruleId: 'runtime.console-errors.desktop', title: 'token=private-token', severity: 'high',
        description: 'Authorization: Bearer abc.def.ghi at C:\\Users\\onura\\secret.js and /home/onur/private.js',
        pageUrl: 'https://example.com/audit?token=private#section',
        evidence: [{ token: 'private-token', path: 'C:\\Users\\onura\\secret.js', message: 'GET https://api.example.com/x?password=private' }],
        remediation: 'Remove cookie=private-cookie'
    }]);
    const serialized = JSON.stringify(stored);
    for (const leaked of ['private-token', 'abc.def.ghi', 'C:\\Users\\onura\\secret.js', '/home/onur/private.js', 'password=private', 'private-cookie', '?token=private']) assert.equal(serialized.includes(leaked), false);
    assert.equal(stored.pageUrl, 'https://example.com/audit');
    assert.equal(stored.evidence[0].token, '[REDACTED]');
    assert.equal(stored.evidence[0].path, '[LOCAL_PATH]');
});

test('Engine Lab strips unsafe evidence keys and bounds nested payloads', () => {
    const [stored] = samples([{
        ruleId: 'safe', title: 'Safe', evidence: [{ __proto__: { polluted: true }, constructor: 'bad', value: ['x', ['y', ['z', ['too-deep']]]] }]
    }]);
    assert.equal(Object.hasOwn(stored.evidence[0], 'constructor'), false);
    assert.equal(stored.evidence[0].value[1][1][1], '[TRUNCATED]');
    assert.equal({}.polluted, undefined);
});

test('Engine Lab exposes only image artifacts as protected screenshot metadata', () => {
    const summary = resultSummary({ artifactPaths: ['C:\\lab\\wpa_desktop_1.png', 'C:\\lab\\raw.json'] }, { findings: [] }, 'C:\\lab');
    const screenshot = summary.evidence.find((item) => item.kind === 'screenshot');
    assert.deepEqual(screenshot, { kind: 'screenshot', label: 'Desktop screenshot', filename: 'wpa_desktop_1.png', device: 'desktop', mimeType: 'image/png' });
    assert.equal(JSON.stringify(summary).includes('C:\\lab'), false);
});

test('Engine Lab normalizes artifact basenames across Windows and Linux workers', () => {
    assert.equal(portableBasename('C:\\lab\\wpa_desktop_1.png'), 'wpa_desktop_1.png');
    assert.equal(portableBasename('/tmp/lab/wpa_mobile_1.webp'), 'wpa_mobile_1.webp');
    const summary = resultSummary({ artifactPaths: ['C:\\lab\\wpa_desktop_1.png', '/tmp/lab/wpa_mobile_1.webp'] }, { findings: [] }, 'C:\\lab');
    assert.deepEqual(summary.evidence.filter((item) => item.kind === 'screenshot').map((item) => item.filename), ['wpa_desktop_1.png', 'wpa_mobile_1.webp']);
    assert.equal(summary.metrics.artifactScope, 'lab');
});

test('YellowLab and Axe native records retain their actionable diagnostics', () => {
    const [yellow, axe] = samples([
        { rule: 'dom-depth', message: 'DOM is too deep', score: 42, penalty: 18 },
        { id: 'color-contrast', help: 'Elements must meet contrast', description: 'Low contrast', impact: 'serious', helpUrl: 'https://deque.example/help?token=secret', tags: ['wcag2aa'], nodes: [{ target: ['.hero'], html: '<p class="hero">Text</p>', failureSummary: 'Fix foreground color' }] }
    ]);
    assert.equal(yellow.ruleId, 'dom-depth');
    assert.equal(yellow.title, 'DOM is too deep');
    assert.equal(yellow.evidence[0].value.penalty, 18);
    assert.equal(axe.ruleId, 'color-contrast');
    assert.equal(axe.title, 'Elements must meet contrast');
    assert.equal(axe.evidence[0].value[0].target[0], '.hero');
    assert.equal(JSON.stringify(axe).includes('token=secret'), false);
});

test('Lighthouse failing audits become device-specific detailed findings', () => {
    const findings = lighthouseFindings({
        finalDisplayedUrl: 'https://example.com/?token=secret',
        audits: { 'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'Largest Contentful Paint', description: 'LCP is slow', score: 0.25, displayValue: '4.8 s', explanation: 'The main image is late.', details: { items: [{ node: { selector: 'main img' } }] } } }
    }, 'mobile');
    assert.equal(findings[0].ruleId, 'lighthouse.largest-contentful-paint.mobile');
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].pageUrl, 'https://example.com/');
    assert.equal(findings[0].evidence[0].value.displayValue, '4.8 s');
});
