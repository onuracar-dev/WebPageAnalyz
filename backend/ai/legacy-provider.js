const { AppError } = require('../lib/errors');
const { AIProvider } = require('./provider');
const { normalizeExecutiveInput, normalizeFindingForAI } = require('./redaction');
const {
    EXECUTIVE_SUMMARY_SCHEMA_VERSION,
    REMEDIATION_SCHEMA_VERSION,
    validateExecutiveSummary,
    validateRemediation
} = require('./schemas');

function boundedLegacyText(value, maxLength) {
    const text = String(value || '').replace(/\0/g, '').trim();
    if (!text) throw new AppError('Legacy AI provider returned an empty response.', { status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE' });
    return text.slice(0, maxLength);
}

class LegacyAIProvider extends AIProvider {
    constructor({ service, providerName = 'legacy', modelName = null } = {}) {
        super({ name: String(providerName || 'legacy'), configured: Boolean(service) });
        this.service = service;
        this.modelName = modelName ? String(modelName) : null;
    }

    assertConfigured() {
        if (!this.service) throw new AppError('Legacy AI provider is not configured.', { status: 503, code: 'AI_NOT_CONFIGURED', expose: true });
    }

    metadata(startedAt) {
        return Object.freeze({
            provider: this.name,
            requestedModel: this.modelName,
            requestedModels: Object.freeze(this.modelName ? [this.modelName] : []),
            actualModel: this.modelName,
            actualProvider: this.name,
            providerRequestId: null,
            latencyMs: Date.now() - startedAt,
            clientAttempts: 1,
            usage: Object.freeze({ promptTokens: null, completionTokens: null, totalTokens: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null }),
            cost: Object.freeze({ totalCredits: null, upstreamInferenceCredits: null }),
            routing: Object.freeze({ strategy: 'legacy-adapter', region: null, routerAttempt: null, fallbackUsed: false }),
            legacyUnstructured: true
        });
    }

    async generateRemediation(finding, context = {}) {
        this.assertConfigured();
        const normalized = normalizeFindingForAI(finding);
        const startedAt = Date.now();
        const text = boundedLegacyText(await this.service.solveIssue(normalized, context.signal), 4_000);
        const output = validateRemediation({
            schemaVersion: REMEDIATION_SCHEMA_VERSION,
            summary: text.slice(0, 800),
            likelyCause: 'Legacy adapter output is unstructured; the likely cause must be verified.',
            steps: [text.slice(0, 800)],
            codeExample: null,
            caveats: ['This response came through the optional legacy adapter and was not constrained by provider-side JSON Schema.'],
            confidence: 'low'
        });
        return Object.freeze({ operation: 'remediation', output, metadata: this.metadata(startedAt) });
    }

    async generateExecutiveSummary(input, context = {}) {
        this.assertConfigured();
        const normalized = normalizeExecutiveInput(input);
        const startedAt = Date.now();
        const text = boundedLegacyText(await this.service.generateExecutiveSummary(normalized.scores, context.signal), 4_000);
        const scoreFacts = Object.entries(normalized.scores).slice(0, 12).map(([name, score]) => `${name}: ${score}/100`);
        const output = validateExecutiveSummary({
            schemaVersion: EXECUTIVE_SUMMARY_SCHEMA_VERSION,
            overview: text.slice(0, 1_200),
            measuredFacts: scoreFacts,
            risks: ['Legacy narrative risks must be reviewed against the measured audit evidence.'],
            priorities: [{ title: 'Validate legacy narrative', rationale: 'Provider-side structured output was unavailable for this adapter.' }],
            caveats: ['This response came through the optional legacy adapter and was not constrained by provider-side JSON Schema.']
        });
        return Object.freeze({ operation: 'executive-summary', output, metadata: this.metadata(startedAt) });
    }
}

function createLegacyAIProvider(options) {
    return new LegacyAIProvider(options);
}

module.exports = {
    GeminiAIProvider: LegacyAIProvider,
    LegacyAIProvider,
    createGeminiAIProvider: createLegacyAIProvider,
    createLegacyAIProvider
};
