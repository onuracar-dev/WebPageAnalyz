const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINE_CAPABILITIES, requestedPageEngines, summarizeModules, aggregateState } = require('../domain/analysis-contract');
const { journeySchema } = require('../validation/schemas');
const { reportHtml } = require('../reports/pdf');

test('executable capability matrix declares input, dependency, coverage and terminal semantics for every engine', () => {
    assert.deepEqual(Object.keys(ENGINE_CAPABILITIES).sort(), ['advancedGeo', 'axe', 'crawler', 'journey', 'lighthouse', 'osvScanner', 'performancePlus', 'visualUx', 'wpaPage', 'yellowLab', 'zapBaseline'].sort());
    for (const capability of Object.values(ENGINE_CAPABILITIES)) {
        assert.ok(capability.requiredInput);
        assert.ok(capability.entitlement);
        assert.ok(capability.dependency);
        assert.ok(capability.devices.length);
        assert.ok(capability.coverage.length);
        assert.deepEqual(capability.terminalStates, ['completed', 'failed', 'unavailable', 'cancelled']);
    }
    for (const engineId of ['lighthouse', 'axe', 'yellowLab', 'wpaPage', 'performancePlus', 'advancedGeo', 'visualUx']) {
        assert.equal(ENGINE_CAPABILITIES[engineId].requiredInput, 'public_url');
    }
    for (const engineId of ['crawler', 'journey', 'zapBaseline']) {
        assert.match(ENGINE_CAPABILITIES[engineId].requiredInput, /^verified_/);
    }
});

test('requested core engines are all required and any unavailable engine makes module and scan incomplete', () => {
    const manifest = { entitlements: { core_audit: { executionMode: 'automated' }, runtime: { executionMode: 'automated' } } };
    assert.deepEqual(requestedPageEngines(manifest), ['lighthouse', 'axe', 'yellowLab', 'wpaPage']);
    const modules = summarizeModules(manifest, [{ report: { moduleRuns: { lighthouse: { status: 'completed' }, axe: { status: 'unavailable' }, yellowLab: { status: 'completed' }, wpaPage: { status: 'completed' } } } }]);
    assert.equal(modules.core_audit.status, 'unavailable');
    assert.equal(aggregateState(modules), 'partial');
});

test('Journey Test rejects body-only smoke and accepts a real read-only path assertion', () => {
    assert.equal(journeySchema.safeParse({ name: 'Smoke', steps: [{ action: 'expectVisible', selector: 'body' }] }).success, false);
    assert.equal(journeySchema.safeParse({ name: 'Primary', steps: [{ action: 'goto', path: '/' }, { action: 'expectVisible', selector: 'main' }] }).success, true);
});

test('printable PDF source retains null scores and completeness without coercing unavailable to zero', () => {
    const html = reportHtml({ locale: 'en', status: 'automated_incomplete', version: 1, payload: { schemaVersion: 'wpa.report.v2', summary: { terminalState: 'partial', unavailablePages: 1 }, modules: { core_audit: { status: 'unavailable' } }, pages: [{ report: { scores: { performance: null } } }] } });
    assert.match(html, /automated_incomplete/);
    assert.match(html, /"terminalState": "partial"/);
    assert.match(html, /"performance": null/);
    assert.doesNotMatch(html, /"performance": 0/);
});
