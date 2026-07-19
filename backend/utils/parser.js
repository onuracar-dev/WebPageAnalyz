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

function number(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
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

async function parseLogs(logPaths, { maxArtifactBytes = 50 * 1024 * 1024, maxIssuesPerCategory = 150 } = {}) {
    const parsed = {
        scores: { performance: 0, seo: 0, accessibility: 0, bestPractices: 0 },
        categories: { performance: [], seo: [], accessibility: [], bestPractices: [] }
    };

    if (logPaths.lighthouseDesktop) {
        const lighthouse = await readJson(logPaths.lighthouseDesktop, maxArtifactBytes);
        for (const [source, target] of Object.entries(categoryMapping)) {
            const category = lighthouse.categories?.[source];
            parsed.scores[target] = Math.round(number(category?.score) * 100);
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
                    source: 'Lighthouse (Desktop)',
                    snippet: lighthouseSnippet(audit),
                    normalizedImpact: (1 - number(audit.score)) * 100
                });
            }
        }
    }

    if (logPaths.yellowlab) {
        const yellowLab = await readJson(logPaths.yellowlab, maxArtifactBytes);
        for (const issue of Array.isArray(yellowLab.issues) ? yellowLab.issues : []) {
            if (parsed.categories.performance.length >= maxIssuesPerCategory) break;
            parsed.categories.performance.push({
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
            if (parsed.categories.accessibility.length >= maxIssuesPerCategory) break;
            const snippets = (Array.isArray(violation.nodes) ? violation.nodes : [])
                .map((node) => text(node?.html, 10_000))
                .filter(Boolean)
                .slice(0, 20);
            const impactScores = { critical: 100, serious: 75, moderate: 50, minor: 25 };
            const impact = text(violation.impact || 'unknown', 32);
            parsed.categories.accessibility.push({
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

    for (const issues of Object.values(parsed.categories)) {
        issues.sort((left, right) => number(right.normalizedImpact) - number(left.normalizedImpact));
    }
    return parsed;
}

module.exports = { parseLogs };
