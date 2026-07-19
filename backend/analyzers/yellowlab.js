const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { abortableDelay } = require('../lib/abort');
const { AppError } = require('../lib/errors');

const API_BASE = 'https://yellowlab.tools/api';

async function responseJson(response, operation) {
    if (!response.ok) {
        throw new AppError(`YellowLab ${operation} failed.`, {
            status: 502,
            code: 'YELLOWLAB_UPSTREAM_ERROR'
        });
    }
    try {
        return await response.json();
    } catch (error) {
        throw new AppError(`YellowLab ${operation} returned invalid data.`, {
            status: 502,
            code: 'YELLOWLAB_INVALID_RESPONSE',
            cause: error
        });
    }
}

async function runYellowLab(url, {
    artifactDir,
    signal,
    fetchImpl = fetch,
    maxPollAttempts = 24,
    pollIntervalMs = 5_000
} = {}) {
    const postResponse = await fetchImpl(`${API_BASE}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url }),
        signal
    });
    const postData = await responseJson(postResponse, 'submission');
    const runId = String(postData.runId || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
        throw new AppError('YellowLab returned an invalid run identifier.', {
            status: 502,
            code: 'YELLOWLAB_INVALID_RESPONSE'
        });
    }

    let resultData;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        await abortableDelay(pollIntervalMs, signal);
        const statusResponse = await fetchImpl(`${API_BASE}/runs/${encodeURIComponent(runId)}`, { signal });
        const statusData = await responseJson(statusResponse, 'status request');
        const status = statusData.status?.statusCode ?? statusData.status ?? statusData.state;

        if ([4, 'completed', 'complete'].includes(status)) {
            const resultResponse = await fetchImpl(`${API_BASE}/results/${encodeURIComponent(runId)}?all=true`, { signal });
            resultData = await responseJson(resultResponse, 'result request');
            break;
        }
        if ([5, 'failed', 'error'].includes(status)) {
            throw new AppError('YellowLab could not analyze the target.', {
                status: 502,
                code: 'YELLOWLAB_ANALYSIS_FAILED'
            });
        }
    }

    if (!resultData) {
        throw new AppError('YellowLab did not finish before the polling limit.', {
            status: 504,
            code: 'YELLOWLAB_TIMEOUT'
        });
    }

    const profile = resultData.scoreProfiles?.generic;
    const issues = Object.entries(resultData.rules || {}).flatMap(([ruleKey, rule]) => {
        if (!rule || (!rule.bad && !rule.abnormal)) return [];
        return [{
            rule: ruleKey.slice(0, 256),
            score: Number.isFinite(rule.score) ? rule.score : null,
            penalty: Number.isFinite(rule.abnormalityScore) ? rule.abnormalityScore : null,
            message: String(rule.policy?.message || 'YellowLab rule violation').slice(0, 2_000)
        }];
    }).slice(0, 250);
    const cleanedData = {
        runId,
        globalScore: Number.isFinite(profile?.globalScore) ? profile.globalScore : null,
        categories: profile?.categories || {},
        issues
    };

    await fs.mkdir(artifactDir, { recursive: true });
    const logPath = path.join(artifactDir, `yellowlab_${crypto.randomUUID()}.json`);
    await fs.writeFile(logPath, JSON.stringify(cleanedData), { mode: 0o600 });
    return { logPath, score: cleanedData.globalScore };
}

module.exports = { runYellowLab };
