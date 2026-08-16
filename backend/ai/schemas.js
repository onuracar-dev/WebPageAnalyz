const { AppError } = require('../lib/errors');
const { redactText } = require('./redaction');

const REMEDIATION_SCHEMA_VERSION = 'wpa.ai.remediation.v1';
const EXECUTIVE_SUMMARY_SCHEMA_VERSION = 'wpa.ai.executive-summary.v1';

const remediationSchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'summary', 'likelyCause', 'steps', 'codeExample', 'caveats', 'confidence'],
    properties: {
        schemaVersion: { type: 'string', const: REMEDIATION_SCHEMA_VERSION },
        summary: { type: 'string', minLength: 1, maxLength: 800 },
        likelyCause: { type: 'string', minLength: 1, maxLength: 1_200 },
        steps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 800 } },
        codeExample: { type: ['string', 'null'], maxLength: 4_000 },
        caveats: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 600 } },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
    }
});

const executiveSummarySchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'overview', 'measuredFacts', 'risks', 'priorities', 'caveats'],
    properties: {
        schemaVersion: { type: 'string', const: EXECUTIVE_SUMMARY_SCHEMA_VERSION },
        overview: { type: 'string', minLength: 1, maxLength: 1_200 },
        measuredFacts: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
        risks: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 600 } },
        priorities: {
            type: 'array', minItems: 1, maxItems: 3,
            items: {
                type: 'object', additionalProperties: false, required: ['title', 'rationale'],
                properties: {
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    rationale: { type: 'string', minLength: 1, maxLength: 600 }
                }
            }
        },
        caveats: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 600 } }
    }
});

function schemaError(message) {
    return new AppError(`AI response did not match the required schema: ${message}`, {
        status: 502,
        code: 'AI_SCHEMA_INVALID'
    });
}

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError(`${label} must be an object`);
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw schemaError(`${label} contains missing or unknown fields`);
}

function boundedString(value, label, maxLength, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string') throw schemaError(`${label} must be a string${nullable ? ' or null' : ''}`);
    const normalized = redactText(value, { maxLength });
    if (!normalized || normalized.length > maxLength) throw schemaError(`${label} length is invalid`);
    return normalized;
}

function stringArray(value, label, { min = 1, max, itemMax }) {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw schemaError(`${label} count is invalid`);
    return value.map((item, index) => boundedString(item, `${label}[${index}]`, itemMax));
}

function validateRemediation(value) {
    const input = plainObject(value, 'remediation');
    exactKeys(input, remediationSchema.required, 'remediation');
    if (input.schemaVersion !== REMEDIATION_SCHEMA_VERSION) throw schemaError('schemaVersion is unsupported');
    if (!['low', 'medium', 'high'].includes(input.confidence)) throw schemaError('confidence is invalid');
    return Object.freeze({
        schemaVersion: REMEDIATION_SCHEMA_VERSION,
        summary: boundedString(input.summary, 'summary', 800),
        likelyCause: boundedString(input.likelyCause, 'likelyCause', 1_200),
        steps: Object.freeze(stringArray(input.steps, 'steps', { max: 8, itemMax: 800 })),
        codeExample: boundedString(input.codeExample, 'codeExample', 4_000, { nullable: true }),
        caveats: Object.freeze(stringArray(input.caveats, 'caveats', { max: 6, itemMax: 600 })),
        confidence: input.confidence
    });
}

function validateExecutiveSummary(value) {
    const input = plainObject(value, 'executive summary');
    exactKeys(input, executiveSummarySchema.required, 'executive summary');
    if (input.schemaVersion !== EXECUTIVE_SUMMARY_SCHEMA_VERSION) throw schemaError('schemaVersion is unsupported');
    if (!Array.isArray(input.priorities) || input.priorities.length < 1 || input.priorities.length > 3) throw schemaError('priorities count is invalid');
    const priorities = input.priorities.map((priority, index) => {
        const item = plainObject(priority, `priorities[${index}]`);
        exactKeys(item, ['title', 'rationale'], `priorities[${index}]`);
        return Object.freeze({
            title: boundedString(item.title, `priorities[${index}].title`, 200),
            rationale: boundedString(item.rationale, `priorities[${index}].rationale`, 600)
        });
    });
    return Object.freeze({
        schemaVersion: EXECUTIVE_SUMMARY_SCHEMA_VERSION,
        overview: boundedString(input.overview, 'overview', 1_200),
        measuredFacts: Object.freeze(stringArray(input.measuredFacts, 'measuredFacts', { max: 12, itemMax: 500 })),
        risks: Object.freeze(stringArray(input.risks, 'risks', { max: 10, itemMax: 600 })),
        priorities: Object.freeze(priorities),
        caveats: Object.freeze(stringArray(input.caveats, 'caveats', { max: 6, itemMax: 600 }))
    });
}

module.exports = {
    EXECUTIVE_SUMMARY_SCHEMA_VERSION,
    REMEDIATION_SCHEMA_VERSION,
    executiveSummarySchema,
    remediationSchema,
    validateExecutiveSummary,
    validateRemediation
};
