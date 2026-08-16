const { AppError } = require('../lib/errors');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { getPlan, publicPlan, PLANS } = require('../domain/plans');
const { isAdminGrantableModule } = require('../domain/admin-entitlements');
const { normalizePageUrl, pageCreditKey, projectOrigin } = require('../domain/url-normalization');
const { workspacePlan, findingsFromPayload } = require('./store');
const { candidateTrapReason, discoverSite, isRobotsAllowed, resolveDiscoveryLimits, VERSION: CRAWLER_VERSION } = require('../analyzers/crawler');
const { DEFINITIONS, defaultScanModules, requiresVerifiedTarget } = require('../domain/modules');
const {
    CONTRACT_VERSION, REPORT_SCHEMA, requestedPageEngines, classifyErrorCode, remediationFor,
    pageIsComplete, summarizeModules, aggregateState, publicCapabilityContract
} = require('../domain/analysis-contract');
const { enqueueWorkerJob, assertWorkerJob } = require('./execution-boundary');

const QUEUE_NAME = 'wpa-scan';
const PAGE_QUEUE_NAME = 'wpa-scan-page';
const PAGE_TERMINAL = new Set(['completed', 'incomplete', 'failed', 'unavailable', 'cancelled']);
const ENGINE_VERSIONS = Object.freeze({ lighthouse: '13.4.1', axe: '4.12.1', yellowLab: 'current-api', playwright: '1.62.1', wpaPage: '1.1.0', crawler: CRAWLER_VERSION, performancePlus: '1.0.0', advancedGeo: '1.0.0', visualUx: '1.0.0', journey: '1.0.0', zapBaseline: '2.17.0', osvScanner: '2.3.8' });
const SHARE_EXPIRY_DAYS = Object.freeze([7, 30, 90]);
const MAX_RENDERED_DISCOVERY_LINKS = 500;
const RENDERED_ORIGIN_VALIDATION_CONCURRENCY = 8;
const RENDERED_DISCOVERY_VALIDATION_MS = 30_000;
const COMMERCIAL_PLAN_RANK = Object.freeze({ free: 0, signal: 1, studio: 2, enterprise: 3 });
const COMMERCIAL_CAPABILITIES = Object.freeze({
    report_export: { minimumPlan: 'signal', label: 'Report export' },
    report_compare: { minimumPlan: 'studio', label: 'Report comparison' },
    report_share: { minimumPlan: 'studio', label: 'Public report sharing' }
});

async function requireCommercialCapability(store, workspaceId, requesterUserId, capability) {
    const rule = COMMERCIAL_CAPABILITIES[capability];
    if (!rule) throw new AppError('Unknown commercial capability.', { status: 500, code: 'COMMERCIAL_CAPABILITY_UNKNOWN' });
    const plan = await workspacePlan(store, workspaceId, requesterUserId);
    const planId = plan.effectivePlanId || plan.id || 'free';
    if ((COMMERCIAL_PLAN_RANK[planId] ?? -1) < COMMERCIAL_PLAN_RANK[rule.minimumPlan]) {
        const minimumName = rule.minimumPlan[0].toUpperCase() + rule.minimumPlan.slice(1);
        throw new AppError(`${rule.label} requires the ${minimumName} plan or higher.`, { status: 403, code: 'PLAN_UPGRADE_REQUIRED' });
    }
    return plan;
}

function allowance(limitValue, usedValue, details = {}) {
    const limit = Math.max(0, Math.floor(Number(limitValue) || 0));
    const used = Math.max(0, Math.floor(Number(usedValue) || 0));
    return { limit, used, remaining: Math.max(0, limit - used), ...details };
}

function selectedEntitlements(plan, requestedModules) {
    const requested = requestedModules?.length ? [...new Set(requestedModules)] : defaultScanModules(plan);
    const snapshot = {};
    for (const moduleId of requested) {
        const entitlement = plan.entitlements[moduleId];
        if (!entitlement || entitlement.executionMode === 'disabled') {
            throw new AppError(`Module '${moduleId}' is not available on this plan.`, { status: 403, code: 'MODULE_NOT_ENTITLED' });
        }
        snapshot[moduleId] = entitlement;
    }
    return snapshot;
}

function coreSuccessCount(report) {
    const engines = report?.meta?.analyzers || {};
    return ['lighthouse', 'axe', 'yellowLab'].filter((engine) => engines[engine] === 'completed').length;
}

function scanDueAt(plan, now = new Date()) {
    const days = plan.id === 'enterprise' ? 5 : 3;
    return new Date(now.getTime() + days * 86_400_000).toISOString();
}

function reportFingerprints(report) {
    return new Set(findingsFromPayload(report?.payload).map((finding) => finding.fingerprint).filter(Boolean));
}

function publicSharePayload(payload = {}) {
    const summaryInput = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
    const summary = Object.fromEntries(['terminalState', 'requestedPages', 'completedPages', 'incompletePages', 'failedPages', 'unavailablePages'].filter((key) => summaryInput[key] !== undefined).map((key) => [key, summaryInput[key]]));
    const modulesInput = payload.modules && typeof payload.modules === 'object' ? payload.modules : {};
    const modules = Object.fromEntries(Object.entries(modulesInput).slice(0, 24).map(([key, value]) => [String(key).slice(0, 80), {
        status: String(value?.status || 'recorded').slice(0, 40),
        engines: Array.isArray(value?.engines) ? value.engines.map((engine) => String(engine).slice(0, 80)).slice(0, 12) : []
    }]));
    const pages = (Array.isArray(payload.pages) ? payload.pages : []).slice(0, 24).map((page) => {
        const candidate = typeof page === 'string' ? page : page?.url || page?.href || page?.location;
        try {
            const url = new URL(candidate);
            url.username = ''; url.password = ''; url.search = ''; url.hash = '';
            return { url: `${url.origin}${url.pathname}`.slice(0, 260) };
        } catch { return null; }
    }).filter(Boolean);
    return { summary, modules, pages };
}

function publicShareReport(report) {
    return {
        id: report.id, version: report.version, status: report.status, locale: report.locale || 'en',
        publishedAt: report.publishedAt || null, payload: publicSharePayload(report.payload)
    };
}

function uniqueLatestReports(reports) {
    const seen = new Set();
    return reports.filter((report) => {
        if (seen.has(report.scanId)) return false;
        seen.add(report.scanId);
        return true;
    });
}

function reportComparisonKey(report) {
    const projectId = report.payload?.manifest?.project?.id;
    if (!projectId) return `scan:${report.scanId}`;
    const modules = Object.entries(report.payload?.manifest?.entitlements || {}).sort(([left], [right]) => left.localeCompare(right)).map(([moduleId, entitlement]) => [moduleId, entitlement?.executionMode, entitlement?.limit ?? null]);
    const devices = [...(report.payload?.manifest?.devices || [])].sort();
    return JSON.stringify({ projectId, modules, devices, capabilityContractVersion: report.payload?.manifest?.capabilityContractVersion || null });
}

function findingLifecycle(allReports) {
    const groups = new Map();
    for (const report of uniqueLatestReports(allReports)) {
        const key = reportComparisonKey(report);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(report);
    }
    const active = new Map();
    const resolved = new Map();
    for (const reports of groups.values()) {
        reports.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
        const latest = reports[0];
        const currentFindings = findingsFromPayload(latest.payload);
        for (const finding of currentFindings) {
            if (!active.has(finding.fingerprint)) active.set(finding.fingerprint, { ...finding, state: 'active', reportId: latest.id, reportVersion: latest.version, createdAt: latest.createdAt });
        }
        const previous = reports[1];
        if (!previous) continue;
        const currentFingerprints = new Set(currentFindings.map((finding) => finding.fingerprint));
        for (const finding of findingsFromPayload(previous.payload)) {
            if (!currentFingerprints.has(finding.fingerprint) && !resolved.has(finding.fingerprint)) {
                resolved.set(finding.fingerprint, { ...finding, state: 'resolved', reportId: previous.id, reportVersion: previous.version, createdAt: previous.createdAt, resolvedAt: latest.createdAt });
            }
        }
    }
    const sort = (left, right) => Number(right.normalizedImpact || 0) - Number(left.normalizedImpact || 0) || String(right.createdAt).localeCompare(String(left.createdAt));
    return { active: [...active.values()].sort(sort), resolved: [...resolved.values()].sort(sort) };
}

function scopedReportFindings(report, pageUrls) {
    const scope = new Set(pageUrls);
    return (report.payload?.pages || []).filter((page) => scope.has(page.url)).flatMap((page) => (page.report?.findings || []).map((finding) => ({ ...finding, pageUrl: finding.pageUrl || page.url })));
}

function safeHttpOrigin(value) {
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        return projectOrigin(parsed.toString());
    } catch { return null; }
}

function belongsToProjectHostname(candidateOrigin, projectOriginValue) {
    try {
        const candidate = new URL(candidateOrigin);
        const project = new URL(projectOriginValue);
        return candidate.hostname === project.hostname || candidate.hostname.endsWith(`.${project.hostname}`);
    } catch { return false; }
}

function recordedAuthorizedOrigins(project, authorizations) {
    const primaryOrigin = safeHttpOrigin(project?.origin);
    if (!primaryOrigin) throw new AppError('The project origin is invalid.', { status: 409, code: 'PROJECT_ORIGIN_INVALID' });
    const active = (authorizations || []).map((record) => safeHttpOrigin(record?.origin)).filter(Boolean);
    if (!active.includes(primaryOrigin)) {
        throw new AppError('The project has no active target-authorization record. Re-attest target authority before scanning.', { status: 409, code: 'TARGET_AUTHORIZATION_REQUIRED' });
    }
    const additional = [...new Set(active.filter((origin) => origin !== primaryOrigin && belongsToProjectHostname(origin, primaryOrigin)))].sort();
    return [primaryOrigin, ...additional];
}

function normalizeScopedUrls(values, allowedOrigins) {
    const scope = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
    return (values || []).map((value) => {
        const origin = safeHttpOrigin(value);
        if (!origin || !scope.has(origin)) {
            throw new AppError('Every scan URL must belong to an actively authorized project origin.', { status: 400, code: 'PROJECT_ORIGIN_MISMATCH' });
        }
        return normalizePageUrl(value);
    });
}

function discoveryProvenanceByUrl(discovery) {
    const provenance = new Map();
    for (const page of discovery?.pages || []) {
        let url;
        try { url = normalizePageUrl(page.url); } catch { continue; }
        const sources = Array.isArray(page.sources)
            ? page.sources
            : (page.discoverySource ? [{ type: page.discoverySource, referrer: page.referrer || null }] : []);
        provenance.set(url, { sources });
    }
    return provenance;
}

function renderedEntriesFromReport(report, fallbackReferrer) {
    const values = Array.isArray(report?.discovery?.renderedLinks) ? report.discovery.renderedLinks : [];
    return values.slice(0, MAX_RENDERED_DISCOVERY_LINKS).map((value) => {
        if (typeof value === 'string') return { url: value, referrer: fallbackReferrer };
        return { url: value?.url, referrer: value?.referrer || fallbackReferrer };
    });
}

function mergeCountMaps(...values) {
    const result = {};
    for (const value of values) for (const [key, count] of Object.entries(value || {})) result[key] = (result[key] || 0) + Number(count || 0);
    return result;
}

function prepareRenderedCandidates(values, { referrer, allowedOrigins, existingPages, pageLimit, crawlerConfig = {} }) {
    const scope = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
    const limits = resolveDiscoveryLimits(pageLimit, crawlerConfig);
    const queryVariants = new Map();
    const existingUrls = new Set();
    for (const page of existingPages || []) {
        let parsed;
        try { parsed = new URL(page.url); } catch { continue; }
        existingUrls.add(page.url);
        if (!parsed.search) continue;
        const key = `${parsed.origin}${parsed.pathname}`;
        const variants = queryVariants.get(key) || new Set();
        variants.add(parsed.search);
        queryVariants.set(key, variants);
    }
    const seen = new Set();
    const candidates = [];
    const skipped = { invalid: 0, offScope: 0, duplicate: 0, queryExplosion: 0, traps: {} };
    for (const value of (values || []).slice(0, MAX_RENDERED_DISCOVERY_LINKS)) {
        let parsed;
        try {
            parsed = new URL(value?.url, value?.referrer || referrer);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.toString().length > 2_048) throw new Error('unsafe rendered URL');
        } catch { skipped.invalid += 1; continue; }
        if (!scope.has(parsed.origin)) { skipped.offScope += 1; continue; }
        const trap = candidateTrapReason(parsed, limits);
        if (trap) { skipped.traps[trap] = (skipped.traps[trap] || 0) + 1; continue; }
        let url;
        try { url = normalizePageUrl(parsed.toString()); }
        catch { skipped.invalid += 1; continue; }
        if (seen.has(url)) { skipped.duplicate += 1; continue; }
        const normalized = new URL(url);
        const queryKey = `${normalized.origin}${normalized.pathname}`;
        const variants = queryVariants.get(queryKey) || new Set();
        if (!existingUrls.has(url) && normalized.search && !variants.has(normalized.search) && variants.size >= limits.maxQueryVariantsPerPath) {
            skipped.queryExplosion += 1;
            continue;
        }
        if (normalized.search) { variants.add(normalized.search); queryVariants.set(queryKey, variants); }
        let normalizedReferrer = null;
        try { normalizedReferrer = normalizePageUrl(value?.referrer || referrer); } catch { /* The page URL fallback is validated by the worker. */ }
        seen.add(url);
        candidates.push({ url, source: { type: 'rendered_link', referrer: normalizedReferrer } });
    }
    return { candidates, skipped, truncated: (values || []).length > MAX_RENDERED_DISCOVERY_LINKS };
}

function applyRenderedRobots(candidates, robotsByOrigin) {
    const accepted = [];
    let disallowed = 0;
    let unverified = 0;
    for (const candidate of candidates) {
        const parsed = new URL(candidate.url);
        const rules = robotsByOrigin?.[parsed.origin];
        if (!rules) { unverified += 1; continue; }
        if (!isRobotsAllowed(`${parsed.pathname}${parsed.search}`, rules)) { disallowed += 1; continue; }
        accepted.push(candidate);
    }
    return { candidates: accepted, skipped: { robots_disallowed: disallowed, robots_unverified: unverified }, truncated: unverified > 0 };
}

function renderedCoverageForPages(baseCoverage, pages) {
    const producerRuns = pages.map((page) => page.report?.discovery?.queue).filter((run) => run?.enabled === true);
    const renderedPages = pages.filter((page) => page.discovery?.sources?.some((source) => source.type === 'rendered_link'));
    if (!producerRuns.length && !renderedPages.length) return baseCoverage || null;
    const coverage = structuredClone(baseCoverage || {});
    const sourceCoverage = coverage.sources?.rendered_link || {};
    const skipped = {};
    for (const run of producerRuns) {
        for (const [reason, count] of Object.entries(run.skipped || {})) skipped[reason] = (skipped[reason] || 0) + Number(count || 0);
    }
    coverage.rendered = {
        producer: 'wpa_page_playwright_snapshot',
        producerPages: producerRuns.length,
        references: producerRuns.reduce((sum, run) => sum + Number(run.references || 0), 0),
        candidates: producerRuns.reduce((sum, run) => sum + Number(run.candidates || 0), 0),
        validated: producerRuns.reduce((sum, run) => sum + Number(run.validated || 0), 0),
        queuedUniquePages: renderedPages.length,
        skipped,
        truncated: producerRuns.some((run) => run.truncated === true)
    };
    coverage.renderedLinksDiscovered = Math.max(Number(coverage.renderedLinksDiscovered || 0), renderedPages.length);
    coverage.sources = {
        ...(coverage.sources || {}),
        rendered_link: {
            references: Number(sourceCoverage.references || 0) + coverage.rendered.references,
            uniqueUrls: Math.max(Number(sourceCoverage.uniqueUrls || 0), renderedPages.length)
        }
    };
    coverage.truncated = coverage.truncated === true || coverage.rendered.truncated;
    return coverage;
}

function createPlatformService({ store, queue, analysisPool, analysisService, validateUrl, config, logger, integrationService = null, crawler = discoverSite, resolveTxt = dns.resolveTxt }) {
    let workerReady = null;
    let recoveryTimer = null;
    const analysisHealth = async () => {
        if (config.executionRole === 'worker' || (!config.browserExecutionDisabled && !config.sourceExecutionDisabled)) {
            return { status: 'operational', detail: `${analysisPool.stats.active}/${config.maxConcurrentAnalyses} active in this process.` };
        }
        const heartbeat = typeof store.workerHealth === 'function'
            ? await store.workerHealth('analysis', { maxAgeMs: 90_000 })
            : { status: 'unavailable' };
        if (heartbeat.status === 'operational') return { status: 'operational', detail: 'A recent isolated analysis-worker heartbeat was observed.' };
        if (heartbeat.status === 'stale') return { status: 'stale', detail: 'The isolated analysis-worker heartbeat is stale.' };
        return { status: 'unavailable', detail: 'No recent isolated analysis-worker heartbeat was observed.' };
    };
    const workerId = `worker-${crypto.randomUUID()}`;

    async function refreshExpiredDnsVerification(workspaceId, project) {
        if (!project?.verifiedAt || project.verificationMethod !== 'dns') return project;
        const expiresAt = Date.parse(project.verificationExpiresAt || '');
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return project;
        const hostname = new URL(project.origin).hostname;
        const recordName = `_wpa-verification.${hostname}`;
        let records;
        try { records = await resolveTxt(recordName); }
        catch {
            await store.revokeProjectVerification?.(workspaceId, project.id);
            throw new AppError('DNS ownership verification could not be revalidated.', { status: 409, code: 'TARGET_VERIFICATION_REVOKED' });
        }
        const expected = `wpa-verification=${project.verificationToken}`;
        const values = records.map((chunks) => chunks.join(''));
        if (!values.includes(expected)) {
            await store.revokeProjectVerification?.(workspaceId, project.id);
            throw new AppError('DNS ownership verification was revoked or changed.', { status: 409, code: 'TARGET_VERIFICATION_REVOKED' });
        }
        return store.verifyProject(workspaceId, project.id, 'dns', {
            checkedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + config.verificationTtlMs).toISOString()
        });
    }

    async function appendProgress(workspaceId, scanId, type, payload = {}) {
        return store.appendScanEvent?.(workspaceId, scanId, type, payload);
    }

    async function assertWorkspaceExecutable(workspaceId) {
        if (typeof store.getWorkspaceState !== 'function') return null;
        const state = await store.getWorkspaceState(workspaceId);
        if (!state) throw new AppError('The workspace is no longer available for queued execution.', { status: 404, code: 'WORKSPACE_NOT_FOUND' });
        if (state.state !== 'active') throw new AppError('Queued execution is paused while this workspace is suspended.', { status: 409, code: 'WORKSPACE_EXECUTION_BLOCKED' });
        return state;
    }

    async function workspaceIsExecutable(workspaceId) {
        if (typeof store.getWorkspaceState !== 'function') return true;
        const state = await store.getWorkspaceState(workspaceId);
        return Boolean(state?.state === 'active');
    }

    async function validateRenderedCandidateOrigins(candidates, currentTarget, allowedOrigins) {
        const validOrigins = new Set();
        const rejectedOrigins = new Map();
        const currentOrigin = safeHttpOrigin(currentTarget?.url);
        if (currentOrigin && allowedOrigins.has(currentOrigin)) validOrigins.add(currentOrigin);
        const firstByOrigin = new Map();
        for (const candidate of candidates) {
            const origin = safeHttpOrigin(candidate.url);
            if (origin && !validOrigins.has(origin) && !firstByOrigin.has(origin)) firstByOrigin.set(origin, candidate.url);
        }
        const origins = [...firstByOrigin.entries()];
        const deadline = Date.now() + RENDERED_DISCOVERY_VALIDATION_MS;
        let cursor = 0;
        const worker = async () => {
            while (cursor < origins.length) {
                const index = cursor++;
                const [origin, candidateUrl] = origins[index];
                if (Date.now() >= deadline) { rejectedOrigins.set(origin, 'origin_validation_timeout'); continue; }
                try {
                    const validated = await validateUrl(candidateUrl);
                    const validatedOrigin = safeHttpOrigin(validated?.url);
                    if (validatedOrigin !== origin || !allowedOrigins.has(validatedOrigin)) rejectedOrigins.set(origin, 'origin_mismatch');
                    else validOrigins.add(origin);
                } catch (error) {
                    rejectedOrigins.set(origin, String(error?.code || 'origin_validation_failed').toLowerCase());
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(RENDERED_ORIGIN_VALIDATION_CONCURRENCY, origins.length) }, () => worker()));
        const skipped = {};
        for (const reason of rejectedOrigins.values()) skipped[reason] = (skipped[reason] || 0) + 1;
        return {
            candidates: candidates.filter((candidate) => validOrigins.has(safeHttpOrigin(candidate.url))),
            skipped,
            timedOut: [...rejectedOrigins.values()].includes('origin_validation_timeout')
        };
    }

    async function appendRenderedDiscovery(scan, page, report, currentTarget) {
        const renderedEntries = renderedEntriesFromReport(report, page.url);
        const producerCoverage = report?.discovery?.coverage || {};
        if (report?.discovery) delete report.discovery.renderedLinks;
        const enabled = Boolean(scan.manifest.discovery && scan.manifest.entitlements?.full_site_crawl?.executionMode === 'automated');
        if (!enabled || !renderedEntries.length) {
            if (report?.discovery) report.discovery.queue = {
                enabled,
                references: Number(producerCoverage.references || renderedEntries.length),
                candidates: 0,
                validated: 0,
                inserted: 0,
                existing: 0,
                rejected: 0,
                skipped: {},
                truncated: producerCoverage.truncated === true
            };
            return { inserted: [], pages: [] };
        }
        const allowedOrigins = new Set(scan.manifest.project.authorizedOrigins || [scan.manifest.project.origin]);
        const pageLimit = Math.max(0, Math.floor(Number(scan.manifest.plan?.limits?.pageCredits) || 0));
        const existingPages = await store.listScanPages(scan.workspaceId, scan.id);
        const prepared = prepareRenderedCandidates(renderedEntries, {
            referrer: page.url,
            allowedOrigins,
            existingPages,
            pageLimit,
            crawlerConfig: config.crawler || {}
        });
        const robots = applyRenderedRobots(prepared.candidates, scan.manifest.discovery?.robotsByOrigin);
        const validated = await validateRenderedCandidateOrigins(robots.candidates, currentTarget, allowedOrigins);
        const appended = await store.appendScanPagesWithCredits(scan.workspaceId, scan.id, validated.candidates, {
            maxAttempts: 3,
            pageLimit,
            creditLimit: pageLimit
        });
        for (const discoveredPage of appended.pages.filter((candidate) => candidate.pageKey !== page.pageKey && ['queued', 'retrying'].includes(candidate.status))) {
            await enqueueWorkerJob(queue, 'page', { scanId: scan.id, workspaceId: scan.workspaceId, pageKey: discoveredPage.pageKey }, { singletonKey: `${scan.id}:${discoveredPage.pageKey}`, retryLimit: Math.max(0, discoveredPage.maxAttempts - 1) });
        }
        const skipped = mergeCountMaps(
            { invalid: prepared.skipped.invalid, off_scope: prepared.skipped.offScope, duplicate: prepared.skipped.duplicate, query_explosion: prepared.skipped.queryExplosion },
            Object.fromEntries(Object.entries(prepared.skipped.traps).map(([reason, count]) => [`trap_${reason}`, count])),
            robots.skipped,
            validated.skipped,
            Object.fromEntries(appended.rejected.reduce((counts, entry) => counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1), new Map()))
        );
        report.discovery ||= {};
        report.discovery.queue = {
            enabled: true,
            references: Number(producerCoverage.references || renderedEntries.length),
            candidates: prepared.candidates.length,
            validated: validated.candidates.length,
            inserted: appended.inserted.length,
            existing: appended.pages.length - appended.inserted.length,
            rejected: appended.rejected.length,
            skipped,
            truncated: producerCoverage.truncated === true || prepared.truncated || robots.truncated || appended.limitReached || validated.timedOut
        };
        await appendProgress(scan.workspaceId, scan.id, 'page.discovery', {
            pageIndex: page.pageIndex,
            url: page.url,
            ...report.discovery.queue
        });
        return appended;
    }

    async function finalizeScan(scanId, workspaceId) {
        const scan = await store.getScan(workspaceId, scanId);
        if (!scan) return null;
        const durablePages = await store.listScanPages(workspaceId, scanId);
        if (!durablePages.length || durablePages.some((page) => !PAGE_TERMINAL.has(page.status))) return null;
        const pages = durablePages.map((page) => ({ url: page.url, status: page.status, attempts: page.attempts, ...(page.discovery?.sources?.length ? { discovery: page.discovery } : {}), ...(page.errorCode ? { errorCode: page.errorCode } : {}), ...(page.report ? { report: page.report } : {}) }));
        const crawlerResult = scan.manifest.discovery || null;
        const crawlerCoverage = renderedCoverageForPages(crawlerResult?.coverage || null, pages);
        const modules = summarizeModules(scan.manifest, pages, crawlerResult);
        const aggregate = aggregateState(modules);
        const pageCounts = Object.fromEntries(['completed', 'incomplete', 'failed', 'unavailable', 'cancelled'].map((status) => [status, pages.filter((page) => page.status === status).length]));
        const moduleCounts = Object.fromEntries(['completed', 'failed', 'unavailable', 'incomplete', 'pending_operator', 'not_executed'].map((status) => [status, Object.values(modules).filter((module) => module.status === status).length]));
        const reportPayload = {
            schemaVersion: REPORT_SCHEMA,
            capabilityContractVersion: CONTRACT_VERSION,
            manifest: scan.manifest,
            summary: { requestedPages: pages.length, completedPages: pageCounts.completed, incompletePages: pageCounts.incomplete, failedPages: pageCounts.failed, unavailablePages: pageCounts.unavailable, cancelledPages: pageCounts.cancelled, requestedModules: Object.keys(modules).length, moduleCounts, terminalState: aggregate },
            modules,
            coverage: { crawler: crawlerCoverage, pages: pages.map((page) => ({ url: page.url, status: page.status, discovery: page.discovery || null, moduleRuns: page.report?.moduleRuns || {} })) },
            findings: crawlerResult?.findings || [],
            pages
        };
        const existing = await store.getLatestReportForScan(workspaceId, scanId);
        const report = existing || await store.saveReportOnce(workspaceId, scanId, reportPayload, { locale: scan.manifest.locale, status: aggregate === 'completed' ? 'automated_draft' : 'automated_incomplete' });
        if (!existing) await integrationService?.deliverReport(workspaceId, report);
        const operatorModules = Object.entries(scan.manifest.entitlements).filter(([, entitlement]) => entitlement.executionMode === 'operator_assisted').map(([moduleId]) => moduleId);
        const plan = getPlan(scan.manifest.plan.id) || getPlan('free');
        if (operatorModules.length) await store.createOperatorTasks(workspaceId, scanId, operatorModules, scanDueAt(plan));
        const terminalStatus = aggregate;
        if (!['completed', 'partial', 'awaiting_operator', 'failed', 'cancelled'].includes(scan.status)) {
            await assertWorkspaceExecutable(workspaceId);
            const updated = await store.updateScan(workspaceId, scanId, { status: terminalStatus, ...(terminalStatus === 'partial' ? { failureCode: 'REQUESTED_CAPABILITY_INCOMPLETE' } : {}), completedAt: new Date().toISOString() }, { expectedStatuses: ['queued', 'running'] });
            if (updated) await appendProgress(workspaceId, scanId, `scan.${terminalStatus}`, { summary: reportPayload.summary, reportId: report.id });
        }
        return report;
    }

    async function executeScanPage(scanId, workspaceId, pageKey) {
        const scan = await store.getScan(workspaceId, scanId);
        if (!scan || ['completed', 'partial', 'awaiting_operator', 'failed', 'cancelled'].includes(scan.status)) return null;
        await assertWorkspaceExecutable(workspaceId);
        const pageLeaseMs = Math.max(30_000, config.timeouts.analysisMs + 30_000);
        const page = await store.claimScanPage(workspaceId, scanId, pageKey, { owner: workerId, leaseMs: pageLeaseMs });
        if (!page) {
            const existing = (await store.listScanPages(workspaceId, scanId)).find((item) => item.pageKey === pageKey);
            if (existing?.status === 'running' && new Date(existing.leaseExpiresAt || 0).getTime() > Date.now()) throw Object.assign(new Error('The page lease is still owned by another worker.'), { code: 'PAGE_LEASE_ACTIVE' });
            return finalizeScan(scanId, workspaceId);
        }
        await appendProgress(workspaceId, scanId, 'page.running', { pageIndex: page.pageIndex, url: page.url, attempt: page.attempts });
        let pageLeaseLost = false;
        const pageLeaseHeartbeat = typeof store.renewScanPageLease === 'function' ? setInterval(() => {
            void Promise.resolve(store.renewScanPageLease(workspaceId, scanId, pageKey, {
                owner: page.leaseOwner || workerId,
                leaseToken: page.leaseToken,
                leaseMs: pageLeaseMs
            })).then((renewed) => { if (!renewed) pageLeaseLost = true; }).catch((error) => {
                logger.warn('Scan page lease heartbeat failed', { scanId, workspaceId, pageKey, errorCode: error.code || 'PAGE_LEASE_HEARTBEAT_FAILED' });
            });
        }, Math.max(5_000, Math.floor(pageLeaseMs / 3))) : null;
        pageLeaseHeartbeat?.unref?.();
        try {
            const target = await validateUrl(page.url);
            const queuedScope = new Set(scan.manifest.project.authorizedOrigins || [scan.manifest.project.origin]);
            if (!queuedScope.has(projectOrigin(target.url))) throw new AppError('A scan URL must remain on an authorized project origin.', { status: 400, code: 'PROJECT_ORIGIN_MISMATCH' });
            const engineIds = requestedPageEngines(scan.manifest, page.pageIndex);
            const ownershipOnly = Object.keys(scan.manifest.entitlements || {}).some(requiresVerifiedTarget);
            let currentProject = scan.manifest.project;
            if (ownershipOnly) {
                currentProject = await store.getProject(workspaceId, scan.manifest.project.id);
                if (!currentProject || currentProject.verificationRevokedAt || !currentProject.verifiedAt) throw new AppError('DNS ownership verification is no longer active for this queued page.', { status: 409, code: 'TARGET_VERIFICATION_REVOKED' });
                if (currentProject.verificationMethod === 'dns') {
                    const verificationExpiry = Date.parse(currentProject.verificationExpiresAt || '');
                    if (!Number.isFinite(verificationExpiry) || verificationExpiry <= Date.now()) currentProject = await refreshExpiredDnsVerification(workspaceId, currentProject);
                    const currentExpiry = Date.parse(currentProject?.verificationExpiresAt || '');
                    if (!Number.isFinite(currentExpiry) || currentExpiry <= Date.now()) throw new AppError('DNS ownership verification expired before queued execution.', { status: 409, code: 'TARGET_VERIFICATION_EXPIRED' });
                }
                if (!currentProject?.verifiedAt || currentProject.verificationRevokedAt) throw new AppError('DNS ownership verification expired before queued execution.', { status: 409, code: 'TARGET_VERIFICATION_EXPIRED' });
            }
            const advancedModules = engineIds.map((engine) => ({ performancePlus: 'performance_plus', advancedGeo: 'advanced_geo', visualUx: 'visual_ux', journey: 'journey_test' })[engine]).filter(Boolean);
            const report = await analysisPool.run((signal) => analysisService.analyze(target, signal, {
                engineIds, advancedModules, journey: page.pageIndex === 0 ? scan.manifest.journey : null,
                passiveSecurity: engineIds.includes('zapBaseline'),
                externalProviderConsent: scan.manifest.externalProviderConsent === true,
                targetOriginVerified: Boolean(currentProject?.verifiedAt),
                authorizedOrigins: [...queuedScope],
                onProgress: ({ type, payload }) => appendProgress(workspaceId, scanId, type, {
                    ...payload,
                    pageKey: page.pageKey,
                    pageIndex: page.pageIndex,
                    attempt: page.attempts
                })
            }), { timeoutMs: config.timeouts.analysisMs });
            if (pageLeaseLost) throw Object.assign(new Error('The scan page lease was reclaimed during analysis.'), { code: 'PAGE_LEASE_STALE' });
            await assertWorkspaceExecutable(workspaceId);
            await appendRenderedDiscovery(scan, page, report, target);
            const complete = pageIsComplete({ report });
            const states = Object.values(report.moduleRuns || {}).map((run) => run.status);
            const status = complete ? 'completed' : (states.length && states.every((state) => state === 'unavailable') ? 'unavailable' : 'incomplete');
            await assertWorkspaceExecutable(workspaceId);
            const completionPatch = { status, report, errorCode: complete ? null : 'REQUESTED_ENGINE_INCOMPLETE', leaseOwner: page.leaseOwner || workerId, leaseToken: page.leaseToken };
            let completed;
            if (typeof store.completeScanPageAndSettleCredit === 'function') {
                const result = await store.completeScanPageAndSettleCredit(workspaceId, scanId, pageKey, { ...completionPatch, creditKey: pageCreditKey(page.url), creditState: complete ? 'consumed' : 'released' });
                completed = result?.page || null;
            } else {
                completed = await store.completeScanPage(workspaceId, scanId, pageKey, completionPatch);
                if (completed) await store.settleCredit(workspaceId, scanId, pageCreditKey(page.url), complete ? 'consumed' : 'released');
            }
            if (!completed) throw Object.assign(new Error('The scan page lease was reclaimed by another worker.'), { code: 'PAGE_LEASE_STALE' });
            if (completed.status !== status) throw Object.assign(new Error('The scan page was cancelled or completed by another worker.'), { code: 'PAGE_LEASE_STALE' });
            await appendProgress(workspaceId, scanId, `page.${status}`, { pageIndex: page.pageIndex, url: page.url, attempt: page.attempts, modules: report.moduleRuns });
            return finalizeScan(scanId, workspaceId);
        } catch (error) {
            const errorCode = error.code || 'ANALYSIS_FAILED';
            if (page.attempts < page.maxAttempts) {
                const retryPage = await store.completeScanPage(workspaceId, scanId, pageKey, { status: 'retrying', errorCode, leaseOwner: page.leaseOwner || workerId, leaseToken: page.leaseToken });
                if (!retryPage) throw error;
                if (PAGE_TERMINAL.has(retryPage.status)) throw error;
                await appendProgress(workspaceId, scanId, 'page.retrying', { pageIndex: page.pageIndex, url: page.url, attempt: page.attempts, errorCode });
                throw error;
            }
            const status = classifyErrorCode(errorCode) === 'unavailable' ? 'unavailable' : 'failed';
            const failurePatch = { status, errorCode, leaseOwner: page.leaseOwner || workerId, leaseToken: page.leaseToken, report: { findings: [], moduleRuns: Object.fromEntries(requestedPageEngines(scan.manifest, page.pageIndex).map((engineId) => [engineId, { status, errorCode, remediation: remediationFor(errorCode, engineId) }])) } };
            let failedPage;
            if (typeof store.completeScanPageAndSettleCredit === 'function') {
                const result = await store.completeScanPageAndSettleCredit(workspaceId, scanId, pageKey, { ...failurePatch, creditKey: pageCreditKey(page.url), creditState: 'released' });
                failedPage = result?.page || null;
            } else {
                failedPage = await store.completeScanPage(workspaceId, scanId, pageKey, failurePatch);
                if (failedPage) await store.settleCredit(workspaceId, scanId, pageCreditKey(page.url), 'released');
            }
            if (!failedPage) throw Object.assign(new Error('The scan page lease was reclaimed by another worker.'), { code: 'PAGE_LEASE_STALE' });
            if (failedPage.status !== status) return finalizeScan(scanId, workspaceId);
            await appendProgress(workspaceId, scanId, `page.${status}`, { pageIndex: page.pageIndex, url: page.url, attempt: page.attempts, errorCode });
            logger.warn('Platform scan page failed after bounded retries', { scanId, workspaceId, url: page.url, errorCode, attempts: page.attempts });
            return finalizeScan(scanId, workspaceId);
        } finally {
            if (pageLeaseHeartbeat) clearInterval(pageLeaseHeartbeat);
        }
    }

    async function executeScan(scanId, workspaceId) {
        const scan = await store.getScan(workspaceId, scanId);
        if (!scan || !['queued', 'running'].includes(scan.status)) return scan;
        await assertWorkspaceExecutable(workspaceId);
        if (scan.status === 'queued') {
            const running = await store.updateScan(workspaceId, scanId, { status: 'running', startedAt: new Date().toISOString() }, { expectedStatus: 'queued' });
            if (!running) return store.getScan(workspaceId, scanId);
            await appendProgress(workspaceId, scanId, 'scan.running', { requestedPages: scan.manifest.urls.length });
        }
        const current = await store.getScan(workspaceId, scanId);
        if (!current || !['queued', 'running'].includes(current.status)) return current;
        await assertWorkspaceExecutable(workspaceId);
        const pages = await store.listScanPages(workspaceId, scanId);
        for (const page of pages.filter((item) => !PAGE_TERMINAL.has(item.status))) {
            await enqueueWorkerJob(queue, 'page', { scanId, workspaceId, pageKey: page.pageKey }, { singletonKey: `${scanId}:${page.pageKey}`, retryLimit: Math.max(0, page.maxAttempts - 1) });
        }
        return finalizeScan(scanId, workspaceId);
    }

    async function startWorker() {
        if (!config.workerEnabled) return;
        if (!workerReady) {
            workerReady = Promise.all([
                queue.work(PAGE_QUEUE_NAME, async (jobs) => { for (const job of jobs) { const data = assertWorkerJob(job.data || {}, 'page'); await executeScanPage(data.scanId, data.workspaceId, data.pageKey); } }),
                queue.work(QUEUE_NAME, async (jobs) => { for (const job of jobs) { const data = assertWorkerJob(job.data || {}, 'scan'); await executeScan(data.scanId, data.workspaceId); } })
            ]).catch((error) => {
                workerReady = null;
                throw error;
            });
        }
        await workerReady;
    }

    async function recoverScans() {
        if (!config.workerEnabled || typeof store.listRecoverableScans !== 'function') return;
        for (const scan of await store.listRecoverableScans()) {
            if (!await workspaceIsExecutable(scan.workspaceId)) continue;
            await enqueueWorkerJob(queue, 'scan', { scanId: scan.id, workspaceId: scan.workspaceId }, { singletonKey: scan.id, retryLimit: 2 });
        }
    }

    return {
        async plans() { return store.listPlans ? store.listPlans() : PLANS.map(publicPlan); },
        async capabilities() { return publicCapabilityContract(); },
        async start() {
            await queue.start();
            await startWorker();
            await recoverScans();
            if (config.workerEnabled && !recoveryTimer) {
                const recoveryIntervalMs = Math.max(1_000, Number(config.scanRecoveryIntervalMs) || 30_000);
                recoveryTimer = setInterval(() => {
                    void recoverScans().catch((error) => logger.warn('Recoverable scan sweep failed', { error: error.message }));
                }, recoveryIntervalMs);
                recoveryTimer.unref?.();
            }
        },
        async close() {
            if (recoveryTimer) clearInterval(recoveryTimer);
            recoveryTimer = null;
            await queue.close();
        },
        async workspace(workspaceId, requesterUserId = null) {
            const workspace = await store.ensureWorkspace(workspaceId);
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, requesterUserId);
            const plan = await workspacePlan(store, workspaceId, requesterUserId);
            const usage = await store.getUsage(entitlementUserId);
            return { workspace, plan: publicPlan(plan), usage, entitlementState: { basePlanId: plan.basePlanId || workspace.planId, effectivePlanId: plan.effectivePlanId || plan.id, grants: plan.grants || [] } };
        },
        async status() {
            let persistence;
            try {
                persistence = await store.healthCheck?.();
            } catch {
                persistence = { status: 'unavailable' };
            }
            persistence ||= { status: config.databaseUrl ? 'operational' : 'development' };
            const worker = await analysisHealth();
            const components = [
                { id: 'api', label: 'API', status: 'operational', detail: 'Requests are being accepted.' },
                { id: 'database', label: 'Database', status: persistence.status, detail: persistence.status === 'operational' ? 'PostgreSQL responded.' : persistence.status === 'development' ? 'In-memory development store.' : 'PostgreSQL did not respond.' },
                { id: 'workers', label: 'Analysis workers', status: worker.status, detail: worker.detail },
                { id: 'storage', label: 'Encrypted artifacts', status: config.sourceEncryptionKey ? 'operational' : 'configuration_required', detail: config.sourceEncryptionKey ? 'Encryption key loaded.' : 'Production key required.' }
            ];
            return {
                checkedAt: new Date().toISOString(),
                overall: components.every((component) => component.status === 'operational') ? 'operational' : 'configuration_review',
                components
            };
        },
        async publicStatus({ platformReady = true } = {}) {
            let persistence;
            try {
                persistence = await store.healthCheck?.();
            } catch {
                persistence = { status: 'unavailable' };
            }
            persistence ||= { status: config.databaseUrl ? 'operational' : 'development' };
            const worker = await analysisHealth();
            const components = [
                { id: 'api', label: 'API', status: 'operational', detail: 'The status endpoint is responding.' },
                { id: 'analysis', label: 'Analysis service', status: platformReady ? worker.status : 'unavailable', detail: platformReady ? worker.detail : 'The API is starting.' },
                { id: 'persistence', label: 'Persistence', status: persistence.status, detail: persistence.status === 'operational' ? 'Durable storage is responding.' : persistence.status === 'development' ? 'Development storage is active.' : 'Durable storage did not respond.' }
            ];
            return {
                checkedAt: new Date().toISOString(),
                overall: components.every((component) => component.status === 'operational') ? 'operational' : 'degraded',
                components
            };
        },
        async settings(workspaceId) {
            const [workspace, settings, subscription] = await Promise.all([store.ensureWorkspace(workspaceId), store.getWorkspaceSettings(workspaceId), store.getSubscription?.(workspaceId)]);
            return { workspace, settings, subscription: subscription ? { provider: subscription.provider || 'stripe', status: subscription.status, accessState: subscription.accessState || null, billingPlanId: subscription.billingPlanId || null, paymentStatus: subscription.paymentStatus || subscription.payment?.status || null, refundStatus: subscription.refundStatus || subscription.refund?.status || null, currentPeriodEnd: subscription.currentPeriodEnd, scheduledChange: subscription.scheduledChange || null } : null };
        },
        async updateSettings(workspaceId, input, actorId) {
            const result = await store.updateWorkspaceSettings(workspaceId, input);
            await store.logAudit({ workspaceId, actorId, action: 'workspace.settings_updated', entityType: 'workspace', entityId: workspaceId, metadata: { defaultLocale: input.defaultLocale } });
            return result;
        },
        async createProject(workspaceId, input, actorId = null, requestId = null, options = {}) {
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, actorId);
            const plan = await workspacePlan(store, workspaceId, actorId);
            const operation = options && typeof options === 'object' ? options : {};
            if (config.nodeEnv === 'production' && (input.authorizationAttested !== true || !input.authorizationVersion)) throw new AppError('Target authorization must be attested.', { status: 400, code: 'TARGET_AUTHORIZATION_REQUIRED' });
            const authorizationVersion = input.authorizationVersion || 'legacy-test-v0';
            const target = await validateUrl(input.url);
            const primaryOrigin = projectOrigin(target.url);
            const authorizedOrigins = [primaryOrigin];
            for (const candidate of input.additionalSubdomains || []) {
                const value = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
                const validated = await validateUrl(value);
                const origin = projectOrigin(validated.url);
                if (!belongsToProjectHostname(origin, primaryOrigin)) {
                    throw new AppError('An additional authorized origin must use the project hostname or one of its subdomains.', { status: 400, code: 'TARGET_AUTHORIZATION_SCOPE_MISMATCH' });
                }
                if (!authorizedOrigins.includes(origin)) authorizedOrigins.push(origin);
            }
            const created = await store.createProject(workspaceId, { name: input.name, origin: primaryOrigin, locale: input.locale }, {
                limit: operation.limit ?? plan.limits.projects,
                idempotencyKey: operation.idempotencyKey,
                requestFingerprint: operation.requestFingerprint,
                requestedByUserId: actorId,
                entitlementUserId
            });
            const duplicate = Boolean(created?.idempotent === true || created?.project?.idempotent === true);
            const projectRecord = created?.project || created;
            const project = { ...projectRecord };
            delete project.idempotent;
            if (duplicate) {
                const existingAuthorizations = await store.listTargetAuthorizations?.(workspaceId, { projectId: project.id, activeOnly: true });
                return { ...project, idempotent: true, authorizedOrigins, authorizations: (existingAuthorizations || []).filter(Boolean) };
            }
            const authorizations = [];
            for (const origin of authorizedOrigins) authorizations.push(await store.recordTargetAuthorization?.({ workspaceId, projectId: project.id, userId: actorId || 'unknown', origin, attestationVersion: authorizationVersion, authorizationBasis: 'authorized_control', requestId: requestId || `project:${project.id}`, metadata: { primary: origin === project.origin, legacyTestFallback: !input.authorizationVersion } }));
            await store.logAudit({ workspaceId, actorId, action: 'project.created', entityType: 'project', entityId: project.id, metadata: { origin: project.origin, authorizedOrigins } });
            return { ...project, authorizedOrigins, authorizations: authorizations.filter(Boolean) };
        },
        listProjects(workspaceId) { return store.listProjects(workspaceId); },
        listScans(workspaceId) { return store.listScans(workspaceId); },
        async cancelScan(workspaceId, scanId, input, actorId, requestId = null) {
            const result = await store.cancelScan(workspaceId, scanId, { actorId, reason: input.reason, requestId, idempotencyKey: input.idempotencyKey });
            if (!result) throw new AppError('Scan not found.', { status: 404, code: 'SCAN_NOT_FOUND' });
            return result;
        },
        async retryScan(workspaceId, scanId, input, actorId, requestId = null) {
            const scan = await store.getScan(workspaceId, scanId);
            if (!scan) throw new AppError('Scan not found.', { status: 404, code: 'SCAN_NOT_FOUND' });
            const entitlementUserId = scan.entitlementUserId || await store.resolveEntitlementUser(workspaceId, scan.requestedByUserId || null);
            const plan = await store.getUserEffectiveEntitlements(entitlementUserId);
            const result = await store.retryScan(workspaceId, scanId, { actorId, reason: input.reason, requestId, idempotencyKey: input.idempotencyKey, creditLimit: plan.limits.pageCredits });
            if (!result) throw new AppError('Scan not found.', { status: 404, code: 'SCAN_NOT_FOUND' });
            if (!result.idempotent && result.requeuedPages > 0) await enqueueWorkerJob(queue, 'scan', { scanId, workspaceId }, { singletonKey: scanId, retryLimit: 2 });
            return result;
        },
        async verifyProject(workspaceId, projectId, method) {
            const existing = await store.getProject(workspaceId, projectId);
            if (!existing) throw new AppError('Project not found.', { status: 404, code: 'PROJECT_NOT_FOUND' });
            if (method === 'operator' && config.nodeEnv === 'production') {
                throw new AppError('Operator verification is only available through the admin queue.', { status: 403, code: 'OPERATOR_VERIFICATION_REQUIRED' });
            }
            if (method !== 'dns' && method !== 'operator') {
                throw new AppError('This verification method is not available yet.', { status: 409, code: 'VERIFICATION_METHOD_NOT_AVAILABLE' });
            }
            if (method === 'dns') {
                const hostname = new URL(existing.origin).hostname;
                const recordName = `_wpa-verification.${hostname}`;
                let records;
                try { records = await resolveTxt(recordName); }
                catch (cause) {
                    throw new AppError(`Add the WPA TXT record at ${recordName}, then retry.`, { status: 409, code: 'TARGET_VERIFICATION_PENDING', cause });
                }
                const expected = `wpa-verification=${existing.verificationToken}`;
                const values = records.map((chunks) => chunks.join(''));
                if (!values.includes(expected)) {
                    throw new AppError(`The TXT record at ${recordName} does not match this project challenge.`, { status: 409, code: 'TARGET_VERIFICATION_MISMATCH' });
                }
            }
            const checkedAt = method === 'dns' ? new Date() : null;
            const project = await store.verifyProject(workspaceId, projectId, method, method === 'dns' ? {
                checkedAt: checkedAt.toISOString(),
                expiresAt: new Date(checkedAt.getTime() + config.verificationTtlMs).toISOString()
            } : {});
            return project;
        },
        async revokeProjectVerification(workspaceId, projectId, actorId) {
            const existing = await store.getProject(workspaceId, projectId);
            if (!existing) throw new AppError('Project not found.', { status: 404, code: 'PROJECT_NOT_FOUND' });
            const project = await store.revokeProjectVerification(workspaceId, projectId);
            await store.logAudit({ workspaceId, actorId, action: 'project.verification_revoked', entityType: 'project', entityId: projectId, metadata: {} });
            return project;
        },
        async createScan(workspaceId, input, options = {}) {
            const operation = options && typeof options === 'object' ? options : {};
            const requestedByUserId = operation.requestedByUserId || null;
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, requestedByUserId);
            let project = await store.getProject(workspaceId, input.projectId);
            if (!project) throw new AppError('Project not found.', { status: 404, code: 'PROJECT_NOT_FOUND' });
            project = await refreshExpiredDnsVerification(workspaceId, project);
            const plan = await workspacePlan(store, workspaceId, requestedByUserId);
            const explicitlyRequested = Boolean(input.modules?.length);
            const requestedModules = explicitlyRequested
                ? input.modules
                : defaultScanModules(plan).filter((moduleId) => project.verifiedAt || !requiresVerifiedTarget(moduleId));
            const entitlements = selectedEntitlements(plan, requestedModules);
            const ownershipOnlyModules = Object.keys(entitlements).filter(requiresVerifiedTarget);
            if (!project.verifiedAt && ownershipOnlyModules.length) {
                throw new AppError(`DNS ownership verification is required for: ${ownershipOnlyModules.join(', ')}. Run public-link modules instead or verify this target.`, { status: 409, code: 'TARGET_VERIFICATION_REQUIRED' });
            }
            for (const moduleId of Object.keys(entitlements)) {
                const trigger = DEFINITIONS[moduleId]?.trigger;
                if (!['page_scan', 'site_scan', 'journey'].includes(trigger)) throw new AppError(`Module '${moduleId}' uses a separate product workflow.`, { status: 400, code: 'MODULE_TRIGGER_MISMATCH' });
            }
            if (entitlements.journey_test && !input.journey) throw new AppError('Journey Test requires a validated read-only journey definition.', { status: 400, code: 'JOURNEY_REQUIRED' });
            const authorizationRecords = await store.listTargetAuthorizations(workspaceId, { projectId: project.id, activeOnly: true });
            const authorizedOrigins = recordedAuthorizedOrigins(project, authorizationRecords);
            const authorizedOriginSet = new Set(authorizedOrigins);
            const hasExplicitUrls = Boolean(input.urls?.length);
            const additionalUrls = hasExplicitUrls ? [] : normalizeScopedUrls(input.additionalUrls || [], authorizedOriginSet);
            if (additionalUrls.length && !entitlements.full_site_crawl) {
                throw new AppError('Additional discovery URLs require the Full Site Crawl entitlement and an ownership-verified target.', { status: 403, code: 'ADDITIONAL_URLS_REQUIRE_FULL_SITE_CRAWL' });
            }
            let requestedUrls = hasExplicitUrls ? normalizeScopedUrls(input.urls, authorizedOriginSet) : [project.origin];
            let discovery = null;
            if (!hasExplicitUrls && entitlements.full_site_crawl) {
                try {
                    discovery = await crawler(project.origin, { limit: plan.limits.pageCredits, config, logger, additionalUrls, authorizedOrigins });
                    requestedUrls = discovery.urls.length ? discovery.urls : requestedUrls;
                } catch (error) {
                    const errorCode = error.code || 'CRAWLER_FAILED';
                    discovery = { version: ENGINE_VERSIONS.crawler, status: classifyErrorCode(errorCode), urls: [], pages: [], findings: [], coverage: { limit: plan.limits.pageCredits, attemptedPages: 0, truncated: true }, errorCode, remediation: remediationFor(errorCode, 'crawler') };
                }
            }
            const urls = [...new Set(normalizeScopedUrls(requestedUrls, authorizedOriginSet))];
            if (urls.length > plan.limits.pageCredits) {
                throw new AppError('This scan exceeds the plan page-credit limit.', { status: 409, code: 'SCAN_PAGE_LIMIT_REACHED' });
            }
            const manifest = {
                schemaVersion: 2,
                capabilityContractVersion: CONTRACT_VERSION,
                createdAt: new Date().toISOString(),
                project: { id: project.id, origin: project.origin, authorizedOrigins, verifiedAt: project.verifiedAt, accessMode: project.verifiedAt ? 'verified_origin' : 'public_link' },
                plan: { id: plan.id, limits: plan.limits },
                entitlements,
                externalProviderConsent: input.externalProviderConsent === true,
                urls,
                devices: ['desktop', 'mobile'],
                locale: input.locale,
                ...(input.journey ? { journey: input.journey } : {}),
                engines: ENGINE_VERSIONS,
                ...(discovery ? { discovery } : {})
            };
            const created = await store.createScan(workspaceId, project.id, manifest, {
                idempotencyKey: operation.idempotencyKey,
                requestFingerprint: operation.requestFingerprint,
                requestedByUserId,
                entitlementUserId
            });
            const duplicate = Boolean(created?.idempotent === true || created?.scan?.idempotent === true);
            const scanRecord = created?.scan || created;
            const scan = { ...scanRecord };
            delete scan.idempotent;
            if (duplicate) return { ...scan, idempotent: true };
            let queueAttempted = false;
            try {
                for (const url of urls) await store.reserveCredit(workspaceId, scan.id, pageCreditKey(url), plan.limits.pageCredits, new Date(), entitlementUserId);
                await store.createScanPages(workspaceId, scan.id, urls, {
                    maxAttempts: 3,
                    provenanceByUrl: discoveryProvenanceByUrl(discovery)
                });
                await startWorker();
                await appendProgress(workspaceId, scan.id, 'scan.queued', { requestedPages: urls.length, requestedModules: Object.keys(entitlements) });
                queueAttempted = true;
                const jobId = await enqueueWorkerJob(queue, 'scan', { scanId: scan.id, workspaceId }, { singletonKey: scan.id, retryLimit: 2 });
                await store.logAudit({ workspaceId, action: 'scan.queued', entityType: 'scan', entityId: scan.id, metadata: { pages: urls.length } });
                return { ...scan, jobId };
            } catch (error) {
                const definitelyRejected = error?.queueAccepted === false || error?.accepted === false || ['WORKER_QUEUE_UNAVAILABLE', 'QUEUE_SETUP_FAILED'].includes(error?.code);
                if (queueAttempted && !definitelyRejected) throw error;
                await Promise.all(urls.map((url) => store.settleCredit(workspaceId, scan.id, pageCreditKey(url), 'released')));
                await store.updateScan(workspaceId, scan.id, { status: 'failed', failureCode: error.code || 'QUEUE_SETUP_FAILED' }, { expectedStatuses: ['queued', 'running'] });
                throw error;
            }
        },
        async getScan(workspaceId, scanId) {
            const scan = await store.getScan(workspaceId, scanId);
            if (!scan) throw new AppError('Scan not found.', { status: 404, code: 'SCAN_NOT_FOUND' });
            return scan;
        },
        async getScanProgress(workspaceId, scanId, { after = 0 } = {}) {
            const scan = await this.getScan(workspaceId, scanId);
            const [pages, events] = await Promise.all([store.listScanPages(workspaceId, scanId), store.listScanEvents(workspaceId, scanId, { after, limit: 200 })]);
            const counts = Object.fromEntries(['queued', 'running', 'retrying', 'completed', 'incomplete', 'failed', 'unavailable', 'cancelled'].map((status) => [status, pages.filter((page) => page.status === status).length]));
            return { scan, counts, pages: pages.map(({ report, leaseOwner: _leaseOwner, leaseToken: _leaseToken, ...page }) => ({ ...page, modules: report?.moduleRuns || {} })), events, lastEventId: events.at(-1)?.id || after, historyLimit: 200 };
        },
        async getReport(workspaceId, reportId) {
            const report = await store.getReport(workspaceId, reportId);
            if (!report) throw new AppError('Report not found.', { status: 404, code: 'REPORT_NOT_FOUND' });
            const maxBytes = config.reportPayloadMaxBytes || 20 * 1024 * 1024;
            if (Buffer.byteLength(JSON.stringify(report.payload || {}), 'utf8') > maxBytes) throw new AppError('The report payload exceeds the response limit.', { status: 413, code: 'REPORT_PAYLOAD_TOO_LARGE' });
            return report;
        },
        listReports(workspaceId, options) { return store.listReports(workspaceId, options); },
        async listReportSummaries(workspaceId, { limit = 50, cursor = null } = {}) {
            if (typeof store.listReportSummaries === 'function') return store.listReportSummaries(workspaceId, { limit, cursor });
            return (await store.listReports(workspaceId, { limit })).map((report) => ({ id: report.id, scanId: report.scanId, version: report.version, status: report.status, locale: report.locale, createdAt: report.createdAt, publishedAt: report.publishedAt || null, summary: report.payload?.summary || null }));
        },
        async listFindings(workspaceId, { limit = 200, offset = 0, source, moduleId, device, kind, minConfidence, coverage } = {}) {
            const lifecycle = findingLifecycle(await store.listReports(workspaceId, { limit: 1_000 }));
            const matches = (finding) => {
                const sourceName = typeof finding.source === 'string' ? finding.source : finding.source?.name;
                if (source && sourceName !== source) return false;
                if (moduleId && finding.moduleId !== moduleId) return false;
                if (device && finding.device !== device) return false;
                if (kind && finding.kind !== kind) return false;
                if (Number.isFinite(minConfidence) && Number(finding.confidence) < minConfidence) return false;
                if (coverage === 'truncated' && !finding.coverage?.truncated) return false;
                if (coverage === 'complete' && finding.coverage?.truncated !== false) return false;
                return true;
            };
            const active = lifecycle.active.filter(matches); const resolved = lifecycle.resolved.filter(matches);
            const findings = [...active, ...resolved];
            return { findings: findings.slice(offset, offset + limit), total: findings.length, activeTotal: active.length, resolvedTotal: resolved.length, limit, offset, filters: { source: source || null, moduleId: moduleId || null, device: device || null, kind: kind || null, minConfidence: Number.isFinite(minConfidence) ? minConfidence : null, coverage: coverage || null } };
        },
        async dashboard(workspaceId, requesterUserId = null) {
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, requesterUserId);
            const [workspace, plan, usage, projects, scans, allReports, aiUsed, projectUsed, sourceAuditUsed] = await Promise.all([
                store.ensureWorkspace(workspaceId), workspacePlan(store, workspaceId, requesterUserId), store.getUsage(entitlementUserId),
                store.listProjects(workspaceId), store.listScans(workspaceId), store.listReports(workspaceId),
                store.countAiUsage(entitlementUserId), store.countProjects(entitlementUserId), store.countSourceInputs(entitlementUserId)
            ]);
            const reports = uniqueLatestReports(allReports);
            const lifecycle = findingLifecycle(allReports);
            const findings = lifecycle.active;
            const totalPages = reports.reduce((sum, report) => sum + Number(report.payload?.summary?.completedPages || 0), 0);
            const pageUsed = Number(usage.consumed || 0) + Number(usage.reserved || 0);
            const allowances = {
                periodStart: usage.periodStart,
                pageCredits: allowance(plan.limits.pageCredits, pageUsed, { consumed: Number(usage.consumed || 0), reserved: Number(usage.reserved || 0) }),
                aiRemediations: allowance(plan.limits.aiRemediations, aiUsed),
                projects: allowance(plan.limits.projects, projectUsed),
                sourceAudits: allowance(plan.limits.sourceAudits, sourceAuditUsed)
            };
            const now = Date.now();
            const trend = Array.from({ length: 6 }, (_, index) => {
                const end = now - (5 - index) * 7 * 86_400_000;
                const start = end - 7 * 86_400_000;
                return { at: new Date(end).toISOString(), count: findings.filter((finding) => { const time = new Date(finding.createdAt).getTime(); return time >= start && time < end; }).length };
            });
            return {
                workspace, plan: publicPlan(plan), entitlementState: { basePlanId: plan.basePlanId || workspace.planId, effectivePlanId: plan.effectivePlanId || plan.id, grants: plan.grants || [] }, usage, allowances, projects, scans,
                metrics: {
                    activeFindings: findings.length,
                    critical: findings.filter((finding) => finding.severity === 'critical').length,
                    highPriority: findings.filter((finding) => ['critical', 'high'].includes(finding.severity)).length,
                    resolved: lifecycle.resolved.length,
                    totalPages
                },
                recentFindings: findings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5),
                trend
            };
        },
        async adminOverview() {
            const snapshot = await store.adminOverview();
            const billingProvider = config.billing?.provider || 'unconfigured';
            const paddle = config.billing?.paddle || {};
            const billingConfigured = billingProvider === 'paddle' && Boolean(paddle.apiKey && paddle.webhookSecret && paddle.prices?.signal && paddle.prices?.studio);
            const billingStatus = billingConfigured ? 'operational' : 'configuration_required';
            const billingValue = billingConfigured ? 'Paddle configured' : (billingProvider === 'paddle' ? 'Paddle configuration required' : 'Billing provider configuration required');
            const worker = await analysisHealth();
            return {
                ...snapshot,
                health: [
                    { id: 'api', label: 'API', status: 'operational', value: 'Responding now; historical uptime requires the external monitor' },
                    { id: 'database', label: 'Database', status: config.databaseUrl ? 'operational' : 'development', value: config.databaseUrl ? 'Connected' : 'In-memory' },
                    { id: 'workers', label: 'Workers', status: worker.status, value: worker.detail },
                    { id: 'storage', label: 'Storage', status: config.sourceEncryptionKey ? 'operational' : 'configuration_required', value: config.sourceEncryptionKey ? 'Encrypted' : 'Key required' },
                    { id: 'integrations', label: 'Integrations', status: billingStatus, value: billingValue }
                ]
            };
        },
        adminResources(kind) { return store.adminResources(kind); },
        adminWorkspace(workspaceId) { return store.adminWorkspace(workspaceId); },
        adminUser(userId) { return store.adminUser(userId); },
        getEffectiveEntitlements(workspaceId, now) { return store.getEffectiveEntitlements(workspaceId, now); },
        assertCommercialCapability(workspaceId, requesterUserId, capability) {
            return requireCommercialCapability(store, workspaceId, requesterUserId, capability);
        },
        getUserEffectiveEntitlements(userId, now) { return store.getUserEffectiveEntitlements(userId, now); },
        getFinding(workspaceId, fingerprint) { return store.getFinding(workspaceId, fingerprint); },
        createRedeemCode(input) { return store.createRedeemCode(input); },
        listRedeemCodes(query) { return store.listRedeemCodes(query); },
        mutateRedeemCode(codeId, patch, context) { return store.mutateRedeemCode(codeId, patch, context); },
        redeemCode(workspaceId, userId, code, context) { return store.redeemCode(workspaceId, userId, code, context); },
        adjustCredits(workspaceId, creditType, amount, context) { return store.adjustCredits(workspaceId, creditType, amount, context); },
        grantEntitlement(workspaceId, input, context) { return store.grantEntitlement(workspaceId, input, context); },
        adjustUserCredits(userId, creditType, amount, context) { return store.adjustUserCredits(userId, creditType, amount, context); },
        grantUserEntitlement(userId, input, context) { return store.grantUserEntitlement(userId, input, context); },
        assignUserPlan(userId, planId, context) { return store.assignUserPlan(userId, planId, context); },
        revokeEntitlement(grantId, context) { return store.revokeEntitlement(grantId, context); },
        recordCheckoutAcceptance(input) { return store.recordCheckoutAcceptance(input); },
        markCheckoutAcceptance(workspaceId, idempotencyKey, input) { return store.markCheckoutAcceptance(workspaceId, idempotencyKey, input); },
        listTargetAuthorizations(workspaceId, options) { return store.listTargetAuthorizations(workspaceId, options); },
        consumeAiGeneration(workspaceId, input, options) { return store.consumeAiGeneration(workspaceId, input, options); },
        settleAiGeneration(workspaceId, usageId, input) { return store.settleAiGeneration(workspaceId, usageId, input); },
        recordAiUsage(input) { return store.recordAiUsage(input); },
        getAiCache(workspaceId, cacheKey, now) { return store.getAiCache(workspaceId, cacheKey, now); },
        putAiCache(input) { return store.putAiCache(input); },
        dailyAiCost(workspaceId, now) { return store.dailyAiCost(workspaceId, now); },
        listOperatorTasks(status) { return store.listOperatorTasks(status); },
        async completeOperatorTask(taskId, input, actorId, requestId = null) {
            if (!requestId) throw new AppError('An audit request ID is required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const task = await store.completeOperatorTask(taskId, { notes: input.notes, reportPatch: input.reportPatch, actorId, reason: input.reason, requestId });
            if (!task) throw new AppError('Operator task not found.', { status: 404, code: 'OPERATOR_TASK_NOT_FOUND' });
            return task;
        },
        async publishReport(workspaceId, reportId, context = {}) {
            if (!context.actorId || !context.reason?.trim() || !context.requestId) throw new AppError('An audit actor, reason, and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const result = await store.publishReportWithAudit(workspaceId, reportId, context);
            if (!result) throw new AppError('Report not found.', { status: 404, code: 'REPORT_NOT_FOUND' });
            return result.report;
        },
        async createShareLink(workspaceId, reportId, actorId, expiresInDays = 30) {
            const report = await this.getReport(workspaceId, reportId);
            if (report.status !== 'published') throw new AppError('Only published reports can be shared.', { status: 409, code: 'REPORT_NOT_PUBLISHED' });
            if (!Number.isInteger(expiresInDays) || !SHARE_EXPIRY_DAYS.includes(expiresInDays)) throw new AppError('Share expiry must be 7, 30, or 90 days.', { status: 400, code: 'SHARE_EXPIRY_INVALID' });
            const token = crypto.randomBytes(32).toString('base64url');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const createdAt = new Date();
            const expiresAt = new Date(createdAt.getTime() + expiresInDays * 86_400_000).toISOString();
            await store.setReportShareToken(workspaceId, reportId, tokenHash, { expiresAt, createdAt: createdAt.toISOString() });
            await store.logAudit({ workspaceId, actorId, action: 'report.share_created', entityType: 'report', entityId: reportId, metadata: { expiresAt } });
            const publicPath = `/shared-reports/${token}`;
            return { token, pagePath: publicPath, path: publicPath, url: `${config.appUrl}${publicPath}`, apiPath: `/api/v1/shared-reports/${token}`, reportId, status: 'active', expiresInDays, expiresAt };
        },
        async getSharedReport(token) {
            if (!/^[A-Za-z0-9_-]{16,256}$/.test(String(token || ''))) throw new AppError('Shared report not found.', { status: 404, code: 'SHARED_REPORT_NOT_FOUND' });
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const report = await store.getReportByShareToken(tokenHash);
            if (!report) throw new AppError('Shared report not found.', { status: 404, code: 'SHARED_REPORT_NOT_FOUND' });
            if (report.shareRevokedAt) throw new AppError('This shared report link has been revoked.', { status: 404, code: 'SHARED_REPORT_NOT_FOUND' });
            if (report.shareExpiresAt && Date.parse(report.shareExpiresAt) <= Date.now()) throw new AppError('This shared report link has expired.', { status: 410, code: 'SHARED_REPORT_EXPIRED' });
            await store.logAudit({ workspaceId: report.workspaceId, action: 'report.share_viewed', entityType: 'report', entityId: report.id, metadata: { share: 'public' } });
            return publicShareReport(report);
        },
        async revokeShareLink(workspaceId, reportId, actorId) {
            const report = await this.getReport(workspaceId, reportId);
            if (!report.shareTokenHash) throw new AppError('This report does not have an active share link.', { status: 404, code: 'SHARE_NOT_FOUND' });
            const revoked = await store.revokeReportShare(workspaceId, reportId);
            await store.logAudit({ workspaceId, actorId, action: 'report.share_revoked', entityType: 'report', entityId: reportId, metadata: {} });
            return { reportId, status: 'revoked', revokedAt: revoked?.shareRevokedAt || new Date().toISOString() };
        },
        async compareReports(workspaceId, leftId, rightId) {
            const [left, right] = await Promise.all([this.getReport(workspaceId, leftId), this.getReport(workspaceId, rightId)]);
            if (reportComparisonKey(left) !== reportComparisonKey(right)) throw new AppError('Reports must belong to the same project and use a comparable capability manifest.', { status: 409, code: 'REPORTS_NOT_COMPARABLE' });
            const before = reportFingerprints(left);
            const after = reportFingerprints(right);
            return {
                left: left.id, right: right.id,
                newFindings: [...after].filter((fingerprint) => !before.has(fingerprint)),
                fixedFindings: [...before].filter((fingerprint) => !after.has(fingerprint)),
                unchangedFindings: [...after].filter((fingerprint) => before.has(fingerprint))
            };
        },
        async assignPlan(workspaceId, planId) {
            if (!(await store.getPlan?.(planId)) && !getPlan(planId)) throw new AppError('Unknown plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
            await store.ensureWorkspace(workspaceId);
            const workspace = await store.setWorkspacePlan(workspaceId, planId);
            await store.logAudit({ workspaceId, action: 'workspace.plan_changed', entityType: 'workspace', entityId: workspaceId, metadata: { planId } });
            return workspace;
        },
        async setPlanEntitlement(planId, moduleId, entitlement) {
            if (!isAdminGrantableModule(moduleId)) throw new AppError('This module cannot be granted.', { status: 400, code: 'ENTITLEMENT_MODULE_NOT_GRANTABLE' });
            const plan = await store.setPlanEntitlement(planId, moduleId, entitlement);
            if (!plan) throw new AppError('Unknown plan.', { status: 404, code: 'PLAN_NOT_FOUND' });
            return plan;
        },
        async requestExpertReview(workspaceId, reportId, input, actorId) {
            const report = await this.getReport(workspaceId, reportId);
            if (!['automated_draft', 'operator_completed'].includes(report.status)) throw new AppError('Expert Review must start from a completed automated or operator report.', { status: 409, code: 'EXPERT_REVIEW_SOURCE_INVALID' });
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, actorId);
            const plan = await workspacePlan(store, workspaceId, actorId);
            const entitlement = plan.entitlements?.expert_review;
            const executionMode = typeof entitlement === 'string' ? entitlement : entitlement?.executionMode;
            if (!entitlement || executionMode === 'disabled') throw new AppError('Expert Review is not enabled for this workspace.', { status: 403, code: 'MODULE_NOT_ENTITLED' });
            const reviewLimit = Number(entitlement?.limit ?? plan.limits?.expertReviews);
            if (!Number.isInteger(reviewLimit) || reviewLimit < 1) throw new AppError('Expert Review is not enabled for this workspace.', { status: 403, code: 'MODULE_NOT_ENTITLED' });
            if (await store.countExpertReviews(entitlementUserId) >= reviewLimit) throw new AppError('The monthly Expert Review allowance has been used.', { status: 409, code: 'EXPERT_REVIEW_LIMIT_REACHED' });
            const reportPages = new Set((report.payload?.pages || []).map((page) => page.url));
            const pageUrls = [...new Set(input.pageUrls)];
            if (pageUrls.length > (plan.limits.expertPages || 25) || pageUrls.some((url) => !reportPages.has(url))) throw new AppError('Expert Review pages must belong to this report and remain within the plan limit.', { status: 400, code: 'EXPERT_REVIEW_SCOPE_INVALID' });
            const existing = (await store.listExpertReviews(workspaceId)).find((item) => item.idempotencyKey === input.idempotencyKey);
            if (existing) return existing;
            const review = await store.createExpertReview(workspaceId, { entitlementUserId, scanId: report.scanId, sourceReportId: report.id, scopePageUrls: pageUrls, requestedBy: actorId, idempotencyKey: input.idempotencyKey, dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() });
            await store.logAudit({ workspaceId, actorId, action: 'expert_review.requested', entityType: 'expert_review', entityId: review.id, metadata: { reportId, pages: pageUrls.length } });
            return review;
        },
        async listExpertReviews(workspaceId = null) { return store.listExpertReviews(workspaceId); },
        async getExpertReview(reviewId, workspaceId = null) {
            const review = await store.getExpertReview(reviewId);
            if (!review || (workspaceId && review.workspaceId !== workspaceId)) throw new AppError('Expert Review not found.', { status: 404, code: 'EXPERT_REVIEW_NOT_FOUND' });
            const report = await store.getReportById(review.sourceReportId);
            const latest = await store.getLatestReportForScan(review.workspaceId, review.scanId);
            return { ...review, findings: scopedReportFindings(report, review.scopePageUrls), ...(['expert_reviewed', 'published'].includes(latest?.status) ? { expertReportId: latest.id } : {}) };
        },
        async claimExpertReview(reviewId, actorId, context = {}) {
            if (!context.reason?.trim() || !context.requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const review = await this.getExpertReview(reviewId);
            if (!['requested', 'in_review'].includes(review.status) || (review.assignedTo && review.assignedTo !== actorId)) throw new AppError('This review is already assigned or no longer claimable.', { status: 409, code: 'EXPERT_REVIEW_NOT_CLAIMABLE' });
            return store.updateExpertReview(reviewId, { status: 'in_review', assignedTo: actorId, audit: { actorId, action: 'expert_review.claimed', reason: context.reason, requestId: context.requestId, metadata: { assignedTo: actorId } } });
        },
        async decideExpertFinding(reviewId, fingerprint, decision, actorId, context = {}) {
            if (!context.reason?.trim() || !context.requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const review = await this.getExpertReview(reviewId);
            if (review.status !== 'in_review' || review.assignedTo !== actorId) throw new AppError('Claim this review before editing decisions.', { status: 409, code: 'EXPERT_REVIEW_NOT_ASSIGNED' });
            const report = await store.getReportById(review.sourceReportId);
            if (!scopedReportFindings(report, review.scopePageUrls).some((finding) => finding.fingerprint === fingerprint)) throw new AppError('Finding does not belong to the review scope.', { status: 404, code: 'EXPERT_FINDING_NOT_FOUND' });
            const decisions = { ...(review.decisions || {}), [fingerprint]: { ...decision, decidedBy: actorId, decidedAt: new Date().toISOString() } };
            return store.updateExpertReview(reviewId, { decisions, audit: { actorId, action: 'expert_review.finding_decided', reason: context.reason, requestId: context.requestId, metadata: { fingerprint, decision: decision.decision, priority: decision.priority } } });
        },
        async setExpertRoadmap(reviewId, items, actorId, context = {}) {
            if (!context.reason?.trim() || !context.requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const review = await this.getExpertReview(reviewId);
            if (review.status !== 'in_review' || review.assignedTo !== actorId) throw new AppError('Claim this review before editing its roadmap.', { status: 409, code: 'EXPERT_REVIEW_NOT_ASSIGNED' });
            return store.updateExpertReview(reviewId, { roadmap: items, audit: { actorId, action: 'expert_review.roadmap_updated', reason: context.reason, requestId: context.requestId, metadata: { itemCount: items.length } } });
        },
        async finalizeExpertReview(reviewId, actorId, context = {}) {
            if (!context.reason?.trim() || !context.requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const review = await this.getExpertReview(reviewId);
            if (review.status === 'ready_to_publish') return review;
            if (review.status !== 'in_review' || review.assignedTo !== actorId) throw new AppError('Only the assigned reviewer can finalize this review.', { status: 409, code: 'EXPERT_REVIEW_NOT_ASSIGNED' });
            const source = await store.getReportById(review.sourceReportId);
            const findings = scopedReportFindings(source, review.scopePageUrls);
            const missing = findings.filter((finding) => !review.decisions?.[finding.fingerprint]);
            if (missing.length) throw new AppError(`${missing.length} scoped findings still need a decision.`, { status: 409, code: 'EXPERT_REVIEW_INCOMPLETE' });
            const payload = structuredClone(source.payload);
            for (const page of payload.pages || []) for (const finding of page.report?.findings || []) {
                const decision = review.decisions?.[finding.fingerprint];
                if (!decision) continue;
                finding.expertReview = { decision: decision.decision, priority: decision.priority, rationale: decision.rationale, reviewer: actorId };
                if (decision.decision === 'edited') Object.assign(finding, decision.edits || {});
            }
            payload.expertReview = { reviewId, sourceReportId: source.id, reviewer: actorId, decisions: review.decisions, roadmap: review.roadmap, completedAt: new Date().toISOString() };
            const result = await store.finalizeExpertReviewWithAudit(reviewId, { payload, locale: source.locale, actorId, reason: context.reason, requestId: context.requestId, expectedUpdatedAt: review.updatedAt });
            if (!result) throw new AppError('Expert Review not found.', { status: 404, code: 'EXPERT_REVIEW_NOT_FOUND' });
            return { ...result.review, reportId: result.report.id };
        },
        async publishExpertReview(reviewId, actorId, context = {}) {
            if (!context.reason?.trim() || !context.requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const review = await this.getExpertReview(reviewId);
            if (review.status === 'published') return review;
            if (review.status !== 'ready_to_publish' || !review.expertReportId) throw new AppError('Finalize the Expert Review before publication.', { status: 409, code: 'EXPERT_REVIEW_NOT_READY' });
            const result = await store.publishExpertReviewWithAudit(reviewId, review.expertReportId, { actorId, reason: context.reason, requestId: context.requestId });
            if (!result) throw new AppError('Expert Review not found.', { status: 404, code: 'EXPERT_REVIEW_NOT_FOUND' });
            return { ...result.review, reportId: result.report.id };
        },
        executeScan,
        executeScanPage,
        finalizeScan
    };
}

module.exports = { createPlatformService, coreSuccessCount, selectedEntitlements, reportFingerprints, findingLifecycle, QUEUE_NAME, PAGE_QUEUE_NAME };
