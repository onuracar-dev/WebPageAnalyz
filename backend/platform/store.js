const crypto = require('node:crypto');
const { Pool } = require('pg');
const { AppError } = require('../lib/errors');
const { ALL_PLANS, getPlan, planSalesMode, publicPlan } = require('../domain/plans');
const { isAdminGrantableModule } = require('../domain/admin-entitlements');
const { normalizePageUrl } = require('../domain/url-normalization');
const { assertIdempotentReplay } = require('../domain/idempotency');
const { databasePoolOptions } = require('../config');
const { observePostgresPool } = require('../lib/postgres-pool');
const { canManagePrivilegedRole, canonicalAdminRole } = require('../auth/admin-policy');

function id(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function operationOptions(options = {}) {
    const idempotencyKey = options?.idempotencyKey == null ? null : String(options.idempotencyKey).trim() || null;
    const requestFingerprint = options?.requestFingerprint == null ? null : String(options.requestFingerprint);
    const parsedLimit = options?.limit == null ? null : Number(options.limit);
    const limit = Number.isFinite(parsedLimit) ? Math.max(0, Math.floor(parsedLimit)) : null;
    return { idempotencyKey, requestFingerprint, limit };
}

function operationResult(record, idempotencyKey, idempotent) {
    if (!idempotencyKey) return record;
    const output = { ...record };
    delete output.idempotencyKey;
    delete output.requestFingerprint;
    return { ...output, idempotent: Boolean(idempotent) };
}

function monthStart(now = new Date()) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const SENSITIVE_AUDIT_KEY = /(password|passphrase|secret|token|authorization|credential|cookie|api[_-]?key|private[_-]?key)/i;
const PLAN_RANK = Object.freeze({ free: 0, signal: 1, studio: 2, enterprise: 3 });
const PAGE_TERMINAL_STORE = new Set(['completed', 'incomplete', 'failed', 'unavailable', 'cancelled']);
const AI_QUOTA_STATUSES = new Set(['reserved', 'completed', 'cache_hit']);
const AI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cache_hit']);
const PAGE_DISCOVERY_SOURCES = new Set(['root', 'internal_link', 'rendered_link', 'sitemap', 'manual', 'canonical', 'hreflang']);
function assertGrantableEntitlementModule(moduleId) {
    if (!isAdminGrantableModule(moduleId)) {
        throw new AppError('This module cannot be granted.', { status: 400, code: 'ENTITLEMENT_MODULE_NOT_GRANTABLE' });
    }
}

function assertGrantableEntitlementOverrides(overrides = {}) {
    for (const moduleId of Object.keys(overrides || {})) assertGrantableEntitlementModule(moduleId);
}

function pageKeyFor(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

function normalizePageDiscovery(value = {}) {
    const sources = [];
    const input = Array.isArray(value?.sources) ? value.sources : [];
    for (const source of input.slice(0, 20)) {
        const type = String(source?.type || '').trim();
        if (!PAGE_DISCOVERY_SOURCES.has(type)) continue;
        let referrer = null;
        if (source?.referrer) {
            try { referrer = normalizePageUrl(String(source.referrer)); }
            catch { referrer = null; }
        }
        if (!sources.some((item) => item.type === type && item.referrer === referrer)) sources.push({ type, referrer });
    }
    return { sources };
}

function mergePageDiscovery(left, right) {
    return normalizePageDiscovery({ sources: [...(left?.sources || []), ...(right?.sources || [])] });
}

function normalizedPageEntry(value) {
    const rawUrl = typeof value === 'string' ? value : value?.url;
    const url = normalizePageUrl(String(rawUrl || ''));
    const source = typeof value === 'object' && value?.source ? [value.source] : [];
    return {
        url,
        pageKey: pageKeyFor(url),
        discovery: normalizePageDiscovery(typeof value === 'object' ? (value.discovery || { sources: value.sources || source }) : {})
    };
}

function discoveryForUrl(provenanceByUrl, rawUrl, normalizedUrl) {
    if (!provenanceByUrl) return { sources: [] };
    const value = provenanceByUrl instanceof Map
        ? (provenanceByUrl.get(normalizedUrl) || provenanceByUrl.get(rawUrl))
        : (provenanceByUrl[normalizedUrl] || provenanceByUrl[rawUrl]);
    return normalizePageDiscovery(value || {});
}

function aiMonthBounds(now = new Date()) {
    const at = new Date(now);
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return { start, end };
}

function aiQuotaLimit(effectivePlan) {
    const entitlement = effectivePlan?.entitlements?.ai_remediation;
    if (!entitlement || entitlement.executionMode === 'disabled') {
        throw new AppError('AI remediation is not enabled for this workspace.', { status: 403, code: 'AI_REMEDIATION_NOT_ENTITLED' });
    }
    return Math.max(0, Math.floor(Number(effectivePlan?.limits?.aiRemediations || 0)));
}

function assertAiReservationInput(input) {
    for (const field of ['userId', 'findingFingerprint', 'requestedModel', 'provider', 'promptVersion', 'evidenceVersion', 'idempotencyKey']) {
        if (!String(input?.[field] || '').trim()) throw new AppError(`AI usage ${field} is required.`, { status: 400, code: 'AI_USAGE_INVALID' });
    }
}

function assertAiReplayMatches(existing, requested) {
    const fields = ['userId', 'entitlementUserId', 'findingFingerprint', 'requestedModel', 'provider', 'promptVersion', 'evidenceVersion'];
    if (fields.some((field) => String(existing?.[field] || '') !== String(requested?.[field] || ''))) {
        throw new AppError('The idempotency key was already used for a different request.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    }
}

function checkoutTransitionAllowed(from, to) {
    if (from === to) return true;
    if (from === 'accepted') return ['checkout_created', 'completed', 'expired', 'cancelled'].includes(to);
    if (from === 'checkout_created') return ['completed', 'expired', 'cancelled'].includes(to);
    return false;
}

function sanitizeAuditValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 4_000);
    if (depth >= 8) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeAuditValue(item, depth + 1, seen));
    if (typeof value !== 'object') return String(value).slice(0, 4_000);
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
        output[String(key).slice(0, 120)] = SENSITIVE_AUDIT_KEY.test(key) ? '[REDACTED]' : sanitizeAuditValue(item, depth + 1, seen);
    }
    seen.delete(value);
    return output;
}

function auditTargetUserId(entry) {
    const metadata = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    const after = entry?.after && typeof entry.after === 'object' ? entry.after : {};
    const before = entry?.before && typeof entry.before === 'object' ? entry.before : {};
    const explicit = metadata.targetUserId || after.userId || after.entitlementUserId || before.userId || before.entitlementUserId;
    if (explicit) return String(explicit);
    return ['user', 'user_entitlement_profile'].includes(String(entry?.entityType || '')) && entry?.entityId
        ? String(entry.entityId)
        : null;
}

function auditPrincipal(principal, fallbackId = null) {
    const principalId = principal?.id || principal?.userId || fallbackId;
    if (!principalId) return null;
    return {
        id: String(principalId),
        name: principal?.name || null,
        email: principal?.email || null
    };
}

function normalizeRedeemCode(code) {
    const normalized = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9_-]{6,64}$/.test(normalized)) throw new AppError('Redeem code format is invalid.', { status: 400, code: 'REDEEM_CODE_INVALID' });
    return normalized;
}

function redeemCodeHint(code) {
    const normalized = normalizeRedeemCode(code);
    return `${normalized.slice(0, 3)}:${normalized.length}`;
}

function hashRedeemCode(code, salt = crypto.randomBytes(16)) {
    const normalized = normalizeRedeemCode(code);
    return { salt: Buffer.from(salt), hash: crypto.scryptSync(normalized, salt, 64) };
}

function verifyRedeemCodeHash(code, salt, expectedHash) {
    try {
        const actual = hashRedeemCode(code, Buffer.from(salt)).hash;
        const expected = Buffer.from(expectedHash);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        // Keep malformed and non-matching codes on the same public failure path.
        return false;
    }
}

function findRedeemCodeByHash(candidates, code) {
    let match = null;
    for (const candidate of candidates) {
        const valid = verifyRedeemCodeHash(code, candidate.codeSalt, candidate.codeHash);
        if (valid && !match) match = candidate;
    }
    if (!candidates.length) verifyRedeemCodeHash(code, Buffer.alloc(16), Buffer.alloc(64));
    return match;
}

function activeAt(record, now = new Date()) {
    const timestamp = new Date(now).getTime();
    return !record.revokedAt
        && (!record.startsAt || new Date(record.startsAt).getTime() <= timestamp)
        && (!record.expiresAt || new Date(record.expiresAt).getTime() > timestamp);
}

function composeEffectivePlan(basePlan, grants = [], adjustments = [], now = new Date()) {
    const activeGrants = grants.filter((grant) => activeAt(grant, now));
    let effectivePlan = basePlan || getPlan('free');
    for (const grant of activeGrants) {
        const candidate = grant.temporaryPlanId && getPlan(grant.temporaryPlanId);
        if (candidate && (PLAN_RANK[candidate.id] ?? -1) > (PLAN_RANK[effectivePlan.id] ?? -1)) effectivePlan = candidate;
    }
    const entitlements = Object.fromEntries(Object.entries(effectivePlan.entitlements || {})
        .filter(([moduleId]) => isAdminGrantableModule(moduleId))
        .map(([moduleId, entitlement]) => [moduleId, structuredClone(entitlement)]));
    for (const grant of activeGrants.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id || '').localeCompare(String(right.id || '')))) {
        for (const [moduleId, entitlement] of Object.entries(grant.entitlementOverrides || {})) {
            if (!isAdminGrantableModule(moduleId)) continue;
            entitlements[moduleId] = structuredClone(entitlement);
        }
    }
    const activeAdjustments = adjustments.filter((entry) => activeAt(entry, now));
    const grantPageCredits = activeGrants.reduce((sum, grant) => sum + Number(grant.bonusPageCredits || 0), 0);
    const grantAiCredits = activeGrants.reduce((sum, grant) => sum + Number(grant.bonusAiCredits || 0), 0);
    const adjustedPageCredits = activeAdjustments.filter((entry) => entry.creditType === 'page').reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const adjustedAiCredits = activeAdjustments.filter((entry) => entry.creditType === 'ai').reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const limits = {
        ...structuredClone(effectivePlan.limits || {}),
        pageCredits: Math.max(0, Number(effectivePlan.limits?.pageCredits || 0) + grantPageCredits + adjustedPageCredits),
        aiRemediations: Math.max(0, Number(effectivePlan.limits?.aiRemediations || 0) + grantAiCredits + adjustedAiCredits)
    };
    return {
        ...structuredClone(effectivePlan),
        limits,
        entitlements,
        basePlanId: basePlan?.id || 'free',
        effectivePlanId: effectivePlan.id,
        grants: activeGrants.map((grant) => ({ id: grant.id, source: grant.source, temporaryPlanId: grant.temporaryPlanId || null, startsAt: grant.startsAt, expiresAt: grant.expiresAt || null }))
    };
}

async function insertAuditRecord(client, entry, { returning = true } = {}) {
    const auditId = id('audit');
    const metadata = sanitizeAuditValue(entry.metadata || {});
    const reason = entry.reason || metadata.reason || null;
    const requestId = entry.requestId || metadata.requestId || null;
    const before = sanitizeAuditValue(entry.before ?? metadata.before ?? null);
    const after = sanitizeAuditValue(entry.after ?? metadata.after ?? null);
    const createdAt = new Date().toISOString();
    const { rows } = await client.query(
        `INSERT INTO wpa_audit_log(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,reason,request_id,before_state,after_state)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb)
         ${returning ? 'RETURNING id,workspace_id AS "workspaceId",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",metadata,reason,request_id AS "requestId",before_state AS before,after_state AS after,created_at AS "createdAt"' : ''}`,
        [auditId, entry.workspaceId || null, entry.actorId || null, entry.action, entry.entityType, entry.entityId || null, JSON.stringify(metadata), reason, requestId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]
    );
    return rows[0] || {
        id: auditId,
        workspaceId: entry.workspaceId || null,
        actorId: entry.actorId || null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId || null,
        metadata,
        reason,
        requestId,
        before,
        after,
        createdAt
    };
}

async function publishReportTransaction(client, workspaceId, sourceReportId, { actorId, reason, requestId, writeAudit = true } = {}) {
    const source = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, sourceReportId])).rows[0];
    if (!source) return null;
    if (!['operator_completed', 'expert_reviewed'].includes(source.status)) throw new AppError('Only operator-completed or expert-reviewed reports can be published.', { status: 409, code: 'REPORT_NOT_REVIEWED' });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(source.scanId)]);
    const existing = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND scan_id=$2 AND status=\'published\' AND payload=$3::jsonb ORDER BY version DESC LIMIT 1 FOR UPDATE', [workspaceId, source.scanId, JSON.stringify(source.payload)])).rows[0] || null;
    if (existing) return { report: existing, source, idempotent: true };
    const publishedId = id('rpt');
    const published = (await client.query("INSERT INTO wpa_reports(id,workspace_id,scan_id,version,status,locale,payload,published_at) SELECT $1,$2,$3,COALESCE(max(version),0)+1,'published',$4,$5::jsonb,now() FROM wpa_reports WHERE scan_id=$3 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\",published_at AS \"publishedAt\"", [publishedId, workspaceId, source.scanId, source.locale, JSON.stringify(source.payload)])).rows[0];
    if (writeAudit) await insertAuditRecord(client, {
        workspaceId,
        actorId,
        action: 'report.published',
        entityType: 'report',
        entityId: published.id,
        reason,
        requestId,
        before: { status: source.status, reportId: source.id },
        after: { status: published.status, reportId: published.id }
    });
    return { report: published, source, idempotent: false };
}

function findingsFromPayload(payload) {
    const findings = Array.isArray(payload?.findings) ? payload.findings.map((finding) => ({ ...finding, coverage: finding.coverage || payload?.coverage?.crawler || null })) : [];
    for (const page of payload?.pages || []) {
        if (Array.isArray(page.report?.findings)) findings.push(...page.report.findings.map((finding) => ({ ...finding, pageUrl: finding.pageUrl || page.url, coverage: finding.coverage || page.report?.moduleRuns?.[finding.engineId]?.coverage || null })));
        else for (const issues of Object.values(page.report?.categories || {})) if (Array.isArray(issues)) findings.push(...issues.map((finding) => ({ ...finding, pageUrl: finding.pageUrl || page.url })));
    }
    return findings;
}

function reportSummary(report) {
    return {
        id: report.id,
        scanId: report.scanId,
        version: report.version,
        status: report.status,
        locale: report.locale,
        createdAt: report.createdAt,
        publishedAt: report.publishedAt || null,
        summary: report.payload?.summary && typeof report.payload.summary === 'object' ? structuredClone(report.payload.summary) : null
    };
}

function adminScanView(scan) {
    const failureCode = scan.failureCode || null;
    return {
        ...scan,
        jobState: scan.status,
        retryEligible: ['failed', 'partial', 'cancelled'].includes(scan.status),
        failureExplanation: failureCode
            ? (failureCode === 'ADMIN_CANCELLED' ? 'The scan was cancelled by an administrator.' : `The scan stopped with ${failureCode}; inspect its page and execution evidence before retrying.`)
            : null,
        failureTimestamp: failureCode ? (scan.completedAt || scan.updatedAt || null) : null
    };
}

class MemoryPlatformStore {
    constructor() {
        this.users = new Map();
        this.workspaces = new Map();
        this.projects = new Map();
        this.scans = new Map();
        this.scanPages = new Map();
        this.scanEvents = new Map();
        this.credits = new Map();
        this.reports = new Map();
        this.tasks = new Map();
        this.planCatalog = new Map(ALL_PLANS.map((plan) => [plan.id, { ...structuredClone(publicPlan(plan)), published: plan.id !== 'free', salesMode: planSalesMode(plan.id) }]));
        this.subscriptions = new Map();
        this.sourceInputs = new Map();
        this.expertReviews = new Map();
        this.adminAccounts = new Map();
        this.adminReauthMarkers = new Map();
        this.adminPasskeys = new Map();
        this.adminWebAuthnAssertions = new Map();
        this.adminRecoveryCodes = new Map();
        this.adminRecoverySessions = new Map();
        this.workspaceSettings = new Map();
        this.integrations = new Map();
        this.oauthStates = new Map();
        this.supportTickets = new Map();
        this.supportMessages = new Map();
        this.supportIdempotency = new Map();
        this.webhookOutbox = new Map();
        this.webhookOutboxHistory = [];
        this.deletionRequests = new Map();
        this.deletionRuns = new Map();
        this.retentionRuns = new Map();
        this.executionResults = new Map();
        this.billingEvents = new Map();
        this.checkoutAcceptances = new Map();
        this.legalAcceptances = new Map();
        this.targetAuthorizations = new Map();
        this.redeemCodes = new Map();
        this.redeemRedemptions = new Map();
        this.entitlementGrants = new Map();
        this.creditAdjustments = new Map();
        this.userEntitlementProfiles = new Map();
        this.userPlanChanges = new Map();
        this.aiUsage = new Map();
        this.aiCache = new Map();
        this.aiQuotaLocks = new Map();
        this.pageQuotaLocks = new Map();
        this.scanAppendLocks = new Map();
        this.operationLocks = new Map();
        this.userStates = new Map();
        this.workerHeartbeats = new Map();
        this.auditLog = [];
    }

    async _withAiQuotaLock(workspaceId, operation) {
        const previous = this.aiQuotaLocks.get(workspaceId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.aiQuotaLocks.set(workspaceId, current);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (this.aiQuotaLocks.get(workspaceId) === current) this.aiQuotaLocks.delete(workspaceId);
        }
    }

    async _withPageQuotaLock(entitlementUserId, operation) {
        const previous = this.pageQuotaLocks.get(entitlementUserId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.pageQuotaLocks.set(entitlementUserId, current);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (this.pageQuotaLocks.get(entitlementUserId) === current) this.pageQuotaLocks.delete(entitlementUserId);
        }
    }

    async _withScanAppendLock(workspaceId, operation) {
        const previous = this.scanAppendLocks.get(workspaceId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.scanAppendLocks.set(workspaceId, current);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (this.scanAppendLocks.get(workspaceId) === current) this.scanAppendLocks.delete(workspaceId);
        }
    }

    async _withOperationLock(key, operation) {
        const previous = this.operationLocks.get(key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.operationLocks.set(key, current);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (this.operationLocks.get(key) === current) this.operationLocks.delete(key);
        }
    }

    async close() {}
    async healthCheck() { return { status: 'development' }; }
    async recordWorkerHeartbeat(kind, workerId, { startedAt = null, metadata = {}, now = new Date() } = {}) {
        const at = new Date(now).toISOString();
        const current = this.workerHeartbeats.get(kind);
        const record = {
            kind,
            workerId,
            startedAt: current?.workerId === workerId ? current.startedAt : (startedAt ? new Date(startedAt).toISOString() : at),
            heartbeatAt: at,
            metadata: sanitizeAuditValue(metadata)
        };
        this.workerHeartbeats.set(kind, record);
        return structuredClone(record);
    }
    async workerHealth(kind, { maxAgeMs = 90_000, now = new Date() } = {}) {
        const record = this.workerHeartbeats.get(kind);
        if (!record) return { kind, status: 'unavailable', heartbeatAt: null, ageMs: null };
        const ageMs = Math.max(0, new Date(now).getTime() - new Date(record.heartbeatAt).getTime());
        return { ...structuredClone(record), status: ageMs <= maxAgeMs ? 'operational' : 'stale', ageMs };
    }

    async createExecutionResult({ jobKey, workspaceId = null, kind, input = {} }) {
        if (this.executionResults.has(jobKey)) return structuredClone(this.executionResults.get(jobKey));
        const now = new Date().toISOString();
        const record = { id: id('exec'), jobKey, workspaceId, kind, status: 'queued', input: structuredClone(input), result: null, artifactPath: null, contentType: null, bytes: null, failureCode: null, attempts: 0, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, createdAt: now, updatedAt: now, completedAt: null };
        this.executionResults.set(jobKey, record);
        return structuredClone(record);
    }
    async getExecutionResult(workspaceId, executionId) {
        const record = [...this.executionResults.values()].find((item) => item.id === executionId && (workspaceId == null || item.workspaceId === workspaceId));
        return record ? structuredClone(record) : null;
    }
    async claimExecutionResult(jobKey, { owner = 'worker', leaseMs = 120_000 } = {}) {
        const record = this.executionResults.get(jobKey);
        if (!record || ['completed', 'failed', 'unavailable'].includes(record.status)) return record ? structuredClone(record) : null;
        const now = Date.now();
        if (record.status === 'running' && new Date(record.leaseExpiresAt || 0).getTime() > now) return null;
        Object.assign(record, { status: 'running', attempts: record.attempts + 1, leaseOwner: String(owner), leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date().toISOString() });
        return structuredClone(record);
    }
    async renewExecutionResultLease(jobKey, { owner, leaseToken, leaseMs = 120_000 } = {}) {
        const record = this.executionResults.get(jobKey);
        if (!record || record.status !== 'running' || record.leaseOwner !== String(owner) || record.leaseToken !== leaseToken) return null;
        Object.assign(record, { leaseExpiresAt: new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 120_000)).toISOString(), updatedAt: new Date().toISOString() });
        return structuredClone(record);
    }
    async settleExecutionResult(jobKey, { owner, leaseToken, status, result = null, artifactPath = null, contentType = null, bytes = null, failureCode = null } = {}) {
        const record = this.executionResults.get(jobKey);
        if (!record || record.status !== 'running' || record.leaseOwner !== owner || record.leaseToken !== leaseToken) return null;
        Object.assign(record, { status, result: result == null ? null : structuredClone(result), artifactPath, contentType, bytes, failureCode, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, completedAt: ['completed', 'failed', 'unavailable'].includes(status) ? new Date().toISOString() : null, updatedAt: new Date().toISOString() });
        return structuredClone(record);
    }
    async listWorkspaceIds() { return [...this.workspaces.keys()]; }

    async getAdminAccount(userId) {
        const account = this.adminAccounts.get(userId);
        return account ? { ...account, role: canonicalAdminRole(account.role), securityVersion: Number(account.securityVersion || 1) } : null;
    }
    async upsertAdminAccount(account) {
        const role = canonicalAdminRole(account.role);
        if (!role) throw new AppError('Unknown administrator role.', { status: 400, code: 'ADMIN_ROLE_INVALID' });
        this.adminAccounts.set(account.userId, { securityVersion: 1, ...account, role });
        return this.getAdminAccount(account.userId);
    }
    async touchAdminAccount(userId) { const account = this.adminAccounts.get(userId); if (account) account.lastAccessAt = new Date().toISOString(); return account || null; }
    async countUserPasskeys(userId) { return [...this.adminPasskeys.values()].filter((item) => item.userId === userId).length; }
    async listUserPasskeys(userId) {
        return [...this.adminPasskeys.values()].filter((item) => item.userId === userId).map(({ publicKey: _publicKey, credentialID: _credentialID, ...item }) => structuredClone(item));
    }
    async deletePrivilegedPasskey({ userId, passkeyId, actorId, requestId, minimumCredentialCount = 1, credentialRequired = false }) {
        return this._withOperationLock(`privileged-passkey:${userId}`, async () => {
            const credential = this.adminPasskeys.get(passkeyId);
            if (!credential || credential.userId !== userId) throw new AppError('The passkey was not found.', { status: 404, code: 'PASSKEY_NOT_FOUND' });
            const count = await this.countUserPasskeys(userId);
            if (credentialRequired && count <= Math.max(1, Number(minimumCredentialCount) || 1)) {
                throw new AppError('Add a replacement passkey before removing the final required credential.', { status: 409, code: 'ADMIN_FINAL_PASSKEY_REQUIRED' });
            }
            this.adminPasskeys.delete(passkeyId);
            await this.logAudit({
                actorId,
                action: 'security.webauthn_removed',
                entityType: 'admin_account',
                entityId: userId,
                requestId,
                metadata: { credentialId: credential.id, name: credential.name || null }
            });
            const safeCredential = structuredClone(credential);
            delete safeCredential.publicKey;
            delete safeCredential.credentialID;
            return safeCredential;
        });
    }
    async listAdminAccounts() {
        return Promise.all([...this.adminAccounts.values()].map(async (account) => ({
            ...structuredClone(account),
            role: canonicalAdminRole(account.role),
            securityVersion: Number(account.securityVersion || 1),
            webAuthnCredentialCount: await this.countUserPasskeys(account.userId),
            recoveryCodesRemaining: [...this.adminRecoveryCodes.values()].filter((code) => code.userId === account.userId && !code.usedAt).length
        })));
    }
    async changeAdminAccount({ actorId, targetUserId, email, role, active, reason, requestId }) {
        return this._withOperationLock('privileged-role-management', async () => {
            const actor = await this.getAdminAccount(actorId);
            const nextRole = canonicalAdminRole(role);
            if (!actor?.active || !nextRole || !canManagePrivilegedRole(actor.role, nextRole)) throw new AppError('This administrator cannot assign the requested role.', { status: 403, code: 'ADMIN_ROLE_ASSIGNMENT_FORBIDDEN' });
            const before = await this.getAdminAccount(targetUserId);
            const activeSuperAdmins = [...this.adminAccounts.values()].filter((item) => item.active && canonicalAdminRole(item.role) === 'super_admin');
            if (before?.active && before.role === 'super_admin' && (!active || nextRole !== 'super_admin') && activeSuperAdmins.length <= 1) {
                throw new AppError('The final active super administrator cannot be removed or downgraded.', { status: 409, code: 'LAST_SUPER_ADMIN_REQUIRED' });
            }
            const targetUser = this.users.get(targetUserId);
            const targetEmail = String(email || targetUser?.email || before?.email || '').trim().toLowerCase();
            if (!targetEmail) throw new AppError('The target user email could not be resolved.', { status: 404, code: 'USER_NOT_FOUND' });
            const after = {
                userId: targetUserId,
                email: targetEmail,
                role: nextRole,
                active: Boolean(active),
                securityVersion: Number(before?.securityVersion || 0) + 1,
                createdAt: before?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastAccessAt: before?.lastAccessAt || null
            };
            this.adminAccounts.set(targetUserId, after);
            for (const key of this.adminReauthMarkers.keys()) if (key.endsWith(`:${targetUserId}`)) this.adminReauthMarkers.delete(key);
            await this.logAudit({ actorId, action: before?.active && !after.active ? 'security.role_revoked' : before ? 'security.role_changed' : 'security.role_granted', entityType: 'admin_account', entityId: targetUserId, reason, requestId, before, after, metadata: { targetEmail, previousRole: before?.role || null, role: after.role, active: after.active } });
            return structuredClone(after);
        });
    }
    async recordAdminReauthentication({ sessionId, userId, verifiedAt, expiresAt, method = 'password_totp', securityVersion = 1 }) {
        const marker = { sessionId, userId, verifiedAt: new Date(verifiedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), method, securityVersion: Number(securityVersion) };
        this.adminReauthMarkers.set(`${sessionId}:${userId}`, marker);
        return marker;
    }
    async getAdminReauthentication(sessionId, userId) {
        const key = `${sessionId}:${userId}`;
        const marker = this.adminReauthMarkers.get(key);
        if (!marker || new Date(marker.expiresAt).getTime() <= Date.now()) {
            this.adminReauthMarkers.delete(key);
            return null;
        }
        return marker;
    }
    async recordWebAuthnAssertion({ userId, credentialId, ipHash, userAgentHash, expiresAt }) {
        const assertion = { id: id('assertion'), userId, credentialId, ipHash, userAgentHash, sessionId: null, verifiedAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(), consumedAt: null };
        this.adminWebAuthnAssertions.set(assertion.id, assertion);
        return structuredClone(assertion);
    }
    async bindWebAuthnAssertionToSession({ userId, sessionId, ipHash, userAgentHash }) {
        const assertion = [...this.adminWebAuthnAssertions.values()].filter((item) => item.userId === userId && !item.sessionId && !item.consumedAt && item.ipHash === ipHash && item.userAgentHash === userAgentHash && new Date(item.expiresAt).getTime() > Date.now()).sort((a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt))[0];
        if (!assertion) return null;
        assertion.sessionId = sessionId;
        return structuredClone(assertion);
    }
    async confirmWebAuthnStepUp({ userId, sessionId, securityVersion, expiresAt, requestId }) {
        const assertion = [...this.adminWebAuthnAssertions.values()].find((item) => item.userId === userId && item.sessionId === sessionId && !item.consumedAt && new Date(item.expiresAt).getTime() > Date.now());
        if (!assertion) throw new AppError('No fresh WebAuthn assertion is bound to this session.', { status: 403, code: 'ADMIN_WEBAUTHN_ASSERTION_REQUIRED' });
        assertion.consumedAt = new Date().toISOString();
        const marker = await this.recordAdminReauthentication({ sessionId, userId, verifiedAt: assertion.verifiedAt, expiresAt, method: 'webauthn', securityVersion });
        await this.logAudit({ actorId: userId, action: 'security.step_up_succeeded', entityType: 'admin_session', entityId: sessionId, requestId, metadata: { method: 'webauthn', credentialId: assertion.credentialId } });
        return marker;
    }
    async replaceAdminRecoveryCodes({ userId, batchId, codes, actorId, requestId }) {
        for (const [key, value] of this.adminRecoveryCodes) if (value.userId === userId) this.adminRecoveryCodes.delete(key);
        for (const code of codes) this.adminRecoveryCodes.set(code.id, { ...code, userId, batchId, createdAt: new Date().toISOString(), usedAt: null });
        await this.logAudit({ actorId, action: 'security.recovery_generated', entityType: 'admin_account', entityId: userId, requestId, metadata: { batchId, count: codes.length } });
        return { batchId, count: codes.length };
    }
    async useAdminRecoveryCode({ userId, codeHash, sessionBinding: boundSession, expiresAt, actorId, requestId }) {
        const code = [...this.adminRecoveryCodes.values()].find((item) => item.userId === userId && item.codeHash === codeHash && !item.usedAt);
        if (!code) throw new AppError('The recovery code is invalid or has already been used.', { status: 403, code: 'ADMIN_RECOVERY_CODE_INVALID' });
        code.usedAt = new Date().toISOString();
        for (const key of this.adminReauthMarkers.keys()) if (key.endsWith(`:${userId}`)) this.adminReauthMarkers.delete(key);
        const account = this.adminAccounts.get(userId);
        if (account) account.securityVersion = Number(account.securityVersion || 1) + 1;
        const recovery = { sessionId: boundSession, userId, createdAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString() };
        this.adminRecoverySessions.set(`${boundSession}:${userId}`, recovery);
        await this.logAudit({ actorId, action: 'security.recovery_used', entityType: 'admin_account', entityId: userId, requestId, metadata: { batchId: code.batchId, sessionsRevoked: true } });
        return recovery;
    }
    async hasAdminRecoverySession(sessionId, userId) {
        const item = this.adminRecoverySessions.get(`${sessionId}:${userId}`);
        return Boolean(item && new Date(item.expiresAt).getTime() > Date.now());
    }
    async invalidateAdminRecoverySessions(userId) {
        for (const key of this.adminRecoverySessions.keys()) if (key.endsWith(`:${userId}`)) this.adminRecoverySessions.delete(key);
    }
    async recordAdminPasswordChange({ userId, actorId, requestId }) {
        const account = this.adminAccounts.get(userId);
        if (!account?.active) return null;
        account.securityVersion = Number(account.securityVersion || 1) + 1;
        for (const key of this.adminReauthMarkers.keys()) if (key.endsWith(`:${userId}`)) this.adminReauthMarkers.delete(key);
        await this.invalidateAdminRecoverySessions(userId);
        await this.logAudit({
            actorId,
            action: 'security.password_changed',
            entityType: 'admin_account',
            entityId: userId,
            requestId,
            metadata: { sessionsRevoked: true }
        });
        return { userId, securityVersion: account.securityVersion };
    }
    async resetAdminMfa({ actorId, targetUserId, reason, requestId }) {
        return this._withOperationLock('privileged-role-management', async () => {
            const actor = await this.getAdminAccount(actorId);
            const target = await this.getAdminAccount(targetUserId);
            if (!actor?.active || actor.role !== 'super_admin' || !target?.active) throw new AppError('This MFA reset is not authorized.', { status: 403, code: 'ADMIN_MFA_RESET_FORBIDDEN' });
            const activeSupers = [...this.adminAccounts.values()].filter((item) => item.active && canonicalAdminRole(item.role) === 'super_admin');
            if (target.role === 'super_admin' && activeSupers.length <= 1) throw new AppError('The final active super administrator MFA cannot be reset through the normal control plane.', { status: 409, code: 'LAST_SUPER_ADMIN_REQUIRED' });
            let passkeysRemoved = 0;
            for (const [key, value] of this.adminPasskeys) if (value.userId === targetUserId) { this.adminPasskeys.delete(key); passkeysRemoved += 1; }
            for (const key of this.adminReauthMarkers.keys()) if (key.endsWith(`:${targetUserId}`)) this.adminReauthMarkers.delete(key);
            await this.invalidateAdminRecoverySessions(targetUserId);
            for (const [key, value] of this.adminRecoveryCodes) if (value.userId === targetUserId) this.adminRecoveryCodes.delete(key);
            const stored = this.adminAccounts.get(targetUserId);
            stored.securityVersion = Number(stored.securityVersion || 1) + 1;
            await this.logAudit({ actorId, action: 'security.mfa_reset', entityType: 'admin_account', entityId: targetUserId, reason, requestId, metadata: { passkeysRemoved, sessionsRevoked: true } });
            return { userId: targetUserId, passkeysRemoved, sessionsRevoked: 0 };
        });
    }
    async logAudit(entry) {
        const metadata = sanitizeAuditValue(entry.metadata || {});
        const record = {
            id: id('audit'), ...entry, metadata,
            reason: entry.reason || metadata.reason || null,
            requestId: entry.requestId || metadata.requestId || null,
            before: sanitizeAuditValue(entry.before ?? metadata.before ?? null),
            after: sanitizeAuditValue(entry.after ?? metadata.after ?? null),
            createdAt: new Date().toISOString()
        };
        this.auditLog.unshift(record);
        this.auditLog = this.auditLog.slice(0, 500);
        return record;
    }

    async listPlans() { return [...this.planCatalog.values()].filter((plan) => plan.published !== false).map(publicPlan); }
    async getPlan(planId) { return this.planCatalog.get(planId) || null; }
    async setPlanEntitlement(planId, moduleId, entitlement) {
        assertGrantableEntitlementModule(moduleId);
        const plan = this.planCatalog.get(planId);
        if (!plan) return null;
        plan.entitlements[moduleId] = entitlement;
        return plan;
    }
    async applySubscriptionEvent(workspaceId, subscription, event) {
        const userId = subscription.userId || event.userId || await this.resolveEntitlementUser(workspaceId, null);
        if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
        if (!(await this.getCommercialUser(userId))) await this.registerUser({ id: userId });
        const current = [...this.subscriptions.values()].find((item) => item.userId === userId) || this.subscriptions.get(workspaceId);
        if (current && (current.lastEventCreated > event.created || (current.lastEventCreated === event.created && String(current.lastEventId || '') >= String(event.id || '')))) return { applied: false, subscription: current };
        const record = { workspaceId, ...subscription, userId, lastEventId: event.id, lastEventCreated: event.created };
        if (current) {
            for (const [key, value] of this.subscriptions) if (value === current || value.userId === userId) this.subscriptions.delete(key);
        }
        this.subscriptions.set(userId, record);
        return { applied: true, subscription: record };
    }
    async recordBillingEvent(workspaceId, event) {
        if (this.billingEvents.has(event.id)) { const existing = this.billingEvents.get(event.id); return { accepted: !['applied', 'ignored'].includes(existing.status), event: existing }; }
        const userId = event.userId || await this.resolveEntitlementUser(workspaceId, null);
        if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
        const record = { eventId: event.id, workspaceId, userId, type: event.type, created: event.created, status: 'received', receivedAt: new Date().toISOString() };
        this.billingEvents.set(event.id, record); return { accepted: true, event: record };
    }
    async markBillingEvent(eventId, status) { const event = this.billingEvents.get(eventId); if (event) event.status = status; return event || null; }
    async getSubscription(input) {
        const identity = input && typeof input === 'object' ? input : { workspaceId: input };
        return [...this.subscriptions.values()].find((item) => (identity.userId && item.userId === identity.userId) || (!identity.userId && identity.workspaceId && item.workspaceId === identity.workspaceId)) || null;
    }
    async getBillingSubscription(input, provider = null) {
        const subscription = await this.getSubscription(input);
        return subscription && (!provider || subscription.provider === provider || (!subscription.provider && provider === 'stripe')) ? structuredClone(subscription) : null;
    }
    async applyBillingProviderEvent(input) {
        const provider = String(input.provider || '').toLowerCase();
        return this._withOperationLock(`billing-provider:${provider}`, async () => {
        const eventKey = `${provider}:${input.eventId}`;
        const existingEvent = this.billingEvents.get(eventKey);
        if (existingEvent && ['applied', 'ignored'].includes(existingEvent.status)) return { applied: false, duplicate: true, event: structuredClone(existingEvent), subscription: await this.getBillingSubscription({ userId: existingEvent.userId, workspaceId: existingEvent.workspaceId }, provider) };
        let workspaceId = input.workspaceId || null;
        let userId = input.userId || null;
        if (!userId && input.subscription?.providerSubscriptionId) userId = [...this.subscriptions.values()].find((item) => item.provider === provider && item.providerSubscriptionId === input.subscription.providerSubscriptionId)?.userId || null;
        if (!userId && input.payment?.providerSubscriptionId) userId = [...this.subscriptions.values()].find((item) => item.provider === provider && item.providerSubscriptionId === input.payment.providerSubscriptionId)?.userId || null;
        if (!userId && input.refund?.providerTransactionId) userId = [...this.subscriptions.values()].find((item) => item.provider === provider && item.payment?.providerTransactionId === input.refund.providerTransactionId)?.userId || null;
        if (!workspaceId && userId) workspaceId = [...this.subscriptions.values()].find((item) => item.userId === userId)?.workspaceId || null;
        if (!userId && workspaceId) userId = await this.resolveEntitlementUser(workspaceId, null);
        if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
        if (!(await this.getCommercialUser(userId))) throw new AppError('Billing user was not found.', { status: 404, code: 'USER_NOT_FOUND' });
        if (!workspaceId) throw new AppError('Billing event is missing its workspace reference.', { status: 400, code: 'BILLING_WORKSPACE_MISSING' });
        const workspace = await this.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
        if (workspace.entitlementOwnerUserId !== userId) {
            throw new AppError('Billing user does not own the referenced workspace entitlement.', { status: 409, code: 'BILLING_USER_WORKSPACE_MISMATCH' });
        }
        const previousWorkspace = structuredClone(workspace);
        const previousProfile = await this.getUserCommercialProfile(userId);
        const currentSubscription = [...this.subscriptions.values()].find((item) => item.userId === userId) || null;
        const previousSubscription = currentSubscription ? structuredClone(currentSubscription) : null;
        let providerPlanChange = null;
        const occurredAtMs = Number(input.occurredAtMs ?? Date.parse(input.occurredAt || ''));
        const currentOrder = Number(previousSubscription?.lastEventOccurredAtMs ?? -1);
        const currentEventId = String(previousSubscription?.lastEventId || '');
        const ordersSubscription = input.resourceKind === 'subscription';
        const stale = ordersSubscription && Number.isFinite(occurredAtMs) && (occurredAtMs < currentOrder || (occurredAtMs === currentOrder && String(input.eventId) <= currentEventId));
        const ledger = { eventId: input.eventId, provider, workspaceId, userId, type: input.eventType, created: occurredAtMs, occurredAt: input.occurredAt, status: stale ? 'ignored' : 'received', receivedAt: new Date().toISOString() };
        this.billingEvents.set(eventKey, ledger);
        if (stale) return { applied: false, stale: true, event: structuredClone(ledger), subscription: previousSubscription };
        try {
            const requestedAccess = input.entitlement?.access;
            const accessState = ['paid', 'grace', 'free'].includes(requestedAccess) ? requestedAccess : previousSubscription?.accessState || 'free';
            const subscription = {
                workspaceId,
                userId,
                provider,
                providerCustomerId: input.subscription?.providerCustomerId ?? previousSubscription?.providerCustomerId ?? null,
                providerSubscriptionId: input.subscription?.providerSubscriptionId ?? previousSubscription?.providerSubscriptionId ?? null,
                providerPriceId: input.subscription?.providerPriceId ?? previousSubscription?.providerPriceId ?? null,
                providerProductId: input.subscription?.providerProductId ?? previousSubscription?.providerProductId ?? null,
                status: input.subscription?.status ?? previousSubscription?.status ?? 'unknown',
                currentPeriodEnd: input.subscription?.currentPeriodEnd ?? previousSubscription?.currentPeriodEnd ?? null,
                scheduledChange: input.subscription?.scheduledChange ?? previousSubscription?.scheduledChange ?? null,
                billingPlanId: input.entitlement?.planId ?? previousSubscription?.billingPlanId ?? null,
                accessState,
                payment: input.payment ?? previousSubscription?.payment ?? null,
                refund: input.refund ?? previousSubscription?.refund ?? null,
                lastEventId: ordersSubscription ? input.eventId : previousSubscription?.lastEventId ?? null,
                lastEventOccurredAt: ordersSubscription ? input.occurredAt : previousSubscription?.lastEventOccurredAt ?? null,
                lastEventOccurredAtMs: ordersSubscription ? occurredAtMs : previousSubscription?.lastEventOccurredAtMs ?? null,
                updatedAt: new Date().toISOString()
            };
            if (currentSubscription) for (const [key, value] of this.subscriptions) if (value === currentSubscription || value.userId === userId) this.subscriptions.delete(key);
            this.subscriptions.set(userId, subscription);
            if (input.entitlement?.action === 'set_plan') {
                const nextPlanId = input.entitlement.planId || 'free';
                if (!getPlan(nextPlanId)) throw new AppError('Billing event mapped to an unknown plan.', { status: 409, code: 'BILLING_PLAN_UNMAPPED' });
                const now = new Date().toISOString();
                providerPlanChange = {
                    id: id('user_plan_change'), userId, beforePlanId: previousProfile?.planId || 'free', afterPlanId: nextPlanId,
                    source: 'provider', sourceId: input.externalObjectId || input.eventId, actorId: `${provider}:webhook`,
                    reason: input.entitlement.reason || input.eventType, requestId: eventKey,
                    idempotencyKey: eventKey, requestFingerprint: `${userId}:${nextPlanId}:${eventKey}`, createdAt: now
                };
                this.userEntitlementProfiles.set(userId, {
                    ...(previousProfile || {}), userId, planId: nextPlanId, planSource: 'provider', sourceId: input.externalObjectId || input.eventId,
                    updatedBy: `${provider}:webhook`, reason: input.entitlement.reason || input.eventType, requestId: eventKey,
                    createdAt: previousProfile?.createdAt || now, updatedAt: now
                });
                this.userPlanChanges.set(providerPlanChange.id, providerPlanChange);
            }
            const afterProfile = await this.getUserCommercialProfile(userId);
            const audit = await this.logAudit({
                workspaceId,
                actorId: `${provider}:webhook`,
                action: `${input.resourceKind || 'subscription'}.reconciled`,
                entityType: input.resourceKind || 'subscription',
                entityId: input.externalObjectId || input.subscription?.providerSubscriptionId || input.eventId,
                reason: input.entitlement?.reason || input.eventType,
                before: { userPlanId: previousProfile?.planId || 'free', subscription: previousSubscription },
                after: { userPlanId: afterProfile?.planId || 'free', subscription },
                metadata: { targetUserId: userId, provider, eventId: input.eventId, eventType: input.eventType, access: input.entitlement?.access || null }
            });
            ledger.status = 'applied';
            return { applied: true, event: structuredClone(ledger), subscription: structuredClone(subscription), profile: afterProfile, workspace: structuredClone(workspace), audit };
        } catch (error) {
            Object.assign(workspace, previousWorkspace);
            if (previousProfile) this.userEntitlementProfiles.set(userId, previousProfile); else this.userEntitlementProfiles.delete(userId);
            if (providerPlanChange) this.userPlanChanges.delete(providerPlanChange.id);
            this.subscriptions.delete(userId);
            if (previousSubscription) this.subscriptions.set(userId, previousSubscription);
            ledger.status = 'failed';
            throw error;
        }
        });
    }
    async getWorkspaceSettings(workspaceId) {
        return this.workspaceSettings.get(workspaceId) || { workspaceId, defaultLocale: 'en', notifyScanComplete: true, notifyHighPriority: true, weeklyDigest: false };
    }
    async updateWorkspaceSettings(workspaceId, input) {
        const workspace = await this.ensureWorkspace(workspaceId);
        workspace.name = input.workspaceName;
        const settings = { workspaceId, defaultLocale: input.defaultLocale, notifyScanComplete: input.notifyScanComplete, notifyHighPriority: input.notifyHighPriority, weeklyDigest: input.weeklyDigest, updatedAt: new Date().toISOString() };
        this.workspaceSettings.set(workspaceId, settings);
        return { workspace, settings };
    }
    async listIntegrations(workspaceId) { return [...this.integrations.values()].filter((item) => item.workspaceId === workspaceId); }
    async getIntegration(workspaceId, provider) { return this.integrations.get(`${workspaceId}:${provider}`) || null; }
    async upsertIntegration(workspaceId, provider, input) {
        const key = `${workspaceId}:${provider}`;
        const current = this.integrations.get(key);
        const record = { id: current?.id || id('int'), workspaceId, provider, createdAt: current?.createdAt || new Date().toISOString(), ...current, ...input, updatedAt: new Date().toISOString() };
        this.integrations.set(key, record); return record;
    }
    async touchIntegration(workspaceId, provider, patch) { const current = await this.getIntegration(workspaceId, provider); return current ? this.upsertIntegration(workspaceId, provider, { ...current, ...patch }) : null; }
    async deleteIntegration(workspaceId, provider) { return this.integrations.delete(`${workspaceId}:${provider}`); }
    async enqueueWebhookOutbox(workspaceId, input) {
        const key = `${workspaceId}:${input.idempotencyKey}`;
        const existing = this.webhookOutbox.get(key);
        if (existing) return existing;
        const event = { id: id('outbox'), workspaceId, eventType: input.eventType, idempotencyKey: input.idempotencyKey, payload: input.payload, status: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), leaseOwner: null, leaseToken: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        this.webhookOutbox.set(key, event);
        await this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId, action: 'enqueued', fromStatus: null, toStatus: 'pending' });
        return event;
    }
    async claimWebhookOutbox(owner, { limit = 25, leaseMs = 60_000 } = {}) {
        const now = Date.now(); const result = [];
        for (const event of this.webhookOutbox.values()) {
            if (result.length >= limit || (!['pending', 'retrying'].includes(event.status) && !(event.status === 'processing' && new Date(event.leaseExpiresAt || 0).getTime() <= now)) || new Date(event.nextAttemptAt).getTime() > now) continue;
            const previousStatus = event.status;
            Object.assign(event, { status: 'processing', leaseOwner: owner, leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(now + leaseMs).toISOString(), updatedAt: new Date().toISOString() });
            await this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId: event.workspaceId, action: 'claimed', fromStatus: previousStatus, toStatus: 'processing', actorId: owner });
            result.push(structuredClone(event));
        }
        return result;
    }
    async completeWebhookOutbox(id, owner, token) {
        const event = [...this.webhookOutbox.values()].find((item) => item.id === id);
        if (!event || event.status !== 'processing' || event.leaseOwner !== owner || event.leaseToken !== token) return null;
        const previousStatus = event.status;
        Object.assign(event, { status: 'delivered', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() });
        await this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId: event.workspaceId, action: 'delivered', fromStatus: previousStatus, toStatus: 'delivered', actorId: owner });
        return event;
    }
    async failWebhookOutbox(id, owner, token, error, { maxAttempts = 8 } = {}) {
        const event = [...this.webhookOutbox.values()].find((item) => item.id === id);
        if (!event || event.status !== 'processing' || event.leaseOwner !== owner || event.leaseToken !== token) return null;
        const previousStatus = event.status;
        event.attempts += 1; event.lastError = String(error?.code || error?.message || 'WEBHOOK_DELIVERY_FAILED').slice(0, 256); event.status = event.attempts >= maxAttempts ? 'dead_letter' : 'retrying'; event.nextAttemptAt = new Date(Date.now() + Math.min(60 * 60_000, 1_000 * (2 ** Math.min(event.attempts, 10)))).toISOString(); event.leaseOwner = null; event.leaseToken = null; event.leaseExpiresAt = null; event.updatedAt = new Date().toISOString();
        await this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId: event.workspaceId, action: event.status === 'dead_letter' ? 'dead_letter' : 'retrying', fromStatus: previousStatus, toStatus: event.status, actorId: owner, errorCode: event.lastError });
        return event;
    }
    async listWebhookOutbox(workspaceId, { limit = 50 } = {}) { return [...this.webhookOutbox.values()].filter((item) => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(500, limit)); }
    async recordWebhookOutboxHistory(input) { const record = { id: id('outbox_history'), createdAt: new Date().toISOString(), ...input }; this.webhookOutboxHistory.unshift(record); this.webhookOutboxHistory = this.webhookOutboxHistory.slice(0, 2_000); return record; }
    async listWebhookOutboxAdmin({ workspaceId, status, limit = 50 } = {}) {
        return [...this.webhookOutbox.values()].filter((item) => (!workspaceId || item.workspaceId === workspaceId) && (!status || item.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(500, Math.max(1, Number(limit) || 50))).map(({ payload: _payload, leaseToken: _leaseToken, ...item }) => ({ ...item, history: this.webhookOutboxHistory.filter((entry) => entry.outboxId === item.id).slice(0, 20) }));
    }
    async replayWebhookOutbox(outboxId, actorId, workspaceId = null, context = {}) {
        const event = [...this.webhookOutbox.values()].find((item) => item.id === outboxId && (!workspaceId || item.workspaceId === workspaceId));
        if (!event || !['retrying', 'dead_letter', 'processing'].includes(event.status)) return null;
        const before = structuredClone(event);
        const historyLength = this.webhookOutboxHistory.length;
        const previousStatus = event.status;
        try {
            Object.assign(event, { status: 'pending', nextAttemptAt: new Date().toISOString(), lastError: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() });
            await this.recordWebhookOutboxHistory({ outboxId, workspaceId: event.workspaceId, action: 'replayed', fromStatus: previousStatus, toStatus: 'pending', actorId });
            await this.logAudit({ workspaceId: event.workspaceId, actorId, action: 'webhook_outbox.replayed', entityType: 'webhook_outbox', entityId: event.id, reason: context.reason || null, requestId: context.requestId || null, before: { status: previousStatus }, after: { status: event.status }, metadata: {} });
            return event;
        } catch (error) {
            Object.keys(event).forEach((key) => delete event[key]);
            Object.assign(event, before);
            this.webhookOutboxHistory.splice(0, Math.max(0, this.webhookOutboxHistory.length - historyLength));
            throw error;
        }
    }
    async listWebhookOutboxHistory(outboxId, { limit = 100 } = {}) { return this.webhookOutboxHistory.filter((entry) => entry.outboxId === outboxId).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))); }
    async createOAuthState(input) { this.oauthStates.set(input.stateHash, input); return input; }
    async consumeOAuthState(stateHash, workspaceId, provider, userId) {
        const state = this.oauthStates.get(stateHash); this.oauthStates.delete(stateHash);
        return state && state.workspaceId === workspaceId && state.provider === provider && state.userId === userId && new Date(state.expiresAt).getTime() > Date.now() ? state : null;
    }
    async createSupportTicket(workspaceId, input) {
        const idempotencyKey = input.idempotencyKey || null;
        const idemKey = idempotencyKey ? `${workspaceId}:${idempotencyKey}` : null;
        const operation = async () => {
            if (idemKey && this.supportIdempotency.has(idemKey)) {
                const existing = this.supportTickets.get(this.supportIdempotency.get(idemKey));
                assertIdempotentReplay(existing?.requestFingerprint, input.requestFingerprint);
                return { ticket: existing, created: false, idempotent: true };
            }
            const now = new Date().toISOString();
            const ticket = {
                id: id('ticket'), workspaceId, category: input.category || 'general', subject: input.subject, status: 'open', priority: input.priority || 'normal',
                assignedTo: null, createdBy: input.createdBy, createdAt: now, updatedAt: now, lastMessageAt: null,
                closedAt: null, reopenedAt: null, context: input.context || null, targetUrl: input.targetUrl || null, reportId: input.reportId || null,
                notificationState: input.notificationState || { externalEmail: 'not_configured' }, requestFingerprint: input.requestFingerprint || null
            };
            this.supportTickets.set(ticket.id, ticket);
            this.supportMessages.set(ticket.id, []);
            if (idemKey) this.supportIdempotency.set(idemKey, ticket.id);
            if (input.initialMessage) {
                const messageNow = new Date().toISOString();
                const message = { id: id('ticket_msg'), ticketId: ticket.id, workspaceId, authorId: input.initialMessage.authorId, authorType: input.initialMessage.authorType, visibility: input.initialMessage.visibility, body: input.initialMessage.body, createdAt: messageNow };
                this.supportMessages.set(ticket.id, [message]);
                Object.assign(ticket, { lastMessageAt: messageNow, updatedAt: messageNow });
            }
            if (input.audit) {
                try {
                    await this.logAudit({
                        workspaceId,
                        actorId: input.audit.actorId,
                        action: input.audit.action,
                        entityType: 'support_ticket',
                        entityId: ticket.id,
                        reason: input.audit.reason || null,
                        requestId: input.audit.requestId || null,
                        before: null,
                        after: ticket,
                        metadata: input.audit.metadata || {}
                    });
                } catch (error) {
                    this.supportTickets.delete(ticket.id);
                    this.supportMessages.delete(ticket.id);
                    if (idemKey) this.supportIdempotency.delete(idemKey);
                    throw error;
                }
            }
            return { ticket, created: true, idempotent: false };
        };
        return idemKey ? this._withOperationLock(`support-create:${idemKey}`, operation) : operation();
    }
    async getSupportActors(userIds = []) {
        return [...new Set(userIds.filter(Boolean))].map((userId) => {
            const user = this.users.get(userId);
            const state = this.userStates.get(userId);
            if (!user && !state) return null;
            return {
                id: userId,
                name: user?.name || null,
                email: user?.email || state?.email || null,
                emailVerified: user?.emailVerified ?? null,
                state: state?.state || 'active'
            };
        }).filter(Boolean);
    }
    async getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace = false } = {}) {
        const ticket = this.supportTickets.get(ticketId);
        return ticket && (allowAnyWorkspace || ticket.workspaceId === workspaceId) ? ticket : null;
    }
    async listSupportTickets(workspaceId, { limit = 25, after = null, status, priority, assignedTo, allowAnyWorkspace = false } = {}) {
        let tickets = [...this.supportTickets.values()].filter((ticket) => (allowAnyWorkspace || ticket.workspaceId === workspaceId)
            && (!status || ticket.status === status) && (!priority || ticket.priority === priority) && (assignedTo === undefined || ticket.assignedTo === assignedTo));
        tickets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
        if (after) tickets = tickets.filter((ticket) => ticket.updatedAt < after.at || (ticket.updatedAt === after.at && ticket.id < after.id));
        const page = tickets.slice(0, Math.min(101, limit + 1));
        return { tickets: page.slice(0, limit), hasMore: page.length > limit };
    }
    async listSupportMessages(workspaceId, ticketId, { includeInternal = false } = {}) {
        const ticket = await this.getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace: !workspaceId });
        if (!ticket) return [];
        return (this.supportMessages.get(ticketId) || []).filter((message) => includeInternal || message.visibility === 'public');
    }
    async appendSupportMessage(workspaceId, ticketId, input) {
        return this._withOperationLock(`support-ticket:${ticketId}`, async () => {
            const ticket = await this.getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace: !workspaceId });
            if (!ticket) return null;
            const messages = this.supportMessages.get(ticketId) || [];
            if (input.idempotencyKey) {
                const existing = [...this.supportMessages.values()].flat().find((item) => item.workspaceId === ticket.workspaceId && item.idempotencyKey === input.idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, input.requestFingerprint);
                    return { ticket, message: existing, idempotent: true };
                }
            }
            if (['customer_reply', 'admin_reply'].includes(input.transitionIntent) && ticket.status === 'closed') throw new AppError('Reopen the support ticket before replying.', { status: 409, code: 'SUPPORT_TICKET_CLOSED' });
            const before = structuredClone(ticket);
            const now = new Date().toISOString();
            const message = { id: id('ticket_msg'), ticketId, workspaceId: ticket.workspaceId, authorId: input.authorId, authorType: input.authorType, visibility: input.visibility, body: input.body, idempotencyKey: input.idempotencyKey || null, requestFingerprint: input.requestFingerprint || null, createdAt: now };
            messages.push(message);
            this.supportMessages.set(ticketId, messages);
            let nextStatus = input.nextStatus || ticket.status;
            if (input.transitionIntent === 'customer_reply') nextStatus = ['resolved', 'pending'].includes(ticket.status) ? 'in_progress' : ticket.status;
            if (input.transitionIntent === 'admin_reply') nextStatus = 'pending';
            if (input.transitionIntent === 'internal_note') nextStatus = ticket.status;
            Object.assign(ticket, { status: nextStatus, lastMessageAt: now, updatedAt: now });
            if (ticket.status === 'closed') ticket.closedAt ||= now;
            else ticket.closedAt = null;
            if (input.audit) {
                try {
                    await this.logAudit({
                        workspaceId: ticket.workspaceId,
                        actorId: input.audit.actorId,
                        action: input.audit.action,
                        entityType: 'support_ticket',
                        entityId: ticket.id,
                        reason: input.audit.reason || null,
                        requestId: input.audit.requestId || null,
                        before,
                        after: ticket,
                        metadata: input.audit.metadata || {}
                    });
                } catch (error) {
                    messages.pop();
                    Object.keys(ticket).forEach((key) => delete ticket[key]);
                    Object.assign(ticket, before);
                    throw error;
                }
            }
            return { ticket, message, idempotent: false };
        });
    }
    async updateSupportTicket(workspaceId, ticketId, patch) {
        const ticket = await this.getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace: !workspaceId });
        if (!ticket) return null;
        const before = structuredClone(ticket);
        const { audit, ...changes } = patch;
        Object.assign(ticket, changes, { updatedAt: new Date().toISOString() });
        if (audit) {
            try {
                await this.logAudit({
                    workspaceId: ticket.workspaceId,
                    actorId: audit.actorId,
                    action: audit.action,
                    entityType: 'support_ticket',
                    entityId: ticket.id,
                    reason: audit.reason || null,
                    requestId: audit.requestId || null,
                    before,
                    after: ticket,
                    metadata: audit.metadata || {}
                });
            } catch (error) {
                Object.keys(ticket).forEach((key) => delete ticket[key]);
                Object.assign(ticket, before);
                throw error;
            }
        }
        return ticket;
    }
    async createSourceInput(workspaceId, projectId, input, options = {}) {
        const { idempotencyKey, requestFingerprint, limit } = operationOptions(options);
        const entitlementUserId = options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null);
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.sourceInputs.values()].find((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { sourceInput: structuredClone(existing), idempotent: true };
                }
            }
            const prefix = new Date().toISOString().slice(0, 7);
            const used = [...this.sourceInputs.values()].filter((item) => (item.entitlementUserId || item.workspaceId) === entitlementUserId && item.status !== 'failed' && item.createdAt.startsWith(prefix)).length;
            if (limit != null && used >= limit) throw new AppError('The monthly Source Audit limit has been reached.', { status: 409, code: 'SOURCE_AUDIT_LIMIT_REACHED' });
            const record = { id: id('src'), workspaceId, entitlementUserId, projectId, ...input, idempotencyKey, requestFingerprint, createdAt: new Date().toISOString() };
            this.sourceInputs.set(record.id, record);
            return idempotencyKey ? { sourceInput: structuredClone(record), idempotent: false } : record;
        };
        return this._withOperationLock(`source-quota:${entitlementUserId}`, operation);
    }
    async countSourceInputs(entitlementUserId, now = new Date()) {
        const prefix = now.toISOString().slice(0, 7);
        return [...this.sourceInputs.values()].filter((item) => (item.entitlementUserId || item.workspaceId) === entitlementUserId && item.status !== 'failed' && item.createdAt.startsWith(prefix)).length;
    }
    async getSourceInput(workspaceId, sourceInputId) { const item = this.sourceInputs.get(sourceInputId); return item?.workspaceId === workspaceId ? item : null; }
    async updateSourceInput(workspaceId, sourceInputId, patch) { const item = await this.getSourceInput(workspaceId, sourceInputId); if (!item) return null; Object.assign(item, patch); return item; }
    async listSourceInputs(workspaceId) { return [...this.sourceInputs.values()].filter((item) => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    async createExpertReview(workspaceId, input) { const entitlementUserId = input.entitlementUserId || await this.resolveEntitlementUser(workspaceId, input.requestedBy || null); const record = { id: id('review'), workspaceId, entitlementUserId, status: 'requested', decisions: {}, roadmap: [], createdAt: new Date().toISOString(), ...input }; this.expertReviews.set(record.id, record); return record; }
    async getExpertReview(reviewId) { return this.expertReviews.get(reviewId) || null; }
    async listExpertReviews(workspaceId = null) { return [...this.expertReviews.values()].filter((item) => !workspaceId || item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    async updateExpertReview(reviewId, patch) {
        const item = this.expertReviews.get(reviewId);
        if (!item) return null;
        const { audit, ...changes } = patch;
        const before = structuredClone(item);
        Object.assign(item, changes, { updatedAt: new Date().toISOString() });
        if (!audit) return item;
        try {
            await this.logAudit({
                workspaceId: item.workspaceId,
                actorId: audit.actorId,
                action: audit.action,
                entityType: 'expert_review',
                entityId: reviewId,
                reason: audit.reason || null,
                requestId: audit.requestId || null,
                before,
                after: item,
                metadata: audit.metadata || {}
            });
            return item;
        } catch (error) {
            this.expertReviews.set(reviewId, before);
            throw error;
        }
    }
    async countExpertReviews(entitlementUserId, now = new Date()) { const prefix = now.toISOString().slice(0, 7); return [...this.expertReviews.values()].filter((item) => (item.entitlementUserId || item.workspaceId) === entitlementUserId && item.createdAt.startsWith(prefix) && item.status !== 'cancelled').length; }

    async registerUser({ id: userId, name = null, email = null } = {}) {
        if (!String(userId || '').trim()) throw new AppError('User ID is required.', { status: 400, code: 'USER_ID_REQUIRED' });
        const existing = this.users.get(userId) || {};
        const record = {
            id: userId,
            name: name ?? existing.name ?? null,
            email: email == null ? (existing.email ?? null) : String(email).trim().toLowerCase(),
            createdAt: existing.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        this.users.set(userId, record);
        if (!this.userEntitlementProfiles.has(userId)) {
            this.userEntitlementProfiles.set(userId, {
                userId, planId: 'free', planSource: 'system', sourceId: null,
                updatedBy: null, reason: 'Default commercial profile', requestId: null,
                createdAt: record.createdAt, updatedAt: record.createdAt
            });
        }
        return structuredClone(record);
    }

    async getCommercialUser(userId) {
        const direct = this.users.get(userId);
        if (direct) return structuredClone(direct);
        const state = this.userStates.get(userId);
        if (!state) return null;
        return { id: userId, name: null, email: state.email || null, createdAt: state.changedAt || null, updatedAt: state.changedAt || null };
    }

    async getUserCommercialProfile(userId) {
        const profile = this.userEntitlementProfiles.get(userId);
        return profile ? structuredClone(profile) : null;
    }

    async assignWorkspaceEntitlementOwner(workspaceId, userId, { ifUnset = true } = {}) {
        const workspace = await this.ensureWorkspace(workspaceId);
        if (!this.users.has(userId)) await this.registerUser({ id: userId });
        if (!workspace.entitlementOwnerUserId || !ifUnset) workspace.entitlementOwnerUserId = userId;
        return structuredClone(workspace);
    }

    async resolveEntitlementUser(workspaceId, requesterUserId = null) {
        const workspace = await this.getWorkspace(workspaceId);
        if (workspace?.entitlementOwnerUserId) return workspace.entitlementOwnerUserId;
        if (requesterUserId && (this.users.has(requesterUserId) || this.userEntitlementProfiles.has(requesterUserId))) return requesterUserId;
        // Legacy/test workspaces created before commercial-user ownership use
        // their own ID as an isolated synthetic quota subject. Production
        // session workspaces always receive an explicit sponsor.
        return workspaceId;
    }

    async assignUserPlan(userId, planId, context = {}) {
        const { actorId, reason, requestId = null, source = 'admin', sourceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const user = await this.getCommercialUser(userId);
        if (!user) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
        const plan = this.planCatalog.get(planId) || getPlan(planId);
        if (!plan) throw new AppError('Unknown plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.userPlanChanges.values()].find((item) => item.userId === userId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { profile: await this.getUserCommercialProfile(userId), change: structuredClone(existing), idempotent: true };
                }
            }
            const before = await this.getUserCommercialProfile(userId) || {
                userId, planId: 'free', planSource: 'system', sourceId: null,
                updatedBy: null, reason: null, requestId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            };
            const now = new Date().toISOString();
            const profile = {
                ...before, userId, planId, planSource: source, sourceId,
                updatedBy: actorId || null, reason: reason.trim(), requestId,
                updatedAt: now
            };
            const change = {
                id: id('user_plan_change'), userId, beforePlanId: before.planId || 'free', afterPlanId: planId,
                source, sourceId, actorId: actorId || null, reason: reason.trim(), requestId,
                idempotencyKey, requestFingerprint, createdAt: now
            };
            this.userEntitlementProfiles.set(userId, profile);
            this.userPlanChanges.set(change.id, change);
            try {
                await this.logAudit({
                    actorId, action: 'user.plan_changed', entityType: 'user_entitlement_profile', entityId: userId,
                    reason, requestId, before: { planId: before.planId || 'free' }, after: { planId },
                    metadata: { targetUserId: userId, source, sourceId }
                });
            } catch (error) {
                this.userEntitlementProfiles.set(userId, before);
                this.userPlanChanges.delete(change.id);
                throw error;
            }
            return { profile: structuredClone(profile), change: structuredClone(change), idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`user-plan:${userId}:${idempotencyKey}`, operation) : operation();
    }

    async getUserEffectiveEntitlements(userId, now = new Date()) {
        const profile = await this.getUserCommercialProfile(userId);
        const legacyWorkspace = !profile ? this.workspaces.get(userId) : null;
        const basePlanId = profile?.planId || legacyWorkspace?.planId || 'free';
        const basePlan = this.planCatalog.get(basePlanId) || getPlan(basePlanId) || getPlan('free');
        const grants = [...this.entitlementGrants.values()].filter((grant) => grant.userId === userId || (!profile && grant.workspaceId === userId && !grant.userId));
        const adjustments = [...this.creditAdjustments.values()].filter((entry) => entry.userId === userId || (!profile && entry.workspaceId === userId && !entry.userId));
        return composeEffectivePlan(basePlan, grants, adjustments, now);
    }

    async ensureWorkspace(workspaceId, { name = 'My workspace', planId = 'free', entitlementOwnerUserId = null } = {}) {
        if (!this.workspaces.has(workspaceId)) {
            this.workspaces.set(workspaceId, { id: workspaceId, name, planId, entitlementOwnerUserId, state: 'active', suspendedAt: null, suspendedBy: null, suspensionReason: null, createdAt: new Date().toISOString() });
        } else if (entitlementOwnerUserId && !this.workspaces.get(workspaceId).entitlementOwnerUserId) {
            this.workspaces.get(workspaceId).entitlementOwnerUserId = entitlementOwnerUserId;
        }
        if (entitlementOwnerUserId && !this.users.has(entitlementOwnerUserId)) await this.registerUser({ id: entitlementOwnerUserId });
        return this.workspaces.get(workspaceId);
    }
    async exportWorkspace(workspaceId) {
        const workspace = await this.ensureWorkspace(workspaceId);
        return { exportedAt: new Date().toISOString(), workspace: structuredClone(workspace), projects: [...this.projects.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item)), scans: [...this.scans.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item)), reports: [...this.reports.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item)), sourceInputs: [...this.sourceInputs.values()].filter((item) => item.workspaceId === workspaceId).map(({ encryptedReference: _encryptedReference, ...item }) => structuredClone(item)), deletion: this.deletionRequests.get(workspaceId) || null };
    }
    async requestWorkspaceDeletion(workspaceId, actorId) {
        const requestedAt = new Date();
        const request = this.deletionRequests.get(workspaceId) || { id: id('deletion'), workspaceId, requestedAt: requestedAt.toISOString(), graceUntil: new Date(requestedAt.getTime() + 7 * 86_400_000).toISOString(), status: 'requested', requestedBy: actorId, confirmedAt: requestedAt.toISOString(), authorizedBy: null, authorizedAt: null, executionStartedAt: null, failureCode: null };
        this.deletionRequests.set(workspaceId, request); await this.logAudit({ workspaceId, actorId, action: 'workspace.deletion_requested', entityType: 'workspace', entityId: workspaceId, metadata: { status: request.status } }); return request;
    }
    async authorizeWorkspaceDeletion(workspaceId, actorId, context = {}) {
        const request = this.deletionRequests.get(workspaceId);
        if (!request || request.status !== 'requested') return null;
        const before = structuredClone(request);
        Object.assign(request, { authorizedBy: actorId, authorizedAt: new Date().toISOString() });
        try {
            await this.logAudit({ workspaceId, actorId, action: 'workspace.deletion_authorized', entityType: 'workspace', entityId: request.id, reason: context.reason || null, requestId: context.requestId || null, before, after: request, metadata: { graceUntil: request.graceUntil } });
            return request;
        } catch (error) {
            Object.keys(request).forEach((key) => delete request[key]);
            Object.assign(request, before);
            throw error;
        }
    }
    async listDueWorkspaceDeletions({ now = new Date(), limit = 25, leaseMs = 15 * 60_000 } = {}) {
        const timestamp = new Date(now).getTime();
        return [...this.deletionRequests.values()]
            .filter((request) => (request.status === 'requested' || (request.status === 'processing' && new Date(request.executionStartedAt || 0).getTime() <= timestamp - Math.max(60_000, Number(leaseMs) || 15 * 60_000))) && request.confirmedAt && request.authorizedBy && new Date(request.graceUntil).getTime() <= timestamp)
            .sort((left, right) => left.graceUntil.localeCompare(right.graceUntil))
            .slice(0, Math.min(100, Math.max(1, Number(limit) || 25)))
            .map((request) => structuredClone(request));
    }
    async executeWorkspaceDeletion(workspaceId, { now = new Date(), dryRun = true, actorId = null, artifactCleanup = null, leaseMs = 15 * 60_000, reason = null, requestId = null } = {}) {
        const request = this.deletionRequests.get(workspaceId);
        const previousRun = request ? [...this.deletionRuns.values()].find((run) => run.requestId === request.id) : [...this.deletionRuns.values()].find((run) => run.workspaceId === workspaceId);
        if (previousRun?.status === 'completed') return { status: 'completed', deletedCount: previousRun.deletedReports, runId: previousRun.id, idempotent: true, dryRun: false };
        const timestamp = new Date(now).getTime();
        if (!request || !['requested', 'processing'].includes(request.status) || !request.confirmedAt || !request.authorizedBy || new Date(request.graceUntil).getTime() > timestamp) return { status: 'not_due', deletedCount: 0 };
        if (request.status === 'processing' && previousRun?.status === 'running' && new Date(previousRun.startedAt || 0).getTime() > timestamp - Math.max(60_000, Number(leaseMs) || 15 * 60_000)) return { status: 'running', runId: previousRun.id, dryRun: false };
        const candidates = {
            reports: [...this.reports.values()].filter((item) => item.workspaceId === workspaceId),
            sourceInputs: [...this.sourceInputs.values()].filter((item) => item.workspaceId === workspaceId),
            executions: [...this.executionResults.values()].filter((item) => item.workspaceId === workspaceId)
        };
        const artifactPaths = [...candidates.sourceInputs, ...candidates.executions].map((item) => item.encryptedReference || item.artifactPath).filter(Boolean);
        const deletedCount = candidates.reports.length;
        if (dryRun) return { status: 'ready', deletedCount, deletedReports: deletedCount, deletedSourceInputs: candidates.sourceInputs.length, deletedExecutions: candidates.executions.length, runId: previousRun?.id || null, dryRun: true };
        if (artifactPaths.length && typeof artifactCleanup !== 'function') throw new AppError('Workspace deletion requires an artifact cleanup callback.', { status: 503, code: 'WORKSPACE_DELETION_ARTIFACT_CLEANUP_REQUIRED' });
        const run = previousRun || { id: id('deletion_run'), requestId: request.id, workspaceId, status: 'running', attempts: 0, actorId, startedAt: new Date().toISOString(), deletedReports: 0, deletedSourceInputs: 0, deletedExecutions: 0 };
        Object.assign(run, { status: 'running', attempts: (run.attempts || 0) + 1, actorId: actorId || run.actorId, startedAt: run.startedAt || new Date().toISOString(), failureCode: null });
        this.deletionRuns.set(run.id, run);
        request.status = 'processing'; request.executionStartedAt = new Date().toISOString(); request.failureCode = null;
        const snapshots = new Map();
        for (const [name, collection] of Object.entries({ workspaces: this.workspaces, projects: this.projects, scans: this.scans, scanPages: this.scanPages, scanEvents: this.scanEvents, credits: this.credits, reports: this.reports, tasks: this.tasks, sourceInputs: this.sourceInputs, expertReviews: this.expertReviews, workspaceSettings: this.workspaceSettings, integrations: this.integrations, oauthStates: this.oauthStates, supportTickets: this.supportTickets, supportMessages: this.supportMessages, supportIdempotency: this.supportIdempotency, webhookOutbox: this.webhookOutbox, subscriptions: this.subscriptions, deletionRequests: this.deletionRequests })) snapshots.set(name, [...collection.entries()].map(([key, value]) => [key, structuredClone(value)]));
        try {
            const scanIds = new Set([...this.scans.values()].filter((item) => item.workspaceId === workspaceId).map((item) => item.id));
            const ticketIds = new Set([...this.supportTickets.values()].filter((item) => item.workspaceId === workspaceId).map((item) => item.id));
            for (const artifactPath of artifactPaths) await artifactCleanup(artifactPath);
            for (const [name, collection] of Object.entries({ reports: this.reports, scans: this.scans, projects: this.projects, scanPages: this.scanPages, scanEvents: this.scanEvents, credits: this.credits, tasks: this.tasks, sourceInputs: this.sourceInputs, expertReviews: this.expertReviews, workspaceSettings: this.workspaceSettings, integrations: this.integrations, oauthStates: this.oauthStates, supportTickets: this.supportTickets, supportMessages: this.supportMessages, supportIdempotency: this.supportIdempotency, webhookOutbox: this.webhookOutbox, subscriptions: this.subscriptions })) {
                for (const [key, item] of collection) if (item.workspaceId === workspaceId || (name === 'scanPages' && scanIds.has(item.scanId)) || (name === 'supportMessages' && ticketIds.has(key)) || (name === 'supportIdempotency' && String(key).startsWith(`${workspaceId}:`))) collection.delete(key);
            }
            this.workspaces.delete(workspaceId);
            Object.assign(run, { status: 'completed', completedAt: new Date().toISOString(), deletedReports: candidates.reports.length, deletedSourceInputs: candidates.sourceInputs.length, deletedExecutions: candidates.executions.length });
            Object.assign(request, { status: 'completed', completedAt: run.completedAt });
            await this.logAudit({ workspaceId: null, actorId, action: 'workspace.deletion_completed', entityType: 'workspace', entityId: workspaceId, reason, requestId, before: { status: 'authorized' }, after: { status: 'completed' }, metadata: { deletedReports: candidates.reports.length, deletedSourceInputs: candidates.sourceInputs.length, deletedExecutions: candidates.executions.length, runId: run.id } });
            return { status: 'completed', deletedCount: run.deletedReports, deletedReports: run.deletedReports, deletedSourceInputs: run.deletedSourceInputs, deletedExecutions: run.deletedExecutions, runId: run.id, dryRun: false };
        } catch (error) {
            for (const [name, entries] of snapshots) { const collection = this[name]; collection.clear(); for (const [key, value] of entries) collection.set(key, value); }
            const restoredRequest = this.deletionRequests.get(workspaceId) || request;
            restoredRequest.status = 'requested'; restoredRequest.failureCode = error.code || 'WORKSPACE_DELETION_FAILED';
            Object.assign(run, { status: 'failed', completedAt: new Date().toISOString(), failureCode: restoredRequest.failureCode });
            await this.logAudit({ workspaceId, actorId, action: 'workspace.deletion_failed', entityType: 'workspace', entityId: workspaceId, metadata: { errorCode: restoredRequest.failureCode, runId: run.id } });
            throw error;
        }
    }
    async executeRetentionSweep(workspaceId, { now = new Date(), dryRun = true, actorId = null, artifactCleanup = null } = {}) {
        const workspace = await this.ensureWorkspace(workspaceId);
        const plan = this.planCatalog.get(workspace.planId) || this.planCatalog.get('signal');
        const retentionDays = Math.max(1, Number(plan?.limits?.retentionDays || 30));
        const cutoff = new Date(new Date(now).getTime() - retentionDays * 86_400_000);
        const candidates = {
            reports: [...this.reports.values()].filter((item) => item.workspaceId === workspaceId && new Date(item.createdAt) < cutoff),
            sourceInputs: [...this.sourceInputs.values()].filter((item) => item.workspaceId === workspaceId && ['completed', 'failed', 'unavailable'].includes(item.status) && item.purgeAt && new Date(item.purgeAt) <= new Date(now) && new Date(item.createdAt) < cutoff),
            executions: [...this.executionResults.values()].filter((item) => item.workspaceId === workspaceId && ['completed', 'failed', 'unavailable'].includes(item.status) && new Date(item.completedAt || item.updatedAt || item.createdAt) < cutoff)
        };
        const artifactPaths = [...candidates.sourceInputs, ...candidates.executions].map((item) => item.encryptedReference || item.artifactPath).filter(Boolean);
        if (!dryRun && artifactPaths.length && typeof artifactCleanup !== 'function') throw new AppError('Retention requires an artifact cleanup callback.', { status: 503, code: 'RETENTION_ARTIFACT_CLEANUP_REQUIRED' });
        const run = { id: id('retention'), workspaceId, retentionDays, cutoffAt: cutoff.toISOString(), mode: dryRun ? 'dry_run' : 'execute', deletedCount: 0, deletedReports: 0, deletedSourceInputs: 0, deletedExecutions: 0, artifactCount: artifactPaths.length, status: 'started', actorId, startedAt: new Date().toISOString() };
        try {
            if (!dryRun) {
                for (const artifactPath of artifactPaths) await artifactCleanup(artifactPath);
                for (const [key, item] of this.reports) if (candidates.reports.includes(item)) { this.reports.delete(key); run.deletedReports += 1; }
                for (const [key, item] of this.sourceInputs) if (candidates.sourceInputs.includes(item)) { this.sourceInputs.delete(key); run.deletedSourceInputs += 1; }
                for (const [key, item] of this.executionResults) if (candidates.executions.includes(item)) { this.executionResults.delete(key); run.deletedExecutions += 1; }
                run.deletedCount = run.deletedReports;
            }
        } catch (error) { run.status = 'failed'; run.failureCode = error.code || 'RETENTION_SWEEP_FAILED'; run.completedAt = new Date().toISOString(); this.retentionRuns.set(run.id, run); await this.logAudit({ workspaceId, actorId, action: 'retention.failed', entityType: 'retention_run', entityId: run.id, metadata: { errorCode: run.failureCode } }); throw error; }
        run.status = 'completed'; run.completedAt = new Date().toISOString(); this.retentionRuns.set(run.id, run);
        await this.logAudit({ workspaceId, actorId, action: dryRun ? 'retention.dry_run' : 'retention.executed', entityType: 'retention_run', entityId: run.id, metadata: { retentionDays, cutoffAt: run.cutoffAt, candidateCount: candidates.reports.length, deletedCount: run.deletedCount, deletedSourceInputs: run.deletedSourceInputs, deletedExecutions: run.deletedExecutions, artifactCount: run.artifactCount } });
        return { ...run, candidateCount: candidates.reports.length, sourceInputCount: candidates.sourceInputs.length, executionCount: candidates.executions.length };
    }

    async getWorkspace(workspaceId) {
        return this.workspaces.get(workspaceId) || null;
    }

    async setWorkspacePlan(workspaceId, planId) {
        const workspace = await this.ensureWorkspace(workspaceId);
        workspace.planId = planId;
        return workspace;
    }

    async getUserState(userId) {
        return structuredClone(this.userStates.get(userId) || { userId, email: null, state: 'active', changedAt: null, changedBy: null, reason: null });
    }

    async getUserStateByEmail(email) {
        const normalized = String(email || '').trim().toLowerCase();
        const state = [...this.userStates.values()].find((item) => item.email === normalized);
        return state ? structuredClone(state) : null;
    }

    async setUserState(userId, state, { actorId, reason, requestId, email = null } = {}) {
        if (!['active', 'banned'].includes(state)) throw new AppError('Unknown account state.', { status: 400, code: 'USER_STATE_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const before = await this.getUserState(userId);
        const record = { userId, email: email ? String(email).toLowerCase() : before.email, state, changedAt: new Date().toISOString(), changedBy: actorId, reason: reason.trim(), invalidatedSessions: state === 'banned' ? 0 : undefined };
        this.userStates.set(userId, record);
        try {
            await this.logAudit({ actorId, action: state === 'banned' ? 'user.banned' : 'user.unbanned', entityType: 'user', entityId: userId, reason, requestId, before, after: record, metadata: { reason, requestId, before, after: record } });
            return structuredClone(record);
        } catch (error) { this.userStates.set(userId, before); throw error; }
    }

    async getWorkspaceState(workspaceId) {
        const workspace = await this.getWorkspace(workspaceId);
        return workspace ? { workspaceId, state: workspace.state || 'active', suspendedAt: workspace.suspendedAt || null, suspendedBy: workspace.suspendedBy || null, reason: workspace.suspensionReason || null } : null;
    }

    async setWorkspaceState(workspaceId, state, { actorId, reason, requestId } = {}) {
        if (!['active', 'suspended'].includes(state)) throw new AppError('Unknown workspace state.', { status: 400, code: 'WORKSPACE_STATE_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const workspace = await this.ensureWorkspace(workspaceId);
        const before = structuredClone(workspace);
        Object.assign(workspace, { state, suspendedAt: state === 'suspended' ? new Date().toISOString() : null, suspendedBy: state === 'suspended' ? actorId : null, suspensionReason: reason.trim() });
        try {
            await this.logAudit({ workspaceId, actorId, action: state === 'suspended' ? 'workspace.suspended' : 'workspace.unsuspended', entityType: 'workspace', entityId: workspaceId, reason, requestId, before, after: workspace, metadata: { reason, requestId, before, after: workspace } });
            return this.getWorkspaceState(workspaceId);
        } catch (error) { Object.assign(workspace, before); throw error; }
    }

    async getEffectiveEntitlements(workspaceId, now = new Date()) {
        const workspace = await this.ensureWorkspace(workspaceId);
        if (workspace.entitlementOwnerUserId) return this.getUserEffectiveEntitlements(workspace.entitlementOwnerUserId, now);
        const basePlan = this.planCatalog.get(workspace.planId) || getPlan(workspace.planId) || getPlan('free');
        const grants = [...this.entitlementGrants.values()].filter((grant) => grant.workspaceId === workspaceId);
        const adjustments = [...this.creditAdjustments.values()].filter((entry) => entry.workspaceId === workspaceId);
        return composeEffectivePlan(basePlan, grants, adjustments, now);
    }

    async adjustUserCredits(userId, creditType, amount, context = {}) {
        const { actorId, reason, requestId = null, expiresAt = null, workspaceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!['page', 'ai'].includes(creditType) || !Number.isInteger(amount) || amount === 0) throw new AppError('Credit adjustment is invalid.', { status: 400, code: 'CREDIT_ADJUSTMENT_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        if (!(await this.getCommercialUser(userId))) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.creditAdjustments.values()].find((item) => item.userId === userId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { ...structuredClone(existing), idempotent: true };
                }
            }
            const record = { id: id('credit_adjustment'), userId, workspaceId, creditType, amount, reason: reason.trim(), createdBy: actorId, requestId, expiresAt, idempotencyKey, requestFingerprint, createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null, revokeReason: null };
            this.creditAdjustments.set(record.id, record);
            try {
                await this.logAudit({ actorId, action: amount > 0 ? 'user.credits_granted' : 'user.credits_adjusted', entityType: 'user_credit_adjustment', entityId: record.id, reason, requestId, after: record, metadata: { targetUserId: userId, creditType, amount, expiresAt } });
            } catch (error) {
                this.creditAdjustments.delete(record.id);
                throw error;
            }
            return { ...structuredClone(record), idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`user-credit-adjustment:${userId}:${idempotencyKey}`, operation) : operation();
    }

    async listUserCreditAdjustments(userId) {
        return [...this.creditAdjustments.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item));
    }

    async grantUserEntitlement(userId, input, context = {}) {
        const { actorId, reason, requestId = null, workspaceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !getPlan(input.temporaryPlanId)) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        if (!(await this.getCommercialUser(userId))) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.entitlementGrants.values()].find((item) => item.userId === userId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { ...structuredClone(existing), idempotent: true };
                }
            }
            const record = { id: id('grant'), userId, workspaceId, source: input.source || 'admin', sourceId: input.sourceId || null, temporaryPlanId: input.temporaryPlanId || null, entitlementOverrides: structuredClone(input.entitlementOverrides || {}), bonusPageCredits: Number(input.bonusPageCredits || 0), bonusAiCredits: Number(input.bonusAiCredits || 0), reason: reason.trim(), createdBy: actorId, startsAt: input.startsAt || new Date().toISOString(), expiresAt: input.expiresAt || null, idempotencyKey, requestFingerprint, createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null, revokeReason: null };
            this.entitlementGrants.set(record.id, record);
            try {
                await this.logAudit({ actorId, action: 'user.entitlement_granted', entityType: 'user_entitlement_grant', entityId: record.id, reason, requestId, after: record, metadata: { targetUserId: userId, temporaryPlanId: record.temporaryPlanId, expiresAt: record.expiresAt } });
            } catch (error) {
                this.entitlementGrants.delete(record.id);
                throw error;
            }
            return { ...structuredClone(record), idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`user-entitlement-grant:${userId}:${idempotencyKey}`, operation) : operation();
    }

    async listUserEntitlementGrants(userId) {
        return [...this.entitlementGrants.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item));
    }

    async createRedeemCode(input) {
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !getPlan(input.temporaryPlanId)) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const { idempotencyKey = null, requestFingerprint = null } = operationOptions(input);
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.redeemCodes.values()].find((item) => item.createdBy === input.createdBy && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { ...(await this.listRedeemCodes({ id: existing.id }))[0], idempotent: true };
                }
            }
            const { hash, salt } = hashRedeemCode(input.code);
            const now = new Date().toISOString();
            const record = {
                id: input.id || id('redeem'), codeHash: hash, codeSalt: salt, codeHint: redeemCodeHint(input.code), active: input.active !== false,
                startsAt: input.startsAt || null, expiresAt: input.expiresAt || null, maxGlobalRedemptions: input.maxGlobalRedemptions ?? null,
                maxPerWorkspace: input.maxPerWorkspace ?? input.maxPerUser ?? 1, maxPerUser: input.maxPerUser ?? input.maxPerWorkspace ?? 1, temporaryPlanId: input.temporaryPlanId || null, durationDays: input.durationDays ?? null,
                bonusPageCredits: Number(input.bonusPageCredits || 0), bonusAiCredits: Number(input.bonusAiCredits || 0), entitlementOverrides: structuredClone(input.entitlementOverrides || {}),
                adminNote: input.adminNote || null, createdBy: input.createdBy, createdAt: now, disabledAt: null, disabledBy: null, revokedAt: null, revokedBy: null,
                idempotencyKey, requestFingerprint
            };
            this.redeemCodes.set(record.id, record);
            try {
                await this.logAudit({ actorId: input.createdBy, action: 'redeem.created', entityType: 'redeem_code', entityId: record.id, reason: input.reason?.trim() || input.adminNote?.trim() || 'created', requestId: input.requestId, after: { ...record, codeHash: '[REDACTED]', codeSalt: '[REDACTED]' }, metadata: { codeHint: record.codeHint, requestId: input.requestId } });
            } catch (error) {
                this.redeemCodes.delete(record.id);
                throw error;
            }
            return { ...(await this.listRedeemCodes({ id: record.id }))[0], idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`redeem-create:${input.createdBy}:${idempotencyKey}`, operation) : operation();
    }

    async listRedeemCodes({ id: codeId = null } = {}) {
        return [...this.redeemCodes.values()].filter((record) => !codeId || record.id === codeId).map(({ codeHash: _hash, codeSalt: _salt, idempotencyKey: _idempotencyKey, requestFingerprint: _requestFingerprint, ...record }) => ({ ...structuredClone(record), redemptionCount: [...this.redeemRedemptions.values()].filter((item) => item.codeId === record.id).length }));
    }

    async mutateRedeemCode(codeId, patch, { actorId, reason, requestId } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const record = this.redeemCodes.get(codeId);
        if (!record) return null;
        const before = structuredClone(record);
        if (patch.active !== undefined) Object.assign(record, { active: Boolean(patch.active), disabledAt: patch.active ? null : new Date().toISOString(), disabledBy: patch.active ? null : actorId });
        if (patch.revoke === true) {
            Object.assign(record, { active: false, revokedAt: new Date().toISOString(), revokedBy: actorId });
            for (const redemption of this.redeemRedemptions.values()) {
                if (redemption.codeId !== codeId || redemption.revokedAt) continue;
                Object.assign(redemption, { revokedAt: record.revokedAt, revokedBy: actorId, revokeReason: reason.trim() });
                const grant = this.entitlementGrants.get(redemption.grantId);
                if (grant && !grant.revokedAt) Object.assign(grant, { revokedAt: record.revokedAt, revokedBy: actorId, revokeReason: reason.trim() });
            }
        }
        const action = patch.revoke === true ? 'redeem.revoked' : record.active ? 'redeem.enabled' : 'redeem.disabled';
        await this.logAudit({ actorId, action, entityType: 'redeem_code', entityId: codeId, reason, requestId, before: { active: before.active, revokedAt: before.revokedAt }, after: { active: record.active, revokedAt: record.revokedAt }, metadata: { reason, requestId } });
        return (await this.listRedeemCodes({ id: codeId }))[0];
    }

    async redeemCode(workspaceId, userId, code, { now = new Date(), requestId = null, idempotencyKey = null, requestFingerprint = null } = {}) {
        await this.ensureWorkspace(workspaceId, { entitlementOwnerUserId: userId });
        if (!this.users.has(userId)) await this.registerUser({ id: userId });
        const hint = redeemCodeHint(code);
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.redeemRedemptions.values()].find((item) => item.userId === userId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    const existingGrant = this.entitlementGrants.get(existing.grantId);
                    return { redemption: structuredClone(existing), grant: structuredClone(existingGrant), effective: await this.getUserEffectiveEntitlements(userId, now), idempotent: true };
                }
            }
            const candidates = [...this.redeemCodes.values()].filter((item) => item.codeHint === hint);
            const record = findRedeemCodeByHash(candidates, code);
            const timestamp = new Date(now).getTime();
            if (!record || !record.active || record.revokedAt) throw new AppError('Redeem code is invalid or inactive.', { status: 404, code: 'REDEEM_CODE_INVALID' });
            if (record.startsAt && new Date(record.startsAt).getTime() > timestamp) throw new AppError('Redeem code is not active yet.', { status: 409, code: 'REDEEM_CODE_NOT_STARTED' });
            if (record.expiresAt && new Date(record.expiresAt).getTime() <= timestamp) throw new AppError('Redeem code has expired.', { status: 409, code: 'REDEEM_CODE_EXPIRED' });
            const redemptions = [...this.redeemRedemptions.values()].filter((item) => item.codeId === record.id);
            if (record.maxGlobalRedemptions != null && redemptions.length >= record.maxGlobalRedemptions) throw new AppError('Redeem code usage limit has been reached.', { status: 409, code: 'REDEEM_CODE_LIMIT_REACHED' });
            const maxPerUser = Number(record.maxPerUser ?? record.maxPerWorkspace ?? 1);
            if (redemptions.filter((item) => item.userId === userId).length >= maxPerUser) throw new AppError('This user has already used this redeem code.', { status: 409, code: 'REDEEM_USER_LIMIT_REACHED' });
            const durationExpiry = record.durationDays ? new Date(timestamp + record.durationDays * 86_400_000) : null;
            const codeExpiry = record.expiresAt ? new Date(record.expiresAt) : null;
            const expiresAt = durationExpiry && codeExpiry ? new Date(Math.min(durationExpiry.getTime(), codeExpiry.getTime())).toISOString() : (durationExpiry || codeExpiry)?.toISOString() || null;
            const grant = {
                id: id('grant'), userId, workspaceId, source: 'redeem', sourceId: record.id, temporaryPlanId: record.temporaryPlanId,
                entitlementOverrides: structuredClone(record.entitlementOverrides), bonusPageCredits: record.bonusPageCredits, bonusAiCredits: record.bonusAiCredits,
                reason: `Redeemed ${record.codeHint}`, createdBy: userId, startsAt: new Date(now).toISOString(), expiresAt, createdAt: new Date(now).toISOString(), revokedAt: null, revokedBy: null, revokeReason: null
            };
            const redemption = { id: id('redemption'), codeId: record.id, workspaceId, userId, grantId: grant.id, requestId, idempotencyKey, requestFingerprint, redeemedAt: new Date(now).toISOString(), revokedAt: null };
            this.entitlementGrants.set(grant.id, grant);
            this.redeemRedemptions.set(redemption.id, redemption);
            try {
                await this.logAudit({ workspaceId, actorId: userId, action: 'redeem.redeemed', entityType: 'redeem_code', entityId: record.id, reason: grant.reason, requestId, after: { grantId: grant.id, expiresAt }, metadata: { codeHint: record.codeHint, grantId: grant.id, requestId } });
            } catch (error) {
                this.entitlementGrants.delete(grant.id);
                this.redeemRedemptions.delete(redemption.id);
                throw error;
            }
            return { redemption: structuredClone(redemption), grant: structuredClone(grant), effective: await this.getUserEffectiveEntitlements(userId, now), idempotent: false };
        };
        const codeOperation = () => this._withOperationLock(`redeem-code:${hint}`, operation);
        return idempotencyKey ? this._withOperationLock(`redeem-operation:${userId}:${idempotencyKey}`, codeOperation) : codeOperation();
    }

    async adjustCredits(workspaceId, creditType, amount, context = {}) {
        const { actorId, reason, requestId = null, expiresAt = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!['page', 'ai'].includes(creditType) || !Number.isInteger(amount) || amount === 0) throw new AppError('Credit adjustment is invalid.', { status: 400, code: 'CREDIT_ADJUSTMENT_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        await this.ensureWorkspace(workspaceId);
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.creditAdjustments.values()].find((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { ...structuredClone(existing), idempotent: true };
                }
            }
            const record = { id: id('credit_adjustment'), workspaceId, creditType, amount, reason: reason.trim(), createdBy: actorId, requestId, expiresAt, idempotencyKey, requestFingerprint, createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null, revokeReason: null };
            this.creditAdjustments.set(record.id, record);
            try {
                await this.logAudit({ workspaceId, actorId, action: amount > 0 ? 'credits.granted' : 'credits.revoked', entityType: 'credit_adjustment', entityId: record.id, reason, requestId, after: record, metadata: { creditType, amount, reason, requestId, expiresAt } });
            } catch (error) {
                this.creditAdjustments.delete(record.id);
                throw error;
            }
            return { ...structuredClone(record), idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`credit-adjustment:${workspaceId}:${idempotencyKey}`, operation) : operation();
    }

    async listCreditAdjustments(workspaceId) {
        return [...this.creditAdjustments.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item));
    }

    async grantEntitlement(workspaceId, input, context = {}) {
        const { actorId, reason, requestId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !getPlan(input.temporaryPlanId)) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        await this.ensureWorkspace(workspaceId);
        const operation = async () => {
            if (idempotencyKey) {
                const existing = [...this.entitlementGrants.values()].find((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return { ...structuredClone(existing), idempotent: true };
                }
            }
            const record = { id: id('grant'), workspaceId, source: input.source || 'admin', sourceId: input.sourceId || null, temporaryPlanId: input.temporaryPlanId || null, entitlementOverrides: structuredClone(input.entitlementOverrides || {}), bonusPageCredits: Number(input.bonusPageCredits || 0), bonusAiCredits: Number(input.bonusAiCredits || 0), reason: reason.trim(), createdBy: actorId, startsAt: input.startsAt || new Date().toISOString(), expiresAt: input.expiresAt || null, idempotencyKey, requestFingerprint, createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null, revokeReason: null };
            this.entitlementGrants.set(record.id, record);
            try {
                await this.logAudit({ workspaceId, actorId, action: 'entitlement.granted', entityType: 'entitlement_grant', entityId: record.id, reason, requestId, after: record, metadata: { temporaryPlanId: record.temporaryPlanId, expiresAt: record.expiresAt, reason, requestId } });
            } catch (error) {
                this.entitlementGrants.delete(record.id);
                throw error;
            }
            return { ...structuredClone(record), idempotent: false };
        };
        return idempotencyKey ? this._withOperationLock(`entitlement-grant:${workspaceId}:${idempotencyKey}`, operation) : operation();
    }

    async revokeEntitlement(grantId, { actorId, reason, requestId = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const record = this.entitlementGrants.get(grantId);
        if (!record) return null;
        if (!record.revokedAt) Object.assign(record, { revokedAt: new Date().toISOString(), revokedBy: actorId, revokeReason: reason.trim() });
        await this.logAudit({ workspaceId: record.workspaceId, actorId, action: record.userId ? 'user.entitlement_revoked' : 'entitlement.revoked', entityType: record.userId ? 'user_entitlement_grant' : 'entitlement_grant', entityId: grantId, reason, requestId, after: { revokedAt: record.revokedAt }, metadata: { targetUserId: record.userId || null, reason, requestId } });
        return structuredClone(record);
    }

    async recordCheckoutAcceptance(input) {
        const userId = input.userId || await this.resolveEntitlementUser(input.workspaceId, null);
        if (!userId) throw new AppError('Checkout acceptance is missing its user owner.', { status: 400, code: 'CHECKOUT_ACCEPTANCE_USER_MISSING' });
        const key = `${userId}:${input.idempotencyKey}`;
        return this._withOperationLock(`checkout-intent:${userId}`, async () => {
            const existing = this.checkoutAcceptances.get(key) || [...this.checkoutAcceptances.values()].find((item) => item.userId === userId && item.idempotencyKey === input.idempotencyKey);
            if (existing) {
                assertIdempotentReplay(existing.requestFingerprint, input.requestFingerprint);
                if (existing.workspaceId !== input.workspaceId || existing.planId !== input.planId || existing.provider !== input.provider) throw new AppError('The idempotency key was already used for a different request.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
                if (['accepted', 'checkout_created'].includes(existing.status) && existing.expiresAt && new Date(existing.expiresAt).getTime() <= Date.now()) existing.status = 'expired';
                return { ...structuredClone(existing), idempotent: true };
            }
            for (const candidate of this.checkoutAcceptances.values()) {
                if (candidate.userId !== userId || !['accepted', 'checkout_created'].includes(candidate.status)) continue;
                if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() <= Date.now()) {
                    candidate.status = 'expired';
                    continue;
                }
                throw new AppError('This user already has a checkout operation in progress.', { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
            }
            const record = {
                id: input.id || id('checkout_acceptance'), workspaceId: input.workspaceId, userId, planId: input.planId,
                provider: input.provider, catalogVersion: input.catalogVersion, amountMinor: Number(input.amountMinor), currency: String(input.currency).toUpperCase(),
                billingInterval: input.billingInterval, termsVersion: input.termsVersion, refundPolicyVersion: input.refundPolicyVersion,
                requestId: input.requestId, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint || null, status: 'accepted', providerCheckoutId: null,
                setupLeaseOwner: null, setupLeaseToken: null, setupLeaseExpiresAt: null,
                metadata: sanitizeAuditValue(input.metadata || {}), acceptedAt: input.acceptedAt || new Date().toISOString(), expiresAt: input.expiresAt || null
            };
            this.checkoutAcceptances.set(key, record);
            try {
                await this.logAudit({ workspaceId: record.workspaceId, actorId: record.userId, action: 'checkout.accepted', entityType: 'checkout_acceptance', entityId: record.id, reason: 'paid_checkout', requestId: record.requestId, after: { planId: record.planId, catalogVersion: record.catalogVersion, termsVersion: record.termsVersion, refundPolicyVersion: record.refundPolicyVersion }, metadata: { requestId: record.requestId, provider: record.provider } });
            } catch (error) {
                this.checkoutAcceptances.delete(key);
                throw error;
            }
            return { ...structuredClone(record), idempotent: false };
        });
    }

    async getCheckoutAcceptance(scope, identifier) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const record = [...this.checkoutAcceptances.values()].find((item) => (identity.userId ? item.userId === identity.userId : item.workspaceId === identity.workspaceId) && (item.id === identifier || item.idempotencyKey === identifier));
        return record ? structuredClone(record) : null;
    }

    async claimCheckoutAcceptance(scope, identifier, { owner, leaseMs = 120_000 } = {}) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const record = [...this.checkoutAcceptances.values()].find((item) => (identity.userId ? item.userId === identity.userId : item.workspaceId === identity.workspaceId) && (item.id === identifier || item.idempotencyKey === identifier));
        if (!record) return null;
        return this._withOperationLock(`checkout-intent:${record.userId}`, async () => {
            if (!['accepted', 'checkout_created'].includes(record.status)) return { acceptance: structuredClone(record), claimed: false, terminal: true };
            const now = Date.now();
            if (record.setupLeaseToken && new Date(record.setupLeaseExpiresAt || 0).getTime() > now) return { acceptance: structuredClone(record), claimed: false, active: true };
            const leaseToken = crypto.randomUUID();
            Object.assign(record, { setupLeaseOwner: String(owner), setupLeaseToken: leaseToken, setupLeaseExpiresAt: new Date(now + Math.max(1_000, Number(leaseMs) || 120_000)).toISOString() });
            return { acceptance: structuredClone(record), claimed: true, leaseOwner: record.setupLeaseOwner, leaseToken, leaseExpiresAt: record.setupLeaseExpiresAt };
        });
    }

    async releaseCheckoutAcceptanceClaim(scope, identifier, { owner, leaseToken } = {}) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const record = [...this.checkoutAcceptances.values()].find((item) => (identity.userId ? item.userId === identity.userId : item.workspaceId === identity.workspaceId) && (item.id === identifier || item.idempotencyKey === identifier));
        if (!record) return null;
        return this._withOperationLock(`checkout-intent:${record.userId}`, async () => {
            if (record.setupLeaseOwner !== String(owner) || record.setupLeaseToken !== leaseToken) return null;
            Object.assign(record, { setupLeaseOwner: null, setupLeaseToken: null, setupLeaseExpiresAt: null });
            return structuredClone(record);
        });
    }

    async markCheckoutAcceptance(scope, identifier, { status, providerCheckoutId = null } = {}) {
        if (!['checkout_created', 'completed', 'expired', 'cancelled'].includes(status)) throw new AppError('Checkout acceptance status is invalid.', { status: 400, code: 'CHECKOUT_ACCEPTANCE_STATUS_INVALID' });
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const record = [...this.checkoutAcceptances.values()].find((item) => (identity.userId ? item.userId === identity.userId : item.workspaceId === identity.workspaceId) && (item.id === identifier || item.idempotencyKey === identifier));
        if (!record) return null;
        return this._withOperationLock(`checkout-intent:${record.userId}`, async () => {
            if (!checkoutTransitionAllowed(record.status, status)) throw new AppError('Checkout acceptance cannot move to the requested state.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_TRANSITION_INVALID' });
            if (record.providerCheckoutId && providerCheckoutId && record.providerCheckoutId !== providerCheckoutId) throw new AppError('Checkout provider identity does not match the persisted acceptance.', { status: 409, code: 'CHECKOUT_PROVIDER_ID_MISMATCH' });
            if (record.status === status && (!providerCheckoutId || record.providerCheckoutId === providerCheckoutId)) return { ...structuredClone(record), idempotent: true };
            const before = structuredClone(record);
            Object.assign(record, { status, providerCheckoutId: providerCheckoutId || record.providerCheckoutId || null });
            if (['completed', 'expired', 'cancelled'].includes(status)) Object.assign(record, { setupLeaseOwner: null, setupLeaseToken: null, setupLeaseExpiresAt: null });
            await this.logAudit({ workspaceId: record.workspaceId, actorId: record.userId, action: `checkout.${status}`, entityType: 'checkout_acceptance', entityId: record.id, reason: status, requestId: record.requestId, before: { status: before.status, providerCheckoutId: before.providerCheckoutId }, after: { status: record.status, providerCheckoutId: record.providerCheckoutId } });
            return { ...structuredClone(record), idempotent: false };
        });
    }

    async recordLegalAcceptance(input) {
        const key = `${input.userId}:${input.workspaceId || ''}:${input.documentType}:${input.documentVersion}:${input.purpose}`;
        if (this.legalAcceptances.has(key)) return structuredClone(this.legalAcceptances.get(key));
        const record = { id: input.id || id('legal_acceptance'), userId: input.userId, workspaceId: input.workspaceId || null, documentType: input.documentType, documentVersion: input.documentVersion, purpose: input.purpose, requestId: input.requestId, metadata: sanitizeAuditValue(input.metadata || {}), acceptedAt: input.acceptedAt || new Date().toISOString() };
        this.legalAcceptances.set(key, record);
        await this.logAudit({ workspaceId: record.workspaceId, actorId: record.userId, action: 'legal.accepted', entityType: 'legal_acceptance', entityId: record.id, reason: record.purpose, requestId: record.requestId, after: { documentType: record.documentType, documentVersion: record.documentVersion }, metadata: { requestId: record.requestId } });
        return structuredClone(record);
    }

    async hasCurrentLegalAcceptance(userId, workspaceId, requirements) {
        const required = Array.isArray(requirements) ? requirements : [requirements];
        return required.every((requirement) => this.legalAcceptances.has(`${userId}:${workspaceId || ''}:${requirement.documentType}:${requirement.documentVersion}:${requirement.purpose}`));
    }

    async recordTargetAuthorization(input) {
        const record = { id: input.id || id('target_authorization'), workspaceId: input.workspaceId, projectId: input.projectId || null, userId: input.userId, origin: input.origin, attestationVersion: input.attestationVersion, authorizationBasis: input.authorizationBasis || 'authorized_control', requestId: input.requestId, metadata: sanitizeAuditValue(input.metadata || {}), acceptedAt: input.acceptedAt || new Date().toISOString(), revokedAt: null };
        this.targetAuthorizations.set(record.id, record);
        await this.logAudit({ workspaceId: record.workspaceId, actorId: record.userId, action: 'target.authorization_recorded', entityType: 'project', entityId: record.projectId, reason: record.authorizationBasis, requestId: record.requestId, after: { origin: record.origin, attestationVersion: record.attestationVersion }, metadata: { requestId: record.requestId } });
        return structuredClone(record);
    }

    async listTargetAuthorizations(workspaceId, { projectId = null, activeOnly = true } = {}) {
        return [...this.targetAuthorizations.values()]
            .filter((record) => record.workspaceId === workspaceId && (!projectId || record.projectId === projectId) && (!activeOnly || !record.revokedAt))
            .sort((left, right) => String(right.acceptedAt).localeCompare(String(left.acceptedAt)))
            .map((record) => structuredClone(record));
    }

    async recordAiUsage(input) {
        const usageId = input.id || id('ai_usage');
        const idempotencyKey = input.idempotencyKey || usageId;
        const entitlementUserId = input.entitlementUserId || input.userId;
        const existing = [...this.aiUsage.values()].find((entry) => (entry.entitlementUserId || entry.userId) === entitlementUserId && entry.idempotencyKey === idempotencyKey);
        if (existing) {
            assertAiReplayMatches(existing, input);
            return structuredClone(existing);
        }
        const status = input.status || 'completed';
        const record = {
            ...structuredClone(input), entitlementUserId, id: usageId, idempotencyKey, status,
            usageMetadata: sanitizeAuditValue(input.usageMetadata || {}), costMetadata: sanitizeAuditValue(input.costMetadata || {}),
            failureCode: input.failureCode || null, createdAt: input.createdAt || new Date().toISOString(),
            completedAt: input.completedAt || (AI_TERMINAL_STATUSES.has(status) ? new Date().toISOString() : null)
        };
        this.aiUsage.set(record.id, record);
        return structuredClone(record);
    }

    async consumeAiGeneration(workspaceId, input, { now = new Date() } = {}) {
        assertAiReservationInput(input);
        const entitlementUserId = input.entitlementUserId || await this.resolveEntitlementUser(workspaceId, input.userId);
        const reservationInput = { ...input, entitlementUserId };
        return this._withAiQuotaLock(entitlementUserId, async () => {
            await this.ensureWorkspace(workspaceId);
            const existing = [...this.aiUsage.values()].find((entry) => (entry.entitlementUserId || entry.userId) === entitlementUserId && entry.idempotencyKey === input.idempotencyKey);
            const effective = await this.getUserEffectiveEntitlements(entitlementUserId, now);
            const limit = aiQuotaLimit(effective);
            const { start, end } = aiMonthBounds(now);
            const counted = [...this.aiUsage.values()].filter((entry) => (entry.entitlementUserId || entry.userId) === entitlementUserId
                && AI_QUOTA_STATUSES.has(entry.status)
                && new Date(entry.createdAt) >= start && new Date(entry.createdAt) < end);
            if (existing) {
                assertAiReplayMatches(existing, reservationInput);
                return { usage: structuredClone(existing), quota: { limit, used: counted.length, remaining: Math.max(0, limit - counted.length) }, idempotent: true };
            }
            if (counted.length >= limit) throw new AppError('The monthly AI remediation limit has been reached.', { status: 402, code: 'AI_REMEDIATION_LIMIT_REACHED' });
            const usage = await this.recordAiUsage({
                workspaceId, userId: input.userId, entitlementUserId, findingFingerprint: input.findingFingerprint,
                requestedModel: input.requestedModel, actualModel: null, provider: input.provider,
                promptVersion: input.promptVersion, evidenceVersion: input.evidenceVersion,
                idempotencyKey: input.idempotencyKey, usageMetadata: {}, costMetadata: {}, status: 'reserved',
                createdAt: new Date(now).toISOString()
            });
            const used = counted.length + 1;
            return { usage, quota: { limit, used, remaining: Math.max(0, limit - used) }, idempotent: false };
        });
    }

    async settleAiGeneration(workspaceId, usageId, input = {}) {
        if (!AI_TERMINAL_STATUSES.has(input.status)) throw new AppError('AI usage settlement status is invalid.', { status: 400, code: 'AI_USAGE_STATUS_INVALID' });
        const existing = this.aiUsage.get(usageId);
        const quotaOwner = existing?.entitlementUserId || existing?.userId || workspaceId;
        return this._withAiQuotaLock(quotaOwner, async () => {
            const record = this.aiUsage.get(usageId);
            if (!record || record.workspaceId !== workspaceId) throw new AppError('AI usage reservation was not found.', { status: 404, code: 'AI_USAGE_NOT_FOUND' });
            if (record.status !== 'reserved') return { usage: structuredClone(record), idempotent: true };
            Object.assign(record, {
                status: input.status, actualModel: input.actualModel || record.actualModel || null,
                usageMetadata: sanitizeAuditValue(input.usageMetadata || {}), costMetadata: sanitizeAuditValue(input.costMetadata || {}),
                failureCode: input.status === 'failed' ? (input.failureCode || 'AI_PROVIDER_FAILED') : null,
                completedAt: input.completedAt || new Date().toISOString()
            });
            return { usage: structuredClone(record), idempotent: false };
        });
    }

    async countAiUsage(entitlementUserId, now = new Date()) {
        const { start, end } = aiMonthBounds(now);
        return [...this.aiUsage.values()].filter((entry) => (entry.entitlementUserId || entry.userId) === entitlementUserId
            && AI_QUOTA_STATUSES.has(entry.status)
            && new Date(entry.createdAt) >= start && new Date(entry.createdAt) < end).length;
    }

    async getAiCache(workspaceId, cacheKey, now = new Date()) {
        const record = this.aiCache.get(`${workspaceId}:${cacheKey}`);
        if (!record || record.workspaceId !== workspaceId || (record.expiresAt && new Date(record.expiresAt).getTime() <= new Date(now).getTime())) return null;
        return structuredClone(record);
    }

    async putAiCache(input) {
        const key = `${input.workspaceId}:${input.cacheKey}`;
        const existing = this.aiCache.get(key);
        const record = { ...structuredClone(input), createdAt: existing?.createdAt || input.createdAt || new Date().toISOString() };
        this.aiCache.set(key, record);
        return structuredClone(record);
    }

    async dailyAiCost(workspaceId, now = new Date()) {
        const day = new Date(now).toISOString().slice(0, 10);
        return [...this.aiUsage.values()].filter((entry) => (workspaceId == null || entry.workspaceId === workspaceId) && entry.createdAt.startsWith(day)).reduce((sum, entry) => sum + Number(entry.costMetadata?.cost ?? entry.costMetadata?.amount ?? 0), 0);
    }

    async getFinding(workspaceId, fingerprint) {
        const reports = [...this.reports.values()].filter((report) => report.workspaceId === workspaceId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
        for (const report of reports) {
            const finding = findingsFromPayload(report.payload).find((item) => item.fingerprint === fingerprint);
            if (finding) return { ...structuredClone(finding), reportId: report.id, reportVersion: report.version, evidenceVersion: `${report.id}:${report.version}:${report.createdAt}`, reportCreatedAt: report.createdAt };
        }
        return null;
    }

    async createProject(workspaceId, project, options = {}) {
        const { limit, idempotencyKey, requestFingerprint } = operationOptions(options);
        const entitlementUserId = options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null);
        const create = async () => {
            if (idempotencyKey) {
                const existing = [...this.projects.values()].find((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return operationResult(existing, idempotencyKey, true);
                }
            }
            if (limit != null && [...this.projects.values()].filter((item) => (item.entitlementUserId || item.workspaceId) === entitlementUserId).length >= limit) {
                throw new AppError('The project limit for this plan has been reached.', { status: 409, code: 'PROJECT_LIMIT_REACHED' });
            }
            const record = { id: id('prj'), workspaceId, entitlementUserId, verifiedAt: null, verificationMethod: null, verificationCheckedAt: null, verificationExpiresAt: null, verificationRevokedAt: null, verificationToken: crypto.randomBytes(24).toString('base64url'), createdAt: new Date().toISOString(), ...project };
            if (idempotencyKey) record.idempotencyKey = idempotencyKey;
            if (requestFingerprint != null) record.requestFingerprint = requestFingerprint;
            this.projects.set(record.id, record);
            return operationResult(record, idempotencyKey, false);
        };
        return this._withOperationLock(`project-create:${entitlementUserId}`, create);
    }

    async listProjects(workspaceId) {
        return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId);
    }

    async countProjects(entitlementUserId) {
        return [...this.projects.values()].filter((project) => (project.entitlementUserId || project.workspaceId) === entitlementUserId).length;
    }

    async getProject(workspaceId, projectId) {
        const project = this.projects.get(projectId);
        return project?.workspaceId === workspaceId ? project : null;
    }

    async verifyProject(workspaceId, projectId, method = 'operator', { checkedAt = null, expiresAt = null } = {}) {
        const project = await this.getProject(workspaceId, projectId);
        if (!project) return null;
        project.verifiedAt = checkedAt || new Date().toISOString();
        project.verificationMethod = method;
        project.verificationCheckedAt = checkedAt || project.verifiedAt;
        project.verificationExpiresAt = expiresAt;
        project.verificationRevokedAt = null;
        return project;
    }
    async revokeProjectVerification(workspaceId, projectId, revokedAt = new Date().toISOString()) {
        const project = await this.getProject(workspaceId, projectId);
        if (!project) return null;
        Object.assign(project, { verifiedAt: null, verificationRevokedAt: revokedAt });
        return project;
    }

    async createScan(workspaceId, projectId, manifest, options = {}) {
        const { idempotencyKey, requestFingerprint } = operationOptions(options);
        const create = async () => {
            if (idempotencyKey) {
                const existing = [...this.scans.values()].find((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey);
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    return operationResult(existing, idempotencyKey, true);
                }
            }
            const now = new Date().toISOString();
            const scan = {
                id: id('scan'), workspaceId, projectId,
                requestedByUserId: options.requestedByUserId || null,
                entitlementUserId: options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null),
                status: 'queued', manifest, failureCode: null, createdAt: now, updatedAt: now
            };
            if (idempotencyKey) scan.idempotencyKey = idempotencyKey;
            if (requestFingerprint != null) scan.requestFingerprint = requestFingerprint;
            this.scans.set(scan.id, scan);
            return operationResult(scan, idempotencyKey, false);
        };
        return idempotencyKey ? this._withOperationLock(`scan-create:${workspaceId}:${idempotencyKey}`, create) : create();
    }

    async getScan(workspaceId, scanId) {
        const scan = this.scans.get(scanId);
        return scan?.workspaceId === workspaceId ? scan : null;
    }

    async listScans(workspaceId) {
        return [...this.scans.values()].filter((scan) => scan.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async listRecoverableScans() { return [...this.scans.values()].filter((scan) => ['queued', 'running'].includes(scan.status)); }

    async updateScan(workspaceId, scanId, patch, options = {}) {
        const scan = await this.getScan(workspaceId, scanId);
        if (!scan) return null;
        const expected = options?.expectedStatuses || (options?.expectedStatus ? [options.expectedStatus] : null);
        if (expected?.length && !expected.includes(scan.status)) return null;
        if (scan.status === 'cancelled' && patch?.status && patch.status !== 'cancelled') return null;
        Object.assign(scan, patch, { updatedAt: new Date().toISOString() });
        return scan;
    }

    async cancelScan(workspaceId, scanId, { actorId, reason, requestId = null, idempotencyKey = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const scan = await this.getScan(workspaceId, scanId);
        if (!scan) return null;
        if (scan.status === 'cancelled') return { scan: structuredClone(scan), idempotent: true };
        if (['completed', 'partial', 'awaiting_operator'].includes(scan.status)) throw new AppError('A completed scan cannot be cancelled.', { status: 409, code: 'SCAN_NOT_CANCELLABLE' });
        const before = structuredClone(scan);
        Object.assign(scan, { status: 'cancelled', failureCode: 'ADMIN_CANCELLED', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        for (const page of this.scanPages.get(scanId)?.values() || []) {
            if (!PAGE_TERMINAL_STORE.has(page.status)) Object.assign(page, { status: 'cancelled', errorCode: 'ADMIN_CANCELLED', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() });
        }
        for (const credit of this.credits.values()) if (credit.workspaceId === workspaceId && credit.scanId === scanId && credit.state === 'reserved') credit.state = 'released';
        await this.appendScanEvent(workspaceId, scanId, 'scan.cancelled', { reason, requestId, idempotencyKey });
        await this.logAudit({ workspaceId, actorId, action: 'scan.cancelled', entityType: 'scan', entityId: scanId, reason, requestId, before, after: scan, metadata: { idempotencyKey } });
        return { scan: structuredClone(scan), idempotent: false };
    }

    async retryScan(workspaceId, scanId, { actorId, reason, requestId = null, idempotencyKey = null, creditLimit = Number.MAX_SAFE_INTEGER } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const scan = await this.getScan(workspaceId, scanId);
        if (!scan) return null;
        if (['queued', 'running'].includes(scan.status)) return { scan: structuredClone(scan), idempotent: true, requeuedPages: 0 };
        if (!['failed', 'partial', 'cancelled'].includes(scan.status)) throw new AppError('This scan is not eligible for retry.', { status: 409, code: 'SCAN_NOT_RETRYABLE' });
        const pages = [...(this.scanPages.get(scanId)?.values() || [])];
        const retryable = pages.filter((page) => ['queued', 'failed', 'unavailable', 'incomplete', 'cancelled'].includes(page.status));
        if (!retryable.length) return { scan: structuredClone(scan), idempotent: true, requeuedPages: 0 };
        const periodStart = monthStart();
        const entitlementUserId = scan.entitlementUserId || await this.resolveEntitlementUser(workspaceId, scan.requestedByUserId || null);
        const used = [...this.credits.values()].filter((entry) => (entry.entitlementUserId || entry.workspaceId) === entitlementUserId && entry.periodStart === periodStart && ['reserved', 'consumed'].includes(entry.state)).reduce((sum, entry) => sum + Number(entry.amount || 1), 0);
        const released = [...this.credits.values()].filter((entry) => entry.workspaceId === workspaceId && entry.scanId === scanId && entry.state === 'released');
        if (used + released.length > creditLimit) throw new AppError('The monthly page credit limit has been reached.', { status: 402, code: 'PAGE_CREDIT_LIMIT_REACHED' });
        for (const entry of released) entry.state = 'reserved';
        for (const page of retryable) Object.assign(page, { status: 'retrying', errorCode: null, maxAttempts: Math.min(10, Math.max(page.maxAttempts, page.attempts + 1)), leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() });
        const before = structuredClone(scan);
        Object.assign(scan, { status: 'queued', failureCode: null, completedAt: null, updatedAt: new Date().toISOString() });
        await this.appendScanEvent(workspaceId, scanId, 'scan.retried', { reason, requestId, idempotencyKey, pages: retryable.length });
        await this.logAudit({ workspaceId, actorId, action: 'scan.retried', entityType: 'scan', entityId: scanId, reason, requestId, before, after: scan, metadata: { idempotencyKey, requeuedPages: retryable.length } });
        return { scan: structuredClone(scan), idempotent: false, requeuedPages: retryable.length };
    }

    async createScanPages(workspaceId, scanId, urls, { maxAttempts = 3, provenanceByUrl = null } = {}) {
        const scan = await this.getScan(workspaceId, scanId);
        if (!scan) return [];
        if (!this.scanPages.has(scanId)) this.scanPages.set(scanId, new Map());
        const pages = this.scanPages.get(scanId);
        let nextPageIndex = [...pages.values()].reduce((max, page) => Math.max(max, page.pageIndex), -1) + 1;
        for (const rawUrl of urls) {
            const entry = normalizedPageEntry(rawUrl);
            entry.discovery = mergePageDiscovery(entry.discovery, discoveryForUrl(provenanceByUrl, rawUrl, entry.url));
            const existing = pages.get(entry.pageKey);
            if (existing) {
                existing.discovery = mergePageDiscovery(existing.discovery, entry.discovery);
                continue;
            }
            const now = new Date().toISOString();
            pages.set(entry.pageKey, { scanId, workspaceId, pageKey: entry.pageKey, url: entry.url, pageIndex: nextPageIndex++, status: 'queued', attempts: 0, maxAttempts, leaseExpiresAt: null, leaseOwner: null, leaseToken: null, report: null, errorCode: null, discovery: entry.discovery, createdAt: now, updatedAt: now });
        }
        return [...pages.values()].sort((a, b) => a.pageIndex - b.pageIndex);
    }

    async appendScanPagesWithCredits(workspaceId, scanId, values, { maxAttempts = 3, pageLimit, creditLimit = pageLimit, now = new Date() } = {}) {
        const entries = [...new Map((values || []).map((value) => {
            const entry = normalizedPageEntry(value);
            return [entry.pageKey, entry];
        })).values()];
        const scan = await this.getScan(workspaceId, scanId);
        const entitlementUserId = scan?.entitlementUserId || await this.resolveEntitlementUser(workspaceId, scan?.requestedByUserId || null);
        return this._withScanAppendLock(entitlementUserId, async () => {
            if (!scan || !['queued', 'running'].includes(scan.status)) {
                return { pages: [], inserted: [], rejected: entries.map((entry) => ({ url: entry.url, reason: 'scan_terminal' })), idempotent: true, limitReached: false };
            }
            if (!this.scanPages.has(scanId)) this.scanPages.set(scanId, new Map());
            const pages = this.scanPages.get(scanId);
            const boundedPageLimit = Math.max(0, Math.floor(Number(pageLimit) || 0));
            const boundedCreditLimit = Math.max(0, Math.floor(Number(creditLimit) || 0));
            const periodStart = monthStart(now);
            let usedCredits = [...this.credits.values()].filter((entry) => (entry.entitlementUserId || entry.workspaceId) === entitlementUserId && entry.periodStart === periodStart && ['reserved', 'consumed'].includes(entry.state)).reduce((sum, entry) => sum + Number(entry.amount || 1), 0);
            let nextPageIndex = [...pages.values()].reduce((max, page) => Math.max(max, page.pageIndex), -1) + 1;
            const acceptedKeys = new Set();
            const insertedKeys = new Set();
            const rejected = [];
            for (const entry of entries) {
                const existing = pages.get(entry.pageKey);
                if (existing) {
                    existing.discovery = mergePageDiscovery(existing.discovery, entry.discovery);
                    existing.updatedAt = new Date().toISOString();
                    acceptedKeys.add(entry.pageKey);
                    continue;
                }
                if (pages.size >= boundedPageLimit) { rejected.push({ url: entry.url, reason: 'scan_page_limit' }); continue; }
                const creditMapKey = `${scanId}:${entry.url}`;
                const existingCredit = this.credits.get(creditMapKey);
                if (existingCredit?.state === 'released') { rejected.push({ url: entry.url, reason: 'credit_released' }); continue; }
                if (!existingCredit && usedCredits >= boundedCreditLimit) { rejected.push({ url: entry.url, reason: 'monthly_credit_limit' }); continue; }
                if (!existingCredit) {
                    this.credits.set(creditMapKey, { id: id('credit'), workspaceId, entitlementUserId, scanId, creditKey: entry.url, periodStart, state: 'reserved', amount: 1 });
                    usedCredits += 1;
                }
                const timestamp = new Date().toISOString();
                pages.set(entry.pageKey, { scanId, workspaceId, pageKey: entry.pageKey, url: entry.url, pageIndex: nextPageIndex++, status: 'queued', attempts: 0, maxAttempts, leaseExpiresAt: null, leaseOwner: null, leaseToken: null, report: null, errorCode: null, discovery: entry.discovery, createdAt: timestamp, updatedAt: timestamp });
                acceptedKeys.add(entry.pageKey);
                insertedKeys.add(entry.pageKey);
            }
            const acceptedPages = [...pages.values()].filter((page) => acceptedKeys.has(page.pageKey)).sort((left, right) => left.pageIndex - right.pageIndex).map((page) => structuredClone(page));
            return {
                pages: acceptedPages,
                inserted: acceptedPages.filter((page) => insertedKeys.has(page.pageKey)),
                rejected,
                idempotent: insertedKeys.size === 0,
                limitReached: rejected.some((entry) => ['scan_page_limit', 'monthly_credit_limit'].includes(entry.reason))
            };
        });
    }

    async listScanPages(workspaceId, scanId) {
        if (!(await this.getScan(workspaceId, scanId))) return [];
        return [...(this.scanPages.get(scanId)?.values() || [])].sort((a, b) => a.pageIndex - b.pageIndex);
    }

    async claimScanPage(workspaceId, scanId, pageKey, { leaseMs = 120_000, owner = 'legacy-worker' } = {}) {
        const page = this.scanPages.get(scanId)?.get(pageKey);
        if (!page || page.workspaceId !== workspaceId || ['completed', 'incomplete', 'failed', 'unavailable', 'cancelled'].includes(page.status)) return null;
        const now = Date.now();
        if (page.status === 'running' && new Date(page.leaseExpiresAt || 0).getTime() > now) return null;
        if (page.attempts >= page.maxAttempts) {
            Object.assign(page, { status: 'failed', errorCode: page.errorCode || 'PAGE_RETRY_EXHAUSTED', leaseExpiresAt: null, updatedAt: new Date().toISOString() });
            return null;
        }
        Object.assign(page, { status: 'running', attempts: page.attempts + 1, leaseExpiresAt: new Date(now + leaseMs).toISOString(), leaseOwner: String(owner), leaseToken: crypto.randomUUID(), updatedAt: new Date().toISOString() });
        return structuredClone(page);
    }

    async renewScanPageLease(workspaceId, scanId, pageKey, { owner, leaseToken, leaseMs = 120_000 } = {}) {
        const page = this.scanPages.get(scanId)?.get(pageKey);
        if (!page || page.workspaceId !== workspaceId || page.status !== 'running' || page.leaseOwner !== String(owner) || page.leaseToken !== leaseToken) return null;
        Object.assign(page, { leaseExpiresAt: new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 120_000)).toISOString(), updatedAt: new Date().toISOString() });
        return structuredClone(page);
    }

    async completeScanPage(workspaceId, scanId, pageKey, patch) {
        const page = this.scanPages.get(scanId)?.get(pageKey);
        if (!page || page.workspaceId !== workspaceId) return null;
        const owner = patch.leaseOwner || 'legacy-worker';
        const token = patch.leaseToken || null;
        if (page.leaseOwner && (page.leaseOwner !== owner || (page.leaseToken && token !== page.leaseToken))) return null;
        if (['completed', 'incomplete', 'failed', 'unavailable', 'cancelled'].includes(page.status)) return page;
        const next = { ...patch }; delete next.leaseOwner; delete next.leaseToken;
        Object.assign(page, next, { leaseExpiresAt: null, leaseOwner: null, leaseToken: null, updatedAt: new Date().toISOString() });
        return page;
    }

    async completeScanPageAndSettleCredit(workspaceId, scanId, pageKey, patch = {}) {
        const page = this.scanPages.get(scanId)?.get(pageKey);
        if (!page || page.workspaceId !== workspaceId) return null;
        const credit = patch.creditKey ? this.credits.get(`${scanId}:${patch.creditKey}`) : null;
        const scan = await this.getScan(workspaceId, scanId);
        if (!scan) return null;
        if (scan.status === 'cancelled' && !PAGE_TERMINAL_STORE.has(page.status)) {
            return { page: structuredClone(page), credit: credit ? structuredClone(credit) : null, idempotent: true };
        }
        const owner = patch.leaseOwner || 'legacy-worker';
        const token = patch.leaseToken || null;
        if (page.leaseOwner && (page.leaseOwner !== owner || (page.leaseToken && token !== page.leaseToken))) return null;
        if (PAGE_TERMINAL_STORE.has(page.status)) {
            if (credit?.state === 'reserved') credit.state = page.status === 'cancelled' ? 'released' : (patch.creditState || 'consumed');
            return { page: structuredClone(page), credit: credit ? structuredClone(credit) : null, idempotent: true };
        }
        const beforePage = structuredClone(page);
        const beforeCredit = credit ? structuredClone(credit) : null;
        try {
            const next = { ...patch };
            delete next.leaseOwner;
            delete next.leaseToken;
            delete next.creditKey;
            delete next.creditState;
            Object.assign(page, next, { leaseExpiresAt: null, leaseOwner: null, leaseToken: null, updatedAt: new Date().toISOString() });
            if (credit?.state === 'reserved') credit.state = patch.creditState || 'consumed';
            return { page: structuredClone(page), credit: credit ? structuredClone(credit) : null, idempotent: false };
        } catch (error) {
            Object.assign(page, beforePage);
            if (credit && beforeCredit) Object.assign(credit, beforeCredit);
            throw error;
        }
    }

    async appendScanEvent(workspaceId, scanId, type, payload = {}) {
        if (!(await this.getScan(workspaceId, scanId))) return null;
        const events = this.scanEvents.get(scanId) || [];
        const event = { id: (events.at(-1)?.id || 0) + 1, scanId, workspaceId, type, payload, createdAt: new Date().toISOString() };
        events.push(event);
        this.scanEvents.set(scanId, events.slice(-200));
        return event;
    }

    async listScanEvents(workspaceId, scanId, { after = 0, limit = 200 } = {}) {
        if (!(await this.getScan(workspaceId, scanId))) return [];
        return (this.scanEvents.get(scanId) || []).filter((event) => event.id > after).slice(0, Math.min(200, limit));
    }

    async saveReportOnce(workspaceId, scanId, payload, options = {}) {
        const existing = await this.getLatestReportForScan(workspaceId, scanId);
        return existing || this.saveReport(workspaceId, scanId, payload, options);
    }

    async reserveCredit(workspaceId, scanId, creditKey, limit, now = new Date(), entitlementUserId = null) {
        const scan = await this.getScan(workspaceId, scanId);
        const quotaOwner = entitlementUserId || scan?.entitlementUserId || await this.resolveEntitlementUser(workspaceId, scan?.requestedByUserId || null);
        return this._withPageQuotaLock(quotaOwner, async () => {
            const key = `${scanId}:${creditKey}`;
            if (this.credits.has(key)) return this.credits.get(key);
            const periodStart = monthStart(now);
            const used = [...this.credits.values()].filter((entry) => (entry.entitlementUserId || entry.workspaceId) === quotaOwner && entry.periodStart === periodStart && ['reserved', 'consumed'].includes(entry.state)).reduce((sum, entry) => sum + Number(entry.amount || 1), 0);
            if (used >= limit) throw new AppError('The monthly page credit limit has been reached.', { status: 402, code: 'PAGE_CREDIT_LIMIT_REACHED' });
            const entry = { id: id('credit'), workspaceId, entitlementUserId: quotaOwner, scanId, creditKey, periodStart, state: 'reserved', amount: 1 };
            this.credits.set(key, entry);
            return entry;
        });
    }

    async settleCredit(workspaceId, scanId, creditKey, state) {
        const entry = this.credits.get(`${scanId}:${creditKey}`);
        if (!entry || entry.workspaceId !== workspaceId) return null;
        if (entry.state === 'reserved') entry.state = state;
        return entry;
    }

    async getUsage(entitlementUserId, now = new Date()) {
        const periodStart = monthStart(now);
        const entries = [...this.credits.values()].filter((entry) => (entry.entitlementUserId || entry.workspaceId) === entitlementUserId && entry.periodStart === periodStart);
        return {
            periodStart,
            reserved: entries.filter((entry) => entry.state === 'reserved').length,
            consumed: entries.filter((entry) => entry.state === 'consumed').length
        };
    }

    async saveReport(workspaceId, scanId, payload, { locale = 'en', status = 'automated_draft' } = {}) {
        const version = [...this.reports.values()].filter((item) => item.scanId === scanId).reduce((max, item) => Math.max(max, item.version), 0) + 1;
        const report = { id: id('rpt'), workspaceId, scanId, version, revision: 1, status, locale, payload, shareTokenHash: null, shareExpiresAt: null, shareRevokedAt: null, shareCreatedAt: null, createdAt: new Date().toISOString() };
        this.reports.set(report.id, report);
        return report;
    }

    async getReport(workspaceId, reportId) {
        const report = this.reports.get(reportId);
        return report?.workspaceId === workspaceId ? report : null;
    }
    async getReportById(reportId) { return this.reports.get(reportId) || null; }

    async listReports(workspaceId, { limit = 50, before } = {}) {
        const bounded = Math.min(1_000, Math.max(1, Number(limit) || 50));
        return [...this.reports.values()].filter((report) => report.workspaceId === workspaceId && (!before || report.createdAt < before)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version).slice(0, bounded);
    }

    async listReportSummaries(workspaceId, { limit = 50, cursor = null } = {}) {
        const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
        const afterCursor = cursor && typeof cursor === 'object' ? cursor : null;
        const reports = [...this.reports.values()].filter((report) => report.workspaceId === workspaceId && (!afterCursor || report.createdAt < afterCursor.createdAt || (report.createdAt === afterCursor.createdAt && report.id < afterCursor.id)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const page = reports.slice(0, bounded + 1).map(reportSummary);
        const hasMore = page.length > bounded;
        page.length = Math.min(page.length, bounded);
        Object.defineProperty(page, 'nextCursor', { value: hasMore && page.at(-1) ? { createdAt: page.at(-1).createdAt, id: page.at(-1).id } : null, enumerable: false });
        return page;
    }

    async updateReport(workspaceId, reportId, patch, { expectedVersion = null } = {}) {
        const report = await this.getReport(workspaceId, reportId);
        if (!report) return null;
        if (expectedVersion !== null && (report.revision ?? report.version) !== expectedVersion) return null;
        Object.assign(report, patch, { revision: (report.revision || 1) + 1 });
        return report;
    }
    async publishReportWithAudit(workspaceId, reportId, { actorId, reason, requestId } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const source = await this.getReport(workspaceId, reportId);
        if (!source) return null;
        if (!['operator_completed', 'expert_reviewed'].includes(source.status)) throw new AppError('Only operator-completed or expert-reviewed reports can be published.', { status: 409, code: 'REPORT_NOT_REVIEWED' });
        const existing = [...this.reports.values()].filter((report) => report.workspaceId === workspaceId && report.scanId === source.scanId && report.status === 'published' && JSON.stringify(report.payload) === JSON.stringify(source.payload)).sort((left, right) => right.version - left.version)[0] || null;
        if (existing) return { report: existing, source, idempotent: true };
        const reportsBefore = structuredClone([...this.reports.entries()]);
        const auditBefore = structuredClone(this.auditLog);
        try {
            const created = await this.saveReport(workspaceId, source.scanId, source.payload, { locale: source.locale, status: 'published' });
            const published = await this.updateReport(workspaceId, created.id, { status: 'published', publishedAt: new Date().toISOString() }, { expectedVersion: created.revision ?? created.version });
            await this.logAudit({
                workspaceId,
                actorId,
                action: 'report.published',
                entityType: 'report',
                entityId: published.id,
                reason: reason.trim(),
                requestId,
                before: { status: source.status, reportId: source.id },
                after: { status: published.status, reportId: published.id }
            });
            return { report: published, source, idempotent: false };
        } catch (error) {
            this.reports = new Map(reportsBefore);
            this.auditLog = auditBefore;
            throw error;
        }
    }
    async finalizeExpertReviewWithAudit(reviewId, { payload, locale, actorId, reason, requestId, expectedUpdatedAt = null } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const review = this.expertReviews.get(reviewId);
        if (!review) return null;
        if (review.status === 'ready_to_publish') return { review, report: await this.getLatestReportForScan(review.workspaceId, review.scanId), idempotent: true };
        if (review.status !== 'in_review' || review.assignedTo !== actorId) throw new AppError('Only the assigned reviewer can finalize this review.', { status: 409, code: 'EXPERT_REVIEW_NOT_ASSIGNED' });
        if (expectedUpdatedAt && String(review.updatedAt || '') !== String(expectedUpdatedAt || '')) throw new AppError('The Expert Review changed while it was being finalized.', { status: 409, code: 'EXPERT_REVIEW_UPDATE_CONFLICT' });
        const reviewsBefore = structuredClone([...this.expertReviews.entries()]);
        const reportsBefore = structuredClone([...this.reports.entries()]);
        const auditBefore = structuredClone(this.auditLog);
        const before = structuredClone(review);
        try {
            const report = await this.saveReport(review.workspaceId, review.scanId, payload, { locale, status: 'expert_reviewed' });
            Object.assign(review, { status: 'ready_to_publish', expertReportId: report.id, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            await this.logAudit({ workspaceId: review.workspaceId, actorId, action: 'expert_review.finalized', entityType: 'expert_review', entityId: reviewId, reason: reason.trim(), requestId, before, after: review, metadata: { reportId: report.id } });
            return { review, report, idempotent: false };
        } catch (error) {
            this.expertReviews = new Map(reviewsBefore);
            this.reports = new Map(reportsBefore);
            this.auditLog = auditBefore;
            throw error;
        }
    }
    async publishExpertReviewWithAudit(reviewId, reportId, { actorId, reason, requestId } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const review = this.expertReviews.get(reviewId);
        if (!review) return null;
        if (review.status === 'published') return { review, report: await this.getLatestReportForScan(review.workspaceId, review.scanId), idempotent: true };
        if (review.status !== 'ready_to_publish' || !reportId) throw new AppError('Finalize the Expert Review before publication.', { status: 409, code: 'EXPERT_REVIEW_NOT_READY' });
        const source = await this.getReport(review.workspaceId, reportId);
        if (!source || source.scanId !== review.scanId || source.status !== 'expert_reviewed') throw new AppError('The Expert Review report is not publishable.', { status: 409, code: 'EXPERT_REVIEW_NOT_READY' });
        const reviewsBefore = structuredClone([...this.expertReviews.entries()]);
        const reportsBefore = structuredClone([...this.reports.entries()]);
        const auditBefore = structuredClone(this.auditLog);
        const before = structuredClone(review);
        try {
            const publication = await this.publishReportWithAudit(review.workspaceId, reportId, { actorId, reason, requestId });
            Object.assign(review, { status: 'published', updatedAt: new Date().toISOString() });
            await this.logAudit({ workspaceId: review.workspaceId, actorId, action: 'expert_review.published', entityType: 'expert_review', entityId: reviewId, reason: reason.trim(), requestId, before, after: { ...review, reportId: publication.report.id }, metadata: { reportId: publication.report.id } });
            return { review, report: publication.report, idempotent: false };
        } catch (error) {
            this.expertReviews = new Map(reviewsBefore);
            this.reports = new Map(reportsBefore);
            this.auditLog = auditBefore;
            throw error;
        }
    }
    async getLatestReportForScan(workspaceId, scanId) {
        return [...this.reports.values()].filter((report) => report.workspaceId === workspaceId && report.scanId === scanId).sort((a, b) => b.version - a.version)[0] || null;
    }
    async setReportShareToken(workspaceId, reportId, tokenHash, { expiresAt, createdAt = new Date().toISOString() } = {}) {
        return this.updateReport(workspaceId, reportId, { shareTokenHash: tokenHash, shareExpiresAt: expiresAt, shareRevokedAt: null, shareCreatedAt: createdAt });
    }
    async getReportByShareToken(tokenHash) {
        return [...this.reports.values()].find((report) => report.shareTokenHash === tokenHash) || null;
    }
    async revokeReportShare(workspaceId, reportId, revokedAt = new Date().toISOString()) {
        return this.updateReport(workspaceId, reportId, { shareRevokedAt: revokedAt });
    }
    async pendingOperatorTasksForScan(scanId) {
        return [...this.tasks.values()].filter((task) => task.scanId === scanId && task.status === 'pending');
    }

    async createOperatorTasks(workspaceId, scanId, moduleIds, dueAt) {
        const created = [];
        for (const moduleId of moduleIds) {
            const key = `${scanId}:${moduleId}`;
            if ([...this.tasks.values()].some((task) => `${task.scanId}:${task.moduleId}` === key)) continue;
            const task = { id: id('task'), workspaceId, scanId, moduleId, status: 'pending', notes: '', dueAt, createdAt: new Date().toISOString() };
            this.tasks.set(task.id, task);
            created.push(task);
        }
        return created;
    }

    async listOperatorTasks(status = 'pending') {
        return [...this.tasks.values()].filter((task) => !status || task.status === status);
    }

    async completeOperatorTask(taskId, { notes = '', reportPatch, actorId = 'operator', reason, requestId = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const task = this.tasks.get(taskId);
        if (!task) return null;
        if (task.status === 'completed') return task;
        const tasksBefore = structuredClone([...this.tasks.entries()]);
        const reportsBefore = structuredClone([...this.reports.entries()]);
        const scansBefore = structuredClone([...this.scans.entries()]);
        const auditBefore = structuredClone(this.auditLog);
        const before = structuredClone(task);
        try {
            Object.assign(task, { status: 'completed', notes, completedBy: actorId, completedAt: new Date().toISOString() });
            let report = await this.getLatestReportForScan(task.workspaceId, task.scanId);
            if (report && reportPatch) {
                const updated = await this.updateReport(task.workspaceId, report.id, { payload: { ...report.payload, operatorEvidence: { ...(report.payload.operatorEvidence || {}), [task.moduleId]: reportPatch } } }, { expectedVersion: report.revision ?? report.version });
                if (!updated) throw new AppError('The report changed while the operator update was being saved.', { status: 409, code: 'REPORT_UPDATE_CONFLICT' });
                report = updated;
            }
            let completedReport = null;
            let scan = await this.getScan(task.workspaceId, task.scanId);
            if ((await this.pendingOperatorTasksForScan(task.scanId)).length === 0) {
                if (report) {
                    const expertReviewed = task.moduleId === 'expert_review' || Boolean(report.payload.operatorEvidence?.expert_review);
                    completedReport = await this.saveReport(task.workspaceId, task.scanId, report.payload, { locale: report.locale, status: expertReviewed ? 'expert_reviewed' : 'operator_completed' });
                }
                scan = await this.updateScan(task.workspaceId, task.scanId, { status: 'completed', completedAt: new Date().toISOString() });
            }
            await this.logAudit({
                workspaceId: task.workspaceId,
                actorId,
                action: 'operator_task.completed',
                entityType: 'operator_task',
                entityId: task.id,
                reason: reason.trim(),
                requestId,
                before,
                after: task,
                metadata: { moduleId: task.moduleId, reportId: completedReport?.id || report?.id || null, scanStatus: scan?.status || null }
            });
            return task;
        } catch (error) {
            this.tasks = new Map(tasksBefore);
            this.reports = new Map(reportsBefore);
            this.scans = new Map(scansBefore);
            this.auditLog = auditBefore;
            throw error;
        }
    }

    async adminOverview() {
        const reports = [...this.reports.values()];
        const findings = reports.flatMap((report) => findingsFromPayload(report.payload));
        return {
            totals: { users: this.workspaces.size, scans: this.scans.size, findings: findings.length, critical: findings.filter((finding) => finding.severity === 'critical').length, reports: reports.length },
            activity: this.auditLog.slice(0, 8)
        };
    }

    async adminWorkspace(workspaceId) {
        const workspace = await this.getWorkspace(workspaceId);
        if (!workspace) return null;
        const entitlementUserId = await this.resolveEntitlementUser(workspaceId);
        const [effective, usage] = await Promise.all([this.getEffectiveEntitlements(workspaceId), this.getUsage(entitlementUserId)]);
        const scans = await this.listScans(workspaceId);
        return {
            workspace: structuredClone(workspace), subscription: await this.getSubscription(workspaceId), effective, usage,
            grants: [...this.entitlementGrants.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item)),
            creditAdjustments: [...this.creditAdjustments.values()].filter((item) => item.workspaceId === workspaceId).map((item) => structuredClone(item)),
            projects: await this.listProjects(workspaceId), recentScans: scans.slice(0, 20).map(adminScanView), failedScans: scans.filter((scan) => scan.status === 'failed').slice(0, 20).map(adminScanView),
            aiUsage: [...this.aiUsage.values()].filter((entry) => entry.workspaceId === workspaceId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 100).map((entry) => structuredClone(entry)),
            supportTickets: [...this.supportTickets.values()].filter((ticket) => ticket.workspaceId === workspaceId).slice(0, 20),
            audit: this.auditLog.filter((entry) => entry.workspaceId === workspaceId).slice(0, 50)
        };
    }

    async adminUser(userId) {
        const user = await this.getCommercialUser(userId);
        if (!user) return null;
        const workspaces = [...this.workspaces.values()].filter((workspace) => workspace.entitlementOwnerUserId === userId || (!workspace.entitlementOwnerUserId && workspace.id === userId));
        const [profile, effective, usage, grants, creditAdjustments] = await Promise.all([
            this.getUserCommercialProfile(userId),
            this.getUserEffectiveEntitlements(userId),
            this.getUsage(userId),
            this.listUserEntitlementGrants(userId),
            this.listUserCreditAdjustments(userId)
        ]);
        const subscription = [...this.subscriptions.values()].find((item) => item.userId === userId || workspaces.some((workspace) => workspace.id === item.workspaceId)) || null;
        const aiUsage = [...this.aiUsage.values()].filter((entry) => (entry.entitlementUserId || entry.userId) === userId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 100);
        const audit = this.auditLog.filter((entry) => entry.entityId === userId || entry.metadata?.targetUserId === userId).slice(0, 100);
        return {
            user: { ...structuredClone(user), state: (await this.getUserState(userId)).state || 'active' },
            profile, effective, usage, grants, creditAdjustments,
            workspaces: workspaces.map((workspace) => structuredClone(workspace)),
            subscription: subscription ? structuredClone(subscription) : null,
            aiUsage: aiUsage.map((entry) => structuredClone(entry)),
            audit: audit.map((entry) => structuredClone(entry))
        };
    }

    async adminResources(kind) {
        if (kind === 'users') return [...this.users.values()].map((user) => {
            const workspaces = [...this.workspaces.values()].filter((workspace) => workspace.entitlementOwnerUserId === user.id || (!workspace.entitlementOwnerUserId && workspace.id === user.id));
            const activity = [user.createdAt, user.updatedAt,
                ...[...this.scans.values()].filter((scan) => scan.entitlementUserId === user.id || workspaces.some((workspace) => workspace.id === scan.workspaceId)).flatMap((scan) => [scan.updatedAt, scan.createdAt]),
                ...this.auditLog.filter((entry) => entry.entityId === user.id || entry.metadata?.targetUserId === user.id).map((entry) => entry.createdAt)
            ].filter(Boolean).sort().at(-1) || user.createdAt;
            const state = this.userStates.get(user.id)?.state || 'active';
            return { ...structuredClone(user), state, planId: this.userEntitlementProfiles.get(user.id)?.planId || 'free', workspaces: workspaces.map((workspace) => structuredClone(workspace)), lastActivityAt: activity };
        });
        if (kind === 'workspaces') return Promise.all([...this.workspaces.keys()].map((workspaceId) => this.adminWorkspace(workspaceId)));
        if (kind === 'grants') return [...this.entitlementGrants.values()].map((item) => structuredClone(item));
        if (kind === 'audit') return this.auditLog.slice(0, 200).map((item) => {
            const event = structuredClone(item);
            const targetUserId = auditTargetUserId(event);
            return {
                ...event,
                actor: auditPrincipal(this.users.get(event.actorId) || this.adminAccounts.get(event.actorId), event.actorId),
                targetUser: auditPrincipal(this.users.get(targetUserId), targetUserId)
            };
        });
        if (kind === 'scans') return [...this.scans.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(adminScanView);
        if (kind === 'ai_usage') return [...this.aiUsage.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200).map((entry) => structuredClone(entry));
        if (kind === 'reports') return [...this.reports.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(({ payload: _payload, ...report }) => report);
        if (kind === 'findings') return [...this.reports.values()].flatMap((report) => findingsFromPayload(report.payload).map((finding) => ({ ...finding, reportId: report.id, createdAt: report.createdAt }))).slice(0, 200);
        return [];
    }
}

class PostgresPlatformStore {
    constructor(connectionString, config = null) {
        this.pool = observePostgresPool(
            new Pool(databasePoolOptions(config || connectionString, { max: 10, applicationName: 'webpage-analyzer-platform' })),
            { logger: config?.logger, component: 'platform-store' }
        );
        this.executionRole = config?.executionRole || null;
        // Analysis workers may append progress events but deliberately do not
        // receive table-wide DELETE. Cache the capability after the first
        // bounded trim attempt so worker scans continue without turning a
        // privilege failure into a failed scan.
        this.scanEventTrimPrivilege = null;
    }

    async close() { await this.pool.end(); }

    async healthCheck(timeoutMs = 1_000) {
        let timer;
        try {
            await Promise.race([
                this.pool.query('SELECT 1'),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('PostgreSQL health check timed out.')), timeoutMs);
                    timer.unref?.();
                })
            ]);
            return { status: 'operational' };
        } catch {
            return { status: 'unavailable' };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async recordWorkerHeartbeat(kind, workerId, { startedAt = null, metadata = {}, now = new Date() } = {}) {
        const at = new Date(now).toISOString();
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_worker_heartbeats(kind,worker_id,started_at,heartbeat_at,metadata)
             VALUES($1,$2,COALESCE($3::timestamptz,$4::timestamptz),$4,$5::jsonb)
             ON CONFLICT(kind) DO UPDATE SET
               worker_id=EXCLUDED.worker_id,
               started_at=CASE WHEN wpa_worker_heartbeats.worker_id=EXCLUDED.worker_id THEN wpa_worker_heartbeats.started_at ELSE EXCLUDED.started_at END,
               heartbeat_at=EXCLUDED.heartbeat_at,
               metadata=EXCLUDED.metadata
             RETURNING kind,worker_id AS "workerId",started_at AS "startedAt",heartbeat_at AS "heartbeatAt",metadata`,
            [kind, workerId, startedAt, at, JSON.stringify(sanitizeAuditValue(metadata))]
        );
        return rows[0];
    }

    async workerHealth(kind, { maxAgeMs = 90_000 } = {}) {
        const { rows } = await this.pool.query(
            `SELECT kind,worker_id AS "workerId",started_at AS "startedAt",heartbeat_at AS "heartbeatAt",metadata,
                    GREATEST(0,EXTRACT(EPOCH FROM (now()-heartbeat_at))*1000)::bigint AS "ageMs",
                    CASE WHEN heartbeat_at >= now()-($2::bigint * interval '1 millisecond') THEN 'operational' ELSE 'stale' END AS status
             FROM wpa_worker_heartbeats WHERE kind=$1`,
            [kind, Math.max(1_000, Number(maxAgeMs) || 90_000)]
        );
        return rows[0] || { kind, status: 'unavailable', heartbeatAt: null, ageMs: null };
    }

    async createExecutionResult({ jobKey, workspaceId = null, kind, input = {} }) {
        const executionId = id('exec');
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_worker_execution_results(id,job_key,workspace_id,kind,status,input)
             VALUES($1,$2,$3,$4,'queued',$5::jsonb)
             ON CONFLICT(job_key) DO UPDATE SET updated_at=now()
             RETURNING id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,input,result,artifact_path AS "artifactPath",content_type AS "contentType",bytes,failure_code AS "failureCode",attempts,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`,
            [executionId, jobKey, workspaceId, kind, JSON.stringify(input)]
        );
        return rows[0];
    }
    async getExecutionResult(workspaceId, executionId) {
        const values = workspaceId == null ? [executionId] : [executionId, workspaceId];
        const scope = workspaceId == null ? '' : ' AND workspace_id=$2';
        const { rows } = await this.pool.query(
            `SELECT id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,input,result,artifact_path AS "artifactPath",content_type AS "contentType",bytes,failure_code AS "failureCode",attempts,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM wpa_worker_execution_results WHERE id=$1${scope}`,
            values
        );
        return rows[0] || null;
    }

    async cancelScan(workspaceId, scanId, { actorId, reason, requestId = null, idempotencyKey = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            if (before.status === 'cancelled') { await client.query('COMMIT'); return { scan: before, idempotent: true }; }
            if (['completed', 'partial', 'awaiting_operator'].includes(before.status)) throw new AppError('A completed scan cannot be cancelled.', { status: 409, code: 'SCAN_NOT_CANCELLABLE' });
            const after = (await client.query("UPDATE wpa_scans SET status='cancelled',failure_code='ADMIN_CANCELLED',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS \"workspaceId\",project_id AS \"projectId\",status,failure_code AS \"failureCode\",created_at AS \"createdAt\",completed_at AS \"completedAt\"", [workspaceId, scanId])).rows[0];
            await client.query("UPDATE wpa_scan_pages SET status='cancelled',error_code='ADMIN_CANCELLED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND status NOT IN ('completed','incomplete','failed','unavailable','cancelled')", [workspaceId, scanId]);
            await client.query("UPDATE wpa_credit_entries SET state='released',updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND state='reserved'", [workspaceId, scanId]);
            await client.query("INSERT INTO wpa_scan_events(workspace_id,scan_id,type,payload) VALUES($1,$2,'scan.cancelled',$3::jsonb)", [workspaceId, scanId, JSON.stringify({ reason, requestId, idempotencyKey })]);
            await insertAuditRecord(client, { workspaceId, actorId, action: 'scan.cancelled', entityType: 'scan', entityId: scanId, reason, requestId, before, after, metadata: { idempotencyKey } });
            await client.query('COMMIT');
            return { scan: after, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async renewExecutionResultLease(jobKey, { owner, leaseToken, leaseMs = 120_000 } = {}) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_worker_execution_results SET lease_expires_at=now()+($4::int * interval '1 millisecond'),updated_at=now()
             WHERE job_key=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3
             RETURNING id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,attempts,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",updated_at AS "updatedAt"`,
            [jobKey, String(owner), String(leaseToken), Math.max(1_000, Number(leaseMs) || 120_000)]
        );
        return rows[0] || null;
    }

    async retryScan(workspaceId, scanId, { actorId, reason, requestId = null, idempotencyKey = null, creditLimit = Number.MAX_SAFE_INTEGER, now = new Date() } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`page-credit:${before.entitlementUserId}`]);
            if (['queued', 'running'].includes(before.status)) { await client.query('COMMIT'); return { scan: before, idempotent: true, requeuedPages: 0 }; }
            if (!['failed', 'partial', 'cancelled'].includes(before.status)) throw new AppError('This scan is not eligible for retry.', { status: 409, code: 'SCAN_NOT_RETRYABLE' });
            const retryableCount = Number((await client.query("SELECT count(*)::int AS count FROM wpa_scan_pages WHERE workspace_id=$1 AND scan_id=$2 AND status IN ('queued','failed','unavailable','incomplete','cancelled')", [workspaceId, scanId])).rows[0].count);
            if (!retryableCount) { await client.query('COMMIT'); return { scan: before, idempotent: true, requeuedPages: 0 }; }
            const periodStart = monthStart(new Date(now));
            const usage = Number((await client.query("SELECT COALESCE(sum(amount),0)::int AS used FROM wpa_credit_entries WHERE entitlement_user_id=$1 AND period_start=$2 AND state IN ('reserved','consumed')", [before.entitlementUserId, periodStart])).rows[0].used);
            const released = Number((await client.query("SELECT COALESCE(sum(amount),0)::int AS count FROM wpa_credit_entries WHERE workspace_id=$1 AND scan_id=$2 AND state='released'", [workspaceId, scanId])).rows[0].count);
            if (usage + released > creditLimit) throw new AppError('The monthly page credit limit has been reached.', { status: 402, code: 'PAGE_CREDIT_LIMIT_REACHED' });
            await client.query("UPDATE wpa_credit_entries SET state='reserved',updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND state='released'", [workspaceId, scanId]);
            await client.query("UPDATE wpa_scan_pages SET status='retrying',error_code=NULL,max_attempts=LEAST(10,GREATEST(max_attempts,attempts+1)),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND status IN ('queued','failed','unavailable','incomplete','cancelled')", [workspaceId, scanId]);
            const after = (await client.query("UPDATE wpa_scans SET status='queued',failure_code=NULL,completed_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS \"workspaceId\",project_id AS \"projectId\",requested_by_user_id AS \"requestedByUserId\",entitlement_user_id AS \"entitlementUserId\",status,failure_code AS \"failureCode\",created_at AS \"createdAt\",completed_at AS \"completedAt\"", [workspaceId, scanId])).rows[0];
            await client.query("INSERT INTO wpa_scan_events(workspace_id,scan_id,type,payload) VALUES($1,$2,'scan.retried',$3::jsonb)", [workspaceId, scanId, JSON.stringify({ reason, requestId, idempotencyKey, pages: retryableCount })]);
            await insertAuditRecord(client, { workspaceId, actorId, action: 'scan.retried', entityType: 'scan', entityId: scanId, reason, requestId, before, after, metadata: { idempotencyKey, requeuedPages: retryableCount } });
            await client.query('COMMIT');
            return { scan: after, idempotent: false, requeuedPages: retryableCount };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async claimExecutionResult(jobKey, { owner = 'worker', leaseMs = 120_000 } = {}) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query('SELECT id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,input,result,artifact_path AS "artifactPath",content_type AS "contentType",bytes,failure_code AS "failureCode",attempts,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM wpa_worker_execution_results WHERE job_key=$1 FOR UPDATE', [jobKey]);
            const record = rows[0];
            if (!record || ['completed', 'failed', 'unavailable'].includes(record.status)) { await client.query('COMMIT'); return record || null; }
            if (record.status === 'running' && new Date(record.leaseExpiresAt || 0).getTime() > Date.now()) { await client.query('COMMIT'); return null; }
            const leaseToken = crypto.randomUUID();
            const { rows: claimed } = await client.query(
                `UPDATE wpa_worker_execution_results SET status='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,lease_expires_at=now()+($4::int * interval '1 millisecond'),updated_at=now() WHERE job_key=$1 RETURNING id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,input,result,artifact_path AS "artifactPath",content_type AS "contentType",bytes,failure_code AS "failureCode",attempts,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`,
                [jobKey, String(owner), leaseToken, Math.max(1_000, Number(leaseMs) || 120_000)]
            );
            await client.query('COMMIT');
            return claimed[0] || null;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async recordCheckoutAcceptance(input) {
        const acceptanceId = input.id || id('checkout_acceptance');
        const userId = input.userId || (await this.pool.query('SELECT entitlement_owner_user_id AS "userId" FROM wpa_workspaces WHERE id=$1', [input.workspaceId])).rows[0]?.userId || null;
        if (!userId) throw new AppError('Checkout acceptance is missing its user owner.', { status: 400, code: 'CHECKOUT_ACCEPTANCE_USER_MISSING' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkout-intent:${userId}`]);
            await client.query("UPDATE wpa_checkout_acceptances SET status='expired' WHERE user_id=$1 AND status IN ('accepted','checkout_created') AND expires_at IS NOT NULL AND expires_at<=now()", [userId]);
            const select = `SELECT id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt" FROM wpa_checkout_acceptances`;
            const existing = (await client.query(`${select} WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [userId, input.idempotencyKey])).rows[0];
            if (existing) {
                assertIdempotentReplay(existing.requestFingerprint, input.requestFingerprint);
                if (existing.workspaceId !== input.workspaceId || existing.planId !== input.planId || existing.provider !== input.provider) throw new AppError('The idempotency key was already used for a different request.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
                await client.query('COMMIT');
                return { ...existing, idempotent: true };
            }
            const openIntent = (await client.query("SELECT id FROM wpa_checkout_acceptances WHERE user_id=$1 AND status IN ('accepted','checkout_created') LIMIT 1", [userId])).rows[0];
            if (openIntent) throw new AppError('This user already has a checkout operation in progress.', { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
            const { rows } = await client.query(`INSERT INTO wpa_checkout_acceptances(id,workspace_id,user_id,plan_id,provider,catalog_version,amount_minor,currency,billing_interval,terms_version,refund_policy_version,request_id,idempotency_key,request_fingerprint,metadata,accepted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,COALESCE($16::timestamptz,now()),$17) RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt"`, [acceptanceId, input.workspaceId, userId, input.planId, input.provider, input.catalogVersion, input.amountMinor, String(input.currency).toUpperCase(), input.billingInterval, input.termsVersion, input.refundPolicyVersion, input.requestId, input.idempotencyKey, input.requestFingerprint || null, JSON.stringify(sanitizeAuditValue(input.metadata || {})), input.acceptedAt || null, input.expiresAt || null]);
            const record = rows[0];
            await insertAuditRecord(client, { workspaceId: record.workspaceId, actorId: record.userId, action: 'checkout.accepted', entityType: 'checkout_acceptance', entityId: record.id, reason: 'paid_checkout', requestId: record.requestId, after: { planId: record.planId, catalogVersion: record.catalogVersion, termsVersion: record.termsVersion, refundPolicyVersion: record.refundPolicyVersion }, metadata: { provider: record.provider } });
            await client.query('COMMIT');
            return { ...record, idempotent: false };
        } catch (error) {
            await client.query('ROLLBACK');
            if (error?.code === '23505' && ['wpa_checkout_one_open_intent_idx', 'wpa_checkout_one_open_user_intent_idx'].includes(error?.constraint)) throw new AppError('This user already has a checkout operation in progress.', { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
            if (error?.code === '23505' && error?.constraint === 'wpa_checkout_acceptances_user_operation_idx') throw new AppError('The idempotency key was already used for a different request.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
            if (error?.code === '23505') throw new AppError('The checkout operation conflicts with an existing acceptance.', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
            throw error;
        }
        finally { client.release(); }
    }

    async getCheckoutAcceptance(scope, identifier) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const column = identity.userId ? 'user_id' : 'workspace_id';
        const subject = identity.userId || identity.workspaceId;
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt" FROM wpa_checkout_acceptances WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) LIMIT 1`, [subject, identifier]);
        return rows[0] || null;
    }

    async claimCheckoutAcceptance(scope, identifier, { owner, leaseMs = 120_000 } = {}) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const column = identity.userId ? 'user_id' : 'workspace_id';
        const subject = identity.userId || identity.workspaceId;
        const leaseToken = crypto.randomUUID();
        const select = `SELECT id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt" FROM wpa_checkout_acceptances`;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = (await client.query(`${select} WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) FOR UPDATE`, [subject, identifier])).rows[0];
            if (!current) { await client.query('ROLLBACK'); return null; }
            if (!['accepted', 'checkout_created'].includes(current.status)) {
                await client.query('COMMIT');
                return { acceptance: current, claimed: false, terminal: true };
            }
            if (current.setupLeaseToken && new Date(current.setupLeaseExpiresAt || 0).getTime() > Date.now()) {
                await client.query('COMMIT');
                return { acceptance: current, claimed: false, active: true };
            }
            const { rows } = await client.query(`UPDATE wpa_checkout_acceptances SET setup_lease_owner=$3,setup_lease_token=$4,setup_lease_expires_at=now()+($5::int * interval '1 millisecond') WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt"`, [subject, identifier, String(owner), leaseToken, Math.max(1_000, Number(leaseMs) || 120_000)]);
            const acceptance = rows[0];
            await client.query('COMMIT');
            return { acceptance, claimed: true, leaseOwner: acceptance.setupLeaseOwner, leaseToken: acceptance.setupLeaseToken, leaseExpiresAt: acceptance.setupLeaseExpiresAt };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async releaseCheckoutAcceptanceClaim(scope, identifier, { owner, leaseToken } = {}) {
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const column = identity.userId ? 'user_id' : 'workspace_id';
        const subject = identity.userId || identity.workspaceId;
        const { rows } = await this.pool.query(`UPDATE wpa_checkout_acceptances SET setup_lease_owner=NULL,setup_lease_token=NULL,setup_lease_expires_at=NULL WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) AND setup_lease_owner=$3 AND setup_lease_token=$4 RETURNING id`, [subject, identifier, String(owner), String(leaseToken)]);
        return rows[0] ? this.getCheckoutAcceptance(identity, identifier) : null;
    }

    async markCheckoutAcceptance(scope, identifier, { status, providerCheckoutId = null } = {}) {
        if (!['checkout_created', 'completed', 'expired', 'cancelled'].includes(status)) throw new AppError('Checkout acceptance status is invalid.', { status: 400, code: 'CHECKOUT_ACCEPTANCE_STATUS_INVALID' });
        const identity = scope && typeof scope === 'object' ? scope : { workspaceId: scope };
        const column = identity.userId ? 'user_id' : 'workspace_id';
        const subject = identity.userId || identity.workspaceId;
        const select = `SELECT id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",setup_lease_owner AS "setupLeaseOwner",setup_lease_token AS "setupLeaseToken",setup_lease_expires_at AS "setupLeaseExpiresAt",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt" FROM wpa_checkout_acceptances`;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query(`${select} WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) FOR UPDATE`, [subject, identifier])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            if (!checkoutTransitionAllowed(before.status, status)) throw new AppError('Checkout acceptance cannot move to the requested state.', { status: 409, code: 'CHECKOUT_ACCEPTANCE_TRANSITION_INVALID' });
            if (before.providerCheckoutId && providerCheckoutId && before.providerCheckoutId !== providerCheckoutId) throw new AppError('Checkout provider identity does not match the persisted acceptance.', { status: 409, code: 'CHECKOUT_PROVIDER_ID_MISMATCH' });
            if (before.status === status && (!providerCheckoutId || before.providerCheckoutId === providerCheckoutId)) {
                await client.query('COMMIT');
                return { ...before, idempotent: true };
            }
            const after = (await client.query(`UPDATE wpa_checkout_acceptances SET status=$3,provider_checkout_id=COALESCE($4,provider_checkout_id),setup_lease_owner=CASE WHEN $3 IN ('completed','expired','cancelled') THEN NULL ELSE setup_lease_owner END,setup_lease_token=CASE WHEN $3 IN ('completed','expired','cancelled') THEN NULL ELSE setup_lease_token END,setup_lease_expires_at=CASE WHEN $3 IN ('completed','expired','cancelled') THEN NULL ELSE setup_lease_expires_at END WHERE ${column}=$1 AND (id=$2 OR idempotency_key=$2) RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",plan_id AS "planId",provider,catalog_version AS "catalogVersion",amount_minor AS "amountMinor",currency,billing_interval AS "billingInterval",terms_version AS "termsVersion",refund_policy_version AS "refundPolicyVersion",request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",status,provider_checkout_id AS "providerCheckoutId",metadata,accepted_at AS "acceptedAt",expires_at AS "expiresAt"`, [subject, identifier, status, providerCheckoutId])).rows[0];
            await insertAuditRecord(client, { workspaceId: after.workspaceId, actorId: after.userId, action: `checkout.${status}`, entityType: 'checkout_acceptance', entityId: after.id, reason: status, requestId: after.requestId, before, after: { status: after.status, providerCheckoutId: after.providerCheckoutId } });
            await client.query('COMMIT');
            return { ...after, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async recordLegalAcceptance(input) {
        const acceptanceId = input.id || id('legal_acceptance');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`INSERT INTO wpa_legal_acceptances(id,user_id,workspace_id,document_type,document_version,purpose,request_id,metadata,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now())) ON CONFLICT(user_id,workspace_id,document_type,document_version,purpose) DO UPDATE SET id=wpa_legal_acceptances.id RETURNING id,user_id AS "userId",workspace_id AS "workspaceId",document_type AS "documentType",document_version AS "documentVersion",purpose,request_id AS "requestId",metadata,accepted_at AS "acceptedAt"`, [acceptanceId, input.userId, input.workspaceId || null, input.documentType, input.documentVersion, input.purpose, input.requestId, JSON.stringify(sanitizeAuditValue(input.metadata || {})), input.acceptedAt || null]);
            const record = rows[0];
            if (record.id === acceptanceId) await insertAuditRecord(client, { workspaceId: record.workspaceId, actorId: record.userId, action: 'legal.accepted', entityType: 'legal_acceptance', entityId: record.id, reason: record.purpose, requestId: record.requestId, after: { documentType: record.documentType, documentVersion: record.documentVersion } });
            await client.query('COMMIT');
            return record;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async hasCurrentLegalAcceptance(userId, workspaceId, requirements) {
        const required = Array.isArray(requirements) ? requirements : [requirements];
        if (!required.length) return true;
        const { rows } = await this.pool.query('SELECT document_type AS "documentType",document_version AS "documentVersion",purpose FROM wpa_legal_acceptances WHERE user_id=$1 AND workspace_id IS NOT DISTINCT FROM $2', [userId, workspaceId || null]);
        return required.every((requirement) => rows.some((record) => record.documentType === requirement.documentType && record.documentVersion === requirement.documentVersion && record.purpose === requirement.purpose));
    }

    async recordTargetAuthorization(input) {
        const authorizationId = input.id || id('target_authorization');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const record = (await client.query(`INSERT INTO wpa_target_authorizations(id,workspace_id,project_id,user_id,origin,attestation_version,authorization_basis,request_id,metadata,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,COALESCE($10::timestamptz,now())) RETURNING id,workspace_id AS "workspaceId",project_id AS "projectId",user_id AS "userId",origin,attestation_version AS "attestationVersion",authorization_basis AS "authorizationBasis",request_id AS "requestId",metadata,accepted_at AS "acceptedAt"`, [authorizationId, input.workspaceId, input.projectId || null, input.userId, input.origin, input.attestationVersion, input.authorizationBasis || 'authorized_control', input.requestId, JSON.stringify(sanitizeAuditValue(input.metadata || {})), input.acceptedAt || null])).rows[0];
            await insertAuditRecord(client, { workspaceId: record.workspaceId, actorId: record.userId, action: 'target.authorization_recorded', entityType: 'project', entityId: record.projectId, reason: record.authorizationBasis, requestId: record.requestId, after: { origin: record.origin, attestationVersion: record.attestationVersion } });
            await client.query('COMMIT');
            return record;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async listTargetAuthorizations(workspaceId, { projectId = null, activeOnly = true } = {}) {
        const values = [workspaceId];
        const filters = ['workspace_id=$1'];
        if (projectId) { values.push(projectId); filters.push(`project_id=$${values.length}`); }
        if (activeOnly) filters.push('revoked_at IS NULL');
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",user_id AS "userId",origin,attestation_version AS "attestationVersion",authorization_basis AS "authorizationBasis",request_id AS "requestId",metadata,accepted_at AS "acceptedAt",revoked_at AS "revokedAt" FROM wpa_target_authorizations WHERE ${filters.join(' AND ')} ORDER BY accepted_at DESC,id DESC`, values);
        return rows;
    }

    async recordAiUsage(input) {
        const usageId = input.id || id('ai_usage');
        const status = input.status || 'completed';
        const entitlementUserId = input.entitlementUserId || input.userId;
        const { rows } = await this.pool.query(`INSERT INTO wpa_ai_usage(id,workspace_id,user_id,entitlement_user_id,finding_fingerprint,requested_model,actual_model,provider,prompt_version,evidence_version,idempotency_key,usage_metadata,cost_metadata,status,failure_code,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,COALESCE($16::timestamptz,now()),COALESCE($17::timestamptz,CASE WHEN $14 IN ('completed','failed','cache_hit') THEN now() ELSE NULL END)) ON CONFLICT(entitlement_user_id,idempotency_key) DO UPDATE SET id=wpa_ai_usage.id RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",entitlement_user_id AS "entitlementUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",idempotency_key AS "idempotencyKey",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt"`, [usageId, input.workspaceId, input.userId, entitlementUserId, input.findingFingerprint, input.requestedModel, input.actualModel || null, input.provider, input.promptVersion, input.evidenceVersion, input.idempotencyKey || usageId, JSON.stringify(sanitizeAuditValue(input.usageMetadata || {})), JSON.stringify(sanitizeAuditValue(input.costMetadata || {})), status, input.failureCode || null, input.createdAt || null, input.completedAt || null]);
        assertAiReplayMatches(rows[0], { ...input, entitlementUserId });
        return rows[0];
    }

    async consumeAiGeneration(workspaceId, input, { now = new Date() } = {}) {
        assertAiReservationInput(input);
        const at = new Date(now);
        const { start, end } = aiMonthBounds(at);
        const entitlementUserId = input.entitlementUserId || await this.resolveEntitlementUser(workspaceId, input.userId);
        const reservationInput = { ...input, entitlementUserId };
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai-quota:${entitlementUserId}`]);
            if (!(await client.query('SELECT id FROM "user" WHERE id=$1', [entitlementUserId])).rows[0]) throw new AppError('Commercial entitlement owner was not found.', { status: 409, code: 'WORKSPACE_ENTITLEMENT_OWNER_REQUIRED' });
            const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",user_id AS "userId",entitlement_user_id AS "entitlementUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",idempotency_key AS "idempotencyKey",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_ai_usage WHERE entitlement_user_id=$1 AND idempotency_key=$2`, [entitlementUserId, input.idempotencyKey])).rows[0];
            const profile = (await client.query('SELECT plan_id AS "planId" FROM wpa_user_entitlement_profiles WHERE user_id=$1', [entitlementUserId])).rows[0];
            const basePlan = (await client.query('SELECT id,name,price_usd AS "priceUsd",description,limits,features,entitlements,sales_mode AS "salesMode" FROM wpa_plan_catalog WHERE id=$1', [profile?.planId || 'free'])).rows[0] || getPlan(profile?.planId || 'free');
            const grants = (await client.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_entitlement_grants WHERE user_id=$1 AND revoked_at IS NULL AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at,id`, [entitlementUserId, at.toISOString()])).rows;
            const adjustments = (await client.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at`, [entitlementUserId, at.toISOString()])).rows;
            const limit = aiQuotaLimit(composeEffectivePlan(basePlan, grants, adjustments, at));
            const used = (await client.query(`SELECT count(*)::int AS used FROM wpa_ai_usage WHERE entitlement_user_id=$1 AND status IN ('reserved','completed','cache_hit') AND created_at >= $2 AND created_at < $3`, [entitlementUserId, start.toISOString(), end.toISOString()])).rows[0].used;
            if (existing) {
                assertAiReplayMatches(existing, reservationInput);
                await client.query('COMMIT');
                return { usage: existing, quota: { limit, used, remaining: Math.max(0, limit - used) }, idempotent: true };
            }
            if (used >= limit) throw new AppError('The monthly AI remediation limit has been reached.', { status: 402, code: 'AI_REMEDIATION_LIMIT_REACHED' });
            const usageId = input.id || id('ai_usage');
            const usage = (await client.query(`INSERT INTO wpa_ai_usage(id,workspace_id,user_id,entitlement_user_id,finding_fingerprint,requested_model,provider,prompt_version,evidence_version,idempotency_key,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved',$11) RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",entitlement_user_id AS "entitlementUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",idempotency_key AS "idempotencyKey",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt"`, [usageId, workspaceId, input.userId, entitlementUserId, input.findingFingerprint, input.requestedModel, input.provider, input.promptVersion, input.evidenceVersion, input.idempotencyKey, at.toISOString()])).rows[0];
            await client.query('COMMIT');
            return { usage, quota: { limit, used: used + 1, remaining: Math.max(0, limit - used - 1) }, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async settleAiGeneration(workspaceId, usageId, input = {}) {
        if (!AI_TERMINAL_STATUSES.has(input.status)) throw new AppError('AI usage settlement status is invalid.', { status: 400, code: 'AI_USAGE_STATUS_INVALID' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",user_id AS "userId",entitlement_user_id AS "entitlementUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",idempotency_key AS "idempotencyKey",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_ai_usage WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [usageId, workspaceId])).rows[0];
            if (!existing) throw new AppError('AI usage reservation was not found.', { status: 404, code: 'AI_USAGE_NOT_FOUND' });
            if (existing.status !== 'reserved') {
                await client.query('COMMIT');
                return { usage: existing, idempotent: true };
            }
            const usage = (await client.query(`UPDATE wpa_ai_usage SET status=$3,actual_model=COALESCE($4,actual_model),usage_metadata=$5::jsonb,cost_metadata=$6::jsonb,failure_code=CASE WHEN $3='failed' THEN COALESCE($7,'AI_PROVIDER_FAILED') ELSE NULL END,completed_at=COALESCE($8::timestamptz,now()) WHERE id=$1 AND workspace_id=$2 RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",entitlement_user_id AS "entitlementUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",idempotency_key AS "idempotencyKey",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt"`, [usageId, workspaceId, input.status, input.actualModel || null, JSON.stringify(sanitizeAuditValue(input.usageMetadata || {})), JSON.stringify(sanitizeAuditValue(input.costMetadata || {})), input.failureCode || null, input.completedAt || null])).rows[0];
            await client.query('COMMIT');
            return { usage, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async countAiUsage(entitlementUserId, now = new Date()) {
        const { start, end } = aiMonthBounds(now);
        const { rows } = await this.pool.query(
            "SELECT count(*)::int AS count FROM wpa_ai_usage WHERE entitlement_user_id=$1 AND status = ANY($2::text[]) AND created_at >= $3 AND created_at < $4",
            [entitlementUserId, [...AI_QUOTA_STATUSES], start.toISOString(), end.toISOString()]
        );
        return rows[0].count;
    }

    async getAiCache(workspaceId, cacheKey, now = new Date()) {
        const { rows } = await this.pool.query('SELECT cache_key AS "cacheKey",workspace_id AS "workspaceId",finding_fingerprint AS "findingFingerprint",prompt_version AS "promptVersion",model_version AS "modelVersion",evidence_version AS "evidenceVersion",response,created_at AS "createdAt",expires_at AS "expiresAt" FROM wpa_ai_cache WHERE cache_key=$1 AND workspace_id=$2 AND (expires_at IS NULL OR expires_at>$3)', [cacheKey, workspaceId, new Date(now).toISOString()]);
        return rows[0] || null;
    }

    async putAiCache(input) {
        const { rows } = await this.pool.query(`INSERT INTO wpa_ai_cache(cache_key,workspace_id,finding_fingerprint,prompt_version,model_version,evidence_version,response,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,cache_key) DO UPDATE SET response=EXCLUDED.response,finding_fingerprint=EXCLUDED.finding_fingerprint,prompt_version=EXCLUDED.prompt_version,evidence_version=EXCLUDED.evidence_version,model_version=EXCLUDED.model_version,expires_at=EXCLUDED.expires_at RETURNING cache_key AS "cacheKey",workspace_id AS "workspaceId",finding_fingerprint AS "findingFingerprint",prompt_version AS "promptVersion",model_version AS "modelVersion",evidence_version AS "evidenceVersion",response,created_at AS "createdAt",expires_at AS "expiresAt"`, [input.cacheKey, input.workspaceId, input.findingFingerprint, input.promptVersion, input.modelVersion, input.evidenceVersion, JSON.stringify(input.response), input.expiresAt || null]);
        return rows[0] || null;
    }

    async dailyAiCost(workspaceId, now = new Date()) {
        const values = workspaceId == null ? [new Date(now).toISOString()] : [workspaceId, new Date(now).toISOString()];
        const scope = workspaceId == null ? '' : 'workspace_id=$1 AND ';
        const atParameter = workspaceId == null ? '$1' : '$2';
        const { rows } = await this.pool.query(`SELECT COALESCE(sum(CASE WHEN (cost_metadata->>'cost') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (cost_metadata->>'cost')::numeric ELSE 0 END),0)::text AS cost FROM wpa_ai_usage WHERE ${scope}created_at>=date_trunc('day',${atParameter}::timestamptz) AND created_at<date_trunc('day',${atParameter}::timestamptz)+interval '1 day'`, values);
        return Number(rows[0]?.cost || 0);
    }

    async getFinding(workspaceId, fingerprint) {
        const { rows } = await this.pool.query('SELECT id,version,payload,created_at AS "createdAt" FROM wpa_reports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 250', [workspaceId]);
        for (const report of rows) {
            const finding = findingsFromPayload(report.payload).find((item) => item.fingerprint === fingerprint);
            if (finding) return { ...finding, reportId: report.id, reportVersion: report.version, evidenceVersion: `${report.id}:${report.version}:${new Date(report.createdAt).toISOString()}`, reportCreatedAt: report.createdAt };
        }
        return null;
    }
    async settleExecutionResult(jobKey, { owner, leaseToken, status, result = null, artifactPath = null, contentType = null, bytes = null, failureCode = null } = {}) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_worker_execution_results SET status=$4,result=$5::jsonb,artifact_path=$6,content_type=$7,bytes=$8,failure_code=$9,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=CASE WHEN $4 IN ('completed','failed','unavailable') THEN now() ELSE completed_at END,updated_at=now() WHERE job_key=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3 RETURNING id,job_key AS "jobKey",workspace_id AS "workspaceId",kind,status,result,artifact_path AS "artifactPath",content_type AS "contentType",bytes,failure_code AS "failureCode",attempts,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`,
            [jobKey, String(owner), String(leaseToken), status, result == null ? null : JSON.stringify(result), artifactPath, contentType, bytes, failureCode]
        );
        return rows[0] || null;
    }
    async listWorkspaceIds() {
        const { rows } = await this.pool.query('SELECT id FROM wpa_workspaces ORDER BY id');
        return rows.map((row) => row.id);
    }

    async listDueWorkspaceDeletions({ now = new Date(), limit = 25, leaseMs = 15 * 60_000 } = {}) {
        const { rows } = await this.pool.query(
            `SELECT id,workspace_id AS "workspaceId",requested_by AS "requestedBy",status,requested_at AS "requestedAt",grace_until AS "graceUntil",confirmed_at AS "confirmedAt",authorized_by AS "authorizedBy",authorized_at AS "authorizedAt",execution_started_at AS "executionStartedAt",completed_at AS "completedAt",failure_code AS "failureCode"
             FROM wpa_workspace_deletion_requests
             WHERE (status='requested' OR (status='processing' AND execution_started_at <= $1::timestamptz - ($3::int * interval '1 millisecond')))
               AND confirmed_at IS NOT NULL AND authorized_by IS NOT NULL AND grace_until <= $1::timestamptz
             ORDER BY grace_until,id LIMIT $2`,
            [new Date(now), Math.min(100, Math.max(1, Number(limit) || 25)), Math.max(60_000, Number(leaseMs) || 15 * 60_000)]
        );
        return rows;
    }

    async getAdminAccount(userId) {
        const { rows } = await this.pool.query('SELECT user_id AS "userId",email,role,active,security_version AS "securityVersion",created_at AS "createdAt",updated_at AS "updatedAt",last_access_at AS "lastAccessAt" FROM wpa_admin_accounts WHERE user_id=$1', [userId]);
        return rows[0] ? { ...rows[0], role: canonicalAdminRole(rows[0].role), securityVersion: Number(rows[0].securityVersion || 1) } : null;
    }
    async countUserPasskeys(userId) {
        const { rows } = await this.pool.query('SELECT count(*)::int AS count FROM passkey WHERE "userId"=$1', [userId]);
        return rows[0]?.count || 0;
    }
    async listUserPasskeys(userId) {
        const { rows } = await this.pool.query('SELECT id,name,"deviceType" AS "deviceType","backedUp" AS "backedUp",transports,"createdAt" AS "createdAt","lastUsedAt" AS "lastUsedAt",aaguid FROM passkey WHERE "userId"=$1 ORDER BY "createdAt",id', [userId]);
        return rows;
    }
    async deletePrivilegedPasskey({ userId, passkeyId, actorId, requestId, minimumCredentialCount = 1, credentialRequired = false }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`wpa:privileged-passkey:${userId}`]);
            await client.query('SELECT user_id FROM wpa_admin_accounts WHERE user_id=$1 AND active=true FOR UPDATE', [userId]);
            const credential = (await client.query(
                'SELECT id,name,"deviceType" AS "deviceType","backedUp" AS "backedUp",transports,"createdAt" AS "createdAt","lastUsedAt" AS "lastUsedAt",aaguid FROM passkey WHERE id=$1 AND "userId"=$2 FOR UPDATE',
                [passkeyId, userId]
            )).rows[0];
            if (!credential) throw new AppError('The passkey was not found.', { status: 404, code: 'PASSKEY_NOT_FOUND' });
            const count = Number((await client.query('SELECT count(*)::int AS count FROM passkey WHERE "userId"=$1', [userId])).rows[0]?.count || 0);
            if (credentialRequired && count <= Math.max(1, Number(minimumCredentialCount) || 1)) {
                throw new AppError('Add a replacement passkey before removing the final required credential.', { status: 409, code: 'ADMIN_FINAL_PASSKEY_REQUIRED' });
            }
            await client.query('DELETE FROM passkey WHERE id=$1 AND "userId"=$2', [passkeyId, userId]);
            await insertAuditRecord(client, {
                actorId,
                action: 'security.webauthn_removed',
                entityType: 'admin_account',
                entityId: userId,
                requestId,
                metadata: { credentialId: credential.id, name: credential.name || null }
            });
            await client.query('COMMIT');
            return credential;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }
    async listAdminAccounts() {
        const { rows } = await this.pool.query(
            `SELECT a.user_id AS "userId",a.email,a.role,a.active,a.security_version AS "securityVersion",
                    a.created_at AS "createdAt",a.updated_at AS "updatedAt",a.last_access_at AS "lastAccessAt",
                    count(DISTINCT p.id)::int AS "webAuthnCredentialCount",
                    count(DISTINCT rc.id) FILTER (WHERE rc.used_at IS NULL)::int AS "recoveryCodesRemaining"
             FROM wpa_admin_accounts a
             LEFT JOIN passkey p ON p."userId"=a.user_id
             LEFT JOIN wpa_admin_recovery_codes rc ON rc.user_id=a.user_id
             GROUP BY a.user_id,a.email,a.role,a.active,a.security_version,a.created_at,a.updated_at,a.last_access_at
             ORDER BY a.active DESC,a.role,a.email`
        );
        return rows.map((row) => ({ ...row, role: canonicalAdminRole(row.role), securityVersion: Number(row.securityVersion || 1) }));
    }
    async changeAdminAccount({ actorId, targetUserId, role, active, reason, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('wpa:privileged-role-management'))`);
            const locked = await client.query('SELECT user_id AS "userId",email,role,active,security_version AS "securityVersion",created_at AS "createdAt",updated_at AS "updatedAt",last_access_at AS "lastAccessAt" FROM wpa_admin_accounts ORDER BY user_id FOR UPDATE');
            const actor = locked.rows.find((item) => item.userId === actorId);
            const nextRole = canonicalAdminRole(role);
            if (!actor?.active || !nextRole || !canManagePrivilegedRole(actor.role, nextRole)) throw new AppError('This administrator cannot assign the requested role.', { status: 403, code: 'ADMIN_ROLE_ASSIGNMENT_FORBIDDEN' });
            const before = locked.rows.find((item) => item.userId === targetUserId) || null;
            const superAdmins = locked.rows.filter((item) => item.active && canonicalAdminRole(item.role) === 'super_admin');
            if (before?.active && canonicalAdminRole(before.role) === 'super_admin' && (!active || nextRole !== 'super_admin') && superAdmins.length <= 1) {
                throw new AppError('The final active super administrator cannot be removed or downgraded.', { status: 409, code: 'LAST_SUPER_ADMIN_REQUIRED' });
            }
            const targetUser = (await client.query('SELECT id,email FROM "user" WHERE id=$1 FOR UPDATE', [targetUserId])).rows[0];
            if (!targetUser) throw new AppError('The target user was not found.', { status: 404, code: 'USER_NOT_FOUND' });
            const { rows } = await client.query(
                `INSERT INTO wpa_admin_accounts(user_id,email,role,active,security_version)
                 VALUES($1,$2,$3,$4,1)
                 ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,role=EXCLUDED.role,active=EXCLUDED.active,
                    security_version=wpa_admin_accounts.security_version+1,updated_at=now()
                 RETURNING user_id AS "userId",email,role,active,security_version AS "securityVersion",created_at AS "createdAt",updated_at AS "updatedAt",last_access_at AS "lastAccessAt"`,
                [targetUserId, String(targetUser.email).toLowerCase(), nextRole, Boolean(active)]
            );
            const after = { ...rows[0], securityVersion: Number(rows[0].securityVersion || 1) };
            await client.query('DELETE FROM session WHERE "userId"=$1', [targetUserId]);
            await client.query('DELETE FROM wpa_admin_reauth_markers WHERE user_id=$1', [targetUserId]);
            await client.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [targetUserId]);
            const action = before?.active && !after.active ? 'security.role_revoked' : before ? 'security.role_changed' : 'security.role_granted';
            await insertAuditRecord(client, {
                actorId,
                action,
                entityType: 'admin_account',
                entityId: targetUserId,
                reason,
                requestId,
                before,
                after,
                metadata: { targetEmail: after.email, previousRole: before?.role || null, role: after.role, active: after.active, sessionsRevoked: true }
            });
            await client.query('COMMIT');
            return after;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (error?.code === '23514' && String(error.message).includes('LAST_SUPER_ADMIN_REQUIRED')) throw new AppError('The final active super administrator cannot be removed or downgraded.', { status: 409, code: 'LAST_SUPER_ADMIN_REQUIRED' });
            throw error;
        } finally { client.release(); }
    }
    async exportWorkspace(workspaceId) {
        const [workspace, projects, scans, reports, sourceInputs, deletion] = await Promise.all([
            this.getWorkspace(workspaceId),
            this.pool.query('SELECT id,name,origin,locale,verified_at AS "verifiedAt",verification_method AS "verificationMethod",created_at AS "createdAt" FROM wpa_projects WHERE workspace_id=$1 ORDER BY created_at', [workspaceId]),
            this.pool.query('SELECT id,project_id AS "projectId",status,failure_code AS "failureCode",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt" FROM wpa_scans WHERE workspace_id=$1 ORDER BY created_at', [workspaceId]),
            this.pool.query('SELECT id,scan_id AS "scanId",version,status,locale,payload,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 ORDER BY created_at,version', [workspaceId]),
            this.pool.query('SELECT id,project_id AS "projectId",kind,status,result,failure_code AS "failureCode",purge_at AS "purgeAt",completed_at AS "completedAt",created_at AS "createdAt" FROM wpa_source_inputs WHERE workspace_id=$1 ORDER BY created_at', [workspaceId]),
            this.pool.query('SELECT id,status,requested_by AS "requestedBy",requested_at AS "requestedAt",completed_at AS "completedAt" FROM wpa_workspace_deletion_requests WHERE workspace_id=$1', [workspaceId])
        ]);
        return { exportedAt: new Date().toISOString(), workspace, projects: projects.rows, scans: scans.rows, reports: reports.rows, sourceInputs: sourceInputs.rows, deletion: deletion.rows[0] || null };
    }
    async requestWorkspaceDeletion(workspaceId, actorId) {
        const requestId = id('deletion');
        const { rows } = await this.pool.query(`INSERT INTO wpa_workspace_deletion_requests(id,workspace_id,requested_by,status,grace_until,confirmed_at) VALUES($1,$2,$3,'requested',now()+interval '7 days',now()) ON CONFLICT(workspace_id) DO UPDATE SET requested_by=EXCLUDED.requested_by,status='requested',requested_at=now(),grace_until=now()+interval '7 days',confirmed_at=now(),authorized_by=NULL,authorized_at=NULL RETURNING id,workspace_id AS "workspaceId",requested_by AS "requestedBy",status,requested_at AS "requestedAt",grace_until AS "graceUntil",confirmed_at AS "confirmedAt",authorized_by AS "authorizedBy",authorized_at AS "authorizedAt",execution_started_at AS "executionStartedAt",completed_at AS "completedAt",failure_code AS "failureCode"`, [requestId, workspaceId, actorId]);
        await this.logAudit({ workspaceId, actorId, action: 'workspace.deletion_requested', entityType: 'workspace', entityId: workspaceId, metadata: { status: rows[0].status } });
        return rows[0];
    }
    async authorizeWorkspaceDeletion(workspaceId, actorId, context = {}) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query(`SELECT id,workspace_id AS "workspaceId",requested_by AS "requestedBy",status,requested_at AS "requestedAt",grace_until AS "graceUntil",confirmed_at AS "confirmedAt",authorized_by AS "authorizedBy",authorized_at AS "authorizedAt",execution_started_at AS "executionStartedAt",completed_at AS "completedAt",failure_code AS "failureCode" FROM wpa_workspace_deletion_requests WHERE workspace_id=$1 AND status='requested' FOR UPDATE`, [workspaceId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            const { rows } = await client.query(`UPDATE wpa_workspace_deletion_requests SET authorized_by=$2,authorized_at=now() WHERE workspace_id=$1 RETURNING id,workspace_id AS "workspaceId",requested_by AS "requestedBy",status,requested_at AS "requestedAt",grace_until AS "graceUntil",confirmed_at AS "confirmedAt",authorized_by AS "authorizedBy",authorized_at AS "authorizedAt",execution_started_at AS "executionStartedAt",completed_at AS "completedAt",failure_code AS "failureCode"`, [workspaceId, actorId]);
            await insertAuditRecord(client, { workspaceId, actorId, action: 'workspace.deletion_authorized', entityType: 'workspace', entityId: rows[0].id, reason: context.reason || null, requestId: context.requestId || null, before, after: rows[0], metadata: { graceUntil: rows[0].graceUntil } });
            await client.query('COMMIT');
            return rows[0];
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }
    async executeWorkspaceDeletion(workspaceId, { now = new Date(), dryRun = true, actorId = null, artifactCleanup = null, leaseMs = 15 * 60_000, reason = null, requestId = null } = {}) {
        const client = await this.pool.connect();
        let deletedCount = 0;
        let runId = null;
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`SELECT id,status,grace_until AS "graceUntil",confirmed_at AS "confirmedAt",authorized_by AS "authorizedBy" FROM wpa_workspace_deletion_requests WHERE workspace_id=$1 FOR UPDATE`, [workspaceId]);
            const request = rows[0];
            const prior = request ? (await client.query(`SELECT id,status,deleted_reports AS "deletedReports",deleted_source_inputs AS "deletedSourceInputs",deleted_executions AS "deletedExecutions",started_at AS "startedAt" FROM wpa_workspace_deletion_runs WHERE request_id=$1 FOR UPDATE`, [request.id])).rows[0] : null;
            const timestamp = new Date(now).getTime();
            if (!request || !['requested', 'processing'].includes(request.status) || !request.confirmedAt || !request.authorizedBy || new Date(request.graceUntil).getTime() > timestamp) { await client.query('COMMIT'); return { status: 'not_due', deletedCount: 0 }; }
            if (prior?.status === 'completed') { await client.query('COMMIT'); return { status: 'completed', deletedCount: prior.deletedReports, deletedReports: prior.deletedReports, deletedSourceInputs: prior.deletedSourceInputs, deletedExecutions: prior.deletedExecutions, runId: prior.id, idempotent: true, dryRun: false }; }
            if (request.status === 'processing' && prior?.status === 'running' && new Date(prior.startedAt || 0).getTime() > timestamp - Math.max(60_000, Number(leaseMs) || 15 * 60_000)) { await client.query('COMMIT'); return { status: 'running', runId: prior.id, dryRun: false }; }
            const count = await client.query('SELECT count(*)::int AS count FROM wpa_reports WHERE workspace_id=$1', [workspaceId]);
            deletedCount = count.rows[0]?.count || 0;
            const sourceCount = await client.query('SELECT count(*)::int AS count FROM wpa_source_inputs WHERE workspace_id=$1', [workspaceId]);
            const executionCount = await client.query('SELECT count(*)::int AS count FROM wpa_worker_execution_results WHERE workspace_id=$1', [workspaceId]);
            if (dryRun) { await client.query('COMMIT'); return { status: 'ready', deletedCount, deletedReports: deletedCount, deletedSourceInputs: sourceCount.rows[0]?.count || 0, deletedExecutions: executionCount.rows[0]?.count || 0, dryRun: true }; }
            runId = prior?.id || id('deletion_run');
            if (prior?.status === 'running' && request.status !== 'processing') { await client.query('COMMIT'); return { status: 'running', runId, dryRun: false }; }
            await client.query(
                `INSERT INTO wpa_workspace_deletion_runs(id,request_id,workspace_id,status,attempts,actor_id)
                 VALUES($1,$2,$3,'running',1,$4)
                 ON CONFLICT(request_id) DO UPDATE SET status='running',attempts=wpa_workspace_deletion_runs.attempts+1,actor_id=COALESCE(EXCLUDED.actor_id,wpa_workspace_deletion_runs.actor_id),failure_code=NULL,started_at=now(),completed_at=NULL`,
                [runId, request.id, workspaceId, actorId]
            );
            await client.query(`UPDATE wpa_workspace_deletion_requests SET status='processing',execution_started_at=now(),failure_code=NULL WHERE workspace_id=$1 AND status='requested'`, [workspaceId]);
            const artifactRows = await client.query(`SELECT encrypted_reference AS path FROM wpa_source_inputs WHERE workspace_id=$1 AND encrypted_reference IS NOT NULL UNION ALL SELECT artifact_path AS path FROM wpa_worker_execution_results WHERE workspace_id=$1 AND artifact_path IS NOT NULL`, [workspaceId]);
            const artifactPaths = [...new Set(artifactRows.rows.map((row) => row.path).filter(Boolean))];
            if (artifactPaths.length && typeof artifactCleanup !== 'function') throw new AppError('Retention requires an artifact cleanup callback.', { status: 503, code: 'RETENTION_ARTIFACT_CLEANUP_REQUIRED' });
            for (const artifactPath of artifactPaths) await artifactCleanup?.(artifactPath);
            await client.query(`UPDATE wpa_workspace_deletion_runs SET status='completed',deleted_reports=$2,deleted_source_inputs=$3,deleted_executions=$4,completed_at=now() WHERE id=$1`, [runId, deletedCount, sourceCount.rows[0]?.count || 0, executionCount.rows[0]?.count || 0]);
            await client.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]);
            await insertAuditRecord(client, { workspaceId: null, actorId, action: 'workspace.deletion_completed', entityType: 'workspace', entityId: workspaceId, reason, requestId, before: { status: 'authorized' }, after: { status: 'completed' }, metadata: { deletedReports: deletedCount, deletedSourceInputs: sourceCount.rows[0]?.count || 0, deletedExecutions: executionCount.rows[0]?.count || 0, runId } });
            await client.query('COMMIT');
            return { status: 'completed', deletedCount, deletedReports: deletedCount, deletedSourceInputs: sourceCount.rows[0]?.count || 0, deletedExecutions: executionCount.rows[0]?.count || 0, runId, dryRun: false };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            const errorCode = error.code || 'WORKSPACE_DELETION_FAILED';
            await this.pool.query(`UPDATE wpa_workspace_deletion_requests SET status='requested',failure_code=$2 WHERE workspace_id=$1 AND status='processing'`, [workspaceId, errorCode]).catch(() => {});
            if (runId) await this.pool.query(`UPDATE wpa_workspace_deletion_runs SET status='failed',failure_code=$2,completed_at=now() WHERE id=$1`, [runId, errorCode]).catch(() => {});
            await this.logAudit({ workspaceId, actorId, action: 'workspace.deletion_failed', entityType: 'workspace', entityId: workspaceId, metadata: { errorCode } }).catch(() => {});
            throw error;
        } finally { client.release(); }
    }
    async executeRetentionSweep(workspaceId, { now = new Date(), dryRun = true, actorId = null, artifactCleanup = null } = {}) {
        const client = await this.pool.connect();
        let lockAcquired = false;
        try {
            lockAcquired = Boolean((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`retention:${workspaceId}`])).rows[0]?.locked);
            if (!lockAcquired) return { workspaceId, status: 'active', skipped: true, reason: 'RETENTION_SWEEP_ACTIVE' };
            const { rows: workspaceRows } = await client.query(`SELECT w.id,COALESCE(p.limits->>'retentionDays','30')::int AS "retentionDays" FROM wpa_workspaces w LEFT JOIN wpa_plan_catalog p ON p.id=w.plan_id WHERE w.id=$1`, [workspaceId]);
            const retentionDays = Math.max(1, Number(workspaceRows[0]?.retentionDays || 30));
            const cutoff = new Date(new Date(now).getTime() - retentionDays * 86_400_000);
            const reportRows = await client.query('SELECT id FROM wpa_reports WHERE workspace_id=$1 AND created_at<$2', [workspaceId, cutoff.toISOString()]);
            const sourceRows = await client.query(`SELECT id,encrypted_reference AS "artifactPath" FROM wpa_source_inputs WHERE workspace_id=$1 AND status IN ('completed','failed','unavailable') AND purge_at <= $2 AND created_at<$3`, [workspaceId, new Date(now).toISOString(), cutoff.toISOString()]);
            const executionRows = await client.query(`SELECT id,artifact_path AS "artifactPath" FROM wpa_worker_execution_results WHERE workspace_id=$1 AND status IN ('completed','failed','unavailable') AND COALESCE(completed_at,updated_at,created_at)<$2`, [workspaceId, cutoff.toISOString()]);
            const artifactPaths = [...new Set([...sourceRows.rows, ...executionRows.rows].map((row) => row.artifactPath).filter(Boolean))];
            if (!dryRun && artifactPaths.length && typeof artifactCleanup !== 'function') throw new AppError('Retention requires an artifact cleanup callback.', { status: 503, code: 'RETENTION_ARTIFACT_CLEANUP_REQUIRED' });
            const runId = id('retention');
            await client.query(`INSERT INTO wpa_retention_runs(id,workspace_id,retention_days,cutoff_at,mode,status,actor_id,artifact_count) VALUES($1,$2,$3,$4,$5,'started',$6,$7)`, [runId, workspaceId, retentionDays, cutoff.toISOString(), dryRun ? 'dry_run' : 'execute', actorId, artifactPaths.length]);
            let deletedCount = 0; let deletedSourceInputs = 0; let deletedExecutions = 0;
            try {
                if (!dryRun) {
                    for (const artifactPath of artifactPaths) await artifactCleanup(artifactPath);
                    const deleted = await client.query('DELETE FROM wpa_reports WHERE id=ANY($1::text[])', [reportRows.rows.map((row) => row.id)]); deletedCount = deleted.rowCount;
                    const deletedSources = await client.query('DELETE FROM wpa_source_inputs WHERE id=ANY($1::text[])', [sourceRows.rows.map((row) => row.id)]); deletedSourceInputs = deletedSources.rowCount;
                    const deletedResults = await client.query('DELETE FROM wpa_worker_execution_results WHERE id=ANY($1::text[])', [executionRows.rows.map((row) => row.id)]); deletedExecutions = deletedResults.rowCount;
                }
                await client.query(`UPDATE wpa_retention_runs SET status='completed',deleted_count=$2,deleted_source_inputs=$3,deleted_executions=$4,completed_at=now() WHERE id=$1`, [runId, deletedCount, deletedSourceInputs, deletedExecutions]);
            } catch (error) {
                const errorCode = error.code || 'RETENTION_SWEEP_FAILED';
                await client.query(`UPDATE wpa_retention_runs SET status='failed',error_code=$2,completed_at=now() WHERE id=$1`, [runId, errorCode]).catch(() => {});
                await insertAuditRecord(client, { workspaceId, actorId, action: 'retention.failed', entityType: 'retention_run', entityId: runId, metadata: { errorCode } }).catch(() => {});
                throw error;
            }
            await insertAuditRecord(client, { workspaceId, actorId, action: dryRun ? 'retention.dry_run' : 'retention.executed', entityType: 'retention_run', entityId: runId, metadata: { retentionDays, cutoffAt: cutoff.toISOString(), candidateCount: reportRows.rows.length, sourceInputCount: sourceRows.rows.length, executionCount: executionRows.rows.length, artifactCount: artifactPaths.length, deletedCount } });
            return { id: runId, workspaceId, retentionDays, cutoffAt: cutoff.toISOString(), mode: dryRun ? 'dry_run' : 'execute', status: 'completed', candidateCount: reportRows.rows.length, sourceInputCount: sourceRows.rows.length, executionCount: executionRows.rows.length, artifactCount: artifactPaths.length, deletedCount, deletedSourceInputs, deletedExecutions };
        } finally {
            if (lockAcquired) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`retention:${workspaceId}`]).catch(() => {});
            client.release();
        }
    }

    async upsertAdminAccount(account) {
        const role = canonicalAdminRole(account.role);
        if (!role) throw new AppError('Unknown administrator role.', { status: 400, code: 'ADMIN_ROLE_INVALID' });
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_admin_accounts(user_id,email,role,active) VALUES($1,$2,$3,$4)
             ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,role=EXCLUDED.role,active=EXCLUDED.active,updated_at=now()
             RETURNING user_id AS "userId",email,role,active,security_version AS "securityVersion",last_access_at AS "lastAccessAt"`,
            [account.userId, account.email, role, account.active]
        );
        return rows[0] ? { ...rows[0], securityVersion: Number(rows[0].securityVersion || 1) } : null;
    }

    async touchAdminAccount(userId) {
        const { rows } = await this.pool.query('UPDATE wpa_admin_accounts SET last_access_at=now() WHERE user_id=$1 RETURNING user_id AS "userId",email,role,active,security_version AS "securityVersion",last_access_at AS "lastAccessAt"', [userId]);
        return rows[0] || null;
    }

    async recordAdminReauthentication({ sessionId, userId, verifiedAt, expiresAt, method = 'password_totp', securityVersion = 1 }) {
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_admin_reauth_markers(session_id_hash,user_id,verified_at,expires_at,method,security_version)
             VALUES($1,$2,$3::timestamptz,$4::timestamptz,$5,$6)
             ON CONFLICT(session_id_hash,user_id) DO UPDATE SET verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,method=EXCLUDED.method,security_version=EXCLUDED.security_version
             RETURNING session_id_hash AS "sessionId",user_id AS "userId",verified_at AS "verifiedAt",expires_at AS "expiresAt",method,security_version AS "securityVersion"`,
            [sessionId, userId, verifiedAt, expiresAt, method, Number(securityVersion)]
        );
        return rows[0] ? { ...rows[0], securityVersion: Number(rows[0].securityVersion || 1) } : null;
    }

    async getAdminReauthentication(sessionId, userId) {
        const { rows } = await this.pool.query(
            `SELECT session_id_hash AS "sessionId",user_id AS "userId",verified_at AS "verifiedAt",expires_at AS "expiresAt",method,security_version AS "securityVersion"
             FROM wpa_admin_reauth_markers WHERE session_id_hash=$1 AND user_id=$2 AND expires_at > now()`,
            [sessionId, userId]
        );
        return rows[0] ? { ...rows[0], securityVersion: Number(rows[0].securityVersion || 1) } : null;
    }

    async recordWebAuthnAssertion({ credentialId, ipHash, userAgentHash, expiresAt }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const credential = (await client.query('SELECT id,"userId" AS "userId" FROM passkey WHERE "credentialID"=$1 FOR UPDATE', [credentialId])).rows[0];
            if (!credential) throw new AppError('The verified WebAuthn credential is not registered.', { status: 403, code: 'PASSKEY_NOT_FOUND' });
            await client.query('UPDATE passkey SET "lastUsedAt"=now() WHERE id=$1', [credential.id]);
            const assertionId = id('assertion');
            const { rows } = await client.query(
                `INSERT INTO wpa_admin_webauthn_assertions(id,user_id,credential_id,ip_hash,user_agent_hash,expires_at)
                 VALUES($1,$2,$3,$4,$5,$6::timestamptz)
                 RETURNING id,user_id AS "userId",credential_id AS "credentialId",verified_at AS "verifiedAt",expires_at AS "expiresAt"`,
                [assertionId, credential.userId, credentialId, ipHash, userAgentHash, expiresAt]
            );
            await client.query('COMMIT');
            return rows[0];
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async bindWebAuthnAssertionToSession({ userId, sessionId, ipHash, userAgentHash }) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_admin_webauthn_assertions SET session_id_hash=$4
             WHERE id=(
                 SELECT id FROM wpa_admin_webauthn_assertions
                 WHERE user_id=$1 AND ip_hash=$2 AND user_agent_hash=$3
                   AND session_id_hash IS NULL AND consumed_at IS NULL AND expires_at > now()
                 ORDER BY verified_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
             )
             RETURNING id,user_id AS "userId",credential_id AS "credentialId",session_id_hash AS "sessionId",verified_at AS "verifiedAt",expires_at AS "expiresAt"`,
            [userId, ipHash, userAgentHash, sessionId]
        );
        return rows[0] || null;
    }

    async confirmWebAuthnStepUp({ userId, sessionId, securityVersion, expiresAt, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const account = (await client.query('SELECT security_version AS "securityVersion" FROM wpa_admin_accounts WHERE user_id=$1 AND active=true FOR UPDATE', [userId])).rows[0];
            if (!account || Number(account.securityVersion) !== Number(securityVersion)) throw new AppError('The administrator security state changed. Sign in again.', { status: 403, code: 'ADMIN_SECURITY_STATE_STALE' });
            const assertion = (await client.query(
                `SELECT id,credential_id AS "credentialId",verified_at AS "verifiedAt"
                 FROM wpa_admin_webauthn_assertions
                 WHERE user_id=$1 AND session_id_hash=$2 AND consumed_at IS NULL AND expires_at > now()
                 FOR UPDATE`,
                [userId, sessionId]
            )).rows[0];
            if (!assertion) throw new AppError('No fresh WebAuthn assertion is bound to this session.', { status: 403, code: 'ADMIN_WEBAUTHN_ASSERTION_REQUIRED' });
            await client.query('UPDATE wpa_admin_webauthn_assertions SET consumed_at=now() WHERE id=$1', [assertion.id]);
            const { rows } = await client.query(
                `INSERT INTO wpa_admin_reauth_markers(session_id_hash,user_id,verified_at,expires_at,method,security_version)
                 VALUES($1,$2,$3,$4,'webauthn',$5)
                 ON CONFLICT(session_id_hash,user_id) DO UPDATE SET verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,method='webauthn',security_version=EXCLUDED.security_version
                 RETURNING session_id_hash AS "sessionId",user_id AS "userId",verified_at AS "verifiedAt",expires_at AS "expiresAt",method,security_version AS "securityVersion"`,
                [sessionId, userId, assertion.verifiedAt, expiresAt, Number(securityVersion)]
            );
            await insertAuditRecord(client, { actorId: userId, action: 'security.step_up_succeeded', entityType: 'admin_session', entityId: sessionId, requestId, metadata: { method: 'webauthn', credentialId: assertion.credentialId } });
            await client.query('COMMIT');
            return { ...rows[0], securityVersion: Number(rows[0].securityVersion) };
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async replaceAdminRecoveryCodes({ userId, batchId, codes, actorId, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT user_id FROM wpa_admin_accounts WHERE user_id=$1 AND active=true FOR UPDATE', [userId]);
            await client.query('DELETE FROM wpa_admin_recovery_codes WHERE user_id=$1', [userId]);
            for (const code of codes) {
                await client.query('INSERT INTO wpa_admin_recovery_codes(id,user_id,batch_id,code_hash) VALUES($1,$2,$3,$4)', [code.id, userId, batchId, code.codeHash]);
            }
            await insertAuditRecord(client, { actorId, action: 'security.recovery_generated', entityType: 'admin_account', entityId: userId, requestId, metadata: { batchId, count: codes.length } });
            await client.query('COMMIT');
            return { batchId, count: codes.length };
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async useAdminRecoveryCode({ userId, codeHash, sessionBinding: boundSession, sessionId, expiresAt, actorId, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const code = (await client.query('SELECT id,batch_id AS "batchId" FROM wpa_admin_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL FOR UPDATE', [userId, codeHash])).rows[0];
            if (!code) throw new AppError('The recovery code is invalid or has already been used.', { status: 403, code: 'ADMIN_RECOVERY_CODE_INVALID' });
            await client.query('UPDATE wpa_admin_recovery_codes SET used_at=now() WHERE id=$1', [code.id]);
            const revoked = await client.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [userId, sessionId]);
            await client.query('DELETE FROM wpa_admin_reauth_markers WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [userId]);
            await client.query('UPDATE wpa_admin_accounts SET security_version=security_version+1,updated_at=now() WHERE user_id=$1 AND active=true', [userId]);
            const { rows } = await client.query(
                `INSERT INTO wpa_admin_recovery_sessions(session_id_hash,user_id,expires_at)
                 VALUES($1,$2,$3::timestamptz)
                 RETURNING session_id_hash AS "sessionId",user_id AS "userId",created_at AS "createdAt",expires_at AS "expiresAt"`,
                [boundSession, userId, expiresAt]
            );
            await insertAuditRecord(client, { actorId, action: 'security.recovery_used', entityType: 'admin_account', entityId: userId, requestId, metadata: { batchId: code.batchId, sessionsRevoked: revoked.rowCount } });
            await client.query('COMMIT');
            return rows[0];
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async hasAdminRecoverySession(sessionId, userId) {
        const { rows } = await this.pool.query('SELECT 1 FROM wpa_admin_recovery_sessions WHERE session_id_hash=$1 AND user_id=$2 AND expires_at > now()', [sessionId, userId]);
        return Boolean(rows[0]);
    }

    async invalidateAdminRecoverySessions(userId) {
        await this.pool.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [userId]);
    }
    async recordAdminPasswordChange({ userId, actorId, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const account = (await client.query(
                'UPDATE wpa_admin_accounts SET security_version=security_version+1,updated_at=now() WHERE user_id=$1 AND active=true RETURNING security_version AS "securityVersion"',
                [userId]
            )).rows[0];
            if (!account) {
                await client.query('ROLLBACK');
                return null;
            }
            await client.query('DELETE FROM wpa_admin_reauth_markers WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [userId]);
            await insertAuditRecord(client, {
                actorId,
                action: 'security.password_changed',
                entityType: 'admin_account',
                entityId: userId,
                requestId,
                metadata: { sessionsRevoked: true }
            });
            await client.query('COMMIT');
            return { userId, securityVersion: Number(account.securityVersion) };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async resetAdminMfa({ actorId, targetUserId, reason, requestId }) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('wpa:privileged-role-management'))`);
            const locked = await client.query('SELECT user_id AS "userId",role,active FROM wpa_admin_accounts ORDER BY user_id FOR UPDATE');
            const actor = locked.rows.find((row) => row.userId === actorId);
            const target = locked.rows.find((row) => row.userId === targetUserId);
            if (!actor?.active || canonicalAdminRole(actor.role) !== 'super_admin' || !target?.active) throw new AppError('This MFA reset is not authorized.', { status: 403, code: 'ADMIN_MFA_RESET_FORBIDDEN' });
            const activeSupers = locked.rows.filter((row) => row.active && canonicalAdminRole(row.role) === 'super_admin');
            if (canonicalAdminRole(target.role) === 'super_admin' && activeSupers.length <= 1) throw new AppError('The final active super administrator MFA cannot be reset through the normal control plane.', { status: 409, code: 'LAST_SUPER_ADMIN_REQUIRED' });
            const passkeys = await client.query('DELETE FROM passkey WHERE "userId"=$1', [targetUserId]);
            await client.query('DELETE FROM "twoFactor" WHERE "userId"=$1', [targetUserId]);
            await client.query('UPDATE "user" SET "twoFactorEnabled"=false,"updatedAt"=now() WHERE id=$1', [targetUserId]);
            const sessions = await client.query('DELETE FROM session WHERE "userId"=$1', [targetUserId]);
            await client.query('DELETE FROM wpa_admin_reauth_markers WHERE user_id=$1', [targetUserId]);
            await client.query('DELETE FROM wpa_admin_recovery_sessions WHERE user_id=$1', [targetUserId]);
            await client.query('DELETE FROM wpa_admin_recovery_codes WHERE user_id=$1', [targetUserId]);
            await client.query('UPDATE wpa_admin_accounts SET security_version=security_version+1,updated_at=now() WHERE user_id=$1', [targetUserId]);
            await insertAuditRecord(client, { actorId, action: 'security.mfa_reset', entityType: 'admin_account', entityId: targetUserId, reason, requestId, metadata: { passkeysRemoved: passkeys.rowCount, sessionsRevoked: sessions.rowCount } });
            await client.query('COMMIT');
            return { userId: targetUserId, passkeysRemoved: passkeys.rowCount, sessionsRevoked: sessions.rowCount };
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    async logAudit(entry) {
        // The worker is append-only for audit evidence. Avoid INSERT ...
        // RETURNING so PostgreSQL does not require table-wide SELECT.
        return insertAuditRecord(this.pool, entry, { returning: this.executionRole !== 'worker' });
    }

    async listPlans() {
        const { rows } = await this.pool.query('SELECT id,name,price_usd AS "priceUsd",description,limits,features,entitlements,sales_mode AS "salesMode" FROM wpa_plan_catalog WHERE published=true ORDER BY price_usd');
        return rows;
    }

    async getPlan(planId) {
        const { rows } = await this.pool.query('SELECT id,name,price_usd AS "priceUsd",description,limits,features,entitlements,sales_mode AS "salesMode" FROM wpa_plan_catalog WHERE id=$1', [planId]);
        return rows[0] || null;
    }

    async setPlanEntitlement(planId, moduleId, entitlement) {
        assertGrantableEntitlementModule(moduleId);
        const plan = await this.getPlan(planId);
        if (!plan) return null;
        const entitlements = { ...plan.entitlements, [moduleId]: entitlement };
        const { rows } = await this.pool.query('UPDATE wpa_plan_catalog SET entitlements=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id,name,price_usd AS "priceUsd",description,limits,features,entitlements', [planId, JSON.stringify(entitlements)]);
        return rows[0] || null;
    }

    async applySubscriptionEvent(workspaceId, subscription, event) {
        const userId = subscription.userId || event.userId || (await this.pool.query('SELECT entitlement_owner_user_id AS "userId" FROM wpa_workspaces WHERE id=$1', [workspaceId])).rows[0]?.userId || null;
        if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_subscriptions (workspace_id,user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,current_period_end,last_event_id,last_event_created)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,stripe_customer_id=EXCLUDED.stripe_customer_id,
               stripe_subscription_id=EXCLUDED.stripe_subscription_id,stripe_price_id=EXCLUDED.stripe_price_id,
               status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,last_event_id=EXCLUDED.last_event_id,
               last_event_created=EXCLUDED.last_event_created,updated_at=now()
             WHERE wpa_subscriptions.last_event_created < EXCLUDED.last_event_created
                OR (wpa_subscriptions.last_event_created = EXCLUDED.last_event_created AND COALESCE(wpa_subscriptions.last_event_id, '') < COALESCE(EXCLUDED.last_event_id, ''))
             RETURNING workspace_id AS "workspaceId",user_id AS "userId",status,last_event_id AS "lastEventId",last_event_created AS "lastEventCreated"`,
            [workspaceId, userId, subscription.stripeCustomerId, subscription.stripeSubscriptionId, subscription.stripePriceId, subscription.status, subscription.currentPeriodEnd, event.id, event.created]
        );
        return { applied: Boolean(rows[0]), subscription: rows[0] || null };
    }
    async recordBillingEvent(workspaceId, event) {
        const userId = event.userId || (await this.pool.query('SELECT entitlement_owner_user_id AS "userId" FROM wpa_workspaces WHERE id=$1', [workspaceId])).rows[0]?.userId || null;
        if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
        const { rows } = await this.pool.query(`INSERT INTO wpa_billing_events(event_id,workspace_id,user_id,event_type,event_created,status,payload) VALUES($1,$2,$3,$4,$5,'received',$6::jsonb) ON CONFLICT(event_id) DO NOTHING RETURNING event_id AS "eventId",workspace_id AS "workspaceId",user_id AS "userId",event_type AS type,event_created AS created,status,received_at AS "receivedAt"`, [event.id, workspaceId, userId, event.type, event.created, JSON.stringify(event)]);
        if (rows[0]) return { accepted: true, event: rows[0] };
        const existing = (await this.pool.query('SELECT event_id AS "eventId",workspace_id AS "workspaceId",user_id AS "userId",event_type AS type,event_created AS created,status,received_at AS "receivedAt" FROM wpa_billing_events WHERE event_id=$1', [event.id])).rows[0];
        return { accepted: !['applied', 'ignored'].includes(existing?.status), event: existing };
    }
    async markBillingEvent(eventId, status) { const { rows } = await this.pool.query('UPDATE wpa_billing_events SET status=$2,processed_at=now() WHERE event_id=$1 RETURNING event_id AS "eventId",status,processed_at AS "processedAt"', [eventId, status]); return rows[0] || null; }
    async getSubscription(input) {
        const identity = input && typeof input === 'object' ? input : { workspaceId: input };
        const values = identity.userId ? [identity.userId] : [identity.workspaceId];
        const where = identity.userId ? 'user_id=$1' : 'workspace_id=$1';
        const { rows } = await this.pool.query(`SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",external_product_id AS "providerProductId",external_price_id AS "providerPriceId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",cancel_at AS "cancelAt",scheduled_change AS "scheduledChange",provider_payload AS "providerPayload",last_event_id AS "lastEventId",last_event_occurred_at AS "lastEventOccurredAt",stripe_customer_id AS "stripeCustomerId",stripe_subscription_id AS "stripeSubscriptionId",stripe_price_id AS "stripePriceId" FROM wpa_subscriptions WHERE ${where}`, values);
        return rows[0] || null;
    }
    async getBillingSubscription(input, provider = null) {
        const identity = input && typeof input === 'object' ? input : { workspaceId: input };
        const subject = identity.userId || identity.workspaceId;
        const column = identity.userId ? 'user_id' : 'workspace_id';
        const values = provider ? [subject, provider] : [subject];
        const { rows } = await this.pool.query(`SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",external_product_id AS "providerProductId",external_price_id AS "providerPriceId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",cancel_at AS "cancelAt",scheduled_change AS "scheduledChange",provider_payload AS "providerPayload",last_event_id AS "lastEventId",last_event_occurred_at AS "lastEventOccurredAt",stripe_customer_id AS "stripeCustomerId",stripe_subscription_id AS "stripeSubscriptionId",stripe_price_id AS "stripePriceId" FROM wpa_subscriptions WHERE ${column}=$1${provider ? ' AND provider=$2' : ''}`, values);
        return rows[0] || null;
    }
    async applyBillingProviderEvent(input) {
        const provider = String(input.provider || '').toLowerCase();
        const occurredAt = input.occurredAt || (Number.isFinite(Number(input.occurredAtMs)) ? new Date(Number(input.occurredAtMs)).toISOString() : null);
        if (!provider || !input.eventId || !occurredAt) throw new AppError('Billing event identity is incomplete.', { status: 400, code: 'BILLING_EVENT_INVALID' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            let workspaceId = input.workspaceId || null;
            let userId = input.userId || null;
            const providerSubscriptionId = input.subscription?.providerSubscriptionId || input.payment?.providerSubscriptionId || null;
            if ((!workspaceId || !userId) && providerSubscriptionId) {
                const linked = (await client.query('SELECT workspace_id AS "workspaceId",user_id AS "userId" FROM wpa_subscriptions WHERE provider=$1 AND external_subscription_id=$2', [provider, providerSubscriptionId])).rows[0];
                workspaceId ||= linked?.workspaceId || null;
                userId ||= linked?.userId || null;
            }
            if ((!workspaceId || !userId) && input.refund?.providerTransactionId) {
                const linked = (await client.query("SELECT workspace_id AS \"workspaceId\",user_id AS \"userId\" FROM wpa_subscriptions WHERE provider=$1 AND provider_payload->'payment'->>'providerTransactionId'=$2", [provider, input.refund.providerTransactionId])).rows[0];
                workspaceId ||= linked?.workspaceId || null;
                userId ||= linked?.userId || null;
            }
            if (!workspaceId && userId) workspaceId = (await client.query('SELECT workspace_id AS "workspaceId" FROM wpa_subscriptions WHERE user_id=$1', [userId])).rows[0]?.workspaceId || null;
            if (!userId && workspaceId) userId = (await client.query('SELECT entitlement_owner_user_id AS "userId" FROM wpa_workspaces WHERE id=$1', [workspaceId])).rows[0]?.userId || null;
            if (!userId) throw new AppError('Billing event is missing its user owner.', { status: 400, code: 'BILLING_USER_MISSING' });
            if (!workspaceId) throw new AppError('Billing event is missing its workspace reference.', { status: 400, code: 'BILLING_WORKSPACE_MISSING' });
            if (!(await client.query('SELECT id FROM "user" WHERE id=$1', [userId])).rows[0]) throw new AppError('Billing user was not found.', { status: 404, code: 'USER_NOT_FOUND' });
            const billingWorkspace = (await client.query("INSERT INTO wpa_workspaces(id,name,plan_id,entitlement_owner_user_id) VALUES($1,'My workspace','free',$2) ON CONFLICT(id) DO UPDATE SET entitlement_owner_user_id=COALESCE(wpa_workspaces.entitlement_owner_user_id,EXCLUDED.entitlement_owner_user_id) RETURNING entitlement_owner_user_id AS \"entitlementOwnerUserId\"", [workspaceId, userId])).rows[0];
            if (billingWorkspace?.entitlementOwnerUserId !== userId) {
                throw new AppError('Billing user does not own the referenced workspace entitlement.', { status: 409, code: 'BILLING_USER_WORKSPACE_MISMATCH' });
            }
            await client.query(`INSERT INTO wpa_user_entitlement_profiles(user_id,plan_id,plan_source,created_by,updated_by,reason) VALUES($1,'free','system','system:billing','system:billing','Default commercial profile') ON CONFLICT(user_id) DO NOTHING`, [userId]);
            const ledgerId = `${provider}:${input.eventId}`;
            const inserted = await client.query(`INSERT INTO wpa_billing_events(event_id,workspace_id,user_id,event_type,event_created,status,payload,provider,occurred_at) VALUES($1,$2,$3,$4,$5,'received',$6::jsonb,$7,$8) ON CONFLICT(event_id) DO NOTHING RETURNING event_id AS "eventId",user_id AS "userId",status`, [ledgerId, workspaceId, userId, input.eventType, Number(input.occurredAtMs || Date.parse(occurredAt)), JSON.stringify(input.rawEvent || {}), provider, occurredAt]);
            if (!inserted.rows[0]) {
                const existingEvent = (await client.query('SELECT event_id AS "eventId",workspace_id AS "workspaceId",user_id AS "userId",status FROM wpa_billing_events WHERE event_id=$1 FOR UPDATE', [ledgerId])).rows[0];
                if (['applied', 'ignored'].includes(existingEvent?.status)) {
                    const duplicateSubscription = (await client.query('SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",external_product_id AS "providerProductId",external_price_id AS "providerPriceId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",scheduled_change AS "scheduledChange",provider_payload AS "providerPayload",last_event_id AS "lastEventId",last_event_occurred_at AS "lastEventOccurredAt" FROM wpa_subscriptions WHERE user_id=$1 AND provider=$2', [existingEvent.userId, provider])).rows[0] || null;
                    await client.query('COMMIT');
                    return { applied: false, duplicate: true, event: existingEvent, subscription: duplicateSubscription };
                }
            }
            const beforeProfile = (await client.query('SELECT user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",updated_at AS "updatedAt" FROM wpa_user_entitlement_profiles WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
            const beforeSubscription = (await client.query('SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",external_product_id AS "providerProductId",external_price_id AS "providerPriceId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",scheduled_change AS "scheduledChange",provider_payload AS "providerPayload",last_event_id AS "lastEventId",last_event_occurred_at AS "lastEventOccurredAt" FROM wpa_subscriptions WHERE user_id=$1 FOR UPDATE', [userId])).rows[0] || null;
            const previousAt = beforeSubscription?.lastEventOccurredAt ? new Date(beforeSubscription.lastEventOccurredAt).getTime() : -1;
            const nextAt = new Date(occurredAt).getTime();
            const ordersSubscription = input.resourceKind === 'subscription';
            const stale = ordersSubscription && (nextAt < previousAt || (nextAt === previousAt && String(input.eventId) <= String(beforeSubscription?.lastEventId || '')));
            if (stale) {
                await client.query("UPDATE wpa_billing_events SET status='ignored',processed_at=now() WHERE event_id=$1", [ledgerId]);
                await client.query('COMMIT');
                return { applied: false, ignored: true, stale: true, subscription: beforeSubscription };
            }
            if (input.entitlement?.action === 'set_plan') {
                const nextPlanId = input.entitlement.planId || 'free';
                if (!(await client.query('SELECT 1 FROM wpa_plan_catalog WHERE id=$1', [nextPlanId])).rows[0]) throw new AppError('Billing event mapped to an unknown plan.', { status: 409, code: 'BILLING_PLAN_UNMAPPED' });
                await client.query(`INSERT INTO wpa_user_plan_changes(id,user_id,before_plan_id,after_plan_id,source,source_id,reason,created_by,request_id,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,'provider',$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,idempotency_key) DO NOTHING`, [id('user_plan_change'), userId, beforeProfile.planId, nextPlanId, input.externalObjectId || input.eventId, input.entitlement.reason || input.eventType, `${provider}:webhook`, ledgerId, ledgerId, `${userId}:${nextPlanId}:${ledgerId}`]);
                await client.query(`UPDATE wpa_user_entitlement_profiles SET plan_id=$2,plan_source='provider',source_id=$3,updated_by=$4,reason=$5,request_id=$6,updated_at=now() WHERE user_id=$1`, [userId, nextPlanId, input.externalObjectId || input.eventId, `${provider}:webhook`, input.entitlement.reason || input.eventType, ledgerId]);
            }
            const providerPayload = sanitizeAuditValue({ ...(beforeSubscription?.providerPayload || {}), ...(input.payment ? { payment: input.payment } : {}), ...(input.refund ? { refund: input.refund } : {}), lastEventType: input.eventType });
            const requestedAccess = input.entitlement?.access;
            const accessState = ['paid', 'grace', 'free'].includes(requestedAccess) ? requestedAccess : beforeSubscription?.accessState || 'free';
            await client.query(
                `INSERT INTO wpa_subscriptions(workspace_id,user_id,provider,external_customer_id,external_subscription_id,external_product_id,external_price_id,billing_plan_id,status,payment_status,refund_status,access_state,current_period_end,cancel_at,scheduled_change,provider_payload,last_event_id,last_event_created,last_event_occurred_at,stripe_customer_id,stripe_subscription_id,stripe_price_id)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22)
                 ON CONFLICT(user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,provider=EXCLUDED.provider,external_customer_id=COALESCE(EXCLUDED.external_customer_id,wpa_subscriptions.external_customer_id),external_subscription_id=COALESCE(EXCLUDED.external_subscription_id,wpa_subscriptions.external_subscription_id),external_product_id=COALESCE(EXCLUDED.external_product_id,wpa_subscriptions.external_product_id),external_price_id=COALESCE(EXCLUDED.external_price_id,wpa_subscriptions.external_price_id),billing_plan_id=COALESCE(EXCLUDED.billing_plan_id,wpa_subscriptions.billing_plan_id),status=CASE WHEN $23 THEN EXCLUDED.status ELSE wpa_subscriptions.status END,payment_status=COALESCE(EXCLUDED.payment_status,wpa_subscriptions.payment_status),refund_status=COALESCE(EXCLUDED.refund_status,wpa_subscriptions.refund_status),access_state=COALESCE(EXCLUDED.access_state,wpa_subscriptions.access_state),current_period_end=CASE WHEN $23 THEN EXCLUDED.current_period_end ELSE wpa_subscriptions.current_period_end END,cancel_at=CASE WHEN $23 THEN EXCLUDED.cancel_at ELSE wpa_subscriptions.cancel_at END,scheduled_change=CASE WHEN $23 THEN EXCLUDED.scheduled_change ELSE wpa_subscriptions.scheduled_change END,provider_payload=EXCLUDED.provider_payload,last_event_id=CASE WHEN $23 THEN EXCLUDED.last_event_id ELSE wpa_subscriptions.last_event_id END,last_event_created=CASE WHEN $23 THEN EXCLUDED.last_event_created ELSE wpa_subscriptions.last_event_created END,last_event_occurred_at=CASE WHEN $23 THEN EXCLUDED.last_event_occurred_at ELSE wpa_subscriptions.last_event_occurred_at END,stripe_customer_id=COALESCE(EXCLUDED.stripe_customer_id,wpa_subscriptions.stripe_customer_id),stripe_subscription_id=COALESCE(EXCLUDED.stripe_subscription_id,wpa_subscriptions.stripe_subscription_id),stripe_price_id=COALESCE(EXCLUDED.stripe_price_id,wpa_subscriptions.stripe_price_id),updated_at=now()`,
                [workspaceId, userId, provider, input.subscription?.providerCustomerId || input.payment?.providerCustomerId || null, input.subscription?.providerSubscriptionId || input.payment?.providerSubscriptionId || null, input.subscription?.providerProductId || null, input.subscription?.providerPriceId || null, input.entitlement?.planId || null, input.subscription?.status || beforeSubscription?.status || 'manual', input.payment?.status || null, input.refund?.status || null, accessState, input.subscription?.currentPeriodEnd || null, input.subscription?.scheduledChange?.effectiveAt || null, input.subscription ? JSON.stringify(input.subscription.scheduledChange ?? null) : null, JSON.stringify(providerPayload), ordersSubscription ? input.eventId : beforeSubscription?.lastEventId || null, ordersSubscription ? Number(input.occurredAtMs || Date.parse(occurredAt)) : (previousAt >= 0 ? previousAt : 0), ordersSubscription ? occurredAt : beforeSubscription?.lastEventOccurredAt || null, provider === 'stripe' ? input.subscription?.providerCustomerId || null : null, provider === 'stripe' ? input.subscription?.providerSubscriptionId || null : null, provider === 'stripe' ? input.subscription?.providerPriceId || null : null, ordersSubscription]
            );
            const afterProfile = (await client.query('SELECT user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",updated_at AS "updatedAt" FROM wpa_user_entitlement_profiles WHERE user_id=$1', [userId])).rows[0];
            const afterSubscription = (await client.query('SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",external_product_id AS "providerProductId",external_price_id AS "providerPriceId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",scheduled_change AS "scheduledChange",provider_payload AS "providerPayload",last_event_id AS "lastEventId",last_event_occurred_at AS "lastEventOccurredAt" FROM wpa_subscriptions WHERE user_id=$1', [userId])).rows[0];
            await insertAuditRecord(client, { workspaceId, actorId: `${provider}:webhook`, action: `${input.resourceKind || 'subscription'}.reconciled`, entityType: input.resourceKind || 'subscription', entityId: input.externalObjectId || input.eventId, reason: input.entitlement?.reason || input.eventType, before: { profile: beforeProfile, subscription: beforeSubscription }, after: { profile: afterProfile, subscription: afterSubscription }, metadata: { targetUserId: userId, provider, eventId: input.eventId, eventType: input.eventType } });
            await client.query("UPDATE wpa_billing_events SET status='applied',processed_at=now() WHERE event_id=$1", [ledgerId]);
            await client.query('COMMIT');
            return { applied: true, profile: afterProfile, subscription: afterSubscription };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async getWorkspaceSettings(workspaceId) {
        const { rows } = await this.pool.query(`INSERT INTO wpa_workspace_settings(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id RETURNING workspace_id AS "workspaceId",default_locale AS "defaultLocale",notify_scan_complete AS "notifyScanComplete",notify_high_priority AS "notifyHighPriority",weekly_digest AS "weeklyDigest",updated_at AS "updatedAt"`, [workspaceId]);
        return rows[0];
    }
    async updateWorkspaceSettings(workspaceId, input) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const workspaceResult = await client.query('UPDATE wpa_workspaces SET name=$2,updated_at=now() WHERE id=$1 RETURNING id,name,plan_id AS "planId",created_at AS "createdAt"', [workspaceId, input.workspaceName]);
            const settingsResult = await client.query(`INSERT INTO wpa_workspace_settings(workspace_id,default_locale,notify_scan_complete,notify_high_priority,weekly_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET default_locale=EXCLUDED.default_locale,notify_scan_complete=EXCLUDED.notify_scan_complete,notify_high_priority=EXCLUDED.notify_high_priority,weekly_digest=EXCLUDED.weekly_digest,updated_at=now() RETURNING workspace_id AS "workspaceId",default_locale AS "defaultLocale",notify_scan_complete AS "notifyScanComplete",notify_high_priority AS "notifyHighPriority",weekly_digest AS "weeklyDigest",updated_at AS "updatedAt"`, [workspaceId, input.defaultLocale, input.notifyScanComplete, input.notifyHighPriority, input.weeklyDigest]);
            await client.query('COMMIT');
            return { workspace: workspaceResult.rows[0], settings: settingsResult.rows[0] };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async listIntegrations(workspaceId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",provider,status,display_name AS "displayName",configuration,connected_by AS "connectedBy",last_verified_at AS "lastVerifiedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_integrations WHERE workspace_id=$1 ORDER BY provider', [workspaceId]);
        return rows;
    }
    async getIntegration(workspaceId, provider) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",provider,status,display_name AS "displayName",encrypted_credentials AS "encryptedCredentials",configuration,connected_by AS "connectedBy",last_verified_at AS "lastVerifiedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_integrations WHERE workspace_id=$1 AND provider=$2', [workspaceId, provider]);
        return rows[0] || null;
    }
    async upsertIntegration(workspaceId, provider, input) {
        const integrationId = id('int');
        const { rows } = await this.pool.query(`INSERT INTO wpa_integrations(id,workspace_id,provider,status,display_name,encrypted_credentials,configuration,connected_by,last_verified_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(workspace_id,provider) DO UPDATE SET status=EXCLUDED.status,display_name=EXCLUDED.display_name,encrypted_credentials=EXCLUDED.encrypted_credentials,configuration=EXCLUDED.configuration,connected_by=EXCLUDED.connected_by,last_verified_at=EXCLUDED.last_verified_at,updated_at=now() RETURNING id,workspace_id AS "workspaceId",provider,status,display_name AS "displayName",configuration,connected_by AS "connectedBy",last_verified_at AS "lastVerifiedAt",created_at AS "createdAt",updated_at AS "updatedAt"`, [integrationId, workspaceId, provider, input.status, input.displayName, input.encryptedCredentials || null, JSON.stringify(input.configuration || {}), input.connectedBy || null, input.lastVerifiedAt || null]);
        return rows[0];
    }
    async touchIntegration(workspaceId, provider, patch) {
        const { rows } = await this.pool.query('UPDATE wpa_integrations SET status=COALESCE($3,status),last_verified_at=COALESCE($4::timestamptz,last_verified_at),updated_at=now() WHERE workspace_id=$1 AND provider=$2 RETURNING id,workspace_id AS "workspaceId",provider,status,display_name AS "displayName",configuration,last_verified_at AS "lastVerifiedAt",created_at AS "createdAt",updated_at AS "updatedAt"', [workspaceId, provider, patch.status || null, patch.lastVerifiedAt || null]);
        return rows[0] || null;
    }
    async deleteIntegration(workspaceId, provider) { const result = await this.pool.query('DELETE FROM wpa_integrations WHERE workspace_id=$1 AND provider=$2', [workspaceId, provider]); return result.rowCount > 0; }
    async enqueueWebhookOutbox(workspaceId, input) {
        const eventId = id('outbox');
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_webhook_outbox(id,workspace_id,event_type,idempotency_key,payload,status)
             VALUES($1,$2,$3,$4,$5::jsonb,'pending')
             ON CONFLICT(workspace_id,idempotency_key) DO UPDATE SET updated_at=wpa_webhook_outbox.updated_at
             RETURNING id,workspace_id AS "workspaceId",event_type AS "eventType",idempotency_key AS "idempotencyKey",payload,status,attempts,next_attempt_at AS "nextAttemptAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt"`,
            [eventId, workspaceId, input.eventType, input.idempotencyKey, JSON.stringify(input.payload)]
        );
        const event = rows[0];
        if (event) await this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId, action: 'enqueued', fromStatus: null, toStatus: event.status });
        return event;
    }
    async claimWebhookOutbox(owner, { limit = 25, leaseMs = 60_000 } = {}) {
        const token = crypto.randomUUID();
        const { rows } = await this.pool.query(
            `WITH candidates AS (SELECT id FROM wpa_webhook_outbox WHERE ((status IN ('pending','retrying') AND next_attempt_at<=now()) OR (status='processing' AND lease_expires_at<=now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1)
             UPDATE wpa_webhook_outbox event SET status='processing',lease_owner=$2,lease_token=$3,lease_expires_at=now()+($4::text || ' milliseconds')::interval,updated_at=now() FROM candidates WHERE event.id=candidates.id
             RETURNING event.id,event.workspace_id AS "workspaceId",event.event_type AS "eventType",event.idempotency_key AS "idempotencyKey",event.payload,event.status,event.attempts,event.next_attempt_at AS "nextAttemptAt",event.lease_owner AS "leaseOwner",event.lease_token AS "leaseToken",event.lease_expires_at AS "leaseExpiresAt",event.last_error AS "lastError",event.created_at AS "createdAt",event.updated_at AS "updatedAt"`,
            [Math.min(100, Math.max(1, limit)), owner, token, leaseMs]
        );
        await Promise.all(rows.map((event) => this.recordWebhookOutboxHistory({ outboxId: event.id, workspaceId: event.workspaceId, action: 'claimed', fromStatus: null, toStatus: 'processing', actorId: owner })));
        return rows;
    }
    async completeWebhookOutbox(idValue, owner, token) {
        const { rows } = await this.pool.query(`UPDATE wpa_webhook_outbox SET status='delivered',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_token=$3 RETURNING id,workspace_id AS "workspaceId",status,attempts,updated_at AS "updatedAt"`, [idValue, owner, token]);
        if (rows[0]) await this.recordWebhookOutboxHistory({ outboxId: rows[0].id, workspaceId: rows[0].workspaceId, action: 'delivered', fromStatus: 'processing', toStatus: 'delivered', actorId: owner });
        return rows[0] || null;
    }
    async failWebhookOutbox(idValue, owner, token, error, { maxAttempts = 8 } = {}) {
        const message = String(error?.code || error?.message || 'WEBHOOK_DELIVERY_FAILED').slice(0, 256);
        const { rows } = await this.pool.query(`UPDATE wpa_webhook_outbox SET attempts=attempts+1,status=CASE WHEN attempts+1 >= $4 THEN 'dead_letter' ELSE 'retrying' END,next_attempt_at=now()+LEAST(interval '1 hour', (1000 * power(2,LEAST(attempts+1,10))) * interval '1 millisecond'),last_error=$5,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_token=$3 RETURNING id,workspace_id AS "workspaceId",status,attempts,next_attempt_at AS "nextAttemptAt",last_error AS "lastError",updated_at AS "updatedAt"`, [idValue, owner, token, maxAttempts, message]);
        if (rows[0]) await this.recordWebhookOutboxHistory({ outboxId: rows[0].id, workspaceId: rows[0].workspaceId, action: rows[0].status === 'dead_letter' ? 'dead_letter' : 'retrying', fromStatus: 'processing', toStatus: rows[0].status, actorId: owner, errorCode: message });
        return rows[0] || null;
    }
    async listWebhookOutbox(workspaceId, { limit = 50 } = {}) { const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",event_type AS "eventType",idempotency_key AS "idempotencyKey",status,attempts,next_attempt_at AS "nextAttemptAt",last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_webhook_outbox WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2', [workspaceId, Math.min(500, Math.max(1, limit))]); return rows; }
    async recordWebhookOutboxHistory({ outboxId, workspaceId, action, actorId = null, fromStatus = null, toStatus = null, errorCode = null }) {
        const { rows } = await this.pool.query(`INSERT INTO wpa_webhook_outbox_history(id,outbox_id,workspace_id,action,actor_id,from_status,to_status,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,outbox_id AS "outboxId",workspace_id AS "workspaceId",action,actor_id AS "actorId",from_status AS "fromStatus",to_status AS "toStatus",error_code AS "errorCode",created_at AS "createdAt"`, [id('outbox_history'), outboxId, workspaceId, action, actorId, fromStatus, toStatus, errorCode]);
        return rows[0] || null;
    }
    async listWebhookOutboxAdmin({ workspaceId, status, limit = 50 } = {}) {
        const values = []; const filters = [];
        if (workspaceId) { values.push(workspaceId); filters.push(`workspace_id=$${values.length}`); }
        if (status) { values.push(status); filters.push(`status=$${values.length}`); }
        values.push(Math.min(500, Math.max(1, Number(limit) || 50)));
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",event_type AS "eventType",idempotency_key AS "idempotencyKey",status,attempts,next_attempt_at AS "nextAttemptAt",last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_webhook_outbox${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
        for (const row of rows) row.history = await this.listWebhookOutboxHistory(row.id, { limit: 20 });
        return rows;
    }
    async replayWebhookOutbox(outboxId, actorId, workspaceId = null, context = {}) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const values = [outboxId]; const scope = workspaceId ? ` AND workspace_id=$${values.push(workspaceId)}` : '';
            const before = (await client.query(`SELECT id,workspace_id AS "workspaceId",status FROM wpa_webhook_outbox WHERE id=$1${scope} AND status IN ('retrying','dead_letter','processing') FOR UPDATE`, values)).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            const { rows } = await client.query(`UPDATE wpa_webhook_outbox SET status='pending',next_attempt_at=now(),last_error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1${scope} RETURNING id,workspace_id AS "workspaceId",event_type AS "eventType",idempotency_key AS "idempotencyKey",status,attempts,next_attempt_at AS "nextAttemptAt",last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt"`, values);
            await client.query(`INSERT INTO wpa_webhook_outbox_history(id,outbox_id,workspace_id,action,actor_id,from_status,to_status) VALUES($1,$2,$3,'replayed',$4,$5,'pending')`, [id('outbox_history'), outboxId, before.workspaceId, actorId, before.status]);
            await insertAuditRecord(client, { workspaceId: before.workspaceId, actorId, action: 'webhook_outbox.replayed', entityType: 'webhook_outbox', entityId: outboxId, reason: context.reason || null, requestId: context.requestId || null, before: { status: before.status }, after: { status: 'pending' } });
            await client.query('COMMIT');
            return rows[0];
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }
    async listWebhookOutboxHistory(outboxId, { limit = 100 } = {}) { const { rows } = await this.pool.query('SELECT id,outbox_id AS "outboxId",workspace_id AS "workspaceId",action,actor_id AS "actorId",from_status AS "fromStatus",to_status AS "toStatus",error_code AS "errorCode",created_at AS "createdAt" FROM wpa_webhook_outbox_history WHERE outbox_id=$1 ORDER BY created_at DESC LIMIT $2', [outboxId, Math.min(500, Math.max(1, Number(limit) || 100))]); return rows; }
    async createOAuthState(input) {
        await this.pool.query('DELETE FROM wpa_oauth_states WHERE expires_at < now()');
        await this.pool.query('INSERT INTO wpa_oauth_states(state_hash,workspace_id,provider,user_id,expires_at) VALUES($1,$2,$3,$4,$5)', [input.stateHash, input.workspaceId, input.provider, input.userId, input.expiresAt]);
        return input;
    }
    async consumeOAuthState(stateHash, workspaceId, provider, userId) {
        const { rows } = await this.pool.query('DELETE FROM wpa_oauth_states WHERE state_hash=$1 AND workspace_id=$2 AND provider=$3 AND user_id=$4 AND expires_at>now() RETURNING state_hash', [stateHash, workspaceId, provider, userId]);
        return rows[0] || null;
    }

    async createSupportTicket(workspaceId, input) {
        const ticketId = id('ticket');
        const client = await this.pool.connect();
        let transactionOpen = false;
        const ticketSelect = `SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",request_fingerprint AS "requestFingerprint",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState" FROM wpa_support_tickets`;
        try {
            await client.query('BEGIN');
            transactionOpen = true;
            if (input.idempotencyKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`support-create:${workspaceId}:${input.idempotencyKey}`]);
            const { rows } = await client.query(
                `INSERT INTO wpa_support_tickets(id,workspace_id,category,subject,priority,created_by,context,target_url,report_id,idempotency_key,request_fingerprint,notification_state)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
                 ON CONFLICT(workspace_id,idempotency_key) DO NOTHING
                 RETURNING id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState"`,
                [ticketId, workspaceId, input.category || 'general', input.subject, input.priority || 'normal', input.createdBy, input.context || null, input.targetUrl || null, input.reportId || null, input.idempotencyKey || null, input.requestFingerprint || null, JSON.stringify(input.notificationState || { externalEmail: 'not_configured' })]
            );
            if (!rows[0]) {
                const existingResult = input.idempotencyKey
                    ? await client.query(`${ticketSelect} WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, input.idempotencyKey])
                    : { rows: [] };
                await client.query('COMMIT');
                transactionOpen = false;
                if (existingResult.rows[0]) {
                    assertIdempotentReplay(existingResult.rows[0].requestFingerprint, input.requestFingerprint);
                    const ticket = { ...existingResult.rows[0] };
                    delete ticket.requestFingerprint;
                    return { ticket, created: false, idempotent: true };
                }
                throw new AppError('The support ticket could not be created.', { status: 503, code: 'SUPPORT_TICKET_UNAVAILABLE' });
            }
            let ticket = rows[0];
            if (input.initialMessage) {
                await client.query(
                    `INSERT INTO wpa_support_messages(id,ticket_id,workspace_id,author_id,author_type,visibility,body)
                     VALUES($1,$2,$3,$4,$5,$6,$7)`,
                    [id('ticket_msg'), ticket.id, workspaceId, input.initialMessage.authorId, input.initialMessage.authorType, input.initialMessage.visibility, input.initialMessage.body]
                );
                const updated = await client.query(
                    `UPDATE wpa_support_tickets SET updated_at=now(),last_message_at=now()
                     WHERE id=$1 AND workspace_id=$2
                     RETURNING id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState"`,
                    [ticket.id, workspaceId]
                );
                ticket = updated.rows[0] || ticket;
            }
            if (input.audit) await insertAuditRecord(client, {
                workspaceId,
                actorId: input.audit.actorId,
                action: input.audit.action,
                entityType: 'support_ticket',
                entityId: ticket.id,
                reason: input.audit.reason || null,
                requestId: input.audit.requestId || null,
                before: null,
                after: ticket,
                metadata: input.audit.metadata || {}
            });
            await client.query('COMMIT');
            transactionOpen = false;
            return { ticket, created: true, idempotent: false };
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }

    async getSupportActors(userIds = []) {
        const ids = [...new Set(userIds.filter(Boolean))];
        if (!ids.length) return [];
        const { rows } = await this.pool.query(
            'SELECT id,name,email,"emailVerified" AS "emailVerified","accountState" AS state FROM "user" WHERE id=ANY($1::text[])',
            [ids]
        );
        return rows;
    }

    async getSupportTicketByIdempotency(workspaceId, idempotencyKey) {
        const { rows } = await this.pool.query(
            'SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState" FROM wpa_support_tickets WHERE workspace_id=$1 AND idempotency_key=$2',
            [workspaceId, idempotencyKey]
        );
        return rows[0] || null;
    }

    async getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace = false } = {}) {
        const values = [ticketId];
        const scope = allowAnyWorkspace ? '' : ' AND workspace_id=$2';
        if (!allowAnyWorkspace) values.push(workspaceId);
        const { rows } = await this.pool.query(
            `SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState" FROM wpa_support_tickets WHERE id=$1${scope}`,
            values
        );
        return rows[0] || null;
    }

    async listSupportTickets(workspaceId, { limit = 25, after = null, status, priority, assignedTo, allowAnyWorkspace = false } = {}) {
        const values = [];
        const where = [];
        if (!allowAnyWorkspace) { values.push(workspaceId); where.push(`workspace_id=$${values.length}`); }
        if (status) { values.push(status); where.push(`status=$${values.length}`); }
        if (priority) { values.push(priority); where.push(`priority=$${values.length}`); }
        if (assignedTo !== undefined) { values.push(assignedTo); where.push(`assigned_to=$${values.length}`); }
        if (after) {
            values.push(after.at); const atParam = values.length;
            values.push(after.id); const idParam = values.length;
            where.push(`(updated_at < $${atParam}::timestamptz OR (updated_at = $${atParam}::timestamptz AND id < $${idParam}))`);
        }
        values.push(Math.min(101, limit + 1));
        const { rows } = await this.pool.query(
            `SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState"
             FROM wpa_support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
            values
        );
        return { tickets: rows.slice(0, limit), hasMore: rows.length > limit };
    }

    async listSupportMessages(workspaceId, ticketId, { includeInternal = false } = {}) {
        const ticket = await this.getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace: !workspaceId });
        if (!ticket) return [];
        const values = [ticketId];
        const visibility = includeInternal ? '' : " AND visibility='public'";
        const { rows } = await this.pool.query(
            `SELECT id,ticket_id AS "ticketId",workspace_id AS "workspaceId",author_id AS "authorId",author_type AS "authorType",visibility,body,created_at AS "createdAt" FROM wpa_support_messages WHERE ticket_id=$1${visibility} ORDER BY created_at,id`,
            values
        );
        return rows;
    }

    async appendSupportMessage(workspaceId, ticketId, input) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (input.idempotencyKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`support-message:${workspaceId || 'admin'}:${input.idempotencyKey}`]);
            const scope = workspaceId ? ' AND workspace_id=$2' : '';
            const ticketValues = workspaceId ? [ticketId, workspaceId] : [ticketId];
            const current = await client.query(`SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState" FROM wpa_support_tickets WHERE id=$1${scope} FOR UPDATE`, ticketValues);
            if (!current.rows[0]) { await client.query('ROLLBACK'); return null; }
            if (input.idempotencyKey) {
                const existing = (await client.query(`SELECT id,ticket_id AS "ticketId",workspace_id AS "workspaceId",author_id AS "authorId",author_type AS "authorType",visibility,body,idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",created_at AS "createdAt" FROM wpa_support_messages WHERE workspace_id=$1 AND idempotency_key=$2`, [current.rows[0].workspaceId, input.idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, input.requestFingerprint);
                    await client.query('COMMIT');
                    return { ticket: current.rows[0], message: existing, idempotent: true };
                }
            }
            if (['customer_reply', 'admin_reply'].includes(input.transitionIntent) && current.rows[0].status === 'closed') throw new AppError('Reopen the support ticket before replying.', { status: 409, code: 'SUPPORT_TICKET_CLOSED' });
            const messageId = id('ticket_msg');
            const messageResult = await client.query(
                `INSERT INTO wpa_support_messages(id,ticket_id,workspace_id,author_id,author_type,visibility,body,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING id,ticket_id AS "ticketId",workspace_id AS "workspaceId",author_id AS "authorId",author_type AS "authorType",visibility,body,created_at AS "createdAt"`,
                [messageId, ticketId, current.rows[0].workspaceId, input.authorId, input.authorType, input.visibility, input.body, input.idempotencyKey || null, input.requestFingerprint || null]
            );
            let status = input.nextStatus || current.rows[0].status;
            if (input.transitionIntent === 'customer_reply') status = ['resolved', 'pending'].includes(current.rows[0].status) ? 'in_progress' : current.rows[0].status;
            if (input.transitionIntent === 'admin_reply') status = 'pending';
            if (input.transitionIntent === 'internal_note') status = current.rows[0].status;
            const closedAt = status === 'closed' ? (current.rows[0].closedAt || new Date().toISOString()) : null;
            const updated = await client.query(
                `UPDATE wpa_support_tickets SET status=$2,updated_at=now(),last_message_at=now(),closed_at=$3::timestamptz
                 WHERE id=$1 RETURNING id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState"`,
                [ticketId, status, closedAt]
            );
            if (input.audit) await insertAuditRecord(client, {
                workspaceId: current.rows[0].workspaceId,
                actorId: input.audit.actorId,
                action: input.audit.action,
                entityType: 'support_ticket',
                entityId: ticketId,
                reason: input.audit.reason || null,
                requestId: input.audit.requestId || null,
                before: current.rows[0],
                after: updated.rows[0],
                metadata: input.audit.metadata || {}
            });
            await client.query('COMMIT');
            return { ticket: updated.rows[0], message: messageResult.rows[0], idempotent: false };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    async updateSupportTicket(workspaceId, ticketId, patch) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const scope = workspaceId ? ' AND workspace_id=$2' : '';
            const currentValues = workspaceId ? [ticketId, workspaceId] : [ticketId];
            const current = (await client.query(`SELECT id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState" FROM wpa_support_tickets WHERE id=$1${scope} FOR UPDATE`, currentValues)).rows[0];
            if (!current) { await client.query('ROLLBACK'); return null; }
            const values = [ticketId, current.workspaceId, patch.status ?? current.status, patch.priority ?? current.priority, Object.hasOwn(patch, 'assignedTo'), patch.assignedTo ?? null, Object.hasOwn(patch, 'closedAt'), patch.closedAt ?? null, Object.hasOwn(patch, 'reopenedAt'), patch.reopenedAt ?? null];
            const { rows } = await client.query(
                `UPDATE wpa_support_tickets SET status=$3,priority=$4,assigned_to=CASE WHEN $5::boolean THEN $6 ELSE assigned_to END,closed_at=CASE WHEN $7::boolean THEN $8::timestamptz ELSE closed_at END,reopened_at=CASE WHEN $9::boolean THEN $10::timestamptz ELSE reopened_at END,updated_at=now()
                 WHERE id=$1 AND workspace_id=$2
                 RETURNING id,workspace_id AS "workspaceId",category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",context,target_url AS "targetUrl",report_id AS "reportId",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt",closed_at AS "closedAt",reopened_at AS "reopenedAt",notification_state AS "notificationState"`,
                values
            );
            if (patch.audit) await insertAuditRecord(client, {
                workspaceId: current.workspaceId,
                actorId: patch.audit.actorId,
                action: patch.audit.action,
                entityType: 'support_ticket',
                entityId: ticketId,
                reason: patch.audit.reason || null,
                requestId: patch.audit.requestId || null,
                before: current,
                after: rows[0],
                metadata: patch.audit.metadata || {}
            });
            await client.query('COMMIT');
            return rows[0] || null;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }

    async createSourceInput(workspaceId, projectId, input, options = {}) {
        const { idempotencyKey, requestFingerprint, limit } = operationOptions(options);
        const entitlementUserId = options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null);
        const sourceId = id('src');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`source-quota:${entitlementUserId}`]);
            if (idempotencyKey) {
                const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",kind,status,result,failure_code AS "failureCode",encrypted_reference AS "encryptedReference",purge_at AS "purgeAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",completed_at AS "completedAt",created_at AS "createdAt" FROM wpa_source_inputs WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    return { sourceInput: existing, idempotent: true };
                }
            }
            const used = (await client.query("SELECT count(*)::int AS count FROM wpa_source_inputs WHERE entitlement_user_id=$1 AND status <> 'failed' AND created_at >= date_trunc('month',now())", [entitlementUserId])).rows[0].count;
            if (limit != null && used >= limit) throw new AppError('The monthly Source Audit limit has been reached.', { status: 409, code: 'SOURCE_AUDIT_LIMIT_REACHED' });
            const { rows } = await client.query(
                `INSERT INTO wpa_source_inputs (id,workspace_id,entitlement_user_id,project_id,kind,status,encrypted_reference,purge_at,idempotency_key,request_fingerprint)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",project_id AS "projectId",kind,status,encrypted_reference AS "encryptedReference",purge_at AS "purgeAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",created_at AS "createdAt"`,
                [sourceId, workspaceId, entitlementUserId, projectId, input.kind, input.status, input.encryptedReference, input.purgeAt, idempotencyKey, requestFingerprint]
            );
            await client.query('COMMIT');
            return idempotencyKey ? { sourceInput: rows[0], idempotent: false } : rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }
    async countSourceInputs(entitlementUserId, now = new Date()) {
        const { rows } = await this.pool.query("SELECT count(*)::int AS count FROM wpa_source_inputs WHERE entitlement_user_id=$1 AND status <> 'failed' AND created_at >= date_trunc('month',$2::timestamptz)", [entitlementUserId, now.toISOString()]);
        return rows[0].count;
    }
    async getSourceInput(workspaceId, sourceInputId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",kind,status,result,failure_code AS "failureCode",encrypted_reference AS "encryptedReference",purge_at AS "purgeAt",completed_at AS "completedAt",created_at AS "createdAt" FROM wpa_source_inputs WHERE workspace_id=$1 AND id=$2', [workspaceId, sourceInputId]);
        return rows[0] || null;
    }
    async updateSourceInput(workspaceId, sourceInputId, patch) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_source_inputs SET status=COALESCE($3,status),result=COALESCE($4::jsonb,result),failure_code=$5,
             encrypted_reference=CASE WHEN $6::boolean THEN $7 ELSE encrypted_reference END,completed_at=COALESCE($8::timestamptz,completed_at)
             WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS "workspaceId",project_id AS "projectId",kind,status,result,failure_code AS "failureCode",purge_at AS "purgeAt",completed_at AS "completedAt",created_at AS "createdAt"`,
            [workspaceId, sourceInputId, patch.status || null, patch.result ? JSON.stringify(patch.result) : null, patch.failureCode || null, Object.hasOwn(patch, 'encryptedReference'), patch.encryptedReference ?? null, patch.completedAt || null]
        );
        return rows[0] || null;
    }
    async listSourceInputs(workspaceId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",kind,status,result,failure_code AS "failureCode",purge_at AS "purgeAt",completed_at AS "completedAt",created_at AS "createdAt" FROM wpa_source_inputs WHERE workspace_id=$1 ORDER BY created_at DESC', [workspaceId]);
        return rows;
    }
    async createExpertReview(workspaceId, input) {
        const reviewId = id('review');
        const entitlementUserId = input.entitlementUserId || await this.resolveEntitlementUser(workspaceId, input.requestedBy || null);
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_expert_reviews(id,workspace_id,entitlement_user_id,scan_id,source_report_id,status,scope_page_urls,requested_by,due_at,idempotency_key)
             VALUES($1,$2,$3,$4,$5,'requested',$6::jsonb,$7,$8,$9)
             RETURNING id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",idempotency_key AS "idempotencyKey",created_at AS "createdAt",updated_at AS "updatedAt"`,
            [reviewId, workspaceId, entitlementUserId, input.scanId, input.sourceReportId, JSON.stringify(input.scopePageUrls), input.requestedBy, input.dueAt, input.idempotencyKey]
        ); return rows[0];
    }
    async getExpertReview(reviewId) { const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",idempotency_key AS "idempotencyKey",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_expert_reviews WHERE id=$1', [reviewId]); return rows[0] || null; }
    async listExpertReviews(workspaceId = null) { const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",idempotency_key AS "idempotencyKey",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_expert_reviews ${workspaceId ? 'WHERE workspace_id=$1' : ''} ORDER BY created_at DESC`, workspaceId ? [workspaceId] : []); return rows; }
    async updateExpertReview(reviewId, patch) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_expert_reviews WHERE id=$1 FOR UPDATE', [reviewId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            const { rows } = await client.query(
                `UPDATE wpa_expert_reviews SET status=COALESCE($2,status),decisions=COALESCE($3::jsonb,decisions),roadmap=COALESCE($4::jsonb,roadmap),assigned_to=COALESCE($5,assigned_to),completed_at=COALESCE($6::timestamptz,completed_at),updated_at=now() WHERE id=$1
                 RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
                [reviewId, patch.status || null, patch.decisions ? JSON.stringify(patch.decisions) : null, patch.roadmap ? JSON.stringify(patch.roadmap) : null, patch.assignedTo || null, patch.completedAt || null]
            );
            const after = rows[0];
            if (patch.audit) await insertAuditRecord(client, {
                workspaceId: after.workspaceId,
                actorId: patch.audit.actorId,
                action: patch.audit.action,
                entityType: 'expert_review',
                entityId: reviewId,
                reason: patch.audit.reason || null,
                requestId: patch.audit.requestId || null,
                before,
                after,
                metadata: patch.audit.metadata || {}
            });
            await client.query('COMMIT');
            return after;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async countExpertReviews(entitlementUserId, now = new Date()) { const { rows } = await this.pool.query("SELECT count(*)::int AS count FROM wpa_expert_reviews WHERE entitlement_user_id=$1 AND created_at >= date_trunc('month',$2::timestamptz) AND status <> 'cancelled'", [entitlementUserId, now.toISOString()]); return rows[0].count; }

    async ensureWorkspace(workspaceId, { name = 'My workspace', planId = 'free', entitlementOwnerUserId = null } = {}) {
        if (entitlementOwnerUserId) {
            await this.pool.query(
                `INSERT INTO wpa_user_entitlement_profiles(user_id,plan_id,plan_source,reason)
                 SELECT id,'free','system','Default commercial profile' FROM "user" WHERE id=$1
                 ON CONFLICT(user_id) DO NOTHING`,
                [entitlementOwnerUserId]
            );
        }
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_workspaces (id,name,plan_id,entitlement_owner_user_id) VALUES ($1,$2,$3,$4)
             ON CONFLICT (id) DO UPDATE SET updated_at=now(),entitlement_owner_user_id=COALESCE(wpa_workspaces.entitlement_owner_user_id,EXCLUDED.entitlement_owner_user_id)
             RETURNING id,name,plan_id AS "planId",entitlement_owner_user_id AS "entitlementOwnerUserId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS "suspensionReason",created_at AS "createdAt"`,
            [workspaceId, name, planId, entitlementOwnerUserId]
        );
        return rows[0];
    }

    async getWorkspace(workspaceId) {
        const { rows } = await this.pool.query('SELECT id,name,plan_id AS "planId",entitlement_owner_user_id AS "entitlementOwnerUserId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS "suspensionReason",created_at AS "createdAt" FROM wpa_workspaces WHERE id=$1', [workspaceId]);
        return rows[0] || null;
    }

    async getCommercialUser(userId) {
        const { rows } = await this.pool.query('SELECT id,name,email,"createdAt" AS "createdAt","updatedAt" AS "updatedAt" FROM "user" WHERE id=$1', [userId]);
        return rows[0] || null;
    }

    async getUserCommercialProfile(userId) {
        const { rows } = await this.pool.query(`SELECT user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_user_entitlement_profiles WHERE user_id=$1`, [userId]);
        return rows[0] || null;
    }

    async assignWorkspaceEntitlementOwner(workspaceId, userId, { ifUnset = true } = {}) {
        const user = await this.getCommercialUser(userId);
        if (!user) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
        await this.pool.query(`INSERT INTO wpa_user_entitlement_profiles(user_id,plan_id,plan_source,reason) VALUES($1,'free','system','Default commercial profile') ON CONFLICT(user_id) DO NOTHING`, [userId]);
        const { rows } = await this.pool.query(
            `UPDATE wpa_workspaces SET entitlement_owner_user_id=$2,updated_at=now()
             WHERE id=$1 AND ($3::boolean=false OR entitlement_owner_user_id IS NULL OR entitlement_owner_user_id=$2)
             RETURNING id,name,plan_id AS "planId",entitlement_owner_user_id AS "entitlementOwnerUserId",state,created_at AS "createdAt"`,
            [workspaceId, userId, ifUnset]
        );
        return rows[0] || this.getWorkspace(workspaceId);
    }

    async resolveEntitlementUser(workspaceId, requesterUserId = null) {
        const workspace = await this.getWorkspace(workspaceId);
        if (workspace?.entitlementOwnerUserId) return workspace.entitlementOwnerUserId;
        if (requesterUserId && await this.getCommercialUser(requesterUserId)) return requesterUserId;
        return workspaceId;
    }

    async assignUserPlan(userId, planId, context = {}) {
        const { actorId, reason, requestId = null, source = 'admin', sourceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-plan:${userId}`]);
            if (!(await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0]) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
            if (!(await client.query('SELECT id FROM wpa_plan_catalog WHERE id=$1', [planId])).rows[0]) throw new AppError('Unknown plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
            if (idempotencyKey) {
                const existing = (await client.query(`SELECT id,user_id AS "userId",before_plan_id AS "beforePlanId",after_plan_id AS "afterPlanId",source,source_id AS "sourceId",created_by AS "actorId",reason,request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",created_at AS "createdAt" FROM wpa_user_plan_changes WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [userId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    const profile = (await client.query(`SELECT user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_user_entitlement_profiles WHERE user_id=$1`, [userId])).rows[0];
                    await client.query('COMMIT');
                    return { profile, change: existing, idempotent: true };
                }
            }
            await client.query(`INSERT INTO wpa_user_entitlement_profiles(user_id,plan_id,plan_source,reason) VALUES($1,'free','system','Default commercial profile') ON CONFLICT(user_id) DO NOTHING`, [userId]);
            const before = (await client.query(`SELECT user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_user_entitlement_profiles WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
            const profile = (await client.query(`UPDATE wpa_user_entitlement_profiles SET plan_id=$2,plan_source=$3,source_id=$4,updated_by=$5,reason=$6,request_id=$7,updated_at=now() WHERE user_id=$1 RETURNING user_id AS "userId",plan_id AS "planId",plan_source AS "planSource",source_id AS "sourceId",updated_by AS "updatedBy",reason,request_id AS "requestId",created_at AS "createdAt",updated_at AS "updatedAt"`, [userId, planId, source, sourceId, actorId || `system:${source}`, reason.trim(), requestId])).rows[0];
            const change = (await client.query(`INSERT INTO wpa_user_plan_changes(id,user_id,before_plan_id,after_plan_id,source,source_id,created_by,reason,request_id,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,user_id AS "userId",before_plan_id AS "beforePlanId",after_plan_id AS "afterPlanId",source,source_id AS "sourceId",created_by AS "actorId",reason,request_id AS "requestId",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint",created_at AS "createdAt"`, [id('user_plan_change'), userId, before.planId, planId, source, sourceId, actorId || `system:${source}`, reason.trim(), requestId, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { actorId, action: 'user.plan_changed', entityType: 'user_entitlement_profile', entityId: userId, reason, requestId, before: { planId: before.planId }, after: { planId }, metadata: { targetUserId: userId, source, sourceId } });
            await client.query('COMMIT');
            return { profile, change, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async setWorkspacePlan(workspaceId, planId) {
        const { rows } = await this.pool.query('UPDATE wpa_workspaces SET plan_id=$2,updated_at=now() WHERE id=$1 RETURNING id,name,plan_id AS "planId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS "suspensionReason"', [workspaceId, planId]);
        return rows[0] || null;
    }

    async getUserState(userId) {
        const { rows } = await this.pool.query('SELECT id AS "userId",email,"accountState" AS state,"stateChangedAt" AS "changedAt","stateChangedBy" AS "changedBy","stateReason" AS reason FROM "user" WHERE id=$1', [userId]);
        return rows[0] || null;
    }

    async getUserStateByEmail(email) {
        const { rows } = await this.pool.query('SELECT id AS "userId",email,"accountState" AS state,"stateChangedAt" AS "changedAt","stateChangedBy" AS "changedBy","stateReason" AS reason FROM "user" WHERE lower(email)=lower($1) LIMIT 1', [String(email || '').trim()]);
        return rows[0] || null;
    }

    async setUserState(userId, state, { actorId, reason, requestId } = {}) {
        if (!['active', 'banned'].includes(state)) throw new AppError('Unknown account state.', { status: 400, code: 'USER_STATE_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id AS "userId",email,"accountState" AS state,"stateChangedAt" AS "changedAt","stateChangedBy" AS "changedBy","stateReason" AS reason FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0];
            if (!before) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
            const after = (await client.query('UPDATE "user" SET "accountState"=$2,"stateChangedAt"=now(),"stateChangedBy"=$3,"stateReason"=$4,"updatedAt"=now() WHERE id=$1 RETURNING id AS "userId",email,"accountState" AS state,"stateChangedAt" AS "changedAt","stateChangedBy" AS "changedBy","stateReason" AS reason', [userId, state, actorId, reason.trim()])).rows[0];
            const invalidatedSessions = state === 'banned' ? (await client.query('DELETE FROM session WHERE "userId"=$1', [userId])).rowCount : 0;
            await insertAuditRecord(client, { actorId, action: state === 'banned' ? 'user.banned' : 'user.unbanned', entityType: 'user', entityId: userId, reason, requestId, before, after, metadata: { invalidatedSessions } });
            await client.query('COMMIT');
            return { ...after, invalidatedSessions };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getWorkspaceState(workspaceId) {
        const { rows } = await this.pool.query('SELECT id AS "workspaceId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS reason FROM wpa_workspaces WHERE id=$1', [workspaceId]);
        return rows[0] || null;
    }

    async setWorkspaceState(workspaceId, state, { actorId, reason, requestId } = {}) {
        if (!['active', 'suspended'].includes(state)) throw new AppError('Unknown workspace state.', { status: 400, code: 'WORKSPACE_STATE_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id AS "workspaceId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS reason FROM wpa_workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
            if (!before) throw new AppError('Workspace not found.', { status: 404, code: 'WORKSPACE_NOT_FOUND' });
            const after = (await client.query(`UPDATE wpa_workspaces SET state=$2,suspended_at=CASE WHEN $2='suspended' THEN now() ELSE NULL END,suspended_by=CASE WHEN $2='suspended' THEN $3 ELSE NULL END,suspension_reason=$4,updated_at=now() WHERE id=$1 RETURNING id AS "workspaceId",state,suspended_at AS "suspendedAt",suspended_by AS "suspendedBy",suspension_reason AS reason`, [workspaceId, state, actorId, reason.trim()])).rows[0];
            await insertAuditRecord(client, { workspaceId, actorId, action: state === 'suspended' ? 'workspace.suspended' : 'workspace.unsuspended', entityType: 'workspace', entityId: workspaceId, reason, requestId, before, after });
            await client.query('COMMIT');
            return after;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getUserEffectiveEntitlements(userId, now = new Date()) {
        const at = new Date(now).toISOString();
        const [profile, grantsResult, adjustmentsResult] = await Promise.all([
            this.getUserCommercialProfile(userId),
            this.pool.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_entitlement_grants WHERE user_id=$1 AND revoked_at IS NULL AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at,id`, [userId, at]),
            this.pool.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at`, [userId, at])
        ]);
        let basePlan = profile ? await this.getPlan(profile.planId) : null;
        if (!basePlan) {
            const legacyWorkspace = await this.getWorkspace(userId).catch(() => null);
            basePlan = legacyWorkspace ? await this.getPlan(legacyWorkspace.planId) : null;
        }
        return composeEffectivePlan(basePlan || getPlan('free'), grantsResult.rows, adjustmentsResult.rows, now);
    }

    async getEffectiveEntitlements(workspaceId, now = new Date()) {
        const workspace = await this.ensureWorkspace(workspaceId);
        if (workspace.entitlementOwnerUserId) return this.getUserEffectiveEntitlements(workspace.entitlementOwnerUserId, now);
        const [basePlan, grantsResult, adjustmentsResult] = await Promise.all([
            this.getPlan(workspace.planId),
            this.pool.query(`SELECT id,workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_entitlement_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at,id`, [workspaceId, new Date(now).toISOString()]),
            this.pool.query(`SELECT id,workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at`, [workspaceId, new Date(now).toISOString()])
        ]);
        return composeEffectivePlan(basePlan || getPlan('free'), grantsResult.rows, adjustmentsResult.rows, now);
    }

    async createRedeemCode(input) {
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !(await this.getPlan(input.temporaryPlanId))) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const { idempotencyKey, requestFingerprint } = operationOptions(input);
        const codeId = input.id || id('redeem');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (idempotencyKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`redeem-create:${input.createdBy}:${idempotencyKey}`]);
                const existing = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint" FROM wpa_redeem_codes WHERE created_by=$1 AND idempotency_key=$2 FOR UPDATE`, [input.createdBy, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    const record = (await client.query(`SELECT c.id,c.code_hint AS "codeHint",c.active,c.starts_at AS "startsAt",c.expires_at AS "expiresAt",c.max_global_redemptions AS "maxGlobalRedemptions",c.max_per_user AS "maxPerUser",c.max_per_workspace AS "maxPerWorkspace",c.temporary_plan_id AS "temporaryPlanId",c.duration_days AS "durationDays",c.bonus_page_credits AS "bonusPageCredits",c.bonus_ai_credits AS "bonusAiCredits",c.entitlement_overrides AS "entitlementOverrides",c.admin_note AS "adminNote",c.created_by AS "createdBy",c.created_at AS "createdAt",c.disabled_at AS "disabledAt",c.disabled_by AS "disabledBy",c.revoked_at AS "revokedAt",c.revoked_by AS "revokedBy",(SELECT count(*)::int FROM wpa_redeem_redemptions r WHERE r.code_id=c.id) AS "redemptionCount" FROM wpa_redeem_codes c WHERE c.id=$1`, [existing.id])).rows[0];
                    await client.query('COMMIT');
                    return { ...record, idempotent: true };
                }
            }
            const { hash, salt } = hashRedeemCode(input.code);
            const maxPerUser = input.maxPerUser ?? input.maxPerWorkspace ?? 1;
            const record = (await client.query(`INSERT INTO wpa_redeem_codes(id,code_hash,code_salt,code_hint,active,starts_at,expires_at,max_global_redemptions,max_per_workspace,max_per_user,temporary_plan_id,duration_days,bonus_page_credits,bonus_ai_credits,entitlement_overrides,admin_note,created_by,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19) RETURNING id,code_hint AS "codeHint",active,starts_at AS "startsAt",expires_at AS "expiresAt",max_global_redemptions AS "maxGlobalRedemptions",max_per_user AS "maxPerUser",max_per_workspace AS "maxPerWorkspace",temporary_plan_id AS "temporaryPlanId",duration_days AS "durationDays",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",entitlement_overrides AS "entitlementOverrides",admin_note AS "adminNote",created_by AS "createdBy",created_at AS "createdAt",disabled_at AS "disabledAt",disabled_by AS "disabledBy",revoked_at AS "revokedAt",revoked_by AS "revokedBy"`, [codeId, hash, salt, redeemCodeHint(input.code), input.active !== false, input.startsAt || null, input.expiresAt || null, input.maxGlobalRedemptions ?? null, input.maxPerWorkspace ?? maxPerUser, maxPerUser, input.temporaryPlanId || null, input.durationDays ?? null, Number(input.bonusPageCredits || 0), Number(input.bonusAiCredits || 0), JSON.stringify(input.entitlementOverrides || {}), input.adminNote || null, input.createdBy, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { actorId: input.createdBy, action: 'redeem.created', entityType: 'redeem_code', entityId: codeId, reason: input.reason?.trim() || input.adminNote?.trim() || 'created', requestId: input.requestId, after: { codeHint: redeemCodeHint(input.code), temporaryPlanId: input.temporaryPlanId || null, expiresAt: input.expiresAt || null }, metadata: { codeHint: redeemCodeHint(input.code) } });
            await client.query('COMMIT');
            return { ...record, redemptionCount: 0, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async listRedeemCodes({ id: codeId = null } = {}) {
        const values = codeId ? [codeId] : [];
        const { rows } = await this.pool.query(`SELECT c.id,c.code_hint AS "codeHint",c.active,c.starts_at AS "startsAt",c.expires_at AS "expiresAt",c.max_global_redemptions AS "maxGlobalRedemptions",c.max_per_user AS "maxPerUser",c.max_per_workspace AS "maxPerWorkspace",c.temporary_plan_id AS "temporaryPlanId",c.duration_days AS "durationDays",c.bonus_page_credits AS "bonusPageCredits",c.bonus_ai_credits AS "bonusAiCredits",c.entitlement_overrides AS "entitlementOverrides",c.admin_note AS "adminNote",c.created_by AS "createdBy",c.created_at AS "createdAt",c.disabled_at AS "disabledAt",c.disabled_by AS "disabledBy",c.revoked_at AS "revokedAt",c.revoked_by AS "revokedBy",count(r.id)::int AS "redemptionCount" FROM wpa_redeem_codes c LEFT JOIN wpa_redeem_redemptions r ON r.code_id=c.id ${codeId ? 'WHERE c.id=$1' : ''} GROUP BY c.id ORDER BY c.created_at DESC`, values);
        return rows;
    }

    async mutateRedeemCode(codeId, patch, { actorId, reason, requestId } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,active,disabled_at AS "disabledAt",revoked_at AS "revokedAt" FROM wpa_redeem_codes WHERE id=$1 FOR UPDATE', [codeId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            const active = patch.revoke === true ? false : patch.active ?? before.active;
            const { rows } = await client.query(`UPDATE wpa_redeem_codes SET active=$2,disabled_at=CASE WHEN $2 THEN NULL ELSE COALESCE(disabled_at,now()) END,disabled_by=CASE WHEN $2 THEN NULL ELSE COALESCE(disabled_by,$3) END,revoked_at=CASE WHEN $4 THEN COALESCE(revoked_at,now()) ELSE revoked_at END,revoked_by=CASE WHEN $4 THEN COALESCE(revoked_by,$3) ELSE revoked_by END WHERE id=$1 RETURNING id,active,disabled_at AS "disabledAt",revoked_at AS "revokedAt"`, [codeId, active, actorId, patch.revoke === true]);
            const after = rows[0];
            if (patch.revoke === true) {
                await client.query('UPDATE wpa_redeem_redemptions SET revoked_at=COALESCE(revoked_at,now()),revoked_by=COALESCE(revoked_by,$2),revoke_reason=COALESCE(revoke_reason,$3) WHERE code_id=$1', [codeId, actorId, reason.trim()]);
                await client.query(`UPDATE wpa_entitlement_grants g SET revoked_at=COALESCE(g.revoked_at,now()),revoked_by=COALESCE(g.revoked_by,$2),revoke_reason=COALESCE(g.revoke_reason,$3) FROM wpa_redeem_redemptions r WHERE r.code_id=$1 AND r.grant_id=g.id`, [codeId, actorId, reason.trim()]);
            }
            const action = patch.revoke === true ? 'redeem.revoked' : after.active ? 'redeem.enabled' : 'redeem.disabled';
            await insertAuditRecord(client, { actorId, action, entityType: 'redeem_code', entityId: codeId, reason, requestId, before, after });
            await client.query('COMMIT');
            return (await this.listRedeemCodes({ id: codeId }))[0];
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async redeemCode(workspaceId, userId, code, { now = new Date(), requestId = null, idempotencyKey = null, requestFingerprint = null } = {}) {
        const at = new Date(now);
        const hint = redeemCodeHint(code);
        const client = await this.pool.connect();
        let result;
        try {
            await client.query('BEGIN');
            if (idempotencyKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`redeem-operation:${userId}:${idempotencyKey}`]);
                const existing = (await client.query(`SELECT r.id,r.code_id AS "codeId",r.workspace_id AS "workspaceId",r.user_id AS "userId",r.grant_id AS "grantId",r.request_id AS "requestId",r.idempotency_key AS "idempotencyKey",r.request_fingerprint AS "requestFingerprint",r.redeemed_at AS "redeemedAt",g.user_id AS "grantUserId",g.source,g.source_id AS "sourceId",g.temporary_plan_id AS "temporaryPlanId",g.entitlement_overrides AS "entitlementOverrides",g.bonus_page_credits AS "bonusPageCredits",g.bonus_ai_credits AS "bonusAiCredits",g.reason,g.created_by AS "createdBy",g.starts_at AS "startsAt",g.expires_at AS "expiresAt",g.created_at AS "grantCreatedAt" FROM wpa_redeem_redemptions r JOIN wpa_entitlement_grants g ON g.id=r.grant_id WHERE r.user_id=$1 AND r.idempotency_key=$2 FOR UPDATE OF r,g`, [userId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    result = {
                        redemption: { id: existing.id, codeId: existing.codeId, workspaceId: existing.workspaceId, userId: existing.userId, grantId: existing.grantId, requestId: existing.requestId, idempotencyKey: existing.idempotencyKey, redeemedAt: existing.redeemedAt },
                        grant: { id: existing.grantId, userId: existing.grantUserId, workspaceId: existing.workspaceId, source: existing.source, sourceId: existing.sourceId, temporaryPlanId: existing.temporaryPlanId, entitlementOverrides: existing.entitlementOverrides, bonusPageCredits: existing.bonusPageCredits, bonusAiCredits: existing.bonusAiCredits, reason: existing.reason, createdBy: existing.createdBy, startsAt: existing.startsAt, expiresAt: existing.expiresAt, createdAt: existing.grantCreatedAt },
                        idempotent: true
                    };
                    await client.query('COMMIT');
                }
            }
            if (result) return { ...result, effective: await this.getUserEffectiveEntitlements(userId, now) };
            const candidates = (await client.query('SELECT id,code_hash AS "codeHash",code_salt AS "codeSalt",code_hint AS "codeHint",active,starts_at AS "startsAt",expires_at AS "expiresAt",max_global_redemptions AS "maxGlobalRedemptions",max_per_user AS "maxPerUser",max_per_workspace AS "maxPerWorkspace",temporary_plan_id AS "temporaryPlanId",duration_days AS "durationDays",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",entitlement_overrides AS "entitlementOverrides" FROM wpa_redeem_codes WHERE code_hint=$1 FOR UPDATE', [hint])).rows;
            const redeem = findRedeemCodeByHash(candidates, code);
            if (!redeem || !redeem.active) throw new AppError('Redeem code is invalid or inactive.', { status: 404, code: 'REDEEM_CODE_INVALID' });
            if (redeem.startsAt && new Date(redeem.startsAt) > at) throw new AppError('Redeem code is not active yet.', { status: 409, code: 'REDEEM_CODE_NOT_STARTED' });
            if (redeem.expiresAt && new Date(redeem.expiresAt) <= at) throw new AppError('Redeem code has expired.', { status: 409, code: 'REDEEM_CODE_EXPIRED' });
            const counts = (await client.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE user_id=$2)::int AS "user" FROM wpa_redeem_redemptions WHERE code_id=$1', [redeem.id, userId])).rows[0];
            if (redeem.maxGlobalRedemptions != null && counts.total >= redeem.maxGlobalRedemptions) throw new AppError('Redeem code usage limit has been reached.', { status: 409, code: 'REDEEM_CODE_LIMIT_REACHED' });
            if (counts.user >= redeem.maxPerUser) throw new AppError('This user has already used this redeem code.', { status: 409, code: 'REDEEM_USER_LIMIT_REACHED' });
            const durationExpiry = redeem.durationDays ? new Date(at.getTime() + redeem.durationDays * 86_400_000) : null;
            const codeExpiry = redeem.expiresAt ? new Date(redeem.expiresAt) : null;
            const expiresAt = durationExpiry && codeExpiry ? new Date(Math.min(durationExpiry, codeExpiry)).toISOString() : (durationExpiry || codeExpiry)?.toISOString() || null;
            const grantId = id('grant');
            const redemptionId = id('redemption');
            const reason = `Redeemed ${redeem.codeHint}`;
            const grant = (await client.query(`INSERT INTO wpa_entitlement_grants(id,user_id,workspace_id,source,source_id,temporary_plan_id,entitlement_overrides,bonus_page_credits,bonus_ai_credits,reason,created_by,starts_at,expires_at) VALUES($1,$2,$3,'redeem',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) RETURNING id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt"`, [grantId, userId, workspaceId, redeem.id, redeem.temporaryPlanId, JSON.stringify(redeem.entitlementOverrides || {}), redeem.bonusPageCredits, redeem.bonusAiCredits, reason, userId, at.toISOString(), expiresAt])).rows[0];
            const redemption = (await client.query(`INSERT INTO wpa_redeem_redemptions(id,code_id,workspace_id,user_id,grant_id,request_id,idempotency_key,request_fingerprint,redeemed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,code_id AS "codeId",workspace_id AS "workspaceId",user_id AS "userId",grant_id AS "grantId",request_id AS "requestId",idempotency_key AS "idempotencyKey",redeemed_at AS "redeemedAt"`, [redemptionId, redeem.id, workspaceId, userId, grantId, requestId, idempotencyKey, requestFingerprint, at.toISOString()])).rows[0];
            await insertAuditRecord(client, { workspaceId, actorId: userId, action: 'redeem.redeemed', entityType: 'redeem_code', entityId: redeem.id, reason, requestId, after: { grantId, expiresAt }, metadata: { codeHint: redeem.codeHint } });
            await client.query('COMMIT');
            result = { redemption, grant, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        return { ...result, effective: await this.getUserEffectiveEntitlements(userId, now) };
    }

    async adjustUserCredits(userId, creditType, amount, context = {}) {
        const { actorId, reason, requestId = null, expiresAt = null, workspaceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!['page', 'ai'].includes(creditType) || !Number.isInteger(amount) || amount === 0) throw new AppError('Credit adjustment is invalid.', { status: 400, code: 'CREDIT_ADJUSTMENT_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-credit-adjustment:${userId}`]);
            if (!(await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0]) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
            if (idempotencyKey) {
                const existing = (await client.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint" FROM wpa_credit_adjustments WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [userId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    return { ...existing, idempotent: true };
                }
            }
            const record = (await client.query(`INSERT INTO wpa_credit_adjustments(id,user_id,workspace_id,credit_type,amount,reason,created_by,request_id,expires_at,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,user_id AS "userId",workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt"`, [id('credit_adjustment'), userId, workspaceId, creditType, amount, reason.trim(), actorId, requestId, expiresAt, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { actorId, action: amount > 0 ? 'user.credits_granted' : 'user.credits_adjusted', entityType: 'user_credit_adjustment', entityId: record.id, reason, requestId, after: record, metadata: { targetUserId: userId, creditType, amount, expiresAt } });
            await client.query('COMMIT');
            return { ...record, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async listUserCreditAdjustments(userId) {
        const { rows } = await this.pool.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE user_id=$1 ORDER BY created_at,id`, [userId]);
        return rows;
    }

    async grantUserEntitlement(userId, input, context = {}) {
        const { actorId, reason, requestId = null, workspaceId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !(await this.getPlan(input.temporaryPlanId))) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user-entitlement-grant:${userId}`]);
            if (!(await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0]) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
            if (idempotencyKey) {
                const existing = (await client.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint" FROM wpa_entitlement_grants WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [userId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    return { ...existing, idempotent: true };
                }
            }
            const record = (await client.query(`INSERT INTO wpa_entitlement_grants(id,user_id,workspace_id,source,source_id,temporary_plan_id,entitlement_overrides,bonus_page_credits,bonus_ai_credits,reason,created_by,starts_at,expires_at,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,COALESCE($12::timestamptz,now()),$13,$14,$15) RETURNING id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt"`, [id('grant'), userId, workspaceId, input.source || 'admin', input.sourceId || null, input.temporaryPlanId || null, JSON.stringify(input.entitlementOverrides || {}), Number(input.bonusPageCredits || 0), Number(input.bonusAiCredits || 0), reason.trim(), actorId, input.startsAt || null, input.expiresAt || null, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { actorId, action: 'user.entitlement_granted', entityType: 'user_entitlement_grant', entityId: record.id, reason, requestId, after: record, metadata: { targetUserId: userId, temporaryPlanId: record.temporaryPlanId, expiresAt: record.expiresAt } });
            await client.query('COMMIT');
            return { ...record, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async listUserEntitlementGrants(userId) {
        const { rows } = await this.pool.query(`SELECT id,user_id AS "userId",workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt",revoked_by AS "revokedBy",revoke_reason AS "revokeReason" FROM wpa_entitlement_grants WHERE user_id=$1 ORDER BY created_at,id`, [userId]);
        return rows;
    }

    async adjustCredits(workspaceId, creditType, amount, context = {}) {
        const { actorId, reason, requestId = null, expiresAt = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!['page', 'ai'].includes(creditType) || !Number.isInteger(amount) || amount === 0) throw new AppError('Credit adjustment is invalid.', { status: 400, code: 'CREDIT_ADJUSTMENT_INVALID' });
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const adjustmentId = id('credit_adjustment');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (idempotencyKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credit-adjustment:${workspaceId}:${idempotencyKey}`]);
                const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint" FROM wpa_credit_adjustments WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    return { ...existing, idempotent: true };
                }
            }
            const record = (await client.query(`INSERT INTO wpa_credit_adjustments(id,workspace_id,credit_type,amount,reason,created_by,request_id,expires_at,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt"`, [adjustmentId, workspaceId, creditType, amount, reason.trim(), actorId, requestId, expiresAt, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { workspaceId, actorId, action: amount > 0 ? 'credits.granted' : 'credits.revoked', entityType: 'credit_adjustment', entityId: adjustmentId, reason, requestId, after: record });
            await client.query('COMMIT');
            return { ...record, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async listCreditAdjustments(workspaceId) {
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]);
        return rows;
    }

    async grantEntitlement(workspaceId, input, context = {}) {
        const { actorId, reason, requestId = null } = context;
        const { idempotencyKey, requestFingerprint } = operationOptions(context);
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        assertGrantableEntitlementOverrides(input.entitlementOverrides);
        if (input.temporaryPlanId && !(await this.getPlan(input.temporaryPlanId))) throw new AppError('Unknown temporary plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
        const grantId = id('grant');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (idempotencyKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlement-grant:${workspaceId}:${idempotencyKey}`]);
                const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint" FROM wpa_entitlement_grants WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, idempotencyKey])).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    return { ...existing, idempotent: true };
                }
            }
            const record = (await client.query(`INSERT INTO wpa_entitlement_grants(id,workspace_id,source,source_id,temporary_plan_id,entitlement_overrides,bonus_page_credits,bonus_ai_credits,reason,created_by,starts_at,expires_at,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,COALESCE($11::timestamptz,now()),$12,$13,$14) RETURNING id,workspace_id AS "workspaceId",source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt"`, [grantId, workspaceId, input.source || 'admin', input.sourceId || null, input.temporaryPlanId || null, JSON.stringify(input.entitlementOverrides || {}), Number(input.bonusPageCredits || 0), Number(input.bonusAiCredits || 0), reason.trim(), actorId, input.startsAt || null, input.expiresAt || null, idempotencyKey, requestFingerprint])).rows[0];
            await insertAuditRecord(client, { workspaceId, actorId, action: 'entitlement.granted', entityType: 'entitlement_grant', entityId: grantId, reason, requestId, after: record });
            await client.query('COMMIT');
            return { ...record, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async revokeEntitlement(grantId, { actorId, reason, requestId = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,user_id AS "userId",workspace_id AS "workspaceId",revoked_at AS "revokedAt" FROM wpa_entitlement_grants WHERE id=$1 FOR UPDATE', [grantId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            const after = (await client.query('UPDATE wpa_entitlement_grants SET revoked_at=COALESCE(revoked_at,now()),revoked_by=COALESCE(revoked_by,$2),revoke_reason=COALESCE(revoke_reason,$3) WHERE id=$1 RETURNING id,user_id AS "userId",workspace_id AS "workspaceId",revoked_at AS "revokedAt",revoked_by AS "revokedBy",revoke_reason AS "revokeReason"', [grantId, actorId, reason.trim()])).rows[0];
            await insertAuditRecord(client, { workspaceId: after.workspaceId, actorId, action: after.userId ? 'user.entitlement_revoked' : 'entitlement.revoked', entityType: after.userId ? 'user_entitlement_grant' : 'entitlement_grant', entityId: grantId, reason, requestId, before, after, metadata: { targetUserId: after.userId || null } });
            await client.query('COMMIT');
            return after;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async createProject(workspaceId, project, options = {}) {
        const { limit, idempotencyKey, requestFingerprint } = operationOptions(options);
        const entitlementUserId = options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project-create:${entitlementUserId}`]);
            if (idempotencyKey) {
                const existing = (await client.query(
                    `SELECT id, workspace_id AS "workspaceId", entitlement_user_id AS "entitlementUserId", name, origin, locale, verified_at AS "verifiedAt", verification_token AS "verificationToken", created_at AS "createdAt", idempotency_key AS "idempotencyKey", request_fingerprint AS "requestFingerprint"
                     FROM wpa_projects WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
                    [workspaceId, idempotencyKey]
                )).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    await client.query('COMMIT');
                    const record = { ...existing };
                    delete record.idempotencyKey;
                    delete record.requestFingerprint;
                    return operationResult(record, idempotencyKey, true);
                }
            }
            if (limit != null) {
                const count = Number((await client.query('SELECT count(*)::int AS count FROM wpa_projects WHERE entitlement_user_id=$1', [entitlementUserId])).rows[0].count);
                if (count >= limit) throw new AppError('The project limit for this plan has been reached.', { status: 409, code: 'PROJECT_LIMIT_REACHED' });
            }
            const projectId = id('prj');
            const verificationToken = crypto.randomBytes(24).toString('base64url');
            const { rows } = await client.query(
                `INSERT INTO wpa_projects (id,workspace_id,entitlement_user_id,name,origin,locale,verification_token,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",name,origin,locale,verified_at AS "verifiedAt",verification_token AS "verificationToken",created_at AS "createdAt"`,
                [projectId, workspaceId, entitlementUserId, project.name, project.origin, project.locale, verificationToken, idempotencyKey, requestFingerprint]
            );
            await client.query('COMMIT');
            return operationResult(rows[0], idempotencyKey, false);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async listProjects(workspaceId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",name,origin,locale,verified_at AS "verifiedAt",verification_method AS "verificationMethod",verification_checked_at AS "verificationCheckedAt",verification_expires_at AS "verificationExpiresAt",verification_revoked_at AS "verificationRevokedAt",verification_token AS "verificationToken",created_at AS "createdAt" FROM wpa_projects WHERE workspace_id=$1 ORDER BY created_at DESC', [workspaceId]);
        return rows;
    }

    async countProjects(entitlementUserId) {
        const { rows } = await this.pool.query('SELECT count(*)::int AS count FROM wpa_projects WHERE entitlement_user_id=$1', [entitlementUserId]);
        return rows[0].count;
    }

    async getProject(workspaceId, projectId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",name,origin,locale,verified_at AS "verifiedAt",verification_method AS "verificationMethod",verification_checked_at AS "verificationCheckedAt",verification_expires_at AS "verificationExpiresAt",verification_revoked_at AS "verificationRevokedAt",verification_token AS "verificationToken",created_at AS "createdAt" FROM wpa_projects WHERE workspace_id=$1 AND id=$2', [workspaceId, projectId]);
        return rows[0] || null;
    }

    async verifyProject(workspaceId, projectId, method = 'operator', { checkedAt = null, expiresAt = null } = {}) {
        const { rows } = await this.pool.query('UPDATE wpa_projects SET verified_at = COALESCE($3::timestamptz,now()), verification_method = $4, verification_checked_at = COALESCE($3::timestamptz,now()), verification_expires_at = $5::timestamptz, verification_revoked_at = NULL WHERE workspace_id = $1 AND id = $2 RETURNING id, workspace_id AS "workspaceId", name, origin, locale, verified_at AS "verifiedAt", verification_method AS "verificationMethod", verification_checked_at AS "verificationCheckedAt", verification_expires_at AS "verificationExpiresAt", verification_revoked_at AS "verificationRevokedAt"', [workspaceId, projectId, checkedAt, method, expiresAt]);
        return rows[0] || null;
    }
    async revokeProjectVerification(workspaceId, projectId, revokedAt = new Date().toISOString()) {
        const { rows } = await this.pool.query('UPDATE wpa_projects SET verified_at=NULL,verification_revoked_at=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS "workspaceId",name,origin,locale,verified_at AS "verifiedAt",verification_method AS "verificationMethod",verification_checked_at AS "verificationCheckedAt",verification_expires_at AS "verificationExpiresAt",verification_revoked_at AS "verificationRevokedAt"', [workspaceId, projectId, revokedAt]);
        return rows[0] || null;
    }

    async createScan(workspaceId, projectId, manifest, options = {}) {
        const { idempotencyKey, requestFingerprint } = operationOptions(options);
        const entitlementUserId = options.entitlementUserId || await this.resolveEntitlementUser(workspaceId, options.requestedByUserId || null);
        const create = async (client) => {
            if (idempotencyKey) {
                const existing = (await client.query(
                    `SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,manifest,failure_code AS "failureCode",created_at AS "createdAt",updated_at AS "updatedAt",idempotency_key AS "idempotencyKey",request_fingerprint AS "requestFingerprint"
                     FROM wpa_scans WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
                    [workspaceId, idempotencyKey]
                )).rows[0];
                if (existing) {
                    assertIdempotentReplay(existing.requestFingerprint, requestFingerprint);
                    const record = { ...existing };
                    delete record.idempotencyKey;
                    delete record.requestFingerprint;
                    return operationResult(record, idempotencyKey, true);
                }
            }
            const scanId = id('scan');
            const { rows } = await client.query(
                `INSERT INTO wpa_scans(id,workspace_id,project_id,requested_by_user_id,entitlement_user_id,status,manifest,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,'queued',$6::jsonb,$7,$8)
                 RETURNING id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,manifest,created_at AS "createdAt",updated_at AS "updatedAt"`,
                [scanId, workspaceId, projectId, options.requestedByUserId || null, entitlementUserId, JSON.stringify(manifest), idempotencyKey, requestFingerprint]
            );
            return operationResult(rows[0], idempotencyKey, false);
        };
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (idempotencyKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scan-create:${workspaceId}:${idempotencyKey}`]);
            const result = await create(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async getScan(workspaceId, scanId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,manifest,failure_code AS "failureCode",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt",updated_at AS "updatedAt" FROM wpa_scans WHERE workspace_id=$1 AND id=$2', [workspaceId, scanId]);
        return rows[0] || null;
    }

    async listScans(workspaceId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,manifest,failure_code AS "failureCode",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt",updated_at AS "updatedAt" FROM wpa_scans WHERE workspace_id=$1 ORDER BY created_at DESC', [workspaceId]);
        return rows;
    }

    async listRecoverableScans() {
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",requested_by_user_id AS "requestedByUserId",entitlement_user_id AS "entitlementUserId",status,manifest,failure_code AS "failureCode",created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt",updated_at AS "updatedAt" FROM wpa_scans WHERE status IN ('queued','running') ORDER BY created_at`);
        return rows;
    }

    async updateScan(workspaceId, scanId, patch, options = {}) {
        const current = await this.getScan(workspaceId, scanId);
        if (!current) return null;
        const next = { ...current, ...patch };
        const expected = options?.expectedStatuses || (options?.expectedStatus ? [options.expectedStatus] : null);
        const values = [workspaceId, scanId, next.status, next.failureCode || null, next.startedAt || null, next.completedAt || null];
        let where = 'workspace_id=$1 AND id=$2 AND NOT (status=\'cancelled\' AND $3 <> \'cancelled\')';
        if (expected?.length) {
            values.push(expected);
            where += ` AND status = ANY($${values.length}::text[])`;
        }
        const { rows } = await this.pool.query(
            `UPDATE wpa_scans SET status=$3, failure_code=$4, started_at=$5, completed_at=$6, updated_at=now()
             WHERE ${where}
             RETURNING id, workspace_id AS "workspaceId", project_id AS "projectId", status, manifest, failure_code AS "failureCode", created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"`,
            values
        );
        return rows[0] || null;
    }

    async createScanPages(workspaceId, scanId, urls, { maxAttempts = 3, provenanceByUrl = null } = {}) {
        const entries = [...new Map((urls || []).map((rawUrl) => {
            const entry = normalizedPageEntry(rawUrl);
            entry.discovery = mergePageDiscovery(entry.discovery, discoveryForUrl(provenanceByUrl, rawUrl, entry.url));
            return [entry.pageKey, entry];
        })).values()];
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const locked = await client.query('SELECT id FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId]);
            if (!locked.rows[0]) { await client.query('ROLLBACK'); return []; }
            let nextPageIndex = Number((await client.query('SELECT COALESCE(max(page_index),-1)::int + 1 AS next FROM wpa_scan_pages WHERE workspace_id=$1 AND scan_id=$2', [workspaceId, scanId])).rows[0].next);
            for (const entry of entries) {
                const existing = (await client.query('SELECT discovery FROM wpa_scan_pages WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3', [workspaceId, scanId, entry.pageKey])).rows[0];
                if (existing) {
                    const discovery = mergePageDiscovery(existing.discovery, entry.discovery);
                    await client.query('UPDATE wpa_scan_pages SET discovery=$4::jsonb,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3', [workspaceId, scanId, entry.pageKey, JSON.stringify(discovery)]);
                    continue;
                }
                await client.query(
                    `INSERT INTO wpa_scan_pages(scan_id,workspace_id,page_key,url,page_index,status,max_attempts,discovery)
                     VALUES($1,$2,$3,$4,$5,'queued',$6,$7::jsonb)`,
                    [scanId, workspaceId, entry.pageKey, entry.url, nextPageIndex++, maxAttempts, JSON.stringify(entry.discovery)]
                );
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        return this.listScanPages(workspaceId, scanId);
    }

    async appendScanPagesWithCredits(workspaceId, scanId, values, { maxAttempts = 3, pageLimit, creditLimit = pageLimit, now = new Date() } = {}) {
        const entries = [...new Map((values || []).map((value) => {
            const entry = normalizedPageEntry(value);
            return [entry.pageKey, entry];
        })).values()];
        const boundedPageLimit = Math.max(0, Math.floor(Number(pageLimit) || 0));
        const boundedCreditLimit = Math.max(0, Math.floor(Number(creditLimit) || 0));
        const periodStart = monthStart(now);
        const client = await this.pool.connect();
        const acceptedKeys = new Set();
        const insertedKeys = new Set();
        const rejected = [];
        try {
            await client.query('BEGIN');
            const scan = (await client.query('SELECT id,status,entitlement_user_id AS "entitlementUserId" FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId])).rows[0];
            if (!scan || !['queued', 'running'].includes(scan.status)) {
                await client.query('COMMIT');
                return { pages: [], inserted: [], rejected: entries.map((entry) => ({ url: entry.url, reason: 'scan_terminal' })), idempotent: true, limitReached: false };
            }
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`page-credit:${scan.entitlementUserId}`]);
            const existingPages = (await client.query('SELECT page_key AS "pageKey",url,page_index AS "pageIndex",discovery FROM wpa_scan_pages WHERE workspace_id=$1 AND scan_id=$2 ORDER BY page_index FOR UPDATE', [workspaceId, scanId])).rows;
            const pagesByKey = new Map(existingPages.map((page) => [page.pageKey, page]));
            const credits = (await client.query('SELECT credit_key AS "creditKey",state FROM wpa_credit_entries WHERE workspace_id=$1 AND scan_id=$2 FOR UPDATE', [workspaceId, scanId])).rows;
            const creditsByKey = new Map(credits.map((credit) => [credit.creditKey, credit]));
            let usedCredits = Number((await client.query("SELECT COALESCE(sum(amount),0)::int AS used FROM wpa_credit_entries WHERE entitlement_user_id=$1 AND period_start=$2 AND state IN ('reserved','consumed')", [scan.entitlementUserId, periodStart])).rows[0].used);
            let pageCount = existingPages.length;
            let nextPageIndex = existingPages.reduce((max, page) => Math.max(max, Number(page.pageIndex)), -1) + 1;
            for (const entry of entries) {
                const existing = pagesByKey.get(entry.pageKey);
                if (existing) {
                    const discovery = mergePageDiscovery(existing.discovery, entry.discovery);
                    await client.query('UPDATE wpa_scan_pages SET discovery=$4::jsonb,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3', [workspaceId, scanId, entry.pageKey, JSON.stringify(discovery)]);
                    existing.discovery = discovery;
                    acceptedKeys.add(entry.pageKey);
                    continue;
                }
                if (pageCount >= boundedPageLimit) { rejected.push({ url: entry.url, reason: 'scan_page_limit' }); continue; }
                const existingCredit = creditsByKey.get(entry.url);
                if (existingCredit?.state === 'released') { rejected.push({ url: entry.url, reason: 'credit_released' }); continue; }
                if (!existingCredit && usedCredits >= boundedCreditLimit) { rejected.push({ url: entry.url, reason: 'monthly_credit_limit' }); continue; }
                if (!existingCredit) {
                    const credit = (await client.query("INSERT INTO wpa_credit_entries(id,workspace_id,entitlement_user_id,scan_id,credit_key,period_start,state) VALUES($1,$2,$3,$4,$5,$6,'reserved') RETURNING credit_key AS \"creditKey\",state", [id('credit'), workspaceId, scan.entitlementUserId, scanId, entry.url, periodStart])).rows[0];
                    creditsByKey.set(entry.url, credit);
                    usedCredits += 1;
                }
                await client.query(
                    `INSERT INTO wpa_scan_pages(scan_id,workspace_id,page_key,url,page_index,status,max_attempts,discovery)
                     VALUES($1,$2,$3,$4,$5,'queued',$6,$7::jsonb)`,
                    [scanId, workspaceId, entry.pageKey, entry.url, nextPageIndex++, maxAttempts, JSON.stringify(entry.discovery)]
                );
                pageCount += 1;
                acceptedKeys.add(entry.pageKey);
                insertedKeys.add(entry.pageKey);
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        const pages = (await this.listScanPages(workspaceId, scanId)).filter((page) => acceptedKeys.has(page.pageKey));
        return {
            pages,
            inserted: pages.filter((page) => insertedKeys.has(page.pageKey)),
            rejected,
            idempotent: insertedKeys.size === 0,
            limitReached: rejected.some((entry) => ['scan_page_limit', 'monthly_credit_limit'].includes(entry.reason))
        };
    }

    async listScanPages(workspaceId, scanId) {
        const { rows } = await this.pool.query(
            `SELECT scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",url,page_index AS "pageIndex",status,attempts,max_attempts AS "maxAttempts",lease_expires_at AS "leaseExpiresAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",report,error_code AS "errorCode",discovery,created_at AS "createdAt",updated_at AS "updatedAt"
             FROM wpa_scan_pages WHERE workspace_id=$1 AND scan_id=$2 ORDER BY page_index`, [workspaceId, scanId]
        );
        return rows;
    }

    async claimScanPage(workspaceId, scanId, pageKey, { leaseMs = 120_000, owner = 'legacy-worker' } = {}) {
        const leaseToken = crypto.randomUUID();
        const { rows } = await this.pool.query(
            `UPDATE wpa_scan_pages SET status='running',attempts=attempts+1,lease_expires_at=now()+($4::text || ' milliseconds')::interval,lease_owner=$5,lease_token=$6,updated_at=now()
             WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 AND attempts < max_attempts
               AND (status IN ('queued','retrying') OR (status='running' AND lease_expires_at <= now()))
             RETURNING scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",url,page_index AS "pageIndex",status,attempts,max_attempts AS "maxAttempts",lease_expires_at AS "leaseExpiresAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",report,error_code AS "errorCode",discovery,created_at AS "createdAt",updated_at AS "updatedAt"`,
            [workspaceId, scanId, pageKey, leaseMs, String(owner), leaseToken]
        );
        if (rows[0]) return rows[0];
        await this.pool.query(`UPDATE wpa_scan_pages SET status='failed',error_code=COALESCE(error_code,'PAGE_RETRY_EXHAUSTED'),lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 AND attempts >= max_attempts AND status NOT IN ('completed','incomplete','failed','unavailable','cancelled')`, [workspaceId, scanId, pageKey]);
        return null;
    }

    async completeScanPage(workspaceId, scanId, pageKey, patch) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_scan_pages SET status=$4,report=$5::jsonb,error_code=$6,lease_expires_at=NULL,lease_owner=NULL,lease_token=NULL,updated_at=now()
             WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 AND status NOT IN ('completed','incomplete','failed','unavailable','cancelled')
               AND ((lease_owner=$7 AND lease_token=$8) OR ($7='legacy-worker' AND lease_owner='legacy-worker'))
             RETURNING scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",url,page_index AS "pageIndex",status,attempts,max_attempts AS "maxAttempts",lease_expires_at AS "leaseExpiresAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",report,error_code AS "errorCode",discovery,created_at AS "createdAt",updated_at AS "updatedAt"`,
            [workspaceId, scanId, pageKey, patch.status, patch.report ? JSON.stringify(patch.report) : null, patch.errorCode || null, patch.leaseOwner || 'legacy-worker', patch.leaseToken || null]
        );
        return rows[0] || null;
    }

    async renewScanPageLease(workspaceId, scanId, pageKey, { owner, leaseToken, leaseMs = 120_000 } = {}) {
        const { rows } = await this.pool.query(
            `UPDATE wpa_scan_pages SET lease_expires_at=now()+($6::int * interval '1 millisecond'),updated_at=now()
             WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 AND status='running' AND lease_owner=$4 AND lease_token=$5
             RETURNING scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",status,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",updated_at AS "updatedAt"`,
            [workspaceId, scanId, pageKey, String(owner), String(leaseToken), Math.max(1_000, Number(leaseMs) || 120_000)]
        );
        return rows[0] || null;
    }

    async completeScanPageAndSettleCredit(workspaceId, scanId, pageKey, patch = {}) {
        const client = await this.pool.connect();
        const pageSelect = `SELECT scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",url,page_index AS "pageIndex",status,attempts,max_attempts AS "maxAttempts",lease_expires_at AS "leaseExpiresAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",report,error_code AS "errorCode",discovery,created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_scan_pages`;
        try {
            await client.query('BEGIN');
            const scan = (await client.query('SELECT id,status FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId])).rows[0];
            if (!scan) { await client.query('COMMIT'); return null; }
            const page = (await client.query(`${pageSelect} WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 FOR UPDATE`, [workspaceId, scanId, pageKey])).rows[0];
            if (!page) { await client.query('COMMIT'); return null; }
            const creditState = ['consumed', 'released'].includes(patch.creditState) ? patch.creditState : 'consumed';
            let credit = patch.creditKey
                ? (await client.query('SELECT * FROM wpa_credit_entries WHERE workspace_id=$1 AND scan_id=$2 AND credit_key=$3 FOR UPDATE', [workspaceId, scanId, patch.creditKey])).rows[0] || null
                : null;
            if (scan.status === 'cancelled' || PAGE_TERMINAL_STORE.has(page.status)) {
                if (credit?.state === 'reserved') {
                    const settled = (await client.query('UPDATE wpa_credit_entries SET state=$4,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND credit_key=$3 AND state=\'reserved\' RETURNING *', [workspaceId, scanId, patch.creditKey, page.status === 'cancelled' || scan.status === 'cancelled' ? 'released' : creditState])).rows[0];
                    credit = settled || credit;
                }
                await client.query('COMMIT');
                return { page, credit, idempotent: true };
            }
            const owner = patch.leaseOwner || 'legacy-worker';
            const token = patch.leaseToken || null;
            if (page.leaseOwner && (page.leaseOwner !== owner || (page.leaseToken && token !== page.leaseToken))) {
                await client.query('COMMIT');
                return null;
            }
            const updated = (await client.query(
                `UPDATE wpa_scan_pages SET status=$4,report=$5::jsonb,error_code=$6,lease_expires_at=NULL,lease_owner=NULL,lease_token=NULL,updated_at=now()
                 WHERE workspace_id=$1 AND scan_id=$2 AND page_key=$3 AND status NOT IN ('completed','incomplete','failed','unavailable','cancelled') AND ((lease_owner=$7 AND lease_token=$8) OR ($7='legacy-worker' AND lease_owner='legacy-worker'))
                 RETURNING scan_id AS "scanId",workspace_id AS "workspaceId",page_key AS "pageKey",url,page_index AS "pageIndex",status,attempts,max_attempts AS "maxAttempts",lease_expires_at AS "leaseExpiresAt",lease_owner AS "leaseOwner",lease_token AS "leaseToken",report,error_code AS "errorCode",discovery,created_at AS "createdAt",updated_at AS "updatedAt"`,
                [workspaceId, scanId, pageKey, patch.status, patch.report ? JSON.stringify(patch.report) : null, patch.errorCode || null, owner, token]
            )).rows[0];
            if (!updated) { await client.query('COMMIT'); return null; }
            if (credit?.state === 'reserved') {
                const settled = (await client.query('UPDATE wpa_credit_entries SET state=$4,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND credit_key=$3 AND state=\'reserved\' RETURNING *', [workspaceId, scanId, patch.creditKey, creditState])).rows[0];
                credit = settled || credit;
            }
            await client.query('COMMIT');
            return { page: updated, credit, idempotent: false };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async appendScanEvent(workspaceId, scanId, type, payload = {}) {
        const { rows } = await this.pool.query(`INSERT INTO wpa_scan_events(workspace_id,scan_id,type,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id,scan_id AS "scanId",workspace_id AS "workspaceId",type,payload,created_at AS "createdAt"`, [workspaceId, scanId, type, JSON.stringify(payload)]);
        if (this.scanEventTrimPrivilege !== false) {
            try {
                await this.pool.query(`DELETE FROM wpa_scan_events WHERE scan_id=$1 AND id IN (SELECT id FROM wpa_scan_events WHERE scan_id=$1 ORDER BY id DESC OFFSET 200)`, [scanId]);
                this.scanEventTrimPrivilege = true;
            } catch (error) {
                if (error?.code !== '42501') throw error;
                this.scanEventTrimPrivilege = false;
            }
        }
        return rows[0];
    }

    async listScanEvents(workspaceId, scanId, { after = 0, limit = 200 } = {}) {
        const { rows } = await this.pool.query(`SELECT id,scan_id AS "scanId",workspace_id AS "workspaceId",type,payload,created_at AS "createdAt" FROM wpa_scan_events WHERE workspace_id=$1 AND scan_id=$2 AND id>$3 ORDER BY id LIMIT $4`, [workspaceId, scanId, after, Math.min(200, limit)]);
        return rows;
    }

    async saveReportOnce(workspaceId, scanId, payload, options = {}) {
        const reportId = id('rpt');
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_reports(id,workspace_id,scan_id,version,status,locale,payload)
             SELECT $1,$2,$3,1,$4,$5,$6::jsonb
             WHERE NOT EXISTS (SELECT 1 FROM wpa_reports WHERE workspace_id=$2 AND scan_id=$3)
             ON CONFLICT(scan_id,version) DO NOTHING
             RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,share_token_hash AS "shareTokenHash",published_at AS "publishedAt",created_at AS "createdAt"`,
            [reportId, workspaceId, scanId, options.status || 'automated_draft', options.locale || 'en', JSON.stringify(payload)]
        );
        return rows[0] || this.getLatestReportForScan(workspaceId, scanId);
    }

    async reserveCredit(workspaceId, scanId, creditKey, limit, now = new Date(), entitlementUserId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const scan = (await client.query('SELECT entitlement_user_id AS "entitlementUserId" FROM wpa_scans WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, scanId])).rows[0];
            if (!scan) { await client.query('ROLLBACK'); return null; }
            const quotaOwner = entitlementUserId || scan.entitlementUserId;
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`page-credit:${quotaOwner}`]);
            const periodStart = monthStart(now);
            const existing = await client.query('SELECT * FROM wpa_credit_entries WHERE scan_id=$1 AND credit_key=$2', [scanId, creditKey]);
            if (existing.rows[0]) { await client.query('COMMIT'); return existing.rows[0]; }
            const usage = await client.query("SELECT COALESCE(sum(amount),0)::int AS used FROM wpa_credit_entries WHERE entitlement_user_id=$1 AND period_start=$2 AND state IN ('reserved','consumed')", [quotaOwner, periodStart]);
            if (usage.rows[0].used >= limit) throw new AppError('The monthly page credit limit has been reached.', { status: 402, code: 'PAGE_CREDIT_LIMIT_REACHED' });
            const entryId = id('credit');
            const { rows } = await client.query("INSERT INTO wpa_credit_entries (id,workspace_id,entitlement_user_id,scan_id,credit_key,period_start,state) VALUES ($1,$2,$3,$4,$5,$6,'reserved') RETURNING *", [entryId, workspaceId, quotaOwner, scanId, creditKey, periodStart]);
            await client.query('COMMIT');
            return rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async settleCredit(workspaceId, scanId, creditKey, state) {
        const { rows } = await this.pool.query("UPDATE wpa_credit_entries SET state=$4,updated_at=now() WHERE workspace_id=$1 AND scan_id=$2 AND credit_key=$3 AND state='reserved' RETURNING *", [workspaceId, scanId, creditKey, state]);
        return rows[0] || null;
    }

    async getUsage(entitlementUserId, now = new Date()) {
        const periodStart = monthStart(now);
        const { rows } = await this.pool.query("SELECT state, COALESCE(sum(amount),0)::int AS count FROM wpa_credit_entries WHERE entitlement_user_id=$1 AND period_start=$2 GROUP BY state", [entitlementUserId, periodStart]);
        const count = (state) => rows.find((row) => row.state === state)?.count || 0;
        return { periodStart, reserved: count('reserved'), consumed: count('consumed') };
    }

    async saveReport(workspaceId, scanId, payload, { locale = 'en', status = 'automated_draft' } = {}) {
        const reportId = id('rpt');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Serialize versions per scan so two operator/publish requests
            // cannot both calculate the same max(version)+1.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(scanId)]);
            const { rows } = await client.query("INSERT INTO wpa_reports (id,workspace_id,scan_id,version,status,locale,payload) SELECT $1,$2,$3,COALESCE(max(version),0)+1,$4,$5,$6::jsonb FROM wpa_reports WHERE scan_id=$3 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\"", [reportId, workspaceId, scanId, status, locale, JSON.stringify(payload)]);
            await client.query('COMMIT');
            return rows[0];
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getReport(workspaceId, reportId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND id=$2', [workspaceId, reportId]);
        return rows[0] || null;
    }
    async getReportById(reportId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE id=$1', [reportId]);
        return rows[0] || null;
    }

    async listReports(workspaceId, { limit = 50, before } = {}) {
        const bounded = Math.min(1_000, Math.max(1, Number(limit) || 50));
        const { rows } = await this.pool.query('SELECT id,scan_id AS "scanId",version,status,locale,payload,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz) ORDER BY created_at DESC,version DESC LIMIT $3', [workspaceId, before || null, bounded]);
        return rows;
    }

    async listReportSummaries(workspaceId, { limit = 50, cursor = null } = {}) {
        const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
        const createdAt = cursor?.createdAt || null;
        const reportId = cursor?.id || null;
        const { rows } = await this.pool.query(`SELECT id,scan_id AS "scanId",version,status,locale,payload->'summary' AS summary,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`, [workspaceId, createdAt, reportId, bounded + 1]);
        const page = rows.slice(0, bounded);
        Object.defineProperty(page, 'nextCursor', { value: rows.length > bounded && page.at(-1) ? { createdAt: page.at(-1).createdAt, id: page.at(-1).id } : null, enumerable: false });
        return page;
    }

    async updateReport(workspaceId, reportId, patch, { expectedVersion = null } = {}) {
        const current = await this.getReport(workspaceId, reportId);
        if (!current) return null;
        if (expectedVersion !== null && (current.revision ?? current.version) !== expectedVersion) return null;
        const next = { ...current, ...patch };
        const values = [workspaceId, reportId, next.status, JSON.stringify(next.payload), next.publishedAt || null];
        const compare = expectedVersion === null ? null : Number(current.revision || current.version);
        const versionClause = compare === null ? '' : ` AND revision=$${values.push(compare)}`;
        const { rows } = await this.pool.query(`UPDATE wpa_reports SET status=$3,payload=$4::jsonb,published_at=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2${versionClause} RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,created_at AS "createdAt",published_at AS "publishedAt"`, values);
        return rows[0] || null;
    }

    async publishReportWithAudit(workspaceId, reportId, { actorId, reason, requestId } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const publication = await publishReportTransaction(client, workspaceId, reportId, { actorId, reason: reason.trim(), requestId });
            if (!publication) { await client.query('ROLLBACK'); return null; }
            await client.query('COMMIT');
            return publication;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async finalizeExpertReviewWithAudit(reviewId, { payload, locale, actorId, reason, requestId, expectedUpdatedAt = null } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_expert_reviews WHERE id=$1 FOR UPDATE', [reviewId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            if (before.status === 'ready_to_publish') {
                const report = (await client.query("SELECT id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\",published_at AS \"publishedAt\" FROM wpa_reports WHERE workspace_id=$1 AND scan_id=$2 AND status='expert_reviewed' ORDER BY version DESC LIMIT 1", [before.workspaceId, before.scanId])).rows[0] || null;
                await client.query('COMMIT');
                return { review: { ...before, expertReportId: report?.id || null }, report, idempotent: true };
            }
            if (before.status !== 'in_review' || before.assignedTo !== actorId) throw new AppError('Only the assigned reviewer can finalize this review.', { status: 409, code: 'EXPERT_REVIEW_NOT_ASSIGNED' });
            if (expectedUpdatedAt && new Date(before.updatedAt).getTime() !== new Date(expectedUpdatedAt).getTime()) throw new AppError('The Expert Review changed while it was being finalized.', { status: 409, code: 'EXPERT_REVIEW_UPDATE_CONFLICT' });
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(before.scanId)]);
            const reportId = id('rpt');
            const report = (await client.query("INSERT INTO wpa_reports(id,workspace_id,scan_id,version,status,locale,payload) SELECT $1,$2,$3,COALESCE(max(version),0)+1,'expert_reviewed',$4,$5::jsonb FROM wpa_reports WHERE scan_id=$3 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\",published_at AS \"publishedAt\"", [reportId, before.workspaceId, before.scanId, locale, JSON.stringify(payload)])).rows[0];
            const after = (await client.query("UPDATE wpa_expert_reviews SET status='ready_to_publish',completed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",source_report_id AS \"sourceReportId\",status,scope_page_urls AS \"scopePageUrls\",decisions,roadmap,requested_by AS \"requestedBy\",assigned_to AS \"assignedTo\",due_at AS \"dueAt\",completed_at AS \"completedAt\",created_at AS \"createdAt\",updated_at AS \"updatedAt\"", [reviewId])).rows[0];
            await insertAuditRecord(client, { workspaceId: before.workspaceId, actorId, action: 'expert_review.finalized', entityType: 'expert_review', entityId: reviewId, reason: reason.trim(), requestId, before, after: { ...after, reportId: report.id }, metadata: { reportId: report.id } });
            await client.query('COMMIT');
            return { review: { ...after, expertReportId: report.id }, report, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async publishExpertReviewWithAudit(reviewId, reportId, { actorId, reason, requestId } = {}) {
        if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",source_report_id AS "sourceReportId",status,scope_page_urls AS "scopePageUrls",decisions,roadmap,requested_by AS "requestedBy",assigned_to AS "assignedTo",due_at AS "dueAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wpa_expert_reviews WHERE id=$1 FOR UPDATE', [reviewId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            if (before.status === 'published') {
                const report = (await client.query("SELECT id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\",published_at AS \"publishedAt\" FROM wpa_reports WHERE workspace_id=$1 AND scan_id=$2 AND status='published' ORDER BY version DESC LIMIT 1", [before.workspaceId, before.scanId])).rows[0] || null;
                await client.query('COMMIT');
                return { review: before, report, idempotent: true };
            }
            if (before.status !== 'ready_to_publish' || !reportId) throw new AppError('Finalize the Expert Review before publication.', { status: 409, code: 'EXPERT_REVIEW_NOT_READY' });
            const source = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",status FROM wpa_reports WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [before.workspaceId, reportId])).rows[0];
            if (!source || source.scanId !== before.scanId || source.status !== 'expert_reviewed') throw new AppError('The Expert Review report is not publishable.', { status: 409, code: 'EXPERT_REVIEW_NOT_READY' });
            const publication = await publishReportTransaction(client, before.workspaceId, reportId, { actorId, reason: reason.trim(), requestId });
            const after = (await client.query("UPDATE wpa_expert_reviews SET status='published',updated_at=now() WHERE id=$1 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",source_report_id AS \"sourceReportId\",status,scope_page_urls AS \"scopePageUrls\",decisions,roadmap,requested_by AS \"requestedBy\",assigned_to AS \"assignedTo\",due_at AS \"dueAt\",completed_at AS \"completedAt\",created_at AS \"createdAt\",updated_at AS \"updatedAt\"", [reviewId])).rows[0];
            await insertAuditRecord(client, { workspaceId: before.workspaceId, actorId, action: 'expert_review.published', entityType: 'expert_review', entityId: reviewId, reason: reason.trim(), requestId, before, after: { ...after, reportId: publication.report.id }, metadata: { reportId: publication.report.id } });
            await client.query('COMMIT');
            return { review: after, report: publication.report, idempotent: false };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async getLatestReportForScan(workspaceId, scanId) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE workspace_id=$1 AND scan_id=$2 ORDER BY version DESC LIMIT 1', [workspaceId, scanId]);
        return rows[0] || null;
    }

    async setReportShareToken(workspaceId, reportId, tokenHash, { expiresAt = null, createdAt = new Date().toISOString() } = {}) {
        const { rows } = await this.pool.query('UPDATE wpa_reports SET share_token_hash=$3,share_expires_at=$4,share_revoked_at=NULL,share_created_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",version,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt"', [workspaceId, reportId, tokenHash, expiresAt, createdAt]);
        return rows[0] || null;
    }

    async getReportByShareToken(tokenHash) {
        const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports WHERE share_token_hash=$1', [tokenHash]);
        return rows[0] || null;
    }
    async revokeReportShare(workspaceId, reportId, revokedAt = new Date().toISOString()) {
        const { rows } = await this.pool.query('UPDATE wpa_reports SET share_revoked_at=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",version,status,locale,payload,share_token_hash AS "shareTokenHash",share_expires_at AS "shareExpiresAt",share_revoked_at AS "shareRevokedAt",share_created_at AS "shareCreatedAt",created_at AS "createdAt",published_at AS "publishedAt"', [workspaceId, reportId, revokedAt]);
        return rows[0] || null;
    }

    async pendingOperatorTasksForScan(scanId) {
        const { rows } = await this.pool.query("SELECT id FROM wpa_operator_tasks WHERE scan_id=$1 AND status='pending'", [scanId]);
        return rows;
    }

    async createOperatorTasks(workspaceId, scanId, moduleIds, dueAt) {
        const created = [];
        for (const moduleId of moduleIds) {
            const taskId = id('task');
            const { rows } = await this.pool.query("INSERT INTO wpa_operator_tasks (id,workspace_id,scan_id,module_id,due_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scan_id,module_id) DO NOTHING RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",module_id AS \"moduleId\",status,due_at AS \"dueAt\",created_at AS \"createdAt\"", [taskId, workspaceId, scanId, moduleId, dueAt]);
            if (rows[0]) created.push(rows[0]);
        }
        return created;
    }

    async listOperatorTasks(status = 'pending') {
        const values = [];
        const where = status ? 'WHERE status=$1' : '';
        if (status) values.push(status);
        const { rows } = await this.pool.query(`SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",module_id AS "moduleId",status,notes,due_at AS "dueAt",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_operator_tasks ${where} ORDER BY created_at`, values);
        return rows;
    }

    async completeOperatorTask(taskId, { notes = '', reportPatch, actorId = 'operator', reason, requestId = null } = {}) {
        if (!reason?.trim()) throw new AppError('A reason is required.', { status: 400, code: 'ADMIN_REASON_REQUIRED' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const before = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",module_id AS "moduleId",status,notes,completed_by AS "completedBy",completed_at AS "completedAt" FROM wpa_operator_tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
            if (!before) { await client.query('ROLLBACK'); return null; }
            if (before.status === 'completed') { await client.query('COMMIT'); return before; }
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(before.scanId)]);
            let report = (await client.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,created_at AS "createdAt" FROM wpa_reports WHERE workspace_id=$1 AND scan_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE', [before.workspaceId, before.scanId])).rows[0] || null;
            if (report && reportPatch) {
                const payload = { ...report.payload, operatorEvidence: { ...(report.payload.operatorEvidence || {}), [before.moduleId]: reportPatch } };
                report = (await client.query('UPDATE wpa_reports SET payload=$3::jsonb,revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id AS "workspaceId",scan_id AS "scanId",version,revision,status,locale,payload,created_at AS "createdAt"', [before.workspaceId, report.id, JSON.stringify(payload)])).rows[0];
            }
            const task = (await client.query("UPDATE wpa_operator_tasks SET status='completed',notes=$2,completed_by=$3,completed_at=now() WHERE id=$1 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",module_id AS \"moduleId\",status,notes,completed_by AS \"completedBy\",completed_at AS \"completedAt\"", [taskId, notes, actorId])).rows[0];
            const pending = Number((await client.query("SELECT count(*)::int AS count FROM wpa_operator_tasks WHERE scan_id=$1 AND status='pending'", [task.scanId])).rows[0].count);
            let completedReport = null;
            let scanStatus = null;
            if (pending === 0) {
                if (report) {
                    const expertReviewed = task.moduleId === 'expert_review' || Boolean(report.payload.operatorEvidence?.expert_review);
                    const reportId = id('rpt');
                    completedReport = (await client.query("INSERT INTO wpa_reports(id,workspace_id,scan_id,version,status,locale,payload) SELECT $1,$2,$3,COALESCE(max(version),0)+1,$4,$5,$6::jsonb FROM wpa_reports WHERE scan_id=$3 RETURNING id,workspace_id AS \"workspaceId\",scan_id AS \"scanId\",version,revision,status,locale,payload,created_at AS \"createdAt\"", [reportId, task.workspaceId, task.scanId, expertReviewed ? 'expert_reviewed' : 'operator_completed', report.locale, JSON.stringify(report.payload)])).rows[0];
                }
                const scan = (await client.query("UPDATE wpa_scans SET status='completed',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING status", [task.workspaceId, task.scanId])).rows[0] || null;
                scanStatus = scan?.status || null;
            }
            await insertAuditRecord(client, {
                workspaceId: task.workspaceId,
                actorId,
                action: 'operator_task.completed',
                entityType: 'operator_task',
                entityId: task.id,
                reason: reason.trim(),
                requestId,
                before,
                after: task,
                metadata: { moduleId: task.moduleId, reportId: completedReport?.id || report?.id || null, scanStatus }
            });
            await client.query('COMMIT');
            return task;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async adminOverview() {
        const [usersResult, scansResult, reportsResult, payloadResult, activityResult] = await Promise.all([
            this.pool.query('SELECT count(*)::int AS count FROM "user"'),
            this.pool.query('SELECT count(*)::int AS count FROM wpa_scans'),
            this.pool.query('SELECT count(*)::int AS count FROM wpa_reports'),
            this.pool.query('SELECT payload FROM wpa_reports ORDER BY created_at DESC LIMIT 500'),
            this.pool.query('SELECT id,workspace_id AS "workspaceId",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",metadata,created_at AS "createdAt" FROM wpa_audit_log ORDER BY created_at DESC LIMIT 8')
        ]);
        const findings = payloadResult.rows.flatMap((row) => findingsFromPayload(row.payload));
        return {
            totals: {
                users: usersResult.rows[0].count,
                scans: scansResult.rows[0].count,
                reports: reportsResult.rows[0].count,
                findings: findings.length,
                critical: findings.filter((finding) => finding.severity === 'critical').length
            },
            activity: activityResult.rows
        };
    }

    async adminWorkspace(workspaceId) {
        const workspace = await this.getWorkspace(workspaceId);
        if (!workspace) return null;
        const entitlementUserId = await this.resolveEntitlementUser(workspaceId);
        const [subscription, effective, usage, grants, adjustments, projects, scans, aiUsage, tickets, audit] = await Promise.all([
            this.getSubscription(workspaceId), this.getEffectiveEntitlements(workspaceId), this.getUsage(entitlementUserId),
            this.pool.query('SELECT id,source,source_id AS "sourceId",temporary_plan_id AS "temporaryPlanId",entitlement_overrides AS "entitlementOverrides",bonus_page_credits AS "bonusPageCredits",bonus_ai_credits AS "bonusAiCredits",reason,created_by AS "createdBy",starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt",revoked_by AS "revokedBy",revoke_reason AS "revokeReason" FROM wpa_entitlement_grants WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId]),
            this.pool.query('SELECT id,credit_type AS "creditType",amount,reason,created_by AS "createdBy",request_id AS "requestId",expires_at AS "expiresAt",created_at AS "createdAt",revoked_at AS "revokedAt" FROM wpa_credit_adjustments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId]),
            this.pool.query('SELECT id,name,origin,locale,verified_at AS "verifiedAt",created_at AS "createdAt" FROM wpa_projects WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId]),
            this.pool.query('SELECT id,project_id AS "projectId",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt",updated_at AS "updatedAt" FROM wpa_scans WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId]),
            this.pool.query('SELECT id,user_id AS "userId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_ai_usage WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId]),
            this.pool.query('SELECT id,category,subject,status,priority,assigned_to AS "assignedTo",created_by AS "createdBy",created_at AS "createdAt",updated_at AS "updatedAt",last_message_at AS "lastMessageAt" FROM wpa_support_tickets WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 50', [workspaceId]),
            this.pool.query('SELECT id,actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",reason,request_id AS "requestId",before_state AS before,after_state AS after,metadata,created_at AS "createdAt" FROM wpa_audit_log WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [workspaceId])
        ]);
        return { workspace, subscription, effective, usage, grants: grants.rows, creditAdjustments: adjustments.rows, projects: projects.rows, recentScans: scans.rows.slice(0, 20).map(adminScanView), failedScans: scans.rows.filter((scan) => scan.status === 'failed').slice(0, 20).map(adminScanView), aiUsage: aiUsage.rows, supportTickets: tickets.rows, audit: audit.rows };
    }

    async adminUser(userId) {
        const user = await this.getCommercialUser(userId);
        if (!user) return null;
        const [stateResult, profile, effective, usage, grants, creditAdjustments, workspaces, subscription, aiUsage, audit] = await Promise.all([
            this.pool.query('SELECT "accountState" AS state,"stateChangedAt" AS "stateChangedAt","stateChangedBy" AS "stateChangedBy","stateReason" AS "stateReason","emailVerified" AS "emailVerified","twoFactorEnabled" AS "twoFactorEnabled" FROM "user" WHERE id=$1', [userId]),
            this.getUserCommercialProfile(userId),
            this.getUserEffectiveEntitlements(userId),
            this.getUsage(userId),
            this.listUserEntitlementGrants(userId),
            this.listUserCreditAdjustments(userId),
            this.pool.query(`SELECT id,name,state,entitlement_owner_user_id AS "entitlementOwnerUserId",created_at AS "createdAt" FROM wpa_workspaces WHERE entitlement_owner_user_id=$1 ORDER BY created_at`, [userId]),
            this.pool.query(`SELECT workspace_id AS "workspaceId",user_id AS "userId",provider,external_customer_id AS "providerCustomerId",external_subscription_id AS "providerSubscriptionId",billing_plan_id AS "billingPlanId",status,payment_status AS "paymentStatus",refund_status AS "refundStatus",access_state AS "accessState",current_period_end AS "currentPeriodEnd",cancel_at AS "cancelAt",scheduled_change AS "scheduledChange",updated_at AS "updatedAt" FROM wpa_subscriptions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId]),
            this.pool.query(`SELECT id,workspace_id AS "workspaceId",entitlement_user_id AS "entitlementUserId",user_id AS "requestedByUserId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_ai_usage WHERE entitlement_user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]),
            this.pool.query(`SELECT id,workspace_id AS "workspaceId",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",reason,request_id AS "requestId",before_state AS before,after_state AS after,metadata,created_at AS "createdAt" FROM wpa_audit_log WHERE entity_id=$1 OR metadata->>'targetUserId'=$1 ORDER BY created_at DESC LIMIT 100`, [userId])
        ]);
        return {
            user: { ...user, ...(stateResult.rows[0] || {}), state: stateResult.rows[0]?.state || 'active' },
            profile, effective, usage, grants, creditAdjustments,
            workspaces: workspaces.rows,
            subscription: subscription.rows[0] || null,
            aiUsage: aiUsage.rows,
            audit: audit.rows
        };
    }

    async adminResources(kind) {
        if (kind === 'users') {
            const { rows } = await this.pool.query(`SELECT u.id,u.name,u.email,u."emailVerified" AS "emailVerified",u."twoFactorEnabled" AS "twoFactorEnabled",u."accountState" AS state,u."stateChangedAt" AS "stateChangedAt",u."createdAt" AS "createdAt",COALESCE(p.plan_id,'free') AS "planId",GREATEST(u."updatedAt",COALESCE((SELECT max(s."updatedAt") FROM session s WHERE s."userId"=u.id),u."updatedAt"),COALESCE((SELECT max(a.created_at) FROM wpa_audit_log a WHERE a.actor_id=u.id OR a.entity_id=u.id OR a.metadata->>'targetUserId'=u.id),u."updatedAt")) AS "lastActivityAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'planId',COALESCE(owner_profile.plan_id,w.plan_id),'state',w.state) ORDER BY w.created_at) FROM wpa_workspaces w LEFT JOIN wpa_user_entitlement_profiles owner_profile ON owner_profile.user_id=w.entitlement_owner_user_id WHERE w.entitlement_owner_user_id=u.id OR EXISTS(SELECT 1 FROM wpa_memberships m WHERE m.workspace_id=w.id AND m.user_id=u.id)),'[]'::jsonb) AS workspaces FROM "user" u LEFT JOIN wpa_user_entitlement_profiles p ON p.user_id=u.id ORDER BY u."createdAt" DESC LIMIT 100`);
            return rows;
        }
        if (kind === 'workspaces') {
            const { rows } = await this.pool.query(`SELECT w.id,w.name,COALESCE(owner_profile.plan_id,w.plan_id) AS "planId",w.entitlement_owner_user_id AS "entitlementOwnerUserId",w.state,w.suspended_at AS "suspendedAt",w.created_at AS "createdAt",s.provider,s.status AS "billingStatus",s.access_state AS "billingAccessState",s.payment_status AS "paymentStatus",s.refund_status AS "refundStatus",(SELECT count(*)::int FROM wpa_projects p WHERE p.workspace_id=w.id) AS projects,(SELECT count(*)::int FROM wpa_scans sc WHERE sc.workspace_id=w.id) AS scans,(SELECT count(*)::int FROM wpa_scans sc WHERE sc.workspace_id=w.id AND sc.status='failed') AS "failedScans" FROM wpa_workspaces w LEFT JOIN wpa_user_entitlement_profiles owner_profile ON owner_profile.user_id=w.entitlement_owner_user_id LEFT JOIN wpa_subscriptions s ON s.workspace_id=w.id ORDER BY w.created_at DESC LIMIT 100`);
            return rows;
        }
        if (kind === 'grants') {
            const { rows } = await this.pool.query('SELECT g.id,g.user_id AS "userId",u.email AS "userEmail",g.workspace_id AS "workspaceId",g.source,g.temporary_plan_id AS "temporaryPlanId",g.entitlement_overrides AS "entitlementOverrides",g.bonus_page_credits AS "bonusPageCredits",g.bonus_ai_credits AS "bonusAiCredits",g.reason,g.created_by AS "createdBy",g.starts_at AS "startsAt",g.expires_at AS "expiresAt",g.created_at AS "createdAt",g.revoked_at AS "revokedAt" FROM wpa_entitlement_grants g LEFT JOIN "user" u ON u.id=g.user_id ORDER BY g.created_at DESC LIMIT 200');
            return rows;
        }
        if (kind === 'audit') {
            const { rows } = await this.pool.query(`SELECT a.id,a.workspace_id AS "workspaceId",a.actor_id AS "actorId",a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.reason,a.request_id AS "requestId",a.before_state AS before,a.after_state AS after,a.metadata,a.created_at AS "createdAt",
                CASE WHEN actor_user.id IS NOT NULL THEN jsonb_build_object('id',actor_user.id,'name',actor_user.name,'email',actor_user.email) WHEN a.actor_id IS NOT NULL THEN jsonb_build_object('id',a.actor_id,'name',NULL,'email',NULL) ELSE NULL END AS actor,
                CASE WHEN target_user.id IS NOT NULL THEN jsonb_build_object('id',target_user.id,'name',target_user.name,'email',target_user.email) WHEN target_identity.user_id IS NOT NULL THEN jsonb_build_object('id',target_identity.user_id,'name',NULL,'email',NULL) ELSE NULL END AS "targetUser"
                FROM wpa_audit_log a
                LEFT JOIN "user" actor_user ON actor_user.id=a.actor_id
                LEFT JOIN LATERAL (SELECT COALESCE(NULLIF(a.metadata->>'targetUserId',''),NULLIF(a.after_state->>'userId',''),NULLIF(a.after_state->>'entitlementUserId',''),NULLIF(a.before_state->>'userId',''),NULLIF(a.before_state->>'entitlementUserId',''),CASE WHEN a.entity_type IN ('user','user_entitlement_profile') THEN a.entity_id ELSE NULL END) AS user_id) target_identity ON TRUE
                LEFT JOIN "user" target_user ON target_user.id=target_identity.user_id
                ORDER BY a.created_at DESC LIMIT 200`);
            return rows;
        }
        if (kind === 'scans') {
            const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",project_id AS "projectId",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_scans ORDER BY created_at DESC LIMIT 100');
            return rows.map(adminScanView);
        }
        if (kind === 'ai_usage') {
            const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",user_id AS "userId",finding_fingerprint AS "findingFingerprint",requested_model AS "requestedModel",actual_model AS "actualModel",provider,prompt_version AS "promptVersion",evidence_version AS "evidenceVersion",usage_metadata AS "usageMetadata",cost_metadata AS "costMetadata",status,failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" FROM wpa_ai_usage ORDER BY created_at DESC LIMIT 200');
            return rows;
        }
        if (kind === 'reports') {
            const { rows } = await this.pool.query('SELECT id,workspace_id AS "workspaceId",scan_id AS "scanId",version,status,locale,created_at AS "createdAt",published_at AS "publishedAt" FROM wpa_reports ORDER BY created_at DESC LIMIT 100');
            return rows;
        }
        if (kind === 'findings') {
            const { rows } = await this.pool.query('SELECT id,payload,created_at AS "createdAt" FROM wpa_reports ORDER BY created_at DESC LIMIT 100');
            return rows.flatMap((report) => findingsFromPayload(report.payload).map((finding) => ({ ...finding, reportId: report.id, createdAt: report.createdAt }))).slice(0, 200);
        }
        return [];
    }
}

function createPlatformStore(config) {
    return config.databaseUrl ? new PostgresPlatformStore(config.databaseUrl, config) : new MemoryPlatformStore();
}

async function workspacePlan(store, workspaceId, requesterUserId = null) {
    const workspace = await store.ensureWorkspace(workspaceId);
    const entitlementUserId = typeof store.resolveEntitlementUser === 'function'
        ? await store.resolveEntitlementUser(workspaceId, requesterUserId)
        : workspaceId;
    if (typeof store.getUserEffectiveEntitlements === 'function') return store.getUserEffectiveEntitlements(entitlementUserId);
    if (typeof store.getEffectiveEntitlements === 'function') return store.getEffectiveEntitlements(workspaceId);
    return (await store.getPlan?.(workspace.planId)) || getPlan(workspace.planId) || getPlan('free');
}

module.exports = { MemoryPlatformStore, PostgresPlatformStore, composeEffectivePlan, createPlatformStore, findingsFromPayload, hashRedeemCode, monthStart, normalizeRedeemCode, sanitizeAuditValue, verifyRedeemCodeHash, workspacePlan };
