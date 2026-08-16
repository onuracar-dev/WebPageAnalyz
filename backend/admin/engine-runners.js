const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { SafeBrowserProxy } = require('../security/safe-proxy');
const { runLighthouse } = require('../analyzers/lighthouse');
const { runYellowLab } = require('../analyzers/yellowlab');
const { runAxe } = require('../analyzers/axe');
const { runWpaPage } = require('../analyzers/wpa-page');
const { runAdvancedBrowser } = require('../analyzers/advanced-browser');
const { discoverSite } = require('../analyzers/crawler');
const { runZapBaseline } = require('../analyzers/zap-baseline');
const { chromeExecutable, chromeFlags } = require('../analyzers/browser-options');
const { inspectZip, extractZip } = require('../source/zip-security');
const { runOsv } = require('../source/osv-runner');

const MAX_LAB_FINDINGS = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_DEPTH = 4;
const SENSITIVE_KEYS = /^(?:authorization|cookie|token|password|secret|api[_-]?key|access[_-]?key)$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Analyzer adapters may return paths produced by a different runtime than the
// API process (for example a Windows worker feeding a Linux API container).
// `path.basename` follows the host OS and therefore leaves the other
// platform's separators in the public evidence filename. Normalize both
// separator styles for metadata only; artifact retrieval still validates the
// caller's filename and containment independently.
function portableBasename(value) {
    return path.posix.basename(String(value ?? '').replaceAll('\\', '/'));
}

function sanitizeUrl(value) {
    try {
        const parsed = new URL(String(value));
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function sanitizeText(value, limit = MAX_TEXT_LENGTH) {
    const text = String(value ?? '')
        .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url) || '[REDACTED_URL]')
        .replace(/(["']?(?:authorization|cookie|token|password|secret|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"';}\]]+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/[A-Za-z]:\\[^\s,;"']+/g, '[LOCAL_PATH]')
        .replace(/\/(?:home|Users|tmp|var\/tmp)\/[^\s,;"']+/g, '[LOCAL_PATH]');
    return text.slice(0, Math.max(0, limit));
}

function sanitizeEvidence(value, depth = 0) {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return sanitizeText(value, 2_000);
    if (depth >= MAX_EVIDENCE_DEPTH) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => sanitizeEvidence(entry, depth + 1));
    if (typeof value !== 'object') return sanitizeText(value, 2_000);

    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_EVIDENCE_ITEMS)) {
        if (UNSAFE_KEYS.has(key)) continue;
        output[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitizeEvidence(entry, depth + 1);
    }
    return output;
}

function optionalText(value, limit = MAX_TEXT_LENGTH) {
    return value === undefined || value === null ? null : sanitizeText(value, limit);
}

function sanitizeFinding(finding = {}) {
    const source = finding.source && typeof finding.source === 'object'
        ? { name: optionalText(finding.source.name, 120), version: optionalText(finding.source.version, 120) }
        : { name: optionalText(finding.source, 120), version: null };
    const nativeEvidence = Array.isArray(finding.evidence) ? finding.evidence : Array.isArray(finding.nodes)
        ? [{ type: 'axe-nodes', name: 'Affected elements', value: finding.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary, any: node.any, all: node.all, none: node.none })) }]
        : (finding.rule || Number.isFinite(finding.score) || Number.isFinite(finding.penalty))
            ? [{ type: 'yellowlab-rule', name: 'Rule measurements', value: { score: finding.score, penalty: finding.penalty } }]
            : [];
    return {
        id: optionalText(finding.id, 128),
        fingerprint: optionalText(finding.fingerprint, 128),
        ruleId: optionalText(finding.ruleId || finding.id || finding.rule || 'unknown', 256),
        category: optionalText(finding.category, 120),
        title: sanitizeText(finding.title || finding.help || finding.message || finding.description || 'Finding', 300),
        description: optionalText(finding.description || finding.message),
        severity: optionalText(finding.severity || finding.impact || 'info', 32),
        confidence: Number.isFinite(finding.confidence) ? finding.confidence : null,
        kind: optionalText(finding.kind, 32),
        pageUrl: sanitizeUrl(finding.pageUrl),
        source,
        normalizedImpact: Number.isFinite(finding.normalizedImpact) ? finding.normalizedImpact : null,
        evidence: nativeEvidence.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => sanitizeEvidence(entry)),
        remediation: optionalText(finding.remediation || (finding.helpUrl ? `Review the rule guidance at ${finding.helpUrl}` : null))
    };
}

function lighthouseFindings(lhr, device) {
    if (!lhr?.audits || typeof lhr.audits !== 'object') return [];
    return Object.values(lhr.audits)
        .filter((audit) => Number.isFinite(audit?.score) && audit.score < 1 && !['notApplicable', 'informative', 'manual'].includes(audit.scoreDisplayMode))
        .map((audit) => ({
            ruleId: `lighthouse.${audit.id}.${device}`,
            category: 'lighthouse', title: audit.title || audit.id,
            description: audit.description || audit.explanation || 'Lighthouse reported a failed audit.',
            severity: audit.score < 0.5 ? 'high' : audit.score < 0.9 ? 'medium' : 'low', confidence: 1, kind: 'measured',
            pageUrl: sanitizeUrl(lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl),
            source: { name: 'Lighthouse', version: lhr.lighthouseVersion || null },
            evidence: [{ type: 'lighthouse-audit', name: audit.id, value: { score: audit.score, displayValue: audit.displayValue, numericValue: audit.numericValue, explanation: audit.explanation, items: audit.details?.items } }],
            remediation: audit.explanation || `Review the Lighthouse ${audit.id} audit details and retest after the fix.`
        }));
}

async function jsonFile(filename) {
    if (!filename) return null;
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch { return null; }
}

function samples(findings = []) {
    return findings.slice(0, MAX_LAB_FINDINGS).map(sanitizeFinding);
}

function resultSummary(result, data, artifactDir) {
    const findings = data?.findings || data?.issues || data?.violations || result?.findings || [];
    const artifacts = [result?.logPath, result?.desktopPath, result?.mobilePath, ...(result?.artifactPaths || [])]
        .filter(Boolean)
        .map((filename) => portableBasename(filename));
    const screenshots = artifacts.filter((filename) => /\.(?:png|jpe?g|webp)$/i.test(filename)).map((filename) => {
        const device = /(?:^|_)(desktop|mobile)(?:_|\.)/i.exec(filename)?.[1]?.toLowerCase() || 'unknown';
        const extension = path.extname(filename).toLowerCase();
        return { kind: 'screenshot', label: `${device === 'unknown' ? 'Analyzer' : device[0].toUpperCase() + device.slice(1)} screenshot`, filename, device, mimeType: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg' };
    });
    return {
        findingsCount: Array.isArray(findings) ? findings.length : Number(result?.findingsCount || result?.violationsCount || 0),
        evidence: [
            ...(artifacts.length ? [{ kind: 'artifact', label: `${artifacts.length} analyzer artifact(s)`, artifacts }] : []),
            ...screenshots,
            ...(Array.isArray(findings) && findings.length ? [{
                kind: 'finding', label: `${findings.length} finding(s)`, totalFindings: findings.length,
                truncated: findings.length > MAX_LAB_FINDINGS, samples: samples(findings)
            }] : []),
            ...(result?.coverage ? [{ kind: 'coverage', label: 'Coverage', value: result.coverage }] : [])
        ],
        metrics: {
            ...(Number.isFinite(result?.desktopScore) ? { desktopScore: result.desktopScore } : {}),
            ...(Number.isFinite(result?.mobileScore) ? { mobileScore: result.mobileScore } : {}),
            ...(Number.isFinite(result?.score) ? { score: result.score } : {}),
            artifactScope: portableBasename(artifactDir)
        }
    };
}

async function retainLabScreenshots(artifactDir) {
    let entries = [];
    try { entries = await fs.readdir(artifactDir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
        const filename = path.join(artifactDir, entry.name);
        if (!entry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) return fs.rm(filename, { recursive: true, force: true });
        const stats = await fs.stat(filename).catch(() => null);
        if (!stats || stats.size > 8 * 1024 * 1024) await fs.rm(filename, { force: true });
    }));
}

function createDefaultEngineRunners({ config, logger, proxyFactory, zapLock = null } = {}) {
    let zapQueue = Promise.resolve();

    async function withExclusiveZap(task) {
        const previous = zapQueue;
        let release;
        zapQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        try { return await task(); }
        finally { release(); }
    }

    const createProxy = proxyFactory || ((target) => new SafeBrowserProxy({
        allowedPorts: config.allowedTargetPorts,
        allowedOrigins: [new URL(target.url).origin],
        readOnly: false,
        logger,
        connectTimeoutMs: config.timeouts.proxyConnectMs,
        ...config.proxyLimits
    }));

    async function browserEngine(context, execute) {
        const proxy = createProxy(context.target, context);
        await fs.mkdir(context.artifactDir, { recursive: true });
        try {
            const proxyUrl = await proxy.start();
            context.signal?.throwIfAborted();
            const result = await execute(proxyUrl);
            if (Number.isFinite(result?.findingsCount) && Array.isArray(result?.evidence)) return result;
            const data = await jsonFile(result?.logPath);
            return resultSummary(result, data, context.artifactDir);
        } finally {
            await proxy.stop().catch((error) => logger.warn('Engine Lab proxy cleanup failed', { errorCode: error.code }));
            if (!config.keepArtifacts) await retainLabScreenshots(context.artifactDir).catch(() => {});
        }
    }

    const advanced = (moduleId) => (context) => browserEngine(context, async (proxyUrl) => {
        const result = await runAdvancedBrowser(context.target.url, {
            artifactDir: context.artifactDir, proxyUrl, signal: context.signal, config,
            modules: [moduleId], ...(moduleId === 'journey_test' ? { journey: context.journey } : {})
        });
        const data = await jsonFile(result.logPath);
        const summary = resultSummary(result, data, context.artifactDir);
        if (moduleId === 'journey_test') {
            summary.journey = result.journey;
            summary.findingsCount = data?.findings?.length || 0;
            summary.evidence.push({ kind: 'journey', label: result.journey?.status || 'unknown', value: result.journey });
        }
        return summary;
    });

    return {
        lighthouse: (context) => browserEngine(context, async (proxyUrl) => {
            const result = await runLighthouse(context.target.url, { artifactDir: context.artifactDir, proxyUrl, signal: context.signal, config });
            const [desktop, mobile] = await Promise.all([jsonFile(result.desktopPath), jsonFile(result.mobilePath)]);
            return {
                ...result,
                findings: [...lighthouseFindings(desktop, 'desktop'), ...lighthouseFindings(mobile, 'mobile')],
                coverage: {
                    desktopCategories: desktop?.categories ? sanitizeEvidence(desktop.categories) : null,
                    mobileCategories: mobile?.categories ? sanitizeEvidence(mobile.categories) : null
                }
            };
        }),
        yellowLab: async (context) => {
            await fs.mkdir(context.artifactDir, { recursive: true });
            try {
                const result = await runYellowLab(context.target.url, { artifactDir: context.artifactDir, signal: context.signal, maxPollAttempts: config.yellowLabMaxPollAttempts });
                return resultSummary(result, await jsonFile(result.logPath), context.artifactDir);
            } finally { if (!config.keepArtifacts) await fs.rm(context.artifactDir, { recursive: true, force: true }).catch(() => {}); }
        },
        axe: (context) => browserEngine(context, (proxyUrl) => runAxe(context.target.url, { artifactDir: context.artifactDir, proxyUrl, signal: context.signal, config })),
        playwright: (context) => browserEngine(context, async (proxyUrl) => {
            let browser;
            try {
                browser = await chromium.launch({ headless: true, ...(chromeExecutable(config) ? { executablePath: chromeExecutable(config) } : {}), args: chromeFlags(proxyUrl, config) });
                const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
                const response = await page.goto(context.target.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                return { findingsCount: 0, evidence: [{ kind: 'coverage', label: 'Safe browser smoke', value: { status: response?.status() || 0, title: (await page.title()).slice(0, 300), finalUrl: new URL(page.url()).origin } }] };
            } finally { await browser?.close().catch(() => {}); }
        }),
        wpaPage: (context) => browserEngine(context, (proxyUrl) => runWpaPage(context.target.url, { artifactDir: context.artifactDir, proxyUrl, signal: context.signal, config })),
        crawler: async (context) => {
            const result = await discoverSite(context.target.url, { limit: context.crawlerLimit || 25, config, logger, signal: context.signal });
            return { findingsCount: result.findings.length, evidence: [{ kind: 'coverage', label: `${result.pages.length} page(s) discovered`, value: { pages: result.pages.length, urls: result.urls.length, robots: result.robots } }, ...(result.findings.length ? [{ kind: 'finding', label: `${result.findings.length} finding(s)`, samples: samples(result.findings) }] : [])] };
        },
        performancePlus: advanced('performance_plus'),
        advancedGeo: advanced('advanced_geo'),
        visualUx: advanced('visual_ux'),
        journey: advanced('journey_test'),
        zapBaseline: (context) => withExclusiveZap(async () => {
            context.signal?.throwIfAborted();
            const result = await runZapBaseline(context.target.url, { signal: context.signal, config, logger, distributedLock: context.zapLock || zapLock });
            return { findingsCount: result.findings.length, evidence: [{ kind: 'coverage', label: 'Passive ZAP coverage', value: result.coverage }, ...(result.findings.length ? [{ kind: 'finding', label: `${result.findings.length} finding(s)`, samples: samples(result.findings) }] : [])] };
        }),
        osvScanner: async (context) => {
            if (config.osvExecutionDisabled) throw Object.assign(new Error('OSV execution is available only in the isolated worker.'), { code: 'OSV_WORKER_REQUIRED' });
            if (!context.sourceBuffer) throw Object.assign(new Error('OSV source ZIP is required.'), { code: 'ENGINE_LAB_SOURCE_REQUIRED' });
            let directory;
            try {
                const inventory = await inspectZip(context.sourceBuffer);
                directory = await fs.mkdtemp(path.join(os.tmpdir(), `wpa-engine-lab-${crypto.randomUUID()}-`));
                await fs.chmod(directory, 0o700);
                const extracted = await extractZip(context.sourceBuffer, directory);
                const result = await runOsv(directory, { executable: config.osv.executable, isolationRunner: config.osv.isolationRunner, isolationArgs: config.osv.isolationArgs, timeoutMs: config.timeouts.osvMs, projectUrl: context.target.url, signal: context.signal });
                return { findingsCount: result.findings.length, evidence: [{ kind: 'coverage', label: `${result.coverage.manifests} manifest(s) scanned`, value: { ...result.coverage, extractedFiles: extracted.files.length, zipEntries: inventory.entries } }, ...(result.findings.length ? [{ kind: 'finding', label: `${result.findings.length} dependency finding(s)`, samples: samples(result.findings) }] : [])] };
            } finally {
                context.sourceBuffer.fill(0);
                if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            }
        }
    };
}

module.exports = { MAX_LAB_FINDINGS, createDefaultEngineRunners, lighthouseFindings, portableBasename, resultSummary, samples, sanitizeEvidence, sanitizeFinding, sanitizeText, sanitizeUrl };
