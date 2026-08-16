const TRACKING_PARAMETERS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi'
]);
const SENSITIVE_PARAMETERS = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|signature|auth(?:orization)?|credential|session|code)/i;

function isTrackingParameter(name) {
    const normalized = name.toLowerCase();
    return normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized);
}

function normalizePageUrl(value) {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
        parsed.port = '';
    }

    const retained = [...parsed.searchParams.entries()]
        .filter(([name]) => !isTrackingParameter(name) && !SENSITIVE_PARAMETERS.test(name))
        .sort(([leftName, leftValue], [rightName, rightValue]) => (
            leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
        ));
    parsed.search = '';
    for (const [name, parameterValue] of retained) parsed.searchParams.append(name, parameterValue);

    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString();
}

function pageCreditKey(value) {
    return normalizePageUrl(value);
}

function projectOrigin(value) {
    const parsed = new URL(normalizePageUrl(value));
    return parsed.origin;
}

module.exports = { isTrackingParameter, normalizePageUrl, pageCreditKey, projectOrigin };
