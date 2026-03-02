const fs = require('fs').promises;

/**
 * Reads and categorizes the results from the raw log JSONs
 * @param {Object} logPaths - Object containing paths to the generated log files
 * @returns {Object} - Parsed and categorized results (Performance, SEO, Accessibility, Best Practices)
 */
async function parseLogs(logPaths) {
    const parsedData = {
        scores: {
            performance: 0,
            seo: 0,
            accessibility: 0,
            bestPractices: 0
        },
        categories: {
            performance: [],
            seo: [],
            accessibility: [],
            bestPractices: []
        }
    };

    console.log("parseLogs: Starting parse...");
    // 1. Parse Lighthouse Desktop
    if (logPaths.lighthouseDesktop) {
        console.log("parseLogs: Parsing Lighthouse Desktop...");
        try {
            const lhData = JSON.parse(await fs.readFile(logPaths.lighthouseDesktop, 'utf8'));

            // Extract Scores
            if (lhData.categories) {
                parsedData.scores.performance = Math.round((lhData.categories.performance?.score || 0) * 100);
                parsedData.scores.seo = Math.round((lhData.categories.seo?.score || 0) * 100);
                parsedData.scores.accessibility = Math.round((lhData.categories.accessibility?.score || 0) * 100);
                parsedData.scores.bestPractices = Math.round((lhData.categories['best-practices']?.score || 0) * 100);
            }

            // Extract Audits
            if (lhData.audits) {
                for (const [auditId, audit] of Object.entries(lhData.audits)) {
                    // Only include audits that have a score < 1 (meaning they are issues/warnings) or don't have a score but have warnings
                    if ((audit.score !== null && audit.score < 1) || (audit.scoreDisplayMode === 'informative' && audit.details)) {

                        // Extract relevant details
                        let snippet = null;
                        if (audit.details && audit.details.items && audit.details.items.length > 0) {
                            // Find the first item with a node snippet if available
                            const itemWithNode = audit.details.items.find(item => item.node && item.node.snippet);
                            if (itemWithNode) {
                                snippet = itemWithNode.node.snippet;
                            }
                        }

                        const issue = {
                            id: auditId,
                            title: audit.title,
                            description: audit.description,
                            score: audit.score,
                            displayValue: audit.displayValue || null,
                            source: 'Lighthouse',
                            snippet: snippet
                        };

                        // Map to our categories based on Lighthouse categorization mapping
                        // A quick heuristic: Lighthouse audits belong to categories. We check the categories mapping.
                        // However, to keep it simple, we can map by known prefixes or we check categories
                    }
                }

                // Better approach for Lighthouse: Iterate over categories to know which audit belongs where
                const categoryMapping = {
                    'performance': 'performance',
                    'seo': 'seo',
                    'accessibility': 'accessibility',
                    'best-practices': 'bestPractices'
                };

                for (const [catId, catObj] of Object.entries(lhData.categories)) {
                    const targetCategory = categoryMapping[catId];
                    if (targetCategory && catObj.auditRefs) {
                        for (const ref of catObj.auditRefs) {
                            const audit = lhData.audits[ref.id];
                            // Weight 0 usually means it's informational/diagnostic, but we still want errors
                            // We only want audits that are actually issues
                            if (audit && (audit.score !== null && audit.score < 1) && audit.scoreDisplayMode !== 'notApplicable' && audit.scoreDisplayMode !== 'manual') {

                                let snippet = null;
                                if (audit.details && audit.details.items && audit.details.items.length > 0) {
                                    const itemWithNode = audit.details.items.find(item => item.node && item.node.snippet);
                                    if (itemWithNode) {
                                        snippet = itemWithNode.node.snippet;
                                    }
                                }

                                const issue = {
                                    id: audit.id,
                                    title: audit.title,
                                    description: audit.description,
                                    score: audit.score,
                                    displayValue: audit.displayValue || null,
                                    source: 'Lighthouse (Desktop)',
                                    snippet: snippet,
                                    normalizedImpact: audit.score !== null ? (1 - audit.score) * 100 : 50 // Convert 0-1 metrics to 100-0 severity
                                };
                                parsedData.categories[targetCategory].push(issue);
                            }
                        }
                    }
                }
            }

        } catch (err) {
            console.warn("Failed to parse Lighthouse Desktop log:", err);
        }
    }

    // 2. Parse YellowLab (Focusing heavily on Frontend Performance / Best Practices)
    if (logPaths.yellowlab) {
        console.log("parseLogs: Parsing YellowLab...");
        try {
            const ylData = JSON.parse(await fs.readFile(logPaths.yellowlab, 'utf8'));
            if (ylData.issues && ylData.issues.length > 0) {
                ylData.issues.forEach(issue => {
                    parsedData.categories.performance.push({
                        id: issue.rule,
                        title: issue.message,
                        description: `YellowLab constraint violation. Penalty score: ${issue.penalty}`,
                        score: issue.score,
                        displayValue: `Penalty: ${issue.penalty}`,
                        source: 'YellowLab',
                        snippet: null,
                        normalizedImpact: issue.penalty || 0 // Penalty is usually an integer representing impact
                    });
                });
            }
        } catch (err) {
            console.warn("Failed to parse YellowLab log:", err);
        }
    }

    // 3. Parse Axe DevTools (Accessibility)
    if (logPaths.axe) {
        console.log("parseLogs: Parsing Axe...");
        try {
            const axeData = JSON.parse(await fs.readFile(logPaths.axe, 'utf8'));
            if (axeData.violations && axeData.violations.length > 0) {
                axeData.violations.forEach(violation => {
                    // Axe can have multiple nodes per violation
                    const snippets = violation.nodes.map(node => node.html).filter(Boolean);

                    let impactScore = 25; // minor
                    if (violation.impact === 'critical') impactScore = 100;
                    else if (violation.impact === 'serious') impactScore = 75;
                    else if (violation.impact === 'moderate') impactScore = 50;

                    parsedData.categories.accessibility.push({
                        id: violation.id,
                        title: violation.help,
                        description: violation.description + (violation.helpUrl ? `\n[More info](${violation.helpUrl})` : ''),
                        score: 0, // It's a violation
                        displayValue: `Impact: ${violation.impact}`,
                        impact: violation.impact,
                        source: 'Axe DevTools',
                        snippet: snippets.length > 0 ? snippets[0] : null, // Show the first failing node's HTML
                        allSnippets: snippets,
                        normalizedImpact: impactScore
                    });
                });
            }
        } catch (err) {
            console.warn("Failed to parse Axe log:", err);
        }
    }

    console.log("parseLogs: Finished parsing successfully.");

    // Sort all arrays by normalizedImpact (highest severity first)
    parsedData.categories.performance.sort((a, b) => (b.normalizedImpact || 0) - (a.normalizedImpact || 0));
    parsedData.categories.seo.sort((a, b) => (b.normalizedImpact || 0) - (a.normalizedImpact || 0));
    parsedData.categories.accessibility.sort((a, b) => (b.normalizedImpact || 0) - (a.normalizedImpact || 0));
    parsedData.categories.bestPractices.sort((a, b) => (b.normalizedImpact || 0) - (a.normalizedImpact || 0));

    return parsedData;
}

module.exports = { parseLogs };
