const fs = require('node:fs').promises;
const { createFinding } = require('./findings');

const impact = (severity) => ({ critical: 100, high: 75, medium: 50, low: 25, info: 5 })[severity] || 25;

async function readJson(filename) {
    if (!filename) return null;
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function canonical(input, extras = {}) {
    const finding = createFinding(input);
    return { ...finding, normalizedImpact: impact(finding.severity), ...extras };
}

function lighthouseFindings(lhr, device) {
    if (!lhr?.audits) return [];
    return Object.values(lhr.audits).filter((audit) => Number.isFinite(audit?.score) && audit.score < 1 && !['notApplicable', 'informative', 'manual'].includes(audit.scoreDisplayMode)).slice(0, 250).map((audit) => {
        const severity = audit.score < 0.5 ? 'high' : audit.score < 0.9 ? 'medium' : 'low';
        return canonical({
            ruleId: `lighthouse.${audit.id}.${device}`, category: 'lighthouse', title: audit.title || audit.id,
            description: audit.description || audit.explanation || 'Lighthouse reported a failed audit.', severity, confidence: 1, kind: 'measured',
            pageUrl: lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl, source: 'Lighthouse', sourceVersion: lhr.lighthouseVersion || '13.4.1', evidenceKey: device,
            evidence: [{ type: 'lighthouse-audit', name: audit.id, value: { device, score: audit.score, displayValue: audit.displayValue, numericValue: audit.numericValue, explanation: audit.explanation, items: Array.isArray(audit.details?.items) ? audit.details.items.slice(0, 20) : [] } }],
            remediation: audit.explanation || `Review the Lighthouse ${audit.id} audit details and retest after the fix.`
        }, { moduleId: 'core_audit', engineId: 'lighthouse', device });
    });
}

function axeFindings(result, pageUrl) {
    const severityMap = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' };
    return (result?.violations || []).slice(0, 250).map((violation) => canonical({
        ruleId: `axe.${violation.id}.desktop`, category: 'accessibility', title: violation.help || violation.id,
        description: violation.description || 'Axe reported an accessibility violation.', severity: severityMap[violation.impact] || 'medium', confidence: 0.99, kind: 'measured',
        pageUrl, source: 'Axe', sourceVersion: result?.testEngine?.version || '4.12.1', evidenceKey: 'desktop',
        evidence: [{ type: 'axe-nodes', name: violation.id, value: (violation.nodes || []).slice(0, 20).map((node) => ({ target: node.target, html: String(node.html || '').slice(0, 2_000), failureSummary: String(node.failureSummary || '').slice(0, 2_000) })) }],
        remediation: violation.helpUrl ? `Apply the Axe rule guidance at ${violation.helpUrl} and retest.` : 'Repair the affected accessibility rule and retest with Axe.'
    }, { moduleId: 'core_audit', engineId: 'axe', device: 'desktop' }));
}

function yellowLabFindings(result, pageUrl) {
    return (result?.issues || []).slice(0, 250).map((issue) => {
        const penalty = Number(issue.penalty) || 0;
        const severity = penalty >= 70 ? 'high' : penalty >= 35 ? 'medium' : 'low';
        return canonical({
            ruleId: `yellowlab.${issue.rule}`, category: 'performance', title: issue.message || issue.rule,
            description: `YellowLab reported a frontend-quality rule violation with penalty ${penalty}.`, severity, confidence: 0.9, kind: 'measured',
            pageUrl, source: 'YellowLab', sourceVersion: 'current-api', evidenceKey: 'provider_default',
            evidence: [{ type: 'yellowlab-rule', name: issue.rule, value: { score: issue.score, penalty, device: 'provider_default' } }],
            remediation: 'Review the measured rule, reduce the reported frontend-quality cost, and rerun YellowLab.'
        }, { moduleId: 'core_audit', engineId: 'yellowLab', device: 'provider_default' });
    });
}

function coverageFor(engineId, data, result) {
    if (engineId === 'lighthouse') return { devices: ['desktop', 'mobile'], categories: ['performance', 'accessibility', 'best-practices', 'seo'], truncated: false };
    if (engineId === 'axe') return { devices: ['desktop'], violations: data?.violations?.length || 0, passes: data?.passes?.length || 0, incomplete: data?.incomplete?.length || 0, truncated: (data?.violations?.length || 0) > 250 };
    if (engineId === 'yellowLab') return { devices: ['provider_default'], rules: data?.issues?.length || 0, score: data?.globalScore ?? result?.score ?? null, truncated: (data?.issues?.length || 0) > 250 };
    if (engineId === 'wpaPage') return {
        devices: Object.keys(data?.devices || {}),
        findings: data?.findings?.length || 0,
        renderedLinks: data?.renderedLinkCoverage?.uniqueLinks || 0,
        renderedLinkReferences: data?.renderedLinkCoverage?.references || 0,
        truncated: data?.renderedLinkCoverage?.truncated === true
    };
    if (['performancePlus', 'advancedGeo', 'visualUx', 'journey'].includes(engineId)) return { devices: Object.keys(data?.devices || {}), findings: (data?.findings || []).filter((finding) => ({ performancePlus: 'performance_plus', advancedGeo: 'advanced_geo', visualUx: 'visual_ux', journey: 'journey_test' })[engineId] === finding.moduleId).length, journey: engineId === 'journey' ? data?.journey || null : undefined, truncated: false };
    if (engineId === 'zapBaseline') return result?.coverage || null;
    return null;
}

module.exports = { readJson, lighthouseFindings, axeFindings, yellowLabFindings, coverageFor };
