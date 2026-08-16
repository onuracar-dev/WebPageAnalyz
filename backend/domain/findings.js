const crypto = require('node:crypto');

const severities = new Set(['critical', 'high', 'medium', 'low', 'info']);
const kinds = new Set(['measured', 'heuristic', 'ai', 'human']);

function stableFingerprint({ ruleId, pageUrl, evidenceKey = '' }) {
    return crypto.createHash('sha256')
        .update(`${ruleId}\n${pageUrl}\n${evidenceKey}`)
        .digest('hex');
}

function createFinding({
    ruleId,
    category,
    title,
    description,
    severity = 'medium',
    confidence = 0.8,
    kind = 'measured',
    pageUrl,
    source,
    sourceVersion = '1',
    evidence = [],
    remediation = '',
    evidenceKey = '',
    moduleId = null,
    engineId = null,
    device = null,
    coverage = null
}) {
    if (!ruleId || !category || !title || !pageUrl || !source) throw new TypeError('Finding identity fields are required.');
    if (!severities.has(severity)) throw new TypeError(`Unsupported finding severity: ${severity}`);
    if (!kinds.has(kind)) throw new TypeError(`Unsupported finding kind: ${kind}`);
    const boundedConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    return Object.freeze({
        id: stableFingerprint({ ruleId, pageUrl, evidenceKey }).slice(0, 24),
        fingerprint: stableFingerprint({ ruleId, pageUrl, evidenceKey }),
        ruleId,
        category,
        title: String(title).slice(0, 300),
        description: String(description || '').slice(0, 10_000),
        severity,
        confidence: boundedConfidence,
        kind,
        pageUrl,
        source: Object.freeze({ name: source, version: String(sourceVersion) }),
        ...(moduleId ? { moduleId: String(moduleId) } : {}),
        ...(engineId ? { engineId: String(engineId) } : {}),
        ...(device ? { device: String(device) } : {}),
        ...(coverage ? { coverage: Object.freeze(coverage) } : {}),
        evidence: Object.freeze(evidence.slice(0, 20)),
        remediation: String(remediation || '').slice(0, 10_000)
    });
}

module.exports = { createFinding, stableFingerprint };
