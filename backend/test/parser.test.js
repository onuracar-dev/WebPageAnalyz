const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { parseLogs } = require('../utils/parser');

function lighthouseReport(score, title) {
    const categories = Object.fromEntries(
        ['performance', 'seo', 'accessibility', 'best-practices'].map((category) => [category, {
            score,
            auditRefs: [{ id: `${category}-audit` }]
        }])
    );
    const audits = Object.fromEntries(
        Object.keys(categories).map((category) => [`${category}-audit`, {
            id: `${category}-audit`,
            title: `${title} ${category}`,
            description: 'Finding',
            score: score - 0.1,
            scoreDisplayMode: 'numeric'
        }])
    );
    return { categories, audits };
}

test('parser preserves separate desktop and mobile Lighthouse reports', async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webpage-parser-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const desktopPath = path.join(directory, 'desktop.json');
    const mobilePath = path.join(directory, 'mobile.json');
    await fs.writeFile(desktopPath, JSON.stringify(lighthouseReport(0.9, 'Desktop')));
    await fs.writeFile(mobilePath, JSON.stringify(lighthouseReport(0.6, 'Mobile')));

    const report = await parseLogs({ lighthouseDesktop: desktopPath, lighthouseMobile: mobilePath });

    assert.equal(report.scores.performance, 90);
    assert.equal(report.devices.desktop.scores.performance, 90);
    assert.equal(report.devices.mobile.scores.performance, 60);
    assert.equal(report.devices.mobile.categories.performance[0].source, 'Lighthouse (Mobile)');
});

test('parser reports missing Lighthouse scores as unavailable instead of zero', async () => {
    const report = await parseLogs({});
    assert.equal(report.scores.performance, null);
    assert.deepEqual(report.devices, {});
});
