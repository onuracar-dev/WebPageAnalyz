const { AppError } = require('../lib/errors');
const { createOpenRouterProvider } = require('./openrouter-provider');
const { normalizeFindingForAI } = require('./redaction');
const { validateRemediation } = require('./schemas');
const { evaluationFindings } = require('./fixtures/evaluation-findings');

function qualityFor(fixture, output, schemaValid) {
    const serialized = JSON.stringify(output).toLowerCase();
    const checks = Object.freeze({
        schema: schemaValid,
        expectedTerminology: fixture.expectedKeywords.every((keyword) => serialized.includes(keyword)),
        actionableSteps: Array.isArray(output?.steps) && output.steps.length >= 2,
        verificationCaveat: Array.isArray(output?.caveats) && output.caveats.some((item) => /doğrula|verify|kanıt|ölçüm/i.test(item)),
        noGuarantee: !/\b(?:guaranteed?|garanti eder|kesin olarak|will increase)\b/i.test(serialized)
    });
    return { checks, score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length };
}

function emptyMetrics() {
    return { latencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costCredits: '0' };
}

async function runRemediationEvaluation({
    provider = null,
    fixtures = evaluationFindings,
    live = false,
    allowProviderCalls = false
} = {}) {
    if (live && allowProviderCalls !== true) throw new AppError('Live AI evaluation calls require an explicit opt-in.', { status: 403, code: 'AI_EVAL_LIVE_CALLS_DISABLED', expose: true });
    if (live && (!provider || typeof provider.generateRemediation !== 'function')) throw new AppError('Live AI evaluation requires a provider.', { status: 503, code: 'AI_EVAL_PROVIDER_REQUIRED', expose: true });
    const records = [];
    for (const fixture of fixtures) {
        const minimalFinding = normalizeFindingForAI(fixture.finding);
        const startedAt = Date.now();
        try {
            const result = live
                ? await provider.generateRemediation(minimalFinding)
                : { output: fixture.expectedOutput, metadata: emptyMetrics() };
            const output = validateRemediation(result.output);
            const quality = qualityFor(fixture, output, true);
            const metadata = result.metadata || {};
            records.push(Object.freeze({
                fixtureId: fixture.id,
                mode: live ? 'live' : 'synthetic',
                status: 'passed',
                schemaValid: true,
                qualityScore: quality.score,
                qualityChecks: quality.checks,
                usefulRemediation: quality.score >= 0.8,
                technicalCorrectness: quality.checks.expectedTerminology && quality.checks.actionableSteps,
                hallucinationDetected: !quality.checks.noGuarantee,
                humanReview: 'not_reviewed',
                latencyMs: live ? metadata.latencyMs ?? Date.now() - startedAt : 0,
                promptTokens: metadata.usage?.promptTokens ?? metadata.promptTokens ?? 0,
                completionTokens: metadata.usage?.completionTokens ?? metadata.completionTokens ?? 0,
                totalTokens: metadata.usage?.totalTokens ?? metadata.totalTokens ?? 0,
                costCredits: metadata.cost?.totalCredits ?? metadata.costCredits ?? '0',
                requestedModel: metadata.requestedModel ?? null,
                actualModel: metadata.actualModel ?? null,
                actualProvider: metadata.actualProvider ?? null
            }));
        } catch (error) {
            records.push(Object.freeze({
                fixtureId: fixture.id,
                mode: live ? 'live' : 'synthetic',
                status: 'failed',
                schemaValid: false,
                qualityScore: 0,
                qualityChecks: Object.freeze({}),
                usefulRemediation: false,
                technicalCorrectness: false,
                hallucinationDetected: null,
                humanReview: 'not_reviewed',
                latencyMs: Date.now() - startedAt,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                costCredits: '0',
                requestedModel: null,
                actualModel: null,
                actualProvider: null,
                errorCode: String(error?.code || 'AI_EVAL_FAILURE')
            }));
        }
    }
    const passed = records.filter((record) => record.status === 'passed').length;
    const schemaPassed = records.filter((record) => record.schemaValid).length;
    const totalCost = records.reduce((sum, record) => sum + (Number(record.costCredits) || 0), 0);
    const useful = records.filter((record) => record.usefulRemediation).length;
    const technicallyCorrect = records.filter((record) => record.technicalCorrectness).length;
    const hallucinations = records.filter((record) => record.hallucinationDetected === true).length;
    return Object.freeze({
        mode: live ? 'live' : 'synthetic',
        summary: Object.freeze({
            fixtures: records.length,
            passed,
            failed: records.length - passed,
            schemaPassRate: records.length ? schemaPassed / records.length : 0,
            usefulRemediationRate: records.length ? useful / records.length : 0,
            technicalCorrectnessRate: records.length ? technicallyCorrect / records.length : 0,
            hallucinationRate: records.length ? hallucinations / records.length : 0,
            meanQualityScore: records.length ? records.reduce((sum, record) => sum + record.qualityScore, 0) / records.length : 0,
            totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
            totalCostCredits: String(totalCost),
            estimatedCostPer1000RemediationsCredits: String(records.length ? (totalCost / records.length) * 1_000 : 0),
            humanReviewRequired: true
        }),
        records: Object.freeze(records)
    });
}

async function cli(env = process.env, argv = process.argv.slice(2)) {
    const live = argv.includes('--live');
    const allowProviderCalls = env.AI_EVAL_ALLOW_PROVIDER_CALLS === 'true';
    let provider = null;
    if (live && allowProviderCalls) {
        provider = createOpenRouterProvider({
            apiKey: env.OPENROUTER_API_KEY,
            primaryModel: env.OPENROUTER_MODEL_PRIMARY,
            fallbackModels: String(env.OPENROUTER_MODEL_FALLBACKS || '').split(',').map((item) => item.trim()).filter(Boolean),
            httpReferer: env.OPENROUTER_SITE_URL,
            appTitle: env.OPENROUTER_APP_NAME
        });
    }
    const result = await runRemediationEvaluation({ provider, live, allowProviderCalls });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.summary.failed) process.exitCode = 1;
}

if (require.main === module) cli().catch((error) => { process.stderr.write(`${error.code || 'AI_EVAL_FAILURE'}\n`); process.exitCode = 1; });

module.exports = { qualityFor, runRemediationEvaluation };
