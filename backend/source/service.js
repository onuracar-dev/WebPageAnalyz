const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { workspacePlan } = require('../platform/store');
const os = require('node:os');
const { inspectZip, inspectZipFile, extractZip, extractZipFile } = require('./zip-security');
const { runOsv } = require('./osv-runner');
const { CONTRACT_VERSION, FINDING_SCHEMA, classifyErrorCode, remediationFor } = require('../domain/analysis-contract');
const { enqueueWorkerJob, assertWorkerJob } = require('../platform/execution-boundary');

function encryptionKey(config) {
    if (config.sourceEncryptionKey) {
        const decoded = Buffer.from(config.sourceEncryptionKey, 'base64');
        if (decoded.length === 32) return decoded;
        throw new AppError('SOURCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.', { status: 503, code: 'SOURCE_ENCRYPTION_MISCONFIGURED' });
    }
    if (config.nodeEnv === 'production') throw new AppError('Source upload encryption is not configured.', { status: 503, code: 'SOURCE_ENCRYPTION_MISCONFIGURED' });
    return crypto.createHash('sha256').update('webpage-analyzer-development-source-key').digest();
}

function encrypt(buffer, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([Buffer.from('WPA1'), iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(buffer, key) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.subarray(0, 4).toString('ascii') !== 'WPA1') throw new AppError('Encrypted source package is invalid.', { status: 400, code: 'SOURCE_CIPHERTEXT_INVALID' });
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(4, 16));
        decipher.setAuthTag(buffer.subarray(16, 32));
        return Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]);
    } catch (cause) { throw new AppError('Encrypted source package authentication failed.', { status: 400, code: 'SOURCE_CIPHERTEXT_INVALID', cause }); }
}

async function encryptFile(inputPath, outputPath, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertextPath = `${outputPath}.ciphertext`;
    try {
        // Keep only the fixed-size authentication header in memory. The
        // upload itself is never duplicated into a large request buffer.
        await pipeline(fsReadStream(inputPath), cipher, fsWriteStream(ciphertextPath, { mode: 0o600 }));
        const authTag = cipher.getAuthTag();
        await fs.writeFile(outputPath, Buffer.concat([Buffer.from('WPA1'), iv, authTag]), { mode: 0o600 });
        await pipeline(fsReadStream(ciphertextPath), fsWriteStream(outputPath, { flags: 'a', mode: 0o600 }));
    } finally { await fs.unlink(ciphertextPath).catch(() => {}); }
}

function fsReadStream(filename, options) { return require('node:fs').createReadStream(filename, options); }
function fsWriteStream(filename, options) { return require('node:fs').createWriteStream(filename, options); }

async function decryptFile(inputPath, outputPath, key) {
    const header = await fs.open(inputPath, 'r');
    const headerBuffer = Buffer.alloc(32);
    try { await header.read(headerBuffer, 0, headerBuffer.length, 0); }
    finally { await header.close(); }
    if (headerBuffer.subarray(0, 4).toString('ascii') !== 'WPA1') throw new AppError('Encrypted source package is invalid.', { status: 400, code: 'SOURCE_CIPHERTEXT_INVALID' });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, headerBuffer.subarray(4, 16));
    decipher.setAuthTag(headerBuffer.subarray(16, 32));
    const input = fsReadStream(inputPath, { start: 32 });
    await pipeline(input, decipher, fsWriteStream(outputPath, { mode: 0o600 }));
}

async function purgeExpiredArtifacts(config, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    const directory = path.resolve(config.sourceArtifactDir || path.resolve(config.artifactDir, 'source-inputs'));
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
    const cutoff = now - maxAgeMs;
    let removed = 0;
    const failures = [];
    for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.wpaenc$/i.test(entry.name)) continue;
        const filename = path.resolve(directory, entry.name);
        const stats = await fs.stat(filename).catch(() => null);
        if (!stats || stats.mtimeMs > cutoff) continue;
        await fs.unlink(filename).then(() => { removed += 1; }).catch((error) => { if (error.code !== 'ENOENT') failures.push(error); });
    }
    if (failures.length) throw Object.assign(new Error('Encrypted source artifact cleanup did not complete.'), { code: 'SOURCE_ARTIFACT_CLEANUP_FAILED', cause: failures[0] });
    return removed;
}

async function purgeExpiredStaging(config, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
    const directory = path.resolve(config.artifactDir, 'upload-staging');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    const cutoff = now - Math.max(60_000, maxAgeMs);
    let removed = 0;
    const failures = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filename = path.resolve(directory, entry.name);
        const stats = await fs.stat(filename).catch(() => null);
        if (!stats || stats.mtimeMs > cutoff) continue;
        await fs.unlink(filename).then(() => { removed += 1; }).catch((error) => { if (error.code !== 'ENOENT') failures.push(error); });
    }
    if (failures.length) throw Object.assign(new Error('Plaintext source staging cleanup did not complete.'), { code: 'SOURCE_STAGING_CLEANUP_FAILED', cause: failures[0] });
    return removed;
}

function sourceCreateResult(result) {
    const sourceInput = result?.sourceInput || result?.record || result;
    if (!sourceInput || typeof sourceInput !== 'object' || !sourceInput.id) throw new AppError('Source creation returned an invalid record.', { status: 503, code: 'SOURCE_INPUT_UNAVAILABLE' });
    return {
        sourceInput,
        idempotent: result?.idempotent === true || result?.reused === true || result?.created === false || sourceInput.idempotent === true
    };
}

function sourceSummary(sourceInput, fallback = {}) {
    return {
        id: sourceInput.id,
        projectId: sourceInput.projectId ?? fallback.projectId,
        kind: sourceInput.kind || 'zip',
        status: sourceInput.status || fallback.status || 'queued',
        ...(sourceInput.result ? { result: sourceInput.result } : {}),
        ...(sourceInput.failureCode ? { failureCode: sourceInput.failureCode } : {}),
        ...(sourceInput.purgeAt || fallback.purgeAt ? { purgeAt: sourceInput.purgeAt || fallback.purgeAt } : {}),
        ...(sourceInput.createdAt || fallback.createdAt ? { createdAt: sourceInput.createdAt || fallback.createdAt } : {})
    };
}

function sourceCreateOptions(plan, { idempotencyKey = null, requestFingerprint = null, entitlementUserId = null, requestedByUserId = null } = {}) {
    const limit = Math.max(0, Math.floor(Number(plan?.limits?.sourceAudits || 0)));
    return {
        idempotencyKey: normalizedSourceIdempotencyKey(idempotencyKey),
        requestFingerprint: requestFingerprint || null,
        entitlementUserId,
        requestedByUserId,
        // `limit` is the store's atomic quota contract. `quota` is retained as
        // explicit context for stores that expose a richer quota API.
        limit,
        quota: { kind: 'source_audit', limit, period: 'month' }
    };
}

function normalizedSourceIdempotencyKey(value) {
    if (value == null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

async function fileFingerprint(filePath, projectId) {
    const hash = crypto.createHash('sha256').update(String(projectId || '')).update('\0');
    for await (const chunk of fsReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

function shouldEnqueueSourceExecution(execution) {
    if (!execution) return true;
    // A store may return an idempotent execution row. Re-enqueueing that row
    // would duplicate the external worker side effect even when the queue has
    // its own singleton key.
    if (execution.idempotent === true || execution.created === false) return false;
    return !['running', 'completed', 'failed', 'unavailable', 'cancelled'].includes(execution.status);
}

function createSourceService({ config, store, queue = null, scanner = runOsv, inspect = inspectZip, extract = extractZip, inspectFile = inspectZipFile }) {
    const SOURCE_QUEUE = 'wpa-source-audit';
    async function processStoredSourceInput(workspaceId, sourceInput, project, inventory) {
        let tempDirectory; let extractedFiles = 0;
        const absolutePath = sourceInput.encryptedReference;
        try {
            await store.updateSourceInput?.(workspaceId, sourceInput.id, { status: 'running' });
            tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-source-'));
            await fs.chmod(tempDirectory, 0o700);
            const plaintextPath = path.join(tempDirectory, 'source.zip');
            await decryptFile(absolutePath, plaintextPath, encryptionKey(config));
            const checked = await inspectZipFile(plaintextPath);
            const extracted = await extractZipFile(plaintextPath, tempDirectory);
            extractedFiles = extracted.files.length;
            if (config.osvExecutionDisabled) throw new AppError('OSV execution is available only in the isolated worker.', { status: 503, code: 'OSV_WORKER_REQUIRED' });
            const result = await scanner(tempDirectory, { executable: config.osv.executable, isolationRunner: config.osv.isolationRunner, isolationArgs: config.osv.isolationArgs, timeoutMs: config.timeouts.osvMs, projectUrl: project.origin });
            const normalized = {
                schemaVersion: 'wpa.source-audit.v1', capabilityContractVersion: CONTRACT_VERSION, findingSchema: FINDING_SCHEMA,
                module: { id: 'source_audit', engineId: 'osvScanner', status: 'completed', version: result.version, executionMode: 'automated', kind: 'measured', findingCount: result.findings?.length || 0 },
                findings: result.findings || [], coverage: { ...result.coverage, extractedFiles, zipEntries: inventory?.entries ?? checked.entries, truncated: Boolean(result.coverage?.truncated) }
            };
            await store.updateSourceInput?.(workspaceId, sourceInput.id, { status: 'completed', result: normalized, encryptedReference: null, completedAt: new Date().toISOString() });
            sourceInput.status = 'completed'; sourceInput.result = normalized;
        } catch (error) {
            const failureCode = error.code || 'SOURCE_AUDIT_FAILED';
            const status = classifyErrorCode(failureCode) === 'unavailable' ? 'unavailable' : 'failed';
            const result = {
                schemaVersion: 'wpa.source-audit.v1', capabilityContractVersion: CONTRACT_VERSION, findingSchema: FINDING_SCHEMA,
                module: { id: 'source_audit', engineId: 'osvScanner', status, executionMode: 'automated', kind: 'measured', findingCount: 0, failureCode, remediation: remediationFor(failureCode, 'osvScanner') },
                findings: [], coverage: { zipEntries: inventory?.entries || 0, uncompressedBytes: inventory?.uncompressedBytes || 0, extractedFiles, manifests: 0, truncated: false }
            };
            await store.updateSourceInput?.(workspaceId, sourceInput.id, { status, failureCode, result, encryptedReference: null, completedAt: new Date().toISOString() });
            sourceInput.status = status; sourceInput.failureCode = failureCode; sourceInput.result = result;
        } finally {
            await fs.unlink(absolutePath).catch(() => {});
            if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
        }
        return {
            sourceInput: { id: sourceInput.id, projectId: sourceInput.projectId, kind: sourceInput.kind, status: sourceInput.status, result: sourceInput.result, ...(sourceInput.failureCode ? { failureCode: sourceInput.failureCode } : {}), purgeAt: sourceInput.purgeAt, createdAt: sourceInput.createdAt },
            inventory: inventory || null
        };
    }
    async function processQueuedSource(data, expectedKind = 'source') {
        const job = assertWorkerJob(data || {}, expectedKind);
        const sourceInput = await store.getSourceInput(job.workspaceId, job.sourceInputId);
        const project = await store.getProject(job.workspaceId, job.projectId);
        if (!sourceInput || !project) return null;
        if (['completed', 'failed', 'unavailable', 'cancelled'].includes(sourceInput.status)) {
            return { sourceInput: sourceSummary(sourceInput, { projectId: job.projectId }), inventory: null, idempotent: true };
        }
        sourceInput.encryptedReference = job.encryptedReference;
        return processStoredSourceInput(job.workspaceId, sourceInput, project, null);
    }
    return {
        async start() {
            if (!queue?.work) return;
            await queue.work(SOURCE_QUEUE, async (jobs) => {
                for (const job of jobs) {
                    await processQueuedSource(job.data || {}, 'source');
                }
            });
        },
        processQueuedSource,
        purgeExpiredArtifacts(options) { return purgeExpiredArtifacts(config, options); },
        purgeExpiredStaging(options) { return purgeExpiredStaging(config, options); },
        async acceptZip(workspaceId, { projectId, buffer, idempotencyKey = null, requestFingerprint = null, requestedByUserId = null }) {
            idempotencyKey = normalizedSourceIdempotencyKey(idempotencyKey);
            const project = await store.getProject(workspaceId, projectId);
            if (!project) throw new AppError('Project not found.', { status: 404, code: 'PROJECT_NOT_FOUND' });
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, requestedByUserId);
            const plan = await workspacePlan(store, workspaceId, requestedByUserId);
            const entitlement = plan.entitlements.source_audit;
            if (!entitlement || entitlement.executionMode === 'disabled' || !plan.limits.sourceAudits) throw new AppError('Source Audit is not available on this plan.', { status: 403, code: 'MODULE_NOT_ENTITLED' });
            // Idempotent retries must reach the store even when the visible
            // count is already at the limit: the store can atomically return
            // the existing row without consuming another quota unit.
            if (!idempotencyKey && await store.countSourceInputs(entitlementUserId) >= plan.limits.sourceAudits) throw new AppError('The monthly Source Audit limit has been reached.', { status: 409, code: 'SOURCE_AUDIT_LIMIT_REACHED' });
            const inventory = await inspect(buffer);
            const fingerprint = requestFingerprint || (idempotencyKey ? crypto.createHash('sha256').update(String(projectId || '')).update('\0').update(buffer).digest('hex') : null);
            const createOptions = sourceCreateOptions(plan, { idempotencyKey, requestFingerprint: fingerprint, entitlementUserId, requestedByUserId });
            const directory = path.resolve(config.sourceArtifactDir || path.resolve(config.artifactDir, 'source-inputs'));
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            const filename = `${crypto.randomUUID()}.wpaenc`;
            const absolutePath = path.resolve(directory, filename);
            if (!absolutePath.startsWith(`${directory}${path.sep}`)) throw new AppError('Invalid source storage path.', { code: 'SOURCE_STORAGE_PATH_INVALID' });
            const purgeAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            let sourceInput;
            try {
                await fs.writeFile(absolutePath, encrypt(buffer, encryptionKey(config)), { mode: 0o600 });
                const created = sourceCreateResult(await store.createSourceInput(workspaceId, projectId, { kind: 'zip', status: 'queued', encryptedReference: absolutePath, purgeAt }, createOptions));
                sourceInput = created.sourceInput;
                if (created.idempotent) {
                    buffer.fill(0);
                    await fs.unlink(absolutePath).catch(() => {});
                    return {
                        sourceInput: sourceSummary(sourceInput, { projectId, purgeAt }),
                        inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes },
                        idempotent: true
                    };
                }
            } catch (error) {
                // The source row is not available yet, so the normal audit
                // cleanup below cannot run. Remove ciphertext and clear the
                // caller-owned plaintext buffer before surfacing the error.
                buffer.fill(0);
                await fs.unlink(absolutePath).catch(() => {});
                throw error;
            }
            let tempDirectory; let plaintext; let extractedFiles = 0;
            try {
                await store.updateSourceInput?.(workspaceId, sourceInput.id, { status: 'running' });
                const ciphertext = await fs.readFile(absolutePath);
                plaintext = decrypt(ciphertext, encryptionKey(config));
                await inspect(plaintext);
                tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-source-'));
                await fs.chmod(tempDirectory, 0o700);
                const extracted = await extract(plaintext, tempDirectory);
                extractedFiles = extracted.files.length;
                if (config.osvExecutionDisabled) throw new AppError('OSV execution is available only in the isolated worker.', { status: 503, code: 'OSV_WORKER_REQUIRED' });
                const result = await scanner(tempDirectory, { executable: config.osv.executable, isolationRunner: config.osv.isolationRunner, isolationArgs: config.osv.isolationArgs, timeoutMs: config.timeouts.osvMs, projectUrl: project.origin });
                const normalized = {
                    schemaVersion: 'wpa.source-audit.v1', capabilityContractVersion: CONTRACT_VERSION, findingSchema: FINDING_SCHEMA,
                    module: { id: 'source_audit', engineId: 'osvScanner', status: 'completed', version: result.version, executionMode: 'automated', kind: 'measured', findingCount: result.findings?.length || 0 },
                    findings: result.findings || [], coverage: { ...result.coverage, extractedFiles, zipEntries: inventory.entries, truncated: Boolean(result.coverage?.truncated) }
                };
                await store.updateSourceInput?.(workspaceId, sourceInput.id, { status: 'completed', result: normalized, encryptedReference: null, completedAt: new Date().toISOString() });
                sourceInput.status = 'completed'; sourceInput.result = normalized;
            } catch (error) {
                const failureCode = error.code || 'SOURCE_AUDIT_FAILED';
                const status = classifyErrorCode(failureCode) === 'unavailable' ? 'unavailable' : 'failed';
                const result = {
                    schemaVersion: 'wpa.source-audit.v1', capabilityContractVersion: CONTRACT_VERSION, findingSchema: FINDING_SCHEMA,
                    module: { id: 'source_audit', engineId: 'osvScanner', status, executionMode: 'automated', kind: 'measured', findingCount: 0, failureCode, remediation: remediationFor(failureCode, 'osvScanner') },
                    findings: [], coverage: { zipEntries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes, extractedFiles, manifests: 0, truncated: false }
                };
                await store.updateSourceInput?.(workspaceId, sourceInput.id, { status, failureCode, result, encryptedReference: null, completedAt: new Date().toISOString() });
                sourceInput.status = status; sourceInput.failureCode = failureCode; sourceInput.result = result;
            } finally {
                plaintext?.fill(0);
                buffer.fill(0);
                await fs.unlink(absolutePath).catch(() => {});
                if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
            }
            return {
                sourceInput: { id: sourceInput.id, projectId: sourceInput.projectId, kind: sourceInput.kind, status: sourceInput.status, result: sourceInput.result, ...(sourceInput.failureCode ? { failureCode: sourceInput.failureCode } : {}), purgeAt: sourceInput.purgeAt, createdAt: sourceInput.createdAt },
                inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes }
            };
        },
        // Production uploads are staged by multer on disk. This path keeps
        // ZIP inspection/extraction streaming and leaves only bounded chunks
        // in Node buffers while preserving the synchronous test helper above.
        async acceptZipFile(workspaceId, { projectId, filePath, idempotencyKey = null, requestFingerprint = null, requestedByUserId = null }) {
            idempotencyKey = normalizedSourceIdempotencyKey(idempotencyKey);
            const project = await store.getProject(workspaceId, projectId);
            if (!project) throw new AppError('Project not found.', { status: 404, code: 'PROJECT_NOT_FOUND' });
            const entitlementUserId = await store.resolveEntitlementUser(workspaceId, requestedByUserId);
            const plan = await workspacePlan(store, workspaceId, requestedByUserId);
            const entitlement = plan.entitlements.source_audit;
            if (!entitlement || entitlement.executionMode === 'disabled' || !plan.limits.sourceAudits) throw new AppError('Source Audit is not available on this plan.', { status: 403, code: 'MODULE_NOT_ENTITLED' });
            if (!idempotencyKey && await store.countSourceInputs(entitlementUserId) >= plan.limits.sourceAudits) throw new AppError('The monthly Source Audit limit has been reached.', { status: 409, code: 'SOURCE_AUDIT_LIMIT_REACHED' });
            const inventory = await inspectFile(filePath);
            const fingerprint = requestFingerprint || (idempotencyKey ? await fileFingerprint(filePath, projectId) : null);
            const createOptions = sourceCreateOptions(plan, { idempotencyKey, requestFingerprint: fingerprint, entitlementUserId, requestedByUserId });
            const directory = path.resolve(config.artifactDir, 'source-inputs');
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            const absolutePath = path.resolve(directory, `${crypto.randomUUID()}.wpaenc`);
            if (!absolutePath.startsWith(`${directory}${path.sep}`)) throw new AppError('Invalid source storage path.', { code: 'SOURCE_STORAGE_PATH_INVALID' });
            const purgeAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            let sourceInput;
            try {
                await encryptFile(filePath, absolutePath, encryptionKey(config));
                const created = sourceCreateResult(await store.createSourceInput(workspaceId, projectId, { kind: 'zip', status: 'queued', encryptedReference: absolutePath, purgeAt }, createOptions));
                sourceInput = created.sourceInput;
                if (created.idempotent) {
                    await fs.unlink(filePath).catch(() => {});
                    await fs.unlink(absolutePath).catch(() => {});
                    if (queue?.send && sourceInput.status === 'queued' && sourceInput.encryptedReference) {
                        const jobKey = `source:${sourceInput.id}`;
                        const execution = await store.createExecutionResult?.({ jobKey, workspaceId, kind: 'source', input: { sourceInputId: sourceInput.id, projectId } });
                        if (shouldEnqueueSourceExecution(execution)) {
                            const jobId = await enqueueWorkerJob(queue, 'source', { workspaceId, sourceInputId: sourceInput.id, projectId, encryptedReference: sourceInput.encryptedReference, jobKey: execution?.jobKey || jobKey, executionId: execution?.id || null }, { singletonKey: sourceInput.id });
                            return {
                                sourceInput: sourceSummary(sourceInput, { projectId, purgeAt }),
                                inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes },
                                execution: execution ? { id: execution.id, status: execution.status } : null,
                                jobId,
                                idempotent: true
                            };
                        }
                    }
                    return {
                        sourceInput: sourceSummary(sourceInput, { projectId, purgeAt }),
                        inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes },
                        idempotent: true
                    };
                }
            } catch (error) {
                await fs.unlink(absolutePath).catch(() => {});
                throw error;
            }
            await fs.unlink(filePath).catch(() => {});
            if (queue?.send) {
                let execution = null;
                const jobKey = `source:${sourceInput.id}`;
                try {
                    execution = await store.createExecutionResult?.({ jobKey, workspaceId, kind: 'source', input: { sourceInputId: sourceInput.id, projectId } });
                    if (!shouldEnqueueSourceExecution(execution)) {
                        return { sourceInput: sourceSummary(sourceInput, { projectId, purgeAt }), inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes }, execution: execution ? { id: execution.id, status: execution.status, idempotent: execution.idempotent === true } : null, idempotent: true };
                    }
                    const jobId = await enqueueWorkerJob(queue, 'source', { workspaceId, sourceInputId: sourceInput.id, projectId, encryptedReference: absolutePath, jobKey: execution?.jobKey || jobKey, executionId: execution?.id || null }, { singletonKey: sourceInput.id });
                    return { sourceInput: { id: sourceInput.id, projectId, kind: 'zip', status: 'queued', purgeAt, createdAt: sourceInput.createdAt }, inventory: { entries: inventory.entries, uncompressedBytes: inventory.uncompressedBytes }, execution: execution ? { id: execution.id, status: execution.status } : null, jobId };
                } catch (error) {
                    // A queue send error is an ambiguous outcome: pg-boss may
                    // have accepted the stable singleton before the response
                    // was lost. Preserve the queued row, execution result and
                    // encrypted artifact so a same-key retry can safely send
                    // the same singleton again.
                    await Promise.resolve(store.logAudit?.({ workspaceId, actorId: null, action: 'source.queue_outcome_unknown', entityType: 'source_input', entityId: sourceInput.id, metadata: { jobKey, errorCode: error.code || 'SOURCE_QUEUE_OUTCOME_UNKNOWN' } })).catch(() => {});
                    throw error;
                }
            }
            sourceInput.encryptedReference = absolutePath;
            return processStoredSourceInput(workspaceId, sourceInput, project, inventory);
        }
    };
}

module.exports = { createSourceService, decrypt, encrypt, encryptionKey, fileFingerprint, purgeExpiredArtifacts, purgeExpiredStaging, shouldEnqueueSourceExecution, sourceCreateOptions, sourceCreateResult, sourceSummary };
