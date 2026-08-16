const { SafeBrowserProxy } = require('../security/safe-proxy');
const { createFinding } = require('../domain/findings');

const VERSION = '2.17.0';
const riskSeverity = Object.freeze({ High: 'high', Medium: 'medium', Low: 'low', Informational: 'info' });
const confidenceMap = Object.freeze({ High: 0.95, Medium: 0.8, Low: 0.6, 'False Positive': 0.2 });
let zapLock = Promise.resolve();

async function acquireZapLock() {
    const previous = zapLock;
    let release;
    zapLock = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
}

function redact(value) {
    return String(value || '')
        .replace(/([?&](?:token|key|secret|password|auth|session)=)[^&#\s]+/gi, '$1[REDACTED]')
        .replace(/(authorization|cookie|set-cookie):\s*[^\r\n]+/gi, '$1: [REDACTED]')
        .slice(0, 2_000);
}

function normalizeAlert(alert, pageUrl) {
    const severity = riskSeverity[alert.risk] || riskSeverity[alert.riskdesc?.split(' ')[0]] || 'low';
    const confidenceLabel = alert.confidence || alert.confidenceDesc || alert.confidencedesc || 'Medium';
    const safeAlertUrl = (() => { try { const parsed = new URL(alert.url || pageUrl); parsed.search = ''; parsed.hash = ''; return parsed.href; } catch { return pageUrl; } })();
    return {
        ...createFinding({
            ruleId: `zap:${alert.pluginId || alert.alertRef || 'unknown'}`,
            category: 'security',
            title: alert.name || alert.alert || 'Passive security finding',
            description: redact(alert.description || alert.desc),
            severity,
            confidence: confidenceMap[confidenceLabel] || 0.75,
            kind: 'measured',
            pageUrl: safeAlertUrl,
            source: 'OWASP ZAP Baseline',
            sourceVersion: VERSION,
            remediation: redact(alert.solution),
            evidenceKey: `${alert.pluginId || ''}:${safeAlertUrl}:${alert.method || 'GET'}:${alert.param || ''}`,
            evidence: [{ type: 'http', name: 'passiveAlert', value: { method: alert.method || 'GET', parameter: redact(alert.param), evidence: redact(alert.evidence), reference: redact(alert.reference) } }]
        }),
        moduleId: 'passive_security',
        normalizedImpact: { high: 75, medium: 50, low: 25, info: 5 }[severity]
    };
}

function createZapClient(baseUrl, apiKey, signal) {
    async function call(component, type, action, params = {}) {
        const url = new URL(`/JSON/${component}/${type}/${action}/`, baseUrl);
        url.searchParams.set('apikey', apiKey);
        for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
        const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw Object.assign(new Error(`ZAP API returned ${response.status}.`), { code: 'ZAP_API_FAILED' });
        const text = await response.text();
        if (text.length > 20 * 1024 * 1024) throw Object.assign(new Error('ZAP response exceeded the size limit.'), { code: 'ZAP_OUTPUT_TOO_LARGE' });
        return JSON.parse(text);
    }
    return { call };
}

async function waitFor(client, component, scanId, signal, maxAttempts = 120) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        signal?.throwIfAborted();
        const result = await client.call(component, 'view', 'status', scanId ? { scanId } : {});
        if (Number(result.status) >= 100) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw Object.assign(new Error('ZAP scan timed out.'), { code: 'ZAP_TIMEOUT' });
}

async function runZapBaseline(url, { signal, config, logger, proxyFactory, distributedLock } = {}) {
    if (!config.zap?.url || !config.zap?.apiKey) throw Object.assign(new Error('ZAP runner is not configured.'), { code: 'ZAP_UNAVAILABLE' });
    const origin = new URL(url).origin;
    const release = distributedLock ? await distributedLock.acquire(signal) : await acquireZapLock();
    const proxy = proxyFactory ? proxyFactory() : new SafeBrowserProxy({
        allowedPorts: config.allowedTargetPorts,
        logger,
        connectTimeoutMs: config.timeouts.proxyConnectMs,
        ...config.proxyLimits,
        allowedOrigins: [origin],
        readOnly: true
    });
    let client;
    let session;
    try {
        const proxyUrl = await proxy.start({ bindHost: config.zap.proxyBindHost, advertisedHost: config.zap.proxyAdvertisedHost });
        const parsedProxy = new URL(proxyUrl);
        client = createZapClient(config.zap.url, config.zap.apiKey, signal);
        session = `wpa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await client.call('core', 'action', 'newSession', { name: session, overwrite: true });
        await client.call('core', 'action', 'setOptionProxyChainName', { String: parsedProxy.hostname });
        await client.call('core', 'action', 'setOptionProxyChainPort', { Integer: parsedProxy.port });
        await client.call('core', 'action', 'setOptionUseProxyChain', { Boolean: true });
        const started = await client.call('spider', 'action', 'scan', { url, maxChildren: config.zap.maxUrls, recurse: true, subtreeOnly: true });
        const scanId = started.scan;
        await waitFor(client, 'spider', scanId, signal, config.zap.maxPollAttempts);
        let pending = 0;
        for (let attempt = 0; attempt < config.zap.maxPollAttempts; attempt++) {
            const result = await client.call('pscan', 'view', 'recordsToScan');
            pending = Number(result.recordsToScan) || 0;
            if (!pending) break;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        const maxAlerts = Math.max(1, Number(config.zap.maxAlerts) || 1_000);
        const pageSize = Math.min(100, maxAlerts);
        const alerts = [];
        for (let start = 0; start < maxAlerts; start += pageSize) {
            const result = await client.call('core', 'view', 'alerts', { baseurl: origin, start, count: pageSize });
            const page = Array.isArray(result.alerts) ? result.alerts : [];
            alerts.push(...page);
            if (page.length < pageSize) break;
        }
        const truncated = alerts.length >= maxAlerts || pending > 0;
        return { version: VERSION, status: truncated ? 'incomplete' : 'completed', scannedOrigin: origin, findings: alerts.slice(0, maxAlerts).map((alert) => normalizeAlert(alert, url)), coverage: { spiderId: scanId, alerts: Math.min(alerts.length, maxAlerts), activeScan: pending > 0, pagination: true, truncated } };
    } finally {
        if (client) await client.call('core', 'action', 'endSession', { name: session }).catch(() => {});
        await proxy.stop().catch(() => {});
        release();
    }
}

module.exports = { VERSION, redact, normalizeAlert, runZapBaseline, acquireZapLock };
