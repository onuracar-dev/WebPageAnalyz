const test = require('node:test');
const assert = require('node:assert/strict');
const { runRemediationEvaluation } = require('../ai/evaluation');
const { evaluationFindings } = require('../ai/fixtures/evaluation-findings');

test('deterministic evaluation covers at least twenty findings without invoking a provider', async () => {
    let calls = 0;
    const result = await runRemediationEvaluation({
        provider: { async generateRemediation() { calls += 1; throw new Error('must not call'); } }
    });
    assert.equal(evaluationFindings.length, 24);
    assert.equal(calls, 0);
    assert.deepEqual(result.summary, {
        fixtures: 24, passed: 24, failed: 0, schemaPassRate: 1, usefulRemediationRate: 1,
        technicalCorrectnessRate: 1, hallucinationRate: 0, meanQualityScore: 1,
        totalTokens: 0, totalCostCredits: '0', estimatedCostPer1000RemediationsCredits: '0', humanReviewRequired: true
    });
    for (const record of result.records) {
        assert.equal(record.schemaValid, true);
        assert.equal(record.latencyMs, 0);
        assert.equal(record.totalTokens, 0);
        assert.equal(record.costCredits, '0');
        assert.equal(record.humanReview, 'not_reviewed');
    }
});

test('live evaluation requires two explicit opt-ins before any provider call', async () => {
    let calls = 0;
    const provider = { async generateRemediation() { calls += 1; } };
    await assert.rejects(() => runRemediationEvaluation({ provider, live: true, allowProviderCalls: false }), { code: 'AI_EVAL_LIVE_CALLS_DISABLED' });
    assert.equal(calls, 0);
});
