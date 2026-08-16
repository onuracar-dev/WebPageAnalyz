const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { runWithTimeout } = require('../lib/abort');
const { assertIdempotentReplay, normalizeIdempotencyKey, operationFingerprint } = require('../domain/idempotency');
const { createDefaultEngineRunners } = require('./engine-runners');

const ENGINE_CATALOG = Object.freeze([
    { id: 'lighthouse', label: 'Lighthouse', version: '13.4.1', owner: 'external', input: 'url', expectedSeconds: 90 },
    { id: 'axe', label: 'Axe Accessibility', version: '4.12.1', owner: 'external', input: 'url', expectedSeconds: 45 },
    { id: 'yellowLab', label: 'Yellow Lab Tools', version: 'current-api', owner: 'external', input: 'url', expectedSeconds: 120 },
    { id: 'playwright', label: 'Playwright Safe Browser', version: '1.62.1', owner: 'infrastructure', input: 'url', expectedSeconds: 45 },
    { id: 'wpaPage', label: 'WPA Page', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 60 },
    { id: 'crawler', label: 'WPA Site Crawler', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 90 },
    { id: 'performancePlus', label: 'Performance Plus', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 75 },
    { id: 'advancedGeo', label: 'Advanced GEO', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 75 },
    { id: 'visualUx', label: 'Visual UX', version: '1.0.0', owner: 'internal', input: 'url', expectedSeconds: 75 },
    { id: 'journey', label: 'Journey Test', version: '1.0.0', owner: 'internal', input: 'journey', expectedSeconds: 90 },
    { id: 'zapBaseline', label: 'OWASP ZAP Passive Baseline', version: '2.17.0', owner: 'external', input: 'url', expectedSeconds: 180 },
    { id: 'osvScanner', label: 'OSV Scanner', version: '2.3.8', owner: 'external', input: 'source_zip', expectedSeconds: 180 }
]);

const TERMINAL = new Set(['completed', 'failed', 'unavailable', 'cancelled']);
const RUN_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const UNAVAILABLE_CODES = new Set(['ZAP_UNAVAILABLE', 'OSV_UNAVAILABLE', 'ANALYZER_UNAVAILABLE', 'CHROME_NOT_FOUND']);
const RUN_ID = /^lab_[0-9a-f-]{36}$/i;

function safeMessage(error) {
    return String(error?.message || 'Engine execution failed.')
        .replace(/https?:\/\/[^\s?#]+\?[^\s]+/gi, (value) => value.split('?')[0])
        .replace(/(authorization|cookie|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/[A-Za-z]:\\[^\s,;]+/g, '[LOCAL_PATH]')
        .replace(/\/(?:home|Users|tmp|var\/tmp)\/[^\s,;]+/g, '[LOCAL_PATH]')
        .slice(0, 500);
}

function redactTargetUrl(value) {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function snapshot(run) {
    return {
        id: run.id,
        targetUrl: run.targetUrl,
        targetOrigin: run.targetOrigin,
        status: run.status,
        actorId: run.actorId,
        createdAt: run.createdAt,
        startedAt: run.startedAt || null,
        completedAt: run.completedAt || null,
        cancelledAt: run.cancelledAt || null,
        summary: run.summary,
        engines: run.engines.map((engine) => ({ ...engine, evidence: engine.evidence ? structuredClone(engine.evidence) : [] }))
    };
}

function listSnapshot(run) {
    return {
        id: run.id,
        targetUrl: run.targetUrl,
        targetOrigin: run.targetOrigin,
        status: run.status,
        actorId: run.actorId,
        createdAt: run.createdAt,
        startedAt: run.startedAt || null,
        completedAt: run.completedAt || null,
        cancelledAt: run.cancelledAt || null,
        summary: structuredClone(run.summary),
        engines: run.engines.map((engine) => ({
            engineId: engine.engineId,
            label: engine.label,
            version: engine.version,
            status: engine.status,
            progress: engine.progress,
            progressMode: engine.progressMode,
            phase: engine.phase,
            findingsCount: engine.findingsCount,
            error: engine.error ? { ...engine.error } : null,
            startedAt: engine.startedAt || null,
            completedAt: engine.completedAt || null
        }))
    };
}

function attachArtifactUrls(runId, engineId, evidence = []) {
    const screenshots = evidence.filter((item) => item?.kind === 'screenshot' && item?.filename).map((item) => ({
        ...item,
        artifactUrl: `/api/v1/admin/engine-lab/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(engineId)}/${encodeURIComponent(item.filename)}`
    }));
    const byDevice = new Map(screenshots.map((item) => [item.device, item]));
    return evidence.map((item) => {
        if (item?.kind === 'screenshot') return screenshots.find((screenshot) => screenshot.filename === item.filename) || item;
        if (item?.kind !== 'finding' || !Array.isArray(item.samples)) return item;
        return { ...item, samples: item.samples.map((sample) => {
            const device = /\.(desktop|mobile)$/.exec(String(sample?.ruleId || ''))?.[1] || sample?.device || 'unknown';
            const screenshot = byDevice.get(device) || (screenshots.length === 1 ? screenshots[0] : null);
            return screenshot ? { ...sample, device, artifactUrl: screenshot.artifactUrl } : sample;
        }) };
    });
}

function createEngineLabService({ config, logger, validateUrl, runners, audit, zapLock = null } = {}) {
    const runMap = new Map();
    const catalogById = new Map(ENGINE_CATALOG.map((engine) => [engine.id, engine]));
    const effectiveRunners = runners || createDefaultEngineRunners({ config, logger, zapLock });
    const maxConcurrency = Math.max(1, Math.min(Number(config.engineLabConcurrency || 3), 6));
    const serviceConfig = config.engineLab || {};
    const maxConcurrentRuns = Math.max(1, Math.min(Number(serviceConfig.maxConcurrentRuns || 1), 4));
    const maxQueuedRuns = Math.max(0, Math.min(Number(serviceConfig.maxQueuedRuns ?? 8), 100));
    const historyLimit = Math.max(1, Math.min(Number(serviceConfig.historyLimit || 50), 200));
    const artifactTtlMs = Math.max(60_000, Math.min(Number(serviceConfig.artifactTtlMs || 24 * 60 * 60_000), 7 * 24 * 60 * 60_000));
    const artifactJanitorMs = Math.max(60_000, Math.min(Number(serviceConfig.artifactJanitorMs || 15 * 60_000), 24 * 60 * 60_000));
    const shutdownDrainMs = Math.max(1_000, Math.min(Number(serviceConfig.shutdownDrainMs || 15_000), 60_000));
    const engineLabRoot = path.resolve(config.artifactDir || '.', 'engine-lab');
    const pendingRuns = [];
    const activeRuns = new Map();
    const idempotencyMap = new Map();
    let closing = false;
    let closePromise = null;
    let janitorRunning = false;

    function runArtifactDirectory(runId) {
        if (!RUN_ID.test(String(runId || ''))) throw new Error('Invalid Engine Lab run artifact identifier.');
        const directory = path.resolve(engineLabRoot, runId);
        if (!directory.startsWith(`${engineLabRoot}${path.sep}`)) throw new Error('Engine Lab artifact path escaped its managed root.');
        return directory;
    }

    async function removeRunArtifacts(runId) {
        try { await fs.rm(runArtifactDirectory(runId), { recursive: true, force: true }); }
        catch (error) { logger?.warn?.('Engine Lab artifact cleanup failed', { runId, errorCode: error?.code || 'ENGINE_LAB_ARTIFACT_CLEANUP_FAILED' }); }
    }

    function removeRunRecord(run) {
        runMap.delete(run.id);
        if (run.idempotencyKey && idempotencyMap.get(run.idempotencyKey)?.runId === run.id) idempotencyMap.delete(run.idempotencyKey);
        void removeRunArtifacts(run.id);
    }

    function evictTerminalHistory() {
        if (runMap.size <= historyLimit) return;
        const candidates = [...runMap.values()]
            .filter((run) => RUN_TERMINAL.has(run.status) && !activeRuns.has(run.id) && !pendingRuns.includes(run))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        while (runMap.size > historyLimit && candidates.length) removeRunRecord(candidates.shift());
    }

    async function cleanupExpiredArtifacts() {
        if (janitorRunning) return;
        janitorRunning = true;
        try {
            let entries;
            try {
                const rootStats = await fs.lstat(engineLabRoot);
                if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return;
                entries = await fs.readdir(engineLabRoot, { withFileTypes: true });
            } catch (error) {
                if (error?.code === 'ENOENT') return;
                throw error;
            }
            const cutoff = Date.now() - artifactTtlMs;
            for (const entry of entries) {
                if (!entry.isDirectory() || !RUN_ID.test(entry.name) || runMap.has(entry.name)) continue;
                const directory = runArtifactDirectory(entry.name);
                const stats = await fs.lstat(directory).catch(() => null);
                if (stats?.isDirectory() && !stats.isSymbolicLink() && stats.mtimeMs <= cutoff) await fs.rm(directory, { recursive: true, force: true });
            }
        } catch (error) {
            logger?.warn?.('Engine Lab artifact janitor failed', { errorCode: error?.code || 'ENGINE_LAB_ARTIFACT_JANITOR_FAILED' });
        } finally { janitorRunning = false; }
    }

    void cleanupExpiredArtifacts();
    const artifactJanitor = setInterval(() => void cleanupExpiredArtifacts(), artifactJanitorMs);
    artifactJanitor.unref?.();

    function getRun(id) {
        const run = runMap.get(id);
        if (!run) throw new AppError('Engine Lab run not found.', { status: 404, code: 'ENGINE_LAB_RUN_NOT_FOUND' });
        return snapshot(run);
    }

    function reconcile(run) {
        const statuses = run.engines.map((engine) => engine.status);
        if (run.controller.signal.aborted || run.cancelledAt) run.status = 'cancelled';
        else if (statuses.some((status) => !TERMINAL.has(status))) run.status = statuses.some((status) => status === 'running') ? 'running' : 'queued';
        else {
            const completed = statuses.filter((status) => status === 'completed').length;
            run.status = completed === statuses.length ? 'completed' : completed > 0 ? 'partial' : 'failed';
            run.completedAt ||= new Date().toISOString();
        }
        run.summary = Object.fromEntries(['queued', 'preflight', 'running', 'completed', 'failed', 'unavailable', 'cancelled'].map((status) => [status, statuses.filter((value) => value === status).length]));
    }

    function updateEngine(run, engine, patch) {
        if (TERMINAL.has(engine.status)) return;
        Object.assign(engine, patch, { updatedAt: new Date().toISOString() });
        reconcile(run);
    }

    async function executeEngine(run, engine) {
        if (run.controller.signal.aborted) { updateEngine(run, engine, { status: 'cancelled', progress: 100, phase: 'cancelled', completedAt: new Date().toISOString() }); return; }
        const definition = catalogById.get(engine.engineId);
        const runner = effectiveRunners[engine.engineId];
        updateEngine(run, engine, { status: 'preflight', progress: 5, phase: 'validating target' });
        try {
            const target = await validateUrl(run.executionUrl);
            if (typeof runner !== 'function') throw Object.assign(new Error(`${definition.label} runner is unavailable.`), { code: 'ANALYZER_UNAVAILABLE' });
            updateEngine(run, engine, { status: 'running', progress: 15, phase: 'engine running', startedAt: new Date().toISOString() });
            const timeoutMs = Math.max(10_000, Math.min((definition.expectedSeconds + 60) * 1000, 10 * 60 * 1000));
            const heartbeat = setInterval(() => {
                if (engine.status !== 'running') return;
                const elapsed = Date.now() - Date.parse(engine.startedAt);
                updateEngine(run, engine, { progress: Math.min(90, 15 + Math.round((elapsed / (definition.expectedSeconds * 1000)) * 70)), phase: 'engine running' });
            }, 1_000);
            heartbeat.unref?.();
            try {
                const result = await runWithTimeout((signal) => runner({
                    target, signal, journey: run.journey, sourceBuffer: engine.engineId === 'osvScanner' ? run.sourceBuffer : null,
                    crawlerLimit: run.crawlerLimit,
                    zapLock,
                    artifactDir: path.join(runArtifactDirectory(run.id), engine.engineId)
                }), timeoutMs, `${definition.label} Engine Lab run`, run.controller.signal);
                const evidence = attachArtifactUrls(run.id, engine.engineId, Array.isArray(result?.evidence) ? result.evidence : []);
                updateEngine(run, engine, { status: 'completed', progress: 100, phase: 'completed', completedAt: new Date().toISOString(), findingsCount: Number(result?.findingsCount || 0), evidence, metrics: result?.metrics || null, journey: result?.journey || null });
            } finally { clearInterval(heartbeat); }
        } catch (error) {
            const code = error?.code || (run.controller.signal.aborted ? 'ENGINE_LAB_CANCELLED' : 'ENGINE_FAILED');
            const status = run.controller.signal.aborted ? 'cancelled' : UNAVAILABLE_CODES.has(code) || code === 'ENOENT' ? 'unavailable' : 'failed';
            updateEngine(run, engine, { status, progress: 100, phase: status, completedAt: new Date().toISOString(), error: { code, message: safeMessage(error) } });
        }
    }

    async function executeRun(run) {
        run.status = 'running'; run.startedAt = new Date().toISOString(); reconcile(run);
        try {
            let index = 0;
            const workers = Array.from({ length: Math.min(maxConcurrency, run.engines.length) }, async () => {
                while (index < run.engines.length && !run.controller.signal.aborted) {
                    const current = run.engines[index++];
                    await executeEngine(run, current);
                }
            });
            await Promise.allSettled(workers);
        } finally {
            if (run.controller.signal.aborted) {
                for (const engine of run.engines) if (!TERMINAL.has(engine.status)) Object.assign(engine, { status: 'cancelled', progress: 100, phase: 'cancelled', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            }
            run.sourceBuffer?.fill(0); run.sourceBuffer = null;
            run.executionUrl = run.targetUrl;
            reconcile(run);
            try {
                await audit?.({ action: 'engine_lab.run_terminal', actorId: run.actorId, entityId: run.id, requestId: run.requestId, after: { status: run.status }, metadata: { status: run.status, targetOrigin: run.targetOrigin, engineIds: run.engines.map((engine) => engine.engineId), summary: run.summary } });
            } catch (error) {
                logger?.error?.('Engine Lab terminal audit failed', { runId: run.id, errorCode: error?.code || 'ENGINE_LAB_AUDIT_FAILED' });
            }
        }
    }

    function finalizeQueuedCancellation(run, reason) {
        const cancelledAt = run.cancelledAt || new Date().toISOString();
        run.cancelledAt = cancelledAt;
        if (!run.controller.signal.aborted) run.controller.abort(reason);
        for (const engine of run.engines) if (!TERMINAL.has(engine.status)) Object.assign(engine, { status: 'cancelled', progress: 100, phase: 'cancelled', completedAt: cancelledAt, updatedAt: cancelledAt });
        run.sourceBuffer?.fill(0); run.sourceBuffer = null;
        run.executionUrl = run.targetUrl;
        reconcile(run);
    }

    function scheduleRuns() {
        if (closing) return;
        while (activeRuns.size < maxConcurrentRuns && pendingRuns.length) {
            const run = pendingRuns.shift();
            if (!run || run.controller.signal.aborted || RUN_TERMINAL.has(run.status)) {
                if (run && !RUN_TERMINAL.has(run.status)) finalizeQueuedCancellation(run, Object.assign(new Error('Engine Lab run was cancelled before execution.'), { code: 'ENGINE_LAB_CANCELLED' }));
                continue;
            }
            const execution = Promise.resolve()
                .then(() => executeRun(run))
                .catch((error) => logger?.error?.('Engine Lab run failed outside an engine boundary', { runId: run.id, errorCode: error?.code || 'ENGINE_LAB_RUN_FAILED' }))
                .finally(() => {
                    activeRuns.delete(run.id);
                    if (closing) void removeRunArtifacts(run.id);
                    else {
                        evictTerminalHistory();
                        scheduleRuns();
                    }
                });
            activeRuns.set(run.id, execution);
        }
    }

    return {
        catalog() {
            return ENGINE_CATALOG.map((engine) => ({
                ...engine,
                progressMode: 'stage_estimate',
                configured: engine.id === 'zapBaseline' ? Boolean(config.zap?.url && config.zap?.apiKey) : engine.id === 'osvScanner' ? Boolean(config.osv?.executable && config.osv?.isolationRunner) : true
            }));
        },
        async createRun({ targetUrl, engineIds, journey, sourceBuffer, crawlerLimit, actorId, requestId, idempotencyKey, requestFingerprint }) {
            if (closing) throw new AppError('Engine Lab service is shutting down.', { status: 503, code: 'ENGINE_LAB_SERVICE_CLOSING', expose: true });
            const selected = [...new Set(engineIds || [])];
            if (!selected.length) throw new AppError('Select at least one Engine Lab engine.', { status: 400, code: 'ENGINE_LAB_ENGINE_REQUIRED' });
            if (selected.some((id) => !catalogById.has(id))) throw new AppError('An unknown Engine Lab engine was selected.', { status: 400, code: 'ENGINE_LAB_ENGINE_INVALID' });
            if (selected.includes('journey') && !journey) throw new AppError('Journey Test requires a validated read-only journey.', { status: 400, code: 'ENGINE_LAB_JOURNEY_REQUIRED' });
            if (selected.includes('osvScanner') && !Buffer.isBuffer(sourceBuffer)) throw new AppError('OSV Scanner requires a source ZIP.', { status: 400, code: 'ENGINE_LAB_SOURCE_REQUIRED' });
            const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey, { required: false });
            const fingerprint = requestFingerprint || operationFingerprint({
                targetUrl,
                engineIds: selected,
                journey: journey || null,
                crawlerLimit: Math.max(1, Math.min(Number(crawlerLimit || 25), 200)),
                sourceSha256: Buffer.isBuffer(sourceBuffer) ? crypto.createHash('sha256').update(sourceBuffer).digest('hex') : null
            });
            const prior = normalizedIdempotencyKey ? idempotencyMap.get(normalizedIdempotencyKey) : null;
            if (prior) {
                assertIdempotentReplay(prior.requestFingerprint, fingerprint);
                if (prior.runId && runMap.has(prior.runId)) return snapshot(runMap.get(prior.runId));
                if (prior.promise) return prior.promise;
                idempotencyMap.delete(normalizedIdempotencyKey);
            }
            const nonterminalRuns = [...runMap.values()].filter((run) => !RUN_TERMINAL.has(run.status)).length;
            if (nonterminalRuns >= maxConcurrentRuns + maxQueuedRuns) throw new AppError('Engine Lab execution queue is full.', { status: 429, code: 'ENGINE_LAB_QUEUE_FULL', expose: true });
            let resolveReservation;
            let rejectReservation;
            if (normalizedIdempotencyKey) {
                const promise = new Promise((resolve, reject) => { resolveReservation = resolve; rejectReservation = reject; });
                promise.catch(() => {});
                idempotencyMap.set(normalizedIdempotencyKey, { requestFingerprint: fingerprint, promise });
            }
            let target;
            try { target = await validateUrl(targetUrl); }
            catch (error) {
                if (normalizedIdempotencyKey) idempotencyMap.delete(normalizedIdempotencyKey);
                rejectReservation?.(error);
                throw error;
            }
            const now = new Date().toISOString();
            const run = {
                id: `lab_${crypto.randomUUID()}`, targetUrl: redactTargetUrl(target.url), executionUrl: target.url, targetOrigin: new URL(target.url).origin, actorId, requestId,
                idempotencyKey: normalizedIdempotencyKey, requestFingerprint: fingerprint,
                status: 'queued', createdAt: now, controller: new AbortController(), journey: journey || null,
                sourceBuffer: sourceBuffer ? Buffer.from(sourceBuffer) : null,
                crawlerLimit: Math.max(1, Math.min(Number(crawlerLimit || 25), 200)),
                engines: selected.map((engineId) => ({ engineId, label: catalogById.get(engineId).label, version: catalogById.get(engineId).version, status: 'queued', progress: 0, progressMode: 'stage_estimate', phase: 'queued', findingsCount: 0, evidence: [], error: null, createdAt: now, updatedAt: now })),
                summary: {}
            };
            reconcile(run); runMap.set(run.id, run);
            try {
                await audit?.({ action: 'engine_lab.run_requested', actorId, entityId: run.id, requestId, after: { status: run.status }, metadata: { targetOrigin: run.targetOrigin, engineIds: selected, sourceBytes: sourceBuffer?.length || 0 } });
            } catch (error) {
                runMap.delete(run.id);
                if (normalizedIdempotencyKey) idempotencyMap.delete(normalizedIdempotencyKey);
                run.sourceBuffer?.fill(0);
                run.sourceBuffer = null;
                rejectReservation?.(error);
                throw error;
            }
            if (normalizedIdempotencyKey) idempotencyMap.set(normalizedIdempotencyKey, { requestFingerprint: fingerprint, runId: run.id });
            if (closing) {
                removeRunRecord(run);
                run.sourceBuffer?.fill(0); run.sourceBuffer = null;
                const error = new AppError('Engine Lab service is shutting down.', { status: 503, code: 'ENGINE_LAB_SERVICE_CLOSING', expose: true });
                rejectReservation?.(error);
                throw error;
            }
            pendingRuns.push(run);
            evictTerminalHistory();
            setImmediate(scheduleRuns);
            const result = snapshot(run);
            resolveReservation?.(result);
            return result;
        },
        getRun,
        async getArtifact(id, engineId, filename) {
            const run = runMap.get(id);
            if (!run) throw new AppError('Engine Lab artifact not found.', { status: 404, code: 'ENGINE_LAB_ARTIFACT_NOT_FOUND' });
            const engine = run.engines.find((item) => item.engineId === engineId);
            const safeName = path.basename(String(filename || ''));
            const allowedMimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
            const mimeType = allowedMimeTypes[path.extname(safeName).toLowerCase()];
            const declared = engine?.evidence?.some((item) => item?.kind === 'screenshot' && item?.filename === safeName);
            if (!engine || safeName !== filename || !mimeType || !declared) throw new AppError('Engine Lab artifact not found.', { status: 404, code: 'ENGINE_LAB_ARTIFACT_NOT_FOUND' });
            const directory = path.resolve(runArtifactDirectory(run.id), engine.engineId);
            const artifactPath = path.resolve(directory, safeName);
            if (!artifactPath.startsWith(`${directory}${path.sep}`)) throw new AppError('Engine Lab artifact not found.', { status: 404, code: 'ENGINE_LAB_ARTIFACT_NOT_FOUND' });
            try {
                const stats = await fs.stat(artifactPath);
                if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error('Invalid artifact');
                return { buffer: await fs.readFile(artifactPath), mimeType };
            } catch {
                throw new AppError('Engine Lab artifact not found.', { status: 404, code: 'ENGINE_LAB_ARTIFACT_NOT_FOUND' });
            }
        },
        listRuns() { return [...runMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(listSnapshot); },
        async cancelRun(id, actorId, { reason, requestId } = {}) {
            if (!reason?.trim() || !requestId) throw new AppError('An audit reason and request ID are required.', { status: 400, code: 'ADMIN_AUDIT_CONTEXT_REQUIRED' });
            const run = runMap.get(id);
            if (!run) throw new AppError('Engine Lab run not found.', { status: 404, code: 'ENGINE_LAB_RUN_NOT_FOUND' });
            if (!run.controller.signal.aborted && !RUN_TERMINAL.has(run.status)) {
                const before = { status: run.status, cancelledAt: run.cancelledAt || null, engines: run.engines.map((engine) => ({ engineId: engine.engineId, status: engine.status })) };
                const cancelledAt = new Date().toISOString();
                const after = {
                    status: 'cancelled',
                    cancelledAt,
                    engines: before.engines.map((engine) => TERMINAL.has(engine.status) ? engine : { ...engine, status: 'cancelled' })
                };
                await audit?.({ action: 'engine_lab.run_cancelled', actorId, entityId: run.id, reason: reason.trim(), requestId, before, after, metadata: { targetOrigin: run.targetOrigin, engineIds: run.engines.map((engine) => engine.engineId) } });
                // The run may have completed while the durable cancellation
                // audit was being written. Completion wins that race.
                if (run.completedAt || RUN_TERMINAL.has(run.status) || run.controller.signal.aborted) return snapshot(run);
                run.cancelledAt = cancelledAt;
                run.controller.abort(Object.assign(new Error('Engine Lab run cancelled.'), { code: 'ENGINE_LAB_CANCELLED' }));
                if (!activeRuns.has(run.id)) {
                    const pendingIndex = pendingRuns.indexOf(run);
                    if (pendingIndex >= 0) pendingRuns.splice(pendingIndex, 1);
                    finalizeQueuedCancellation(run, run.controller.signal.reason);
                } else {
                    for (const engine of run.engines) if (!TERMINAL.has(engine.status)) Object.assign(engine, { status: 'cancelled', progress: 100, phase: 'cancelled', completedAt: run.cancelledAt, updatedAt: run.cancelledAt });
                    run.executionUrl = run.targetUrl;
                    reconcile(run);
                }
            }
            return snapshot(run);
        },
        close() {
            if (closePromise) return closePromise;
            closePromise = (async () => {
                closing = true;
                clearInterval(artifactJanitor);
                const closeReason = Object.assign(new Error('Engine Lab service closed.'), { code: 'ENGINE_LAB_CLOSED' });
                for (const run of pendingRuns.splice(0)) finalizeQueuedCancellation(run, closeReason);
                for (const run of runMap.values()) {
                    if (!RUN_TERMINAL.has(run.status) && !run.controller.signal.aborted) {
                        run.cancelledAt ||= new Date().toISOString();
                        run.controller.abort(closeReason);
                    }
                }
                const executions = [...activeRuns.values()];
                if (executions.length) {
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, shutdownDrainMs);
                        Promise.allSettled(executions).then(() => { clearTimeout(timer); resolve(); });
                    });
                }
                await Promise.all([...runMap.values()].filter((run) => !activeRuns.has(run.id)).map((run) => removeRunArtifacts(run.id)));
            })();
            return closePromise;
        }
    };
}

module.exports = { ENGINE_CATALOG, createEngineLabService, listSnapshot, safeMessage };
