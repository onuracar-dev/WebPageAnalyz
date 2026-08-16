const fs = require('node:fs').promises;
const { AppError } = require('../lib/errors');

const categoryMapping = {
    performance: 'performance',
    seo: 'seo',
    accessibility: 'accessibility',
    'best-practices': 'bestPractices'
};

function text(value, maxLength = 4_000) {
    return String(value ?? '').replace(/\0/g, '').slice(0, maxLength);
}

function safeReportUrl(value) {
    try {
        const parsed = new URL(String(value));
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
        return parsed.toString().slice(0, 2_048);
    } catch { return ''; }
}

function number(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function emptyScores() {
    return { performance: null, seo: null, accessibility: null, bestPractices: null };
}

function emptyCategories() {
    return { performance: [], seo: [], accessibility: [], bestPractices: [] };
}

async function readJson(file, maxBytes) {
    const stats = await fs.stat(file);
    if (stats.size > maxBytes) {
        throw new AppError('An analyzer artifact exceeded the parsing size limit.', {
            status: 502,
            code: 'ANALYZER_ARTIFACT_TOO_LARGE'
        });
    }
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

function lighthouseSnippet(audit) {
    const items = Array.isArray(audit?.details?.items) ? audit.details.items : [];
    return text(items.find((item) => item?.node?.snippet)?.node?.snippet, 10_000) || null;
}

function sortIssues(categories) {
    for (const issues of Object.values(categories)) {
        issues.sort((left, right) => number(right.normalizedImpact) - number(left.normalizedImpact));
    }
    return categories;
}

async function parseLighthouse(file, device, maxArtifactBytes, maxIssuesPerCategory) {
    if (!file) return null;
    const lighthouse = await readJson(file, maxArtifactBytes);
    const parsed = { scores: emptyScores(), categories: emptyCategories() };

    for (const [source, target] of Object.entries(categoryMapping)) {
        const category = lighthouse.categories?.[source];
        parsed.scores[target] = Number.isFinite(category?.score)
            ? Math.round(category.score * 100)
            : null;
        for (const reference of Array.isArray(category?.auditRefs) ? category.auditRefs : []) {
            if (parsed.categories[target].length >= maxIssuesPerCategory) break;
            const audit = lighthouse.audits?.[reference.id];
            if (!audit || audit.score === null || audit.score >= 1 || ['manual', 'notApplicable'].includes(audit.scoreDisplayMode)) continue;
            parsed.categories[target].push({
                id: text(audit.id || reference.id, 256),
                title: text(audit.title || 'Lighthouse finding', 300),
                description: text(audit.description, 10_000),
                score: number(audit.score),
                displayValue: text(audit.displayValue, 500) || null,
                source: `Lighthouse (${device})`,
                snippet: lighthouseSnippet(audit),
                normalizedImpact: (1 - number(audit.score)) * 100
            });
        }
    }

    sortIssues(parsed.categories);
    return parsed;
}

function mergeCategories(primary, shared, maxIssuesPerCategory) {
    const merged = emptyCategories();
    for (const category of Object.keys(merged)) {
        merged[category] = [...(primary?.[category] || []), ...(shared[category] || [])]
            .sort((left, right) => number(right.normalizedImpact) - number(left.normalizedImpact))
            .slice(0, maxIssuesPerCategory);
    }
    return merged;
}

function wpaCategory(category) {
    if (category === 'seo' || category === 'geo') return 'seo';
    if (category === 'accessibility') return 'accessibility';
    if (category === 'performance') return 'performance';
    return 'bestPractices';
}

function wpaIssue(finding) {
    return {
        id: text(finding.ruleId || finding.id, 256),
        title: text(finding.title || 'WPA finding', 300),
        description: text(finding.description, 10_000),
        score: 0,
        displayValue: `${text(finding.severity || 'medium', 32)} · ${Math.round(number(finding.confidence) * 100)}% confidence`,
        source: `WPA ${text(finding.source?.version || '', 32)}`.trim(),
        snippet: null,
        normalizedImpact: number(finding.normalizedImpact, 25),
        severity: text(finding.severity || 'medium', 32),
        confidence: number(finding.confidence),
        kind: text(finding.kind || 'measured', 32),
        pageUrl: safeReportUrl(finding.pageUrl),
        fingerprint: text(finding.fingerprint, 128),
        evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 20) : [],
        remediation: text(finding.remediation, 10_000)
    };
}

function findingDevice(finding) {
    return /\.(desktop|mobile)$/.exec(String(finding.ruleId || ''))?.[1] || finding.device || null;
}

function enrichWpaFinding(finding) {
    const moduleId = ({ seo: 'seo', geo: 'geo', design: 'design', performance: 'runtime', runtime: 'runtime', backend: 'backend_surface', security: 'backend_surface' })[finding.category] || finding.moduleId || 'runtime';
    return { ...finding, pageUrl: safeReportUrl(finding.pageUrl), moduleId, engineId: 'wpaPage', device: findingDevice(finding) };
}

function enrichAdvancedFinding(finding) {
    const engineId = ({ performance_plus: 'performancePlus', advanced_geo: 'advancedGeo', visual_ux: 'visualUx', journey_test: 'journey' })[finding.moduleId] || finding.engineId;
    return { ...finding, pageUrl: safeReportUrl(finding.pageUrl), engineId, device: findingDevice(finding) };
}

async function parseLogs(logPaths, { maxArtifactBytes = 50 * 1024 * 1024, maxIssuesPerCategory = 150 } = {}) {
    const [desktop, mobile] = await Promise.all([
        parseLighthouse(logPaths.lighthouseDesktop, 'Desktop', maxArtifactBytes, maxIssuesPerCategory),
        parseLighthouse(logPaths.lighthouseMobile, 'Mobile', maxArtifactBytes, maxIssuesPerCategory)
    ]);
    const sharedCategories = emptyCategories();
    let wpa = null;

    if (logPaths.wpaPage) {
        wpa = await readJson(logPaths.wpaPage, maxArtifactBytes);
        for (const rawFinding of Array.isArray(wpa.findings) ? wpa.findings : []) {
            const category = wpaCategory(rawFinding.category);
            if (sharedCategories[category].length >= maxIssuesPerCategory) continue;
            sharedCategories[category].push(wpaIssue(rawFinding));
        }
    }

    let advanced = null;
    if (logPaths.advancedBrowser) {
        advanced = await readJson(logPaths.advancedBrowser, maxArtifactBytes);
        for (const rawFinding of Array.isArray(advanced.findings) ? advanced.findings : []) {
            const category = wpaCategory(rawFinding.category);
            if (sharedCategories[category].length >= maxIssuesPerCategory) continue;
            sharedCategories[category].push(wpaIssue(rawFinding));
        }
    }

    if (logPaths.yellowlab) {
        const yellowLab = await readJson(logPaths.yellowlab, maxArtifactBytes);
        for (const issue of Array.isArray(yellowLab.issues) ? yellowLab.issues : []) {
            if (sharedCategories.performance.length >= maxIssuesPerCategory) break;
            sharedCategories.performance.push({
                id: text(issue.rule, 256),
                title: text(issue.message || 'YellowLab finding', 300),
                description: `YellowLab constraint violation. Penalty score: ${number(issue.penalty)}`,
                score: number(issue.score),
                displayValue: `Penalty: ${number(issue.penalty)}`,
                source: 'YellowLab',
                snippet: null,
                normalizedImpact: number(issue.penalty)
            });
        }
    }

    if (logPaths.axe) {
        const axe = await readJson(logPaths.axe, maxArtifactBytes);
        for (const violation of Array.isArray(axe.violations) ? axe.violations : []) {
            if (sharedCategories.accessibility.length >= maxIssuesPerCategory) break;
            const snippets = (Array.isArray(violation.nodes) ? violation.nodes : [])
                .map((node) => text(node?.html, 10_000))
                .filter(Boolean)
                .slice(0, 20);
            const impactScores = { critical: 100, serious: 75, moderate: 50, minor: 25 };
            const impact = text(violation.impact || 'unknown', 32);
            sharedCategories.accessibility.push({
                id: text(violation.id, 256),
                title: text(violation.help || 'Accessibility finding', 300),
                description: `${text(violation.description, 8_000)}${violation.helpUrl ? `\n[More info](${text(violation.helpUrl, 2_000)})` : ''}`,
                score: 0,
                displayValue: `Impact: ${impact}`,
                impact,
                source: 'Axe DevTools',
                snippet: snippets[0] || null,
                allSnippets: snippets,
                normalizedImpact: impactScores[impact] || 25
            });
        }
    }

    sortIssues(sharedCategories);
    const devices = {};
    if (desktop) devices.desktop = desktop;
    if (mobile) devices.mobile = mobile;

    return {
        scores: desktop?.scores || emptyScores(),
        categories: mergeCategories(desktop?.categories, sharedCategories, maxIssuesPerCategory),
        sharedCategories,
        devices,
        findings: [
            ...(Array.isArray(wpa?.findings) ? wpa.findings.map(enrichWpaFinding) : []),
            ...(Array.isArray(advanced?.findings) ? advanced.findings.map(enrichAdvancedFinding) : [])
        ],
        modules: advanced ? Object.fromEntries((advanced.modules || []).map((moduleId) => [moduleId, {
            status: 'completed', version: advanced.version,
            findingCount: advanced.findings?.filter((finding) => finding.moduleId === moduleId).length || 0
        }])) : {},
        journey: advanced?.journey || null,
        evidence: {
            ...(wpa ? { wpaPage: { version: wpa.version, devices: wpa.devices } } : {}),
            ...(advanced ? { advancedBrowser: { version: advanced.version, devices: advanced.devices } } : {})
        }
    };
}

module.exports = { parseLogs };
