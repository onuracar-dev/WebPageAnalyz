const CONTRACT_VERSION = 'wpa.analysis-capabilities.v1';
const FINDING_SCHEMA = 'wpa.finding.v1';
const REPORT_SCHEMA = 'wpa.report.v2';

const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'unavailable', 'cancelled']);
const INCOMPLETE_STATES = new Set(['failed', 'unavailable', 'cancelled', 'incomplete']);

const ENGINE_CAPABILITIES = Object.freeze({
    lighthouse: Object.freeze({ requiredInput: 'public_url', entitlement: 'core_audit', executionMode: 'automated', dependency: 'chromium+lighthouse', preflight: 'runtime', devices: ['desktop', 'mobile'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['devices', 'categories', 'audits', 'truncated'], terminalStates: TERMINAL_STATES }),
    axe: Object.freeze({ requiredInput: 'public_url', entitlement: 'core_audit', executionMode: 'automated', dependency: 'chromium+axe-core', preflight: 'runtime', devices: ['desktop'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['violations', 'passes', 'incomplete', 'nodes', 'truncated'], terminalStates: TERMINAL_STATES }),
    yellowLab: Object.freeze({ requiredInput: 'public_url', entitlement: 'core_audit', executionMode: 'automated', dependency: 'yellowlab_public_api', preflight: 'upstream_request', devices: ['provider_default'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['rules', 'scoreProfile', 'truncated'], terminalStates: TERMINAL_STATES }),
    wpaPage: Object.freeze({ requiredInput: 'public_url', entitlement: ['runtime', 'seo', 'geo', 'design', 'backend_surface'], executionMode: 'automated', dependency: 'chromium+playwright', preflight: 'runtime', devices: ['desktop', 'mobile'], kind: 'measured+heuristic', outputSchema: FINDING_SCHEMA, coverage: ['devices', 'snapshots', 'truncated'], terminalStates: TERMINAL_STATES }),
    crawler: Object.freeze({ requiredInput: 'verified_origin', entitlement: 'full_site_crawl', executionMode: 'automated', dependency: 'ssrf_safe_proxy', preflight: 'runtime', devices: ['crawler'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['robots', 'sitemaps', 'internalLinks', 'pages', 'truncated'], terminalStates: TERMINAL_STATES }),
    performancePlus: Object.freeze({ requiredInput: 'public_url', entitlement: 'performance_plus', executionMode: 'automated', dependency: 'chromium+playwright', preflight: 'runtime', devices: ['desktop', 'mobile'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['devices', 'metrics', 'truncated'], terminalStates: TERMINAL_STATES }),
    advancedGeo: Object.freeze({ requiredInput: 'public_url', entitlement: 'geo:advanced', executionMode: 'automated', dependency: 'chromium+playwright', preflight: 'runtime', devices: ['desktop'], kind: 'heuristic', outputSchema: FINDING_SCHEMA, coverage: ['entitySignals', 'structuredData', 'robots', 'llmsTxt', 'truncated'], terminalStates: TERMINAL_STATES }),
    visualUx: Object.freeze({ requiredInput: 'public_url', entitlement: 'design:advanced', executionMode: 'automated', dependency: 'chromium+playwright', preflight: 'runtime', devices: ['desktop', 'mobile'], kind: 'heuristic', outputSchema: FINDING_SCHEMA, coverage: ['viewports', 'sampledElements', 'coordinateEvidence', 'truncated'], terminalStates: TERMINAL_STATES }),
    journey: Object.freeze({ requiredInput: 'verified_read_only_journey', entitlement: 'journey_test', executionMode: 'automated', dependency: 'chromium+playwright', preflight: 'runtime', devices: ['desktop'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['declaredSteps', 'executedSteps', 'failureLocation', 'blockedRequests'], terminalStates: TERMINAL_STATES }),
    zapBaseline: Object.freeze({ requiredInput: 'verified_public_origin', entitlement: 'passive_security', executionMode: 'automated', dependency: 'configured_zap_daemon', preflight: 'configuration', devices: ['passive_proxy'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['passiveOnly', 'urls', 'alerts', 'pagination', 'truncated'], terminalStates: TERMINAL_STATES }),
    osvScanner: Object.freeze({ requiredInput: 'validated_source_zip', entitlement: 'source_audit', executionMode: 'automated', dependency: 'osv_scanner_executable', preflight: 'configuration', devices: ['source'], kind: 'measured', outputSchema: FINDING_SCHEMA, coverage: ['manifests', 'files', 'database', 'truncated'], terminalStates: TERMINAL_STATES })
});

const MODULE_ENGINES = Object.freeze({
    core_audit: ['lighthouse', 'axe', 'yellowLab'],
    runtime: ['wpaPage'], seo: ['wpaPage'], backend_surface: ['wpaPage'],
    geo: ['wpaPage'], design: ['wpaPage'],
    full_site_crawl: ['crawler'], performance_plus: ['performancePlus'],
    passive_security: ['zapBaseline'], source_audit: ['osvScanner'], journey_test: ['journey']
});

function requestedPageEngines(manifest, pageIndex = 0) {
    const requested = new Set();
    const entitlements = manifest?.entitlements || {};
    for (const [moduleId, entitlement] of Object.entries(entitlements)) {
        if (entitlement?.executionMode !== 'automated') continue;
        if (moduleId === 'full_site_crawl' || moduleId === 'source_audit') continue;
        for (const engine of MODULE_ENGINES[moduleId] || []) requested.add(engine);
        if (moduleId === 'geo' && entitlement.limit === 'advanced') requested.add('advancedGeo');
        if (moduleId === 'design' && entitlement.limit === 'advanced') requested.add('visualUx');
    }
    if (pageIndex > 0) {
        requested.delete('journey');
        requested.delete('zapBaseline');
    }
    if (!manifest?.journey) requested.delete('journey');
    return [...requested];
}

function moduleEngines(manifest, moduleId) {
    const engines = [...(MODULE_ENGINES[moduleId] || [])];
    const entitlement = manifest?.entitlements?.[moduleId];
    if (moduleId === 'geo' && entitlement?.limit === 'advanced') engines.push('advancedGeo');
    if (moduleId === 'design' && entitlement?.limit === 'advanced') engines.push('visualUx');
    return [...new Set(engines)];
}

function classifyErrorCode(code) {
    if (['CHROME_NOT_FOUND', 'ANALYZER_UNAVAILABLE', 'ZAP_UNAVAILABLE', 'OSV_UNAVAILABLE', 'OSV_ISOLATION_UNAVAILABLE', 'EXTERNAL_PROVIDER_CONSENT_REQUIRED'].includes(code)) return 'unavailable';
    if (code === 'OPERATION_ABORTED') return 'cancelled';
    return 'failed';
}

function remediationFor(code, engineId) {
    if (code === 'ZAP_UNAVAILABLE') return 'Configure the passive ZAP endpoint and API key, then rerun the scan.';
    if (code === 'OSV_UNAVAILABLE' || code === 'OSV_ISOLATION_UNAVAILABLE') return 'Install the configured OSV-Scanner and configure its constrained, no-network runner, then rerun the audit.';
    if (code === 'CHROME_NOT_FOUND' || code === 'ANALYZER_UNAVAILABLE') return `Install and preflight the ${ENGINE_CAPABILITIES[engineId]?.dependency || engineId} dependency, then rerun the scan.`;
    return 'Review the recorded failure code and rerun after the dependency or target condition is repaired.';
}

function pageIsComplete(page) {
    const runs = Object.values(page?.report?.moduleRuns || {});
    return runs.length > 0 && runs.every((run) => run.status === 'completed');
}

function summarizeModules(manifest, pages, crawlerResult = null) {
    const summary = {};
    for (const [moduleId, entitlement] of Object.entries(manifest?.entitlements || {})) {
        if (entitlement?.executionMode === 'operator_assisted') {
            summary[moduleId] = { status: 'pending_operator', executionMode: entitlement.executionMode, engines: [] };
            continue;
        }
        const engines = moduleEngines(manifest, moduleId);
        if (!engines.length) {
            summary[moduleId] = { status: 'not_executed', executionMode: entitlement?.executionMode, engines: [] };
            continue;
        }
        if (moduleId === 'full_site_crawl') {
            summary[moduleId] = { status: crawlerResult?.status || 'unavailable', executionMode: entitlement.executionMode, engines, coverage: crawlerResult?.coverage || null, errorCode: crawlerResult?.errorCode || null };
            continue;
        }
        const runs = pages.flatMap((page) => engines.map((engine) => page.report?.moduleRuns?.[engine]).filter(Boolean));
        const states = new Set(runs.map((run) => run.status));
        let status = 'completed';
        if (!runs.length) status = 'unavailable';
        else if (states.has('failed')) status = 'failed';
        else if (states.has('unavailable')) status = 'unavailable';
        else if (states.has('cancelled') || states.has('incomplete')) status = 'incomplete';
        summary[moduleId] = { status, executionMode: entitlement.executionMode, engines, runs: runs.length };
    }
    return summary;
}

function aggregateState(moduleSummary) {
    const states = Object.values(moduleSummary).map((module) => module.status);
    if (states.some((state) => INCOMPLETE_STATES.has(state))) return 'partial';
    if (states.some((state) => state === 'pending_operator')) return 'awaiting_operator';
    return states.length && states.every((state) => ['completed', 'not_executed'].includes(state)) ? 'completed' : 'partial';
}

function publicCapabilityContract() {
    return { version: CONTRACT_VERSION, findingSchema: FINDING_SCHEMA, reportSchema: REPORT_SCHEMA, engines: ENGINE_CAPABILITIES };
}

module.exports = {
    CONTRACT_VERSION, FINDING_SCHEMA, REPORT_SCHEMA, TERMINAL_STATES, ENGINE_CAPABILITIES, MODULE_ENGINES,
    requestedPageEngines, moduleEngines, classifyErrorCode, remediationFor, pageIsComplete, summarizeModules, aggregateState, publicCapabilityContract
};
