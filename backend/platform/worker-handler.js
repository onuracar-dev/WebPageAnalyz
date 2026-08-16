const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { assertProductionConfig } = require('../config');
const { createPlatformStore } = require('./store');
const { createPlatformQueue } = require('./queue');
const { EXECUTION_JOBS, assertWorkerJob } = require('./execution-boundary');
const { createSourceService } = require('../source/service');
const { PdfRenderService } = require('../reports/pdf');
const { TaskPool } = require('../lib/task-pool');
const { createAnalysisService } = require('../services/analysis-service');
const { createPlatformService } = require('./service');
const { validatePublicUrl } = require('../security/url-safety');
const { createZapDistributedLock } = require('../analyzers/zap-lock');

function failureCode(error, fallback) { return error?.code || fallback; }

function startExecutionLeaseHeartbeat(store, jobKey, claim, leaseMs, logger) {
    if (typeof store?.renewExecutionResultLease !== 'function' || !claim?.leaseToken) return null;
    const duration = Math.max(1_000, Number(leaseMs) || 120_000);
    const timer = setInterval(() => {
        void Promise.resolve(store.renewExecutionResultLease(jobKey, {
            owner: claim.leaseOwner,
            leaseToken: claim.leaseToken,
            leaseMs: duration
        })).then((renewed) => {
            if (!renewed) logger?.warn?.('Worker execution lease was not renewed', { jobKey, errorCode: 'WORKER_EXECUTION_LEASE_STALE' });
        }).catch((error) => logger?.warn?.('Worker execution lease heartbeat failed', { jobKey, errorCode: failureCode(error, 'WORKER_EXECUTION_LEASE_HEARTBEAT_FAILED') }));
    }, Math.max(1_000, Math.floor(duration / 3)));
    timer.unref?.();
    return timer;
}

function isContainedPath(root, candidate) {
    const base = path.resolve(root);
    const target = path.resolve(candidate);
    return target === base || target.startsWith(`${base}${path.sep}`);
}

function createRetentionArtifactCleanup({ config, store, logger, workerId = 'retention-worker' } = {}) {
    const roots = [config?.sourceArtifactDir, config?.workerResultDir]
        .filter(Boolean)
        .map((root) => path.resolve(root));
    return async (artifactPath) => {
        const rawPath = String(artifactPath || '');
        const target = path.resolve(rawPath || '.');
        if (!rawPath || !roots.some((root) => isContainedPath(root, target))) {
            const error = new AppError('Retention artifact path is outside the managed artifact roots.', { status: 500, code: 'RETENTION_PATH_REJECTED' });
            await Promise.resolve(store?.logAudit?.({ workspaceId: null, actorId: workerId, action: 'retention.artifact_path_rejected', entityType: 'artifact', entityId: null, metadata: { errorCode: error.code } })).catch(() => {});
            throw error;
        }
        try {
            await fs.unlink(target);
            return { deleted: true, path: target };
        } catch (error) {
            if (error.code === 'ENOENT') return { deleted: false, missing: true, path: target };
            const wrapped = new AppError('Retention artifact cleanup failed.', { status: 503, code: 'RETENTION_ARTIFACT_CLEANUP_FAILED', cause: error });
            await Promise.resolve(store?.logAudit?.({ workspaceId: null, actorId: workerId, action: 'retention.artifact_cleanup_failed', entityType: 'artifact', entityId: null, metadata: { errorCode: wrapped.code } })).catch(() => {});
            logger?.warn?.('Retention artifact cleanup failed', { errorCode: wrapped.code });
            throw wrapped;
        }
    };
}

function createRetentionExecutor({ config, store, logger, now = () => new Date(), actorId = 'retention-worker' } = {}) {
    const intervalMs = Math.max(60_000, Number(config?.retentionPollMs) || 6 * 60 * 60 * 1000);
    const dryRun = config?.nodeEnv !== 'production';
    let timer = null;
    let running = null;
    const runOnce = async () => {
        // Coalesce timer ticks in this process. The PostgreSQL store also
        // fences each workspace with a session advisory lock so a second
        // maintenance process returns an explicit active/skipped result.
        if (running) return running;
        running = Promise.resolve().then(async () => {
            const workspaceIds = await store.listWorkspaceIds?.() || [];
            const results = [];
            const artifactCleanup = createRetentionArtifactCleanup({ config, store, logger, workerId: actorId });
            for (const workspaceId of workspaceIds) {
                try {
                    results.push(await store.executeRetentionSweep?.(workspaceId, { now: now(), dryRun, actorId, artifactCleanup }));
                } catch (error) {
                    logger?.warn?.('Retention sweep failed', { workspaceId, errorCode: failureCode(error, 'RETENTION_SWEEP_FAILED') });
                }
            }
            const dueDeletions = await store.listDueWorkspaceDeletions?.({ now: now(), limit: 25 }) || [];
            for (const request of dueDeletions) {
                try {
                    results.push(await store.executeWorkspaceDeletion?.(request.workspaceId, { now: now(), dryRun, actorId, artifactCleanup }));
                } catch (error) {
                    logger?.warn?.('Workspace deletion execution failed', { workspaceId: request.workspaceId, errorCode: failureCode(error, 'WORKSPACE_DELETION_FAILED') });
                }
            }
            return results;
        }).finally(() => { running = null; });
        return running;
    };
    return {
        runOnce,
        start() {
            void runOnce().catch((error) => logger?.warn?.('Retention executor startup failed', { errorCode: failureCode(error, 'RETENTION_START_FAILED') }));
            timer = setInterval(() => void runOnce().catch((error) => logger?.warn?.('Retention executor failed', { errorCode: failureCode(error, 'RETENTION_SWEEP_FAILED') })), intervalMs);
            timer.unref?.();
        },
        async close() { if (timer) clearInterval(timer); await running?.catch(() => {}); }
    };
}

async function startMaintenanceWorker({ config, logger, injectedStore } = {}) {
    if (!config) throw new AppError('MAINTENANCE_CONFIGURATION_REQUIRED', { status: 503, code: 'MAINTENANCE_CONFIGURATION_REQUIRED' });
    assertProductionConfig(config);
    if (config.executionRole !== 'maintenance') throw new AppError('MAINTENANCE_ROLE_REQUIRED', { status: 503, code: 'MAINTENANCE_ROLE_REQUIRED' });
    if (config.databaseExpectedRole !== 'wpa_maintenance') throw new AppError('MAINTENANCE_DATABASE_ROLE_REQUIRED', { status: 503, code: 'MAINTENANCE_DATABASE_ROLE_REQUIRED' });
    if (!config.browserExecutionDisabled || !config.pdfExecutionDisabled || !config.sourceExecutionDisabled || !config.osvExecutionDisabled) {
        throw new AppError('MAINTENANCE_EXECUTION_DISABLED_REQUIRED', { status: 503, code: 'MAINTENANCE_EXECUTION_DISABLED_REQUIRED' });
    }
    if (config.chromeNoSandbox) throw new AppError('MAINTENANCE_SANDBOX_CONFIGURATION_INVALID', { status: 503, code: 'MAINTENANCE_SANDBOX_CONFIGURATION_INVALID' });
    const store = injectedStore || createPlatformStore(config);
    if (typeof store.listWorkspaceIds !== 'function' || typeof store.executeRetentionSweep !== 'function' || typeof store.listDueWorkspaceDeletions !== 'function' || typeof store.executeWorkspaceDeletion !== 'function') {
        throw new AppError('MAINTENANCE_STORE_REQUIRED', { status: 503, code: 'MAINTENANCE_STORE_REQUIRED' });
    }
    const ownsStore = !injectedStore;
    const maintenanceId = `maintenance-${crypto.randomUUID()}`;
    const retention = createRetentionExecutor({ config, store, logger, actorId: maintenanceId });
    retention.start();
    return {
        store,
        async close() {
            await retention.close();
            if (ownsStore) await store.close?.();
        }
    };
}

async function writePdfArtifact(config, executionId, buffer) {
    const directory = path.resolve(config.workerResultDir || path.resolve(config.artifactDir, 'worker-results'), 'pdf');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(executionId || ''))) throw new AppError('Invalid worker execution identifier.', { status: 500, code: 'WORKER_ARTIFACT_ID_INVALID' });
    if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.length > 50 * 1024 * 1024 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new AppError('Generated PDF artifact is invalid or exceeds the export limit.', { status: 500, code: 'PDF_OUTPUT_INVALID' });
    }
    const filename = `${executionId}.pdf`;
    const target = path.resolve(directory, filename);
    if (!target.startsWith(`${directory}${path.sep}`)) throw new AppError('Invalid worker artifact path.', { status: 500, code: 'WORKER_ARTIFACT_PATH_INVALID' });
    const temporary = path.resolve(directory, `.${executionId}.${crypto.randomUUID()}.tmp`);
    if (!temporary.startsWith(`${directory}${path.sep}`)) throw new AppError('Invalid worker artifact path.', { status: 500, code: 'WORKER_ARTIFACT_PATH_INVALID' });
    try {
        // Write-and-rename keeps readers from observing a partial PDF and
        // never follows a pre-existing target symlink. The temp name is
        // unguessable and the directory is mode 0700 inside the worker volume.
        await fs.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, target);
        await fs.chmod(target, 0o600);
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size !== buffer.length) throw new AppError('Generated PDF artifact could not be verified.', { status: 500, code: 'PDF_OUTPUT_INVALID' });
        return target;
    } finally { await fs.unlink(temporary).catch(() => {}); }
}

function payloadWithinLimit(report, maxBytes) {
    try { return Buffer.byteLength(JSON.stringify(report?.payload || {}), 'utf8') <= Math.max(64 * 1024, Number(maxBytes) || 20 * 1024 * 1024); } catch { return false; }
}

async function startWorker({ config, logger, workerKind = 'analysis', queue: injectedQueue, store: injectedStore, pdfRenderer, platformService: injectedPlatformService, analysisService: injectedAnalysisService, analysisPool: injectedAnalysisPool, validateUrl: injectedValidateUrl } = {}) {
    if (workerKind === 'maintenance') return startMaintenanceWorker({ config, logger, injectedStore });
    if (!config) throw new AppError('WORKER_CONFIGURATION_REQUIRED', { status: 503, code: 'WORKER_CONFIGURATION_REQUIRED' });
    assertProductionConfig(config);
    if (config.executionRole !== 'worker') throw new AppError('WORKER_ROLE_REQUIRED', { status: 503, code: 'WORKER_ROLE_REQUIRED' });
    if (config.databaseExpectedRole !== 'wpa_worker') throw new AppError('WORKER_DATABASE_ROLE_REQUIRED', { status: 503, code: 'WORKER_DATABASE_ROLE_REQUIRED' });
    if (config.chromeNoSandbox) throw new AppError('WORKER_SANDBOX_DISABLED', { status: 503, code: 'WORKER_SANDBOX_DISABLED' });
    if (config.browserExecutionDisabled || config.pdfExecutionDisabled || config.sourceExecutionDisabled || config.osvExecutionDisabled) throw new AppError('WORKER_EXECUTION_DISABLED', { status: 503, code: 'WORKER_EXECUTION_DISABLED' });
    const store = injectedStore || createPlatformStore(config);
    if (typeof store.createExecutionResult !== 'function' || typeof store.claimExecutionResult !== 'function' || typeof store.settleExecutionResult !== 'function') throw new AppError('WORKER_RESULT_STORE_REQUIRED', { status: 503, code: 'WORKER_RESULT_STORE_REQUIRED' });
    const queue = injectedQueue || createPlatformQueue(config);
    const ownsStore = !injectedStore;
    await queue.start?.();
    const sourceService = createSourceService({ config, store, queue: null });
    const pdfService = new PdfRenderService({ config, renderer: pdfRenderer, maxConcurrent: config.maxConcurrentPdfExports || 1, maxQueue: config.maxQueuedPdfExports || 4 });
    const analysisPool = injectedAnalysisPool || new TaskPool({ maxConcurrent: config.maxConcurrentAnalyses, maxQueue: config.maxQueuedAnalyses });
    const zapLock = createZapDistributedLock({ pool: store.pool, required: config.nodeEnv === 'production' && Boolean(config.zap?.url) });
    const analysisService = injectedAnalysisService || createAnalysisService({ config, logger, zapLock });
    const validateUrl = injectedValidateUrl || ((url) => validatePublicUrl(url, { allowedPorts: config.allowedTargetPorts }));
    const platformService = injectedPlatformService || createPlatformService({ store, queue, analysisPool, analysisService, validateUrl, config, logger });
    await platformService.start?.();
    const workerId = `${workerKind}-${crypto.randomUUID()}`;
    const workerStartedAt = new Date().toISOString();
    const heartbeat = async () => store.recordWorkerHeartbeat?.(workerKind, workerId, {
        startedAt: workerStartedAt,
        metadata: { executionRole: config.executionRole, handler: 'platform/worker-handler' }
    });
    await heartbeat();
    const heartbeatTimer = setInterval(() => {
        void Promise.resolve(heartbeat()).catch((error) => logger?.warn?.('Worker heartbeat failed', { workerId, errorCode: failureCode(error, 'WORKER_HEARTBEAT_FAILED') }));
    }, 30_000);
    heartbeatTimer.unref?.();
    const handleSourceJobs = async (jobs, expectedKind = 'source') => {
        for (const job of jobs) {
            const data = assertWorkerJob(job.data || {}, expectedKind);
            const jobKey = data.jobKey || `${data.kind}:${data.executionId || data.sourceInputId}`;
            await store.createExecutionResult?.({ jobKey, workspaceId: data.workspaceId, kind: expectedKind, input: { sourceInputId: data.sourceInputId, projectId: data.projectId } });
            const claimed = await store.claimExecutionResult?.(jobKey, { owner: workerId, leaseMs: config.workerLeaseMs || 120_000 });
            if (claimed && claimed.status === 'running') {
                const leaseHeartbeat = startExecutionLeaseHeartbeat(store, jobKey, claimed, config.workerLeaseMs || 120_000, logger);
                try {
                    const result = await sourceService.processQueuedSource(data, 'source');
                    const status = result?.sourceInput?.status === 'completed' ? 'completed' : result?.sourceInput?.status === 'unavailable' ? 'unavailable' : 'failed';
                    await store.settleExecutionResult?.(jobKey, { owner: workerId, leaseToken: claimed.leaseToken, status, result: result?.sourceInput || null, failureCode: result?.sourceInput?.failureCode || null });
                } catch (error) { await store.settleExecutionResult?.(jobKey, { owner: workerId, leaseToken: claimed.leaseToken, status: 'failed', failureCode: failureCode(error, 'SOURCE_WORKER_FAILED') }); }
                finally { if (leaseHeartbeat) clearInterval(leaseHeartbeat); }
            }
            try { await sourceService.purgeExpiredArtifacts?.(); } catch (error) { await Promise.resolve(store.logAudit?.({ workspaceId: data.workspaceId || null, actorId: workerId, action: 'source.artifact_cleanup_failed', entityType: 'source_input', entityId: data.sourceInputId || null, metadata: { errorCode: failureCode(error, 'SOURCE_ARTIFACT_CLEANUP_FAILED') } })).catch(() => {}); }
        }
    };
    const handlePdfJobs = async (jobs) => {
        for (const job of jobs) {
            const data = assertWorkerJob(job.data || {}, 'pdf');
            const jobKey = data.jobKey || `pdf:${data.executionId || `${data.workspaceId}:${data.reportId}`}`;
            await store.createExecutionResult?.({ jobKey, workspaceId: data.workspaceId, kind: 'pdf', input: { reportId: data.reportId } });
            const execution = await store.claimExecutionResult?.(jobKey, { owner: workerId, leaseMs: config.workerLeaseMs || 120_000 });
            if (!execution || execution.status !== 'running') continue;
            const leaseHeartbeat = startExecutionLeaseHeartbeat(store, jobKey, execution, config.workerLeaseMs || 120_000, logger);
            try {
                if (config.pdfExecutionDisabled) throw new AppError('PDF worker execution is disabled.', { status: 503, code: 'PDF_EXECUTION_DISABLED' });
                const report = await store.getReport?.(data.workspaceId, data.reportId);
                if (!report) throw new AppError('Report not found.', { status: 404, code: 'REPORT_NOT_FOUND' });
                if (!payloadWithinLimit(report, config.reportPayloadMaxBytes)) throw new AppError('Report payload exceeds the export limit.', { status: 413, code: 'REPORT_PAYLOAD_TOO_LARGE' });
                const buffer = await pdfService.render(report);
                const artifactPath = await writePdfArtifact(config, execution.id, buffer);
                await store.settleExecutionResult?.(jobKey, { owner: workerId, leaseToken: execution.leaseToken, status: 'completed', artifactPath, contentType: 'application/pdf', bytes: buffer.length });
            } catch (error) { await store.settleExecutionResult?.(jobKey, { owner: workerId, leaseToken: execution.leaseToken, status: error.code === 'PDF_EXECUTION_DISABLED' ? 'unavailable' : 'failed', failureCode: failureCode(error, 'PDF_WORKER_FAILED') }); }
            finally { if (leaseHeartbeat) clearInterval(leaseHeartbeat); }
        }
    };
    // OSV is intentionally part of the source handler's single fenced lifecycle.
    await queue.work?.(EXECUTION_JOBS.source, handleSourceJobs);
    await queue.work?.(EXECUTION_JOBS.pdf, handlePdfJobs);
    const artifactTimer = setInterval(() => {
        void Promise.resolve(sourceService.purgeExpiredArtifacts?.()).catch(async (error) => {
            logger?.warn?.('Encrypted source artifact cleanup failed', { errorCode: failureCode(error, 'SOURCE_ARTIFACT_CLEANUP_FAILED') });
            await Promise.resolve(store.logAudit?.({ workspaceId: null, actorId: workerId, action: 'source.artifact_cleanup_failed', entityType: 'worker', entityId: workerId, metadata: { errorCode: failureCode(error, 'SOURCE_ARTIFACT_CLEANUP_FAILED') } })).catch(() => {});
        });
    }, config.sourceArtifactJanitorMs || config.sourceStagingJanitorMs || 15 * 60_000);
    artifactTimer.unref?.();
    return {
        queue, store, platformService, analysisPool,
        async close() {
            clearInterval(heartbeatTimer);
            clearInterval(artifactTimer);
            await platformService.close?.();
            analysisPool.close?.();
            await Promise.allSettled([ownsStore ? store.close?.() : null, pdfService.close?.()]);
        }
    };
}

module.exports = { startWorker, startMaintenanceWorker, createRetentionExecutor, createRetentionArtifactCleanup, writePdfArtifact };
