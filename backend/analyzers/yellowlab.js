const fs = require('fs').promises;
const path = require('path');

async function runYellowLab(url) {
    try {
        console.log(`Starting YellowLabTools analysis via Public API for: ${url}`);

        // 1. Submit the run
        const postRes = await fetch('https://yellowlab.tools/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ url: url })
        });

        if (!postRes.ok) {
            throw new Error(`YellowLab API POST Error: ${postRes.statusText}`);
        }

        const postData = await postRes.json();
        const runId = postData.runId;
        console.log(`YellowLab run created with ID: ${runId}. Polling for results...`);

        // 2. Poll for completion
        let resultData = null;
        const maxAttempts = Number(process.env.YELLOWLAB_MAX_POLL_ATTEMPTS || 24);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(r => setTimeout(r, 5000)); // sleep 5 seconds

            const getRes = await fetch(`https://yellowlab.tools/api/runs/${runId}`);
            if (!getRes.ok) {
                throw new Error(`YellowLab API GET Error: ${getRes.statusText}`);
            }
            const getData = await getRes.json();

            // In the YellowLab public API, the status string might just be returned as `getData.status.statusCode === 4` or it could be `getData.status === "completed"`.
            // Let's log the actual status to the console to debug, and break if it implies completion.
            const currentStatus = getData.status ? (getData.status.statusCode || getData.status) : getData.state;
            console.log(`YellowLab is still running... (status: ${currentStatus})`);

            if (currentStatus === 4 || currentStatus === 'completed' || currentStatus === 'complete') {
                // Now fetch the actual results
                const resultRes = await fetch(`https://yellowlab.tools/api/results/${runId}?all=true`);
                if (!resultRes.ok) throw new Error(`YellowLab API Result Fetch Error: ${resultRes.statusText}`);
                resultData = await resultRes.json();
                break;
            } else if (currentStatus === 5 || currentStatus === 'failed' || currentStatus === 'error') {
                throw new Error(`YellowLab Analysis Failed: ${getData.error || 'Unknown error'}`);
            }
        }

        if (!resultData) {
            throw new Error(`YellowLab Analysis timed out after ${maxAttempts} polling attempts`);
        }

        // 3. Save logs and return
        // Compress data to ensure Gemini prompt doesn't truncate the important parts
        const cleanedData = {
            runId: resultData.runId,
            globalScore: resultData.scoreProfiles ? resultData.scoreProfiles.generic.globalScore : null,
            categories: resultData.scoreProfiles ? resultData.scoreProfiles.generic.categories : {},
            // Extract the problems that had penalty points (bad or abnormal)
            issues: Object.keys(resultData.rules || {}).map(ruleKey => {
                const rule = resultData.rules[ruleKey];
                if (rule && (rule.bad || rule.abnormal)) {
                    return {
                        rule: ruleKey,
                        score: rule.score,
                        penalty: rule.abnormalityScore,
                        message: rule.policy ? rule.policy.message : "Unknown rule"
                    };
                }
                return null;
            }).filter(Boolean)
        };

        const logPath = path.join(__dirname, '..', `yellowlab_log_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
        await fs.writeFile(logPath, JSON.stringify(cleanedData, null, 2));

        return {
            logPath,
            score: resultData.scoreProfiles ? resultData.scoreProfiles.generic.globalScore : null
        };
    } catch (err) {
        console.error('YellowLab execution failed:', err);
        throw err;
    }
}

module.exports = { runYellowLab };
