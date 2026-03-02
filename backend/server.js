require('dotenv').config();
const express = require('express');
const cors = require('cors');

process.on('unhandledRejection', (err) => {
    console.warn('Unhandled Rejection Ignored:', err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const { runLighthouse } = require('./analyzers/lighthouse');
const { runYellowLab } = require('./analyzers/yellowlab');
const { runAxe } = require('./analyzers/axe');
const { parseLogs } = require('./utils/parser');
const fs = require('fs').promises;
const path = require('path');

// Friendly fallback for browser direct access
app.get('/api/analyze', (req, res) => {
    res.json({ message: "Backend API is up and running. Please send a POST request with { url: '...' } to use this endpoint." });
});

app.get('/api/solve', (req, res) => {
    res.json({ message: "AI API is up and running. Please send a POST request with the issue context." });
});

// Main Analysis Route
app.post('/api/analyze', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`Starting analysis for URL: ${url}`);

        // Run Analyzers Concurrently
        console.log('Running Lighthouse, YellowLab, and Axe DevTools concurrently...');
        const [lighthouseResult, yellowlabResult, axeResult] = await Promise.allSettled([
            runLighthouse(url).catch(e => { console.error('Lighthouse Failed:', e); return null; }),
            runYellowLab(url).catch(e => { console.warn('YellowLab Error:', e.message); return { error: e.message }; }),
            runAxe(url).catch(e => { console.error('Axe Failed:', e); return null; })
        ]);

        const lhData = lighthouseResult.status === 'fulfilled' ? lighthouseResult.value : null;
        const ylData = yellowlabResult.status === 'fulfilled' ? yellowlabResult.value : null;
        const axeData = axeResult.status === 'fulfilled' ? axeResult.value : null;

        // 5. Parse Logs for Dashboard
        console.log('Parsing logs for dashboard...');
        const logPaths = {
            lighthouseDesktop: lhData ? lhData.desktopPath : null,
            lighthouseMobile: lhData ? lhData.mobilePath : null,
            yellowlab: ylData && !ylData.error ? ylData.logPath : null,
            axe: axeData ? axeData.logPath : null
        };

        let parsedReport = null;
        try {
            parsedReport = await parseLogs(logPaths);
        } catch (parseError) {
            console.error('ParseLogs Error:', parseError);
            throw new Error(`ParseLogs failed: ${parseError.message}`);
        }

        res.json({
            message: 'Analysis completed successfully',
            url,
            report: parsedReport
        });
    } catch (error) {
        console.error('Analysis Error:', error);
        res.status(500).json({ error: 'An error occurred during analyzing.', details: error.message });
    }
});

// Clear Logs Route
app.delete('/api/logs', async (req, res) => {
    try {
        const dir = __dirname;
        const files = await fs.readdir(dir);
        let deletedCount = 0;

        for (const file of files) {
            if (file.endsWith('.json') &&
                (file.startsWith('lighthouse_') || file.startsWith('yellowlab_') || file.startsWith('axe_'))) {
                try {
                    await fs.unlink(path.join(dir, file));
                    deletedCount++;
                } catch (err) {
                    console.error(`Failed to delete ${file}:`, err);
                }
            }
        }
        res.json({ message: `Successfully cleared ${deletedCount} log files.` });
    } catch (error) {
        console.error('Clear logs error:', error);
        res.status(500).json({ error: 'Failed to clear logs.' });
    }
});

// On-Demand AI Solve Route
app.post('/api/solve', async (req, res) => {
    const { issue } = req.body;
    if (!issue || !issue.title) {
        return res.status(400).json({ error: 'Issue context is required' });
    }

    try {
        console.log(`Getting AI solution for issue: ${issue.title}`);
        const { solveIssueWithGemini } = require('./analyzers/gemini');
        const solution = await solveIssueWithGemini(issue);
        res.json({ solution });
    } catch (error) {
        console.error('Solve API Error:', error);
        res.status(500).json({ error: 'Failed to generate solution.' });
    }
});

// Executive Summary Route
app.post('/api/executive-summary', async (req, res) => {
    const { scores } = req.body;
    if (!scores) {
        return res.status(400).json({ error: 'Scores object is required' });
    }

    try {
        const { generateExecutiveSummary } = require('./analyzers/gemini');
        const summary = await generateExecutiveSummary(scores);
        res.json({ summary });
    } catch (error) {
        console.error('Executive Summary API Error:', error);
        res.status(500).json({ error: 'Failed to generate executive summary.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
