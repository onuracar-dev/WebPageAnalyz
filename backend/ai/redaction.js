const SECRET_PATTERNS = Object.freeze([
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[redacted-private-key]'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
    [/\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/gi, '[redacted-secret]'],
    [/\bAIza[\w-]{20,}\b/g, '[redacted-secret]'],
    [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi, '[redacted-secret]'],
    [/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,})\b/g, '[redacted-secret]'],
    [/\bAKIA[A-Z0-9]{16}\b/g, '[redacted-secret]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]'],
    [/(\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@'],
    [/(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'],
    [/(password|passphrase|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token)\s*[:=]\s*["']?[^\s,"';}]+/gi, '$1=[redacted]'],
    [/([?&](?:password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token)=)[^&#\s"'<>]+/gi, '$1[redacted]'],
    [/^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=.*$/gm, '[redacted-environment-variable]'],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]']
]);

function redactText(value, { maxLength = 4_000 } = {}) {
    let text = String(value ?? '').replace(/\0/g, '').slice(0, maxLength);
    for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
    return text.trim();
}

function optionalText(value, maxLength) {
    const redacted = redactText(value, { maxLength });
    return redacted || null;
}

function normalizeFindingForAI(finding = {}) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        throw Object.assign(new TypeError('Finding must be an object.'), { code: 'AI_INPUT_INVALID' });
    }
    const title = redactText(finding.title, { maxLength: 240 });
    const description = redactText(finding.description, { maxLength: 2_000 });
    if (!title || !description) throw Object.assign(new TypeError('Finding title and description are required.'), { code: 'AI_INPUT_INVALID' });
    return Object.freeze({
        id: optionalText(finding.id, 120),
        title,
        description,
        source: optionalText(finding.source, 120),
        category: optionalText(finding.category, 120),
        severity: optionalText(finding.severity, 40),
        snippet: optionalText(finding.snippet, 2_000),
        displayValue: optionalText(finding.displayValue, 500)
    });
}

function normalizeExecutiveInput(input = {}) {
    const scores = input?.scores && typeof input.scores === 'object' && !Array.isArray(input.scores)
        ? input.scores
        : input;
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
        throw Object.assign(new TypeError('Executive summary scores must be an object.'), { code: 'AI_INPUT_INVALID' });
    }
    const normalized = {};
    for (const [rawKey, rawValue] of Object.entries(scores).slice(0, 20)) {
        const key = redactText(rawKey, { maxLength: 80 }).replace(/[^\p{L}\p{N} _.-]/gu, '').trim();
        const value = Number(rawValue);
        if (key && Number.isFinite(value) && value >= 0 && value <= 100) normalized[key] = Math.round(value * 100) / 100;
    }
    if (!Object.keys(normalized).length) throw Object.assign(new TypeError('At least one 0-100 score is required.'), { code: 'AI_INPUT_INVALID' });
    return Object.freeze({ scores: Object.freeze(normalized) });
}

module.exports = { normalizeExecutiveInput, normalizeFindingForAI, redactText };
