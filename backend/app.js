const nodeFs = require('node:fs');
const fs = nodeFs.promises;
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const { loadConfig } = require('./config');
const { logger: defaultLogger } = require('./lib/logger');
const { AppError } = require('./lib/errors');
const { TaskPool } = require('./lib/task-pool');
const { validatePublicUrl } = require('./security/url-safety');
const { createAnalysisService } = require('./services/analysis-service');
const { clearArtifacts } = require('./services/artifact-service');
const { createAIServiceClient } = require('./ai/client');
const { createEmailTransport } = require('./auth/email-transport');
const {
    analyzeSchema,
    executiveSummarySchema,
    solveSchema,
    adminReauthSchema,
    adminWebAuthnConfirmSchema,
    adminRoleAssignmentSchema,
    adminRecoveryUseSchema,
    projectSchema,
    scanSchema,
    verificationSchema,
    planAssignmentSchema,
    operatorCompletionSchema,
    entitlementSchema,
    checkoutSchema,
    legalAcceptanceSchema,
    redeemSchema,
    adminReasonSchema,
    adminWebhookReplaySchema,
    adminDeletionExecuteSchema,
    adminCreditAdjustmentSchema,
    adminGrantableModuleSchema,
    adminEntitlementGrantSchema,
    adminRedeemCreateSchema,
    adminRedeemMutationSchema,
    adminScanMutationSchema,
    aiRemediationSchema,
    shareSchema,
    workspaceSettingsSchema,
    workspaceDeletionSchema,
    webhookIntegrationSchema,
    expertReviewRequestSchema,
    expertDecisionSchema,
    roadmapSchema,
    engineLabRunSchema,
    supportTicketSchema,
    supportReplySchema,
    supportAdminUpdateSchema,
    supportCustomerTransitionSchema
} = require('./validation/schemas');
const { validateBody } = require('./middleware/validate');
const { requireAdminApiKey } = require('./middleware/auth');
const { requireLegacyApiAccess } = require('./middleware/legacy-api');
const { limiter, PgRateLimitStore, isScanProgressRead } = require('./middleware/rate-limit');
const { createPlatformStore } = require('./platform/store');
const { createPlatformQueue } = require('./platform/queue');
const { createPlatformService } = require('./platform/service');
const { blockBannedEmailSignIn, createAuthService, platformIdentity, requireTrustedMutationOrigin, authTrustedOrigins } = require('./auth/better-auth');
const { createPrivilegedPasskeyMiddleware } = require('./auth/passkey-policy');
const { createPrivilegedPasswordChangeMiddleware } = require('./auth/password-policy');
const { getAdminAccessStatus, requireAdminReauthentication, requireAdminRouteAuthorization, requireSecurePlatformAdmin, setPlanEntitlementWithAudit } = require('./auth/security');
const { attachWorkspaceMembership, requireWorkspacePermission, WORKSPACE_PERMISSIONS } = require('./auth/workspace-policy');
const { createBillingProvider } = require('./billing');
const { createSourceService } = require('./source/service');
const { createIntegrationService } = require('./integrations/service');
const { PdfRenderService } = require('./reports/pdf');
const { createEngineLabService } = require('./admin/engine-lab');
const { createEngineLabServiceClient } = require('./admin/engine-lab-client');
const { createSupportService } = require('./support/service');
const { createZapDistributedLock } = require('./analyzers/zap-lock');
const { enqueueWorkerJob } = require('./platform/execution-boundary');
const { publicLegalVersions } = require('./domain/legal');
const { getPlan } = require('./domain/plans');
const { normalizeIdempotencyKey, operationFingerprint } = require('./domain/idempotency');

function requestController(request, response) {
    const controller = new AbortController();
    const cancel = () => {
        if (!response.writableEnded && !controller.signal.aborted) {
            controller.abort(new AppError('The client disconnected.', {
                status: 499,
                code: 'CLIENT_DISCONNECTED'
            }));
        }
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    return {
        signal: controller.signal,
        cleanup() {
            request.off('aborted', cancel);
            response.off('close', cancel);
        }
    };
}

function requireAdminRole(..._legacyRoles) {
    // Route-local role lists are retained only while the old declarations are
    // migrated. They never grant authority: the canonical deny-by-default
    // route policy must already have authorized the exact permission.
    return (request, _response, next) => request.adminRoutePolicy
        ? next()
        : next(new AppError('This privileged route has no authorization policy.', { status: 403, code: 'ADMIN_ROUTE_POLICY_MISSING' }));
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRecoveryCode() {
    const bytes = crypto.randomBytes(18);
    const body = Array.from(bytes, (value) => RECOVERY_ALPHABET[value & 31]).join('');
    return `WPA-${body.slice(0, 6)}-${body.slice(6, 12)}-${body.slice(12, 18)}`;
}

function recoveryCodeHash(code, secret) {
    return crypto.createHmac('sha256', secret).update(`wpa-admin-recovery:v1:${String(code).trim().toUpperCase()}`).digest('hex');
}

function decodeReportCursor(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 256) return null;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(parsed.id) || !Number.isFinite(Date.parse(parsed.createdAt))) return null;
        return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
    } catch { return null; }
}

function encodeReportCursor(cursor) {
    return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
}

function executionUnavailable(code, message) {
    return new AppError(message, { status: 503, code, expose: true });
}

function paymentsAreEnabled(config) {
    return config.billing?.paymentsEnabled !== false;
}

function assertPaymentsEnabled(config) {
    if (!paymentsAreEnabled(config)) {
        throw new AppError('Paid billing is disabled during early access. Use a redeem code or an administrator grant.', {
            status: 409,
            code: 'PAYMENTS_DISABLED',
            expose: true
        });
    }
}

function requirePaymentsEnabled(config) {
    return (_request, _response, next) => {
        try { assertPaymentsEnabled(config); next(); } catch (error) { next(error); }
    };
}

function mutationOperation(request, payload) {
    return {
        idempotencyKey: normalizeIdempotencyKey(request.get('Idempotency-Key')),
        requestFingerprint: operationFingerprint(payload)
    };
}

async function sha256File(filePath) {
    const digest = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = nodeFs.createReadStream(filePath);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.once('end', resolve);
        stream.once('error', reject);
    });
    return digest.digest('hex');
}

const AI_REMEDIATION_PROMPT_VERSION = 'wpa-remediation-v1';
const PLAN_CATALOG_VERSION = 'wpa-plans-1.0';

function remediationCacheKey(finding, requestedModel) {
    const payload = JSON.stringify({
        findingFingerprint: finding.fingerprint,
        evidenceVersion: finding.evidenceVersion,
        promptVersion: AI_REMEDIATION_PROMPT_VERSION,
        modelVersion: requestedModel
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function providerCostMetadata(metadata = {}) {
    const cost = metadata?.cost?.totalCredits;
    return {
        cost: typeof cost === 'string' || Number.isFinite(cost) ? Number(cost) : 0,
        currency: 'USD',
        source: cost == null ? 'unavailable' : 'openrouter_provider_reported_credits',
        upstreamInferenceCredits: metadata?.cost?.upstreamInferenceCredits ?? null
    };
}

function createApp(options = {}) {
    const config = options.config || loadConfig();
    if (config.executionRole && config.executionRole !== 'api') throw new Error('API process requires EXECUTION_ROLE=api.');
    const logger = options.logger || defaultLogger;
    const browserExecutionAllowed = !config.browserExecutionDisabled || Boolean(options.engineLabService || options.analysisService || config.engineLab?.serviceUrl);
    const pdfExecutionAllowed = !config.pdfExecutionDisabled || Boolean(options.pdfService);
    const pool = options.pool || new TaskPool({
        maxConcurrent: config.maxConcurrentAnalyses,
        maxQueue: config.maxQueuedAnalyses
    });
    const aiService = options.aiService || createAIServiceClient({
        baseUrl: config.ai?.serviceUrl,
        internalToken: config.ai?.internalToken,
        timeoutMs: config.timeouts.aiMs
    });
    // Test/development callers may still inject the pre-migration adapter.
    // Production never constructs it and reaches OpenRouter only through the
    // isolated internal AI service.
    const legacyAiService = options.geminiService || null;
    const emailTransport = options.emailTransport || createEmailTransport({ config, logger });
    const validateUrl = options.validateUrl || ((url) => validatePublicUrl(url, {
        allowedPorts: config.allowedTargetPorts
    }));
    const clearArtifactFiles = options.clearArtifacts || (() => clearArtifacts(config.artifactDir));
    const platformStore = options.platformStore || createPlatformStore(config);
    const zapLock = options.zapLock || createZapDistributedLock({ pool: platformStore.pool, required: config.nodeEnv === 'production' && Boolean(config.zap?.url) });
    const analysisService = options.analysisService || createAnalysisService({ config, logger, zapLock });
    const durableRateLimitStore = config.nodeEnv === 'production' && platformStore.pool ? true : false;
    // express-rate-limit rejects sharing a Store instance between limiters;
    // each budget gets its own adapter while all adapters share PostgreSQL.
    const makeLimiter = ({ namespace = 'general', ...input }) => limiter({ ...input, ...(durableRateLimitStore ? { store: new PgRateLimitStore(platformStore.pool, namespace) } : {}) });
    const platformQueue = options.platformQueue || createPlatformQueue(config);
    const authService = options.authService || createAuthService(config);
    const billingProvider = options.billingProvider || options.stripeService || createBillingProvider({ config, store: platformStore });
    const sourceService = options.sourceService || createSourceService({ config, store: platformStore, queue: platformQueue });
    const sourceCleanup = sourceService.purgeExpiredArtifacts?.();
    if (sourceCleanup) void Promise.resolve(sourceCleanup).catch((error) => logger.warn('Expired source artifact cleanup failed', { errorCode: error.code || 'SOURCE_CLEANUP_FAILED' }));
    const stagingCleanup = sourceService.purgeExpiredStaging?.();
    if (stagingCleanup) void Promise.resolve(stagingCleanup).catch((error) => logger.warn('Stale source upload cleanup failed', { errorCode: error.code || 'SOURCE_STAGING_CLEANUP_FAILED' }));
    const engineLabService = options.engineLabService || (config.engineLab?.serviceUrl
        ? createEngineLabServiceClient({
            baseUrl: config.engineLab.serviceUrl,
            internalToken: config.engineLab.internalToken,
            allowedHosts: config.engineLab.allowedHosts,
            timeoutMs: config.engineLab.requestTimeoutMs,
            maxRequestBytes: config.engineLab.maxBodyBytes,
            maxResponseBytes: config.engineLab.maxResponseBytes,
            maxArtifactBytes: config.engineLab.maxArtifactBytes
        })
        : createEngineLabService({
            config, logger, validateUrl, zapLock,
            audit: ({ action, actorId, entityId, reason, requestId, before, after, metadata }) => platformStore.logAudit({ workspaceId: null, actorId, action, entityType: 'engine_lab_run', entityId, reason, requestId, before, after, metadata })
        }));
    const integrationService = options.integrationService || createIntegrationService({ config, store: platformStore, validateUrl, logger });
    const supportService = options.supportService || createSupportService({
        store: platformStore,
        logger,
        emailTransport,
        supportEmail: config.email?.supportEmail || ''
    });
    const notifyAccountSecurity = async (state, event, requestId) => {
        if (!emailTransport?.configured || !state?.email) return { status: 'not_configured' };
        try {
            const result = await emailTransport.send({
                kind: 'security',
                to: state.email,
                data: { event },
                idempotencyKey: `security:${state.userId}:${state.state}:${requestId}`.slice(0, 256)
            });
            return { status: 'accepted', provider: result?.provider || emailTransport.provider || 'email' };
        } catch (error) {
            logger.warn('Account security notification failed', { userId: state.userId, state: state.state, errorCode: error.code || 'EMAIL_PROVIDER_UNAVAILABLE' });
            return { status: 'failed', errorCode: error.code || 'EMAIL_PROVIDER_UNAVAILABLE' };
        }
    };
    const pdfService = options.pdfService || new PdfRenderService({ config, maxConcurrent: config.maxConcurrentPdfExports || 1, maxQueue: config.maxQueuedPdfExports || 4 });
    const sourceUpload = multer({
        storage: multer.diskStorage({
            destination(_request, _file, callback) {
                const directory = path.resolve(config.artifactDir, 'upload-staging');
                void fs.mkdir(directory, { recursive: true, mode: 0o700 }).then(() => fs.chmod(directory, 0o700)).then(() => callback(null, directory)).catch(callback);
            },
            filename(_request, file, callback) { callback(null, `${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`); }
        }),
        limits: { fileSize: config.sourceUploadMaxBytes, files: 1, fields: 4 },
        fileFilter(_request, file, callback) {
            callback(file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.zip') ? null : new AppError('Only ZIP source packages are accepted.', { status: 400, code: 'SOURCE_FILE_TYPE_INVALID' }), true);
        }
    });
    // Engine Lab consumes an in-memory fixture only as an administrator tool;
    // customer Source Audit uploads are always disk-staged above.
    const engineLabUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: config.sourceUploadMaxBytes, files: 1, fields: 4 },
        fileFilter(_request, file, callback) {
            callback(file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.zip') ? null : new AppError('Only ZIP source packages are accepted.', { status: 400, code: 'SOURCE_FILE_TYPE_INVALID' }), true);
        }
    });
    const platformService = options.platformService || createPlatformService({
        store: platformStore,
        queue: platformQueue,
        analysisPool: pool,
        analysisService,
        validateUrl,
        config,
        logger,
        integrationService
    });

    const app = express();
    const requirePaidBilling = requirePaymentsEnabled(config);
    let platformReady = false;
    const webhookWorkerId = `webhook-${crypto.randomUUID()}`;
    let webhookTimer = null;
    let sourceJanitorTimer = null;
    let sourceArtifactTimer = null;
    let webhookProcessing = null;
    const processWebhookOutbox = async () => {
        if (webhookProcessing || typeof integrationService.processWebhookOutbox !== 'function') return webhookProcessing;
        webhookProcessing = Promise.resolve().then(() => integrationService.processWebhookOutbox(webhookWorkerId, { limit: config.webhookOutboxBatchSize || 25 }))
            .then((result) => { if (result?.processed) logger.info('Webhook outbox batch processed', { workerId: webhookWorkerId, ...result }); return result; })
            .catch((error) => { logger.warn('Webhook outbox processor failed', { workerId: webhookWorkerId, errorCode: error.code || 'WEBHOOK_OUTBOX_PROCESSOR_FAILED' }); return null; })
            .finally(() => { webhookProcessing = null; });
        return webhookProcessing;
    };
    const canExecuteInProcess = config.executionRole === 'worker' || (!config.browserExecutionDisabled && !config.sourceExecutionDisabled);
    const assertDatabaseRole = async () => {
        if (config.nodeEnv !== 'production' || !config.databaseUrl || !platformStore.pool?.query || !config.databaseExpectedRole) return;
        const result = await platformStore.pool.query('SELECT current_user AS role');
        if (result.rows[0]?.role !== config.databaseExpectedRole) throw new AppError('The API database role is not the configured runtime role.', { status: 503, code: 'DATABASE_ROLE_MISMATCH' });
    };
    const platformStart = assertDatabaseRole().then(() => canExecuteInProcess ? Promise.resolve(sourceService.start?.()).then(() => platformService.start()) : Promise.resolve()).then(async () => {
        platformReady = true;
        await processWebhookOutbox();
        webhookTimer = setInterval(() => { void processWebhookOutbox(); }, config.webhookOutboxPollMs || 15_000);
        webhookTimer.unref?.();
        sourceJanitorTimer = setInterval(() => { void Promise.resolve(sourceService.purgeExpiredStaging?.()).catch((error) => logger.warn('Stale source upload cleanup failed', { errorCode: error.code || 'SOURCE_STAGING_CLEANUP_FAILED' })); }, config.sourceStagingJanitorMs || 15 * 60_000);
        sourceJanitorTimer.unref?.();
        sourceArtifactTimer = setInterval(() => {
            void Promise.resolve(sourceService.purgeExpiredArtifacts?.()).catch(async (error) => {
                logger.warn('Encrypted source artifact cleanup failed', { errorCode: error.code || 'SOURCE_ARTIFACT_CLEANUP_FAILED' });
                await Promise.resolve(platformStore.logAudit?.({ workspaceId: null, actorId: 'api-lifecycle', action: 'source.artifact_cleanup_failed', entityType: 'worker', entityId: 'api-lifecycle', metadata: { errorCode: error.code || 'SOURCE_ARTIFACT_CLEANUP_FAILED' } })).catch(() => {});
            });
        }, config.sourceArtifactJanitorMs || config.sourceStagingJanitorMs || 15 * 60_000);
        sourceArtifactTimer.unref?.();
    }).catch((error) => logger.error('Platform worker failed to start', { error }));
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.locals.closeResources = async () => {
        if (webhookTimer) clearInterval(webhookTimer);
        if (sourceJanitorTimer) clearInterval(sourceJanitorTimer);
        if (sourceArtifactTimer) clearInterval(sourceArtifactTimer);
        pool.close();
        await platformStart;
        await webhookProcessing?.catch(() => {});
        await Promise.allSettled([engineLabService.close?.(), platformService.close(), platformStore.close(), authService.close()]);
    };

    app.use((request, response, next) => {
        request.id = request.get('x-request-id')?.slice(0, 128) || crypto.randomUUID();
        response.setHeader('X-Request-Id', request.id);
        const startedAt = Date.now();
        response.once('finish', () => logger.info('HTTP request completed', {
            requestId: request.id,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            durationMs: Date.now() - startedAt
        }));
        next();
    });

    app.use(helmet({
        contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
        crossOriginResourcePolicy: { policy: 'same-site' },
        hsts: config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
        referrerPolicy: { policy: 'no-referrer' }
    }));
    app.use((_request, response, next) => {
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.use(cors({
        origin(origin, callback) {
            if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
            return callback(new AppError('This origin is not allowed.', { status: 403, code: 'CORS_ORIGIN_DENIED' }));
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id', 'X-Workspace-Id', 'Idempotency-Key'],
        exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
        credentials: true,
        maxAge: 600,
        optionsSuccessStatus: 204
    }));
    const authLimiter = makeLimiter({
        namespace: 'auth',
        windowMs: config.rateLimits.authWindowMs,
        max: config.rateLimits.authMax,
        message: 'Too many authentication requests. Try again later.'
    });
    const loginLimiter = makeLimiter({
        namespace: 'login',
        windowMs: config.rateLimits.loginWindowMs,
        max: config.rateLimits.loginMax,
        message: 'Too many sign-in attempts. Try again later.'
    });
    const passwordResetLimiter = makeLimiter({
        namespace: 'password_reset',
        windowMs: config.rateLimits.passwordResetWindowMs,
        max: config.rateLimits.passwordResetMax,
        message: 'Too many password-reset attempts. Try again later.'
    });
    const passkeyLimiter = makeLimiter({
        namespace: 'admin_passkey',
        windowMs: config.rateLimits.passkeyWindowMs,
        max: config.rateLimits.passkeyMax,
        message: 'Too many passkey requests. Try again later.'
    });
    if (authService.enabled) {
        // Better Auth also has endpoint-specific limits, but this outer IP
        // budget protects the whole auth surface across sign-in, registration,
        // reset, verification, and OAuth callbacks.
        app.use('/api/auth/sign-in', loginLimiter);
        app.use('/api/auth/request-password-reset', passwordResetLimiter);
        app.use('/api/auth/reset-password', passwordResetLimiter);
        app.use('/api/auth/passkey', passkeyLimiter);
        app.use('/api/auth', authLimiter);
        app.use('/api/auth', express.json({ limit: '32kb', strict: true, type: 'application/json' }), (request, _response, next) => {
            if (request.path === '/request-password-reset' && request.body && typeof request.body.redirectTo === 'string') {
                try {
                    const redirect = new URL(request.body.redirectTo, config.appUrl);
                    if (!authTrustedOrigins(config).includes(redirect.origin)) throw new Error('origin');
                    request.body.redirectTo = redirect.toString();
                } catch {
                    return next(new AppError('The password-reset redirect is not an allowed application URL.', { status: 400, code: 'AUTH_REDIRECT_NOT_ALLOWED' }));
                }
            }
            return next();
        });
        app.use('/api/auth', blockBannedEmailSignIn({ store: platformStore }));
        app.use('/api/auth/change-password', createPrivilegedPasswordChangeMiddleware({
            authService,
            store: platformStore,
            notifyAccountSecurity,
            logger
        }));
        app.use('/api/auth/passkey', requireTrustedMutationOrigin(config, authService));
        app.use('/api/auth/passkey', createPrivilegedPasskeyMiddleware({
            config,
            authService,
            store: platformStore,
            notifyAccountSecurity,
            logger
        }));
        app.all('/api/auth/*splat', authService.handler);
    }
    app.post('/api/v1/billing/webhook', requirePaidBilling, express.raw({ type: 'application/json', limit: '256kb' }), async (request, response, next) => {
        try {
            const result = await billingProvider.handleWebhook(request.body, request.get(billingProvider.signatureHeaderName) || '');
            response.json(result);
        } catch (error) { next(error); }
    });
    app.use(express.json({ limit: config.bodyLimit, strict: true, type: 'application/json' }));
    app.use('/api/v1', requireTrustedMutationOrigin(config, authService));

    const generalLimiter = makeLimiter({
        namespace: 'general',
        windowMs: config.rateLimits.generalWindowMs,
        max: config.rateLimits.generalMax,
        message: 'Too many API requests. Try again later.',
        skip: (request) => request.originalUrl.startsWith('/api/v1/admin') || isScanProgressRead(request)
    });
    const scanProgressLimiter = makeLimiter({
        namespace: 'scan_progress',
        windowMs: config.rateLimits.scanProgressWindowMs,
        max: config.rateLimits.scanProgressMax,
        message: 'Too many scan progress requests. Try again later.'
    });
    const adminLimiter = makeLimiter({
        namespace: 'admin',
        windowMs: config.rateLimits.adminWindowMs,
        max: config.rateLimits.adminMax,
        message: 'Too many administrator requests. Try again later.'
    });
    const analysisLimiter = makeLimiter({
        namespace: 'scan',
        windowMs: config.rateLimits.analysisWindowMs,
        max: config.rateLimits.analysisMax,
        message: 'The analysis quota has been reached. Try again later.'
    });
    const aiLimiter = makeLimiter({
        namespace: 'ai',
        windowMs: config.rateLimits.aiWindowMs,
        max: config.rateLimits.aiMax,
        message: 'The AI quota has been reached. Try again later.'
    });
    const adminReauthLimiter = makeLimiter({
        namespace: 'admin_reauth',
        windowMs: config.rateLimits.adminReauthWindowMs,
        max: config.rateLimits.adminReauthMax,
        message: 'Too many administrator re-authentication attempts. Try again later.'
    });
    const adminRecoveryLimiter = makeLimiter({
        namespace: 'admin_recovery',
        windowMs: config.rateLimits.adminRecoveryWindowMs,
        max: config.rateLimits.adminRecoveryMax,
        message: 'Too many administrator recovery attempts. Try again later.'
    });
    const supportLimiter = makeLimiter({
        namespace: 'support',
        windowMs: config.rateLimits.supportWindowMs,
        max: config.rateLimits.supportMax,
        message: 'Too many support requests. Try again later.'
    });
    const supportAdminLimiter = makeLimiter({
        namespace: 'support_admin',
        windowMs: config.rateLimits.supportAdminWindowMs,
        max: config.rateLimits.supportAdminMax,
        message: 'Too many administrator support requests. Try again later.'
    });
    const redeemLimiter = makeLimiter({
        namespace: 'redeem',
        windowMs: config.rateLimits.redeemWindowMs,
        max: config.rateLimits.redeemMax,
        message: 'Too many redeem attempts. Try again later.'
    });
    const adminMutationLimiter = makeLimiter({
        namespace: 'admin_mutation',
        windowMs: config.rateLimits.adminMutationWindowMs,
        max: config.rateLimits.adminMutationMax,
        message: 'Too many administrator mutations. Try again later.'
    });
    const workspaceAuthentication = [
        platformIdentity({ config, authService, store: platformStore }),
        attachWorkspaceMembership({ config, store: platformStore })
    ];
    const legalAcceptanceAuthentication = [
        platformIdentity({ config, authService, store: platformStore, requireLegalAcceptance: false }),
        attachWorkspaceMembership({ config, store: platformStore })
    ];
    const adminAuthentication = requireSecurePlatformAdmin({ config, authService, store: platformStore });
    const adminReauthentication = requireAdminReauthentication({ config, authService, store: platformStore });
    const adminAuthorization = requireAdminRouteAuthorization({ config, store: platformStore });
    const legacyAuthentication = requireLegacyApiAccess(config);

    app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
    // Docker and the reverse proxy only need a bounded readiness signal. Keep
    // capacity, persistence and auth configuration on authenticated details
    // routes rather than exposing deployment facts to anonymous callers.
    app.get('/readyz', async (_request, response) => {
        let ready = platformReady;
        if (ready && config.databaseUrl) {
            const persistence = await platformStore.healthCheck?.().catch(() => ({ status: 'unavailable' }));
            let storage = true;
            try { await fs.mkdir(config.artifactDir, { recursive: true }); await fs.access(config.artifactDir); } catch { storage = false; }
            ready = persistence?.status === 'operational' && storage;
        }
        response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'starting' });
    });

    app.use('/api/v1/admin', adminLimiter);
    app.use('/api/v1/scans/:id/progress', scanProgressLimiter);
    app.use('/api/v1/scans/:id/events', scanProgressLimiter);
    app.use('/api', generalLimiter);
    app.get('/api/v1/legal/config', (_request, response) => {
        const paymentsEnabled = paymentsAreEnabled(config);
        const addressReady = !paymentsEnabled || Boolean(config.legal.businessAddress);
        const operatorReady = Boolean(config.legal.operatorName && config.legal.country && addressReady && config.legal.supportEmail && config.legal.effectiveDate && config.legal.hostingProviderName);
        const subprocessors = [
            {
                provider: config.legal.hostingProviderName,
                purpose: 'Production application, database, artifact and backup infrastructure',
                dataCategories: ['account and workspace data', 'target and report data', 'operational and security metadata'],
                ...(config.legal.hostingProviderRegion ? { processingLocations: [config.legal.hostingProviderRegion] } : {}),
                ...(config.legal.hostingProviderPrivacyUrl ? { privacyUrl: config.legal.hostingProviderPrivacyUrl } : {})
            },
            { provider: 'Resend', purpose: 'Transactional email delivery', dataCategories: ['recipient email', 'message delivery metadata'], privacyUrl: 'https://resend.com/legal/privacy-policy' },
            { provider: 'OpenRouter', purpose: 'Gateway for AI-generated remediation suggestions', dataCategories: ['minimized finding and technical evidence', 'model usage metadata'], privacyUrl: 'https://openrouter.ai/privacy', routing: 'Underlying model providers may vary according to the configured routing policy.' },
            { provider: 'YellowLab.tools', purpose: 'External performance analysis after an explicit per-scan disclosure', dataCategories: ['public target URL', 'analysis job and performance result metadata'], routing: 'The target URL is submitted only when the scan request records external-provider consent.' }
        ];
        if (paymentsAreEnabled(config)) subprocessors.splice(1, 0, {
            provider: 'Paddle',
            purpose: 'Merchant of Record, checkout, subscription and payment lifecycle',
            dataCategories: ['billing identifiers', 'transaction and subscription status'],
            privacyUrl: 'https://www.paddle.com/legal/privacy'
        });
        if (config.legal.edgeProviderName) subprocessors.push({
            provider: config.legal.edgeProviderName,
            purpose: 'Configured DNS, TLS, reverse-proxy or edge delivery services',
            dataCategories: ['request and network metadata'],
            ...(config.legal.edgeProviderRegion ? { processingLocations: [config.legal.edgeProviderRegion] } : {}),
            ...(config.legal.edgeProviderPrivacyUrl ? { privacyUrl: config.legal.edgeProviderPrivacyUrl } : {})
        });
        response.json({
            ready: operatorReady,
            operator: operatorReady ? {
                name: config.legal.operatorName,
                type: config.legal.operatorType || null,
                country: config.legal.country,
                ...(config.legal.businessAddress ? { businessAddress: config.legal.businessAddress } : {}),
                supportEmail: config.legal.supportEmail,
                supportPhone: config.legal.supportPhone || null,
                effectiveDate: config.legal.effectiveDate
            } : null,
            documents: publicLegalVersions(),
            subprocessors,
            billing: {
                provider: config.billing.provider,
                paymentsEnabled,
                mode: paymentsEnabled ? 'paid' : 'redeem_only',
                merchantOfRecord: paymentsEnabled && config.billing.provider === 'paddle' ? 'Paddle' : null,
                enterpriseSalesMode: config.billing.enterpriseSalesMode,
                recurring: paymentsEnabled,
                termsPath: '/terms',
                refundPath: '/refund',
                cancellationPath: '/app/settings/billing'
            }
        });
    });
    app.post('/api/v1/legal/acceptances', ...legalAcceptanceAuthentication, validateBody(legalAcceptanceSchema), async (request, response, next) => {
        try {
            const base = {
                userId: request.platformIdentity.userId,
                workspaceId: request.platformIdentity.workspaceId,
                purpose: 'signup',
                requestId: request.id
            };
            const [terms, acceptableUse] = await Promise.all([
                platformStore.recordLegalAcceptance({ ...base, documentType: 'terms', documentVersion: request.validatedBody.termsVersion }),
                platformStore.recordLegalAcceptance({ ...base, documentType: 'acceptable_use', documentVersion: request.validatedBody.acceptableUseVersion })
            ]);
            response.status(201).json({ accepted: true, acceptances: [terms, acceptableUse] });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/plans', async (_request, response, next) => {
        try { response.json({ plans: await platformService.plans() }); } catch (error) { next(error); }
    });
    app.get('/api/v1/workspace', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json(await platformService.workspace(request.platformIdentity.workspaceId, request.platformIdentity.userId)); } catch (error) { next(error); }
    });
    app.get('/api/v1/workspace/export', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.settings), async (request, response, next) => {
        try {
            const exportData = await platformStore.exportWorkspace(request.platformIdentity.workspaceId);
            response.setHeader('Content-Disposition', 'attachment; filename="workspace-export.json"');
            response.type('application/json').json(exportData);
        } catch (error) { next(error); }
    });
    app.post('/api/v1/workspace/deletion', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.settings), validateBody(workspaceDeletionSchema), async (request, response, next) => {
        try { response.status(202).json({ deletion: await platformStore.requestWorkspaceDeletion(request.platformIdentity.workspaceId, request.platformIdentity.userId) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/dashboard', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json(await platformService.dashboard(request.platformIdentity.workspaceId, request.platformIdentity.userId)); } catch (error) { next(error); }
    });
    // The public status page must not require a workspace session and must not
    // disclose worker capacity, database configuration, or provider flags.
    // Keep the detailed operator/workspace view on a separate authenticated
    // route so the public contract remains safe to cache/display externally.
    app.get('/api/v1/status', async (_request, response, next) => {
        try { response.json(await platformService.publicStatus({ platformReady })); } catch (error) { next(error); }
    });
    app.get('/api/v1/status/details', adminAuthentication, async (_request, response, next) => {
        try { response.json(await platformService.status()); } catch (error) { next(error); }
    });
    app.get('/api/v1/settings', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json(await platformService.settings(request.platformIdentity.workspaceId)); } catch (error) { next(error); }
    });
    app.put('/api/v1/settings', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.settings), validateBody(workspaceSettingsSchema), async (request, response, next) => {
        try { response.json(await platformService.updateSettings(request.platformIdentity.workspaceId, request.validatedBody, request.platformIdentity.userId)); } catch (error) { next(error); }
    });
    app.post('/api/v1/support/tickets', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, validateBody(supportTicketSchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { workspaceId: request.platformIdentity.workspaceId, actorId: request.platformIdentity.userId, ...request.validatedBody });
            const result = await supportService.createTicket(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.validatedBody, operation, request.id);
            response.status(result.created ? 201 : 200).json({ ticket: result.ticket });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/support/tickets', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, async (request, response, next) => {
        try { response.json(await supportService.listTickets(request.platformIdentity.workspaceId, request.query)); } catch (error) { next(error); }
    });
    app.get('/api/v1/support/tickets/:id', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, async (request, response, next) => {
        try { response.json({ ticket: await supportService.customerTicket(request.platformIdentity.workspaceId, request.params.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/support/tickets/:id/replies', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, validateBody(supportReplySchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { ticketId: request.params.id, actorId: request.platformIdentity.userId, intent: 'customer_reply', body: request.validatedBody.body });
            response.status(201).json({ ticket: await supportService.replyCustomer(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.params.id, request.validatedBody.body, operation, request.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/support/tickets/:id/messages', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, validateBody(supportReplySchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { ticketId: request.params.id, actorId: request.platformIdentity.userId, intent: 'customer_reply', body: request.validatedBody.body });
            response.status(201).json({ ticket: await supportService.replyCustomer(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.params.id, request.validatedBody.body, operation, request.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/support/tickets/:id/close', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, async (request, response, next) => {
        try { response.json({ ticket: await supportService.closeCustomer(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.params.id, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/support/tickets/:id/reopen', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, async (request, response, next) => {
        try { response.json({ ticket: await supportService.reopenCustomer(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.params.id, request.id) }); } catch (error) { next(error); }
    });
    app.patch('/api/v1/support/tickets/:id', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.support), supportLimiter, validateBody(supportCustomerTransitionSchema), async (request, response, next) => {
        try { response.json({ ticket: await supportService.transitionCustomer(request.platformIdentity.workspaceId, request.platformIdentity.userId, request.params.id, request.validatedBody.status, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/billing/checkout', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.billing), requirePaidBilling, validateBody(checkoutSchema), async (request, response, next) => {
        try {
            const plan = getPlan(request.validatedBody.planId);
            if (!plan) throw new AppError('Unknown billing plan.', { status: 400, code: 'PLAN_NOT_FOUND' });
            const billingIdentity = {
                userId: request.platformIdentity.userId,
                workspaceId: request.platformIdentity.workspaceId
            };
            const operation = mutationOperation(request, {
                planId: plan.id,
                provider: billingProvider.provider,
                catalogVersion: PLAN_CATALOG_VERSION,
                amountMinor: Math.round(plan.priceUsd * 100),
                currency: 'USD',
                billingInterval: 'month',
                termsVersion: request.validatedBody.termsVersion,
                refundPolicyVersion: request.validatedBody.refundPolicyVersion,
                recurringAcknowledged: true
            });
            const priorAcceptance = await platformStore.getCheckoutAcceptance?.(billingIdentity, operation.idempotencyKey);
            if (!priorAcceptance) {
                const currentSubscription = await platformStore.getSubscription?.(billingIdentity);
                if (currentSubscription && (['paid', 'grace'].includes(currentSubscription.accessState) || ['active', 'trialing', 'past_due'].includes(currentSubscription.status))) {
                    throw new AppError('This user already has a provider-managed subscription.', { status: 409, code: 'BILLING_SUBSCRIPTION_ALREADY_ACTIVE' });
                }
            }
            const acceptance = await platformService.recordCheckoutAcceptance({
                workspaceId: request.platformIdentity.workspaceId,
                userId: request.platformIdentity.userId,
                planId: plan.id,
                provider: billingProvider.provider,
                catalogVersion: PLAN_CATALOG_VERSION,
                amountMinor: Math.round(plan.priceUsd * 100),
                currency: 'USD',
                billingInterval: 'month',
                termsVersion: request.validatedBody.termsVersion,
                refundPolicyVersion: request.validatedBody.refundPolicyVersion,
                requestId: request.id,
                idempotencyKey: operation.idempotencyKey,
                requestFingerprint: operation.requestFingerprint,
                expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
                metadata: { recurringAcknowledged: request.validatedBody.recurringAcknowledged === true }
            });
            if (acceptance.status === 'completed') {
                response.json({ checkout: null, acceptance: { id: acceptance.id, status: acceptance.status, acceptedAt: acceptance.acceptedAt, termsVersion: acceptance.termsVersion, refundPolicyVersion: acceptance.refundPolicyVersion } });
                return;
            }
            if (['expired', 'cancelled'].includes(acceptance.status)) {
                throw new AppError('This checkout operation is closed. Start a new checkout with a new idempotency key.', { status: 409, code: 'CHECKOUT_OPERATION_CLOSED' });
            }
            const checkoutClaim = typeof platformStore.claimCheckoutAcceptance === 'function'
                ? await platformStore.claimCheckoutAcceptance(billingIdentity, operation.idempotencyKey, { owner: request.id, leaseMs: 120_000 })
                : null;
            if (checkoutClaim && !checkoutClaim.claimed) throw new AppError('This checkout operation is already in progress.', { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
            if (!checkoutClaim && acceptance.idempotent && acceptance.status === 'accepted') throw new AppError('This checkout operation is already in progress.', { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
            let checkout;
            try {
                checkout = await billingProvider.createCheckout({
                    userId: request.platformIdentity.userId,
                    workspaceId: request.platformIdentity.workspaceId,
                    planId: acceptance.planId,
                    idempotencyKey: operation.idempotencyKey,
                    acceptanceId: acceptance.id
                });
                await platformService.markCheckoutAcceptance(billingIdentity, operation.idempotencyKey, { status: 'checkout_created', providerCheckoutId: checkout?.id || null });
            } catch (error) {
                if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
                    await platformService.markCheckoutAcceptance(billingIdentity, operation.idempotencyKey, { status: 'cancelled' }).catch(() => {});
                }
                throw error;
            } finally {
                if (checkoutClaim?.claimed) {
                    await platformStore.releaseCheckoutAcceptanceClaim?.(billingIdentity, operation.idempotencyKey, { owner: request.id, leaseToken: checkoutClaim.leaseToken }).catch(() => {});
                }
            }
            response.status(201).json({ ...checkout, checkout, acceptance: { id: acceptance.id, acceptedAt: acceptance.acceptedAt, termsVersion: acceptance.termsVersion, refundPolicyVersion: acceptance.refundPolicyVersion } });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/billing/portal', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.billing), requirePaidBilling, async (request, response, next) => {
        try {
            response.status(201).json(await billingProvider.createCustomerPortal({ userId: request.platformIdentity.userId, workspaceId: request.platformIdentity.workspaceId }));
        } catch (error) { next(error); }
    });
    app.get('/api/v1/billing/subscription', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.billing), async (request, response, next) => {
        try {
            const identity = { userId: request.platformIdentity.userId, workspaceId: request.platformIdentity.workspaceId };
            const subscription = paymentsAreEnabled(config)
                ? await billingProvider.getSubscription(identity)
                : await platformStore.getSubscription?.(identity) || null;
            response.json({ subscription });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/billing/cancel', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.billing), requirePaidBilling, async (request, response, next) => {
        try {
            const subscription = await billingProvider.getSubscription({ userId: request.platformIdentity.userId, workspaceId: request.platformIdentity.workspaceId });
            const subscriptionId = subscription?.providerSubscriptionId || subscription?.stripeSubscriptionId || subscription?.paddleSubscriptionId;
            if (!subscriptionId) throw new AppError('No provider-managed subscription was found.', { status: 409, code: 'BILLING_SUBSCRIPTION_NOT_FOUND' });
            response.json({ subscription: await billingProvider.cancelSubscription({ subscriptionId, immediately: false }) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/redeem', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.billing), redeemLimiter, validateBody(redeemSchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { userId: request.platformIdentity.userId, code: request.validatedBody.code.toUpperCase() });
            const result = await platformService.redeemCode(
                request.platformIdentity.workspaceId,
                request.platformIdentity.userId,
                request.validatedBody.code,
                { requestId: request.id, ...operation }
            );
            response.status(201).json(result);
        } catch (error) { next(error); }
    });
    app.get('/api/v1/integrations', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ integrations: await integrationService.list(request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/integrations/:provider/connect', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.integrations), async (request, response, next) => {
        try { response.status(201).json(await integrationService.beginOAuth(request.platformIdentity.workspaceId, request.params.provider, request.platformIdentity.userId)); } catch (error) { next(error); }
    });
    app.get('/api/v1/integrations/:provider/callback', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.integrations), async (request, response, next) => {
        try {
            await integrationService.finishOAuth(request.platformIdentity.workspaceId, request.params.provider, request.platformIdentity.userId, { code: request.query.code, state: request.query.state });
            response.redirect(303, `${config.appUrl}/app?integration=${encodeURIComponent(request.params.provider)}&result=connected`);
        } catch (error) { next(error); }
    });
    app.put('/api/v1/integrations/webhook', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.integrations), validateBody(webhookIntegrationSchema), async (request, response, next) => {
        try { response.json(await integrationService.configureWebhook(request.platformIdentity.workspaceId, request.validatedBody, request.platformIdentity.userId)); } catch (error) { next(error); }
    });
    app.delete('/api/v1/integrations/:provider', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.integrations), async (request, response, next) => {
        try { response.json(await integrationService.disconnect(request.platformIdentity.workspaceId, request.params.provider)); } catch (error) { next(error); }
    });
    app.get('/api/v1/projects', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ projects: await platformService.listProjects(request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/projects', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.project), validateBody(projectSchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, request.validatedBody);
            const project = await platformService.createProject(request.platformIdentity.workspaceId, request.validatedBody, request.platformIdentity.userId, request.id, operation);
            response.status(project.idempotent ? 200 : 201).json({ project });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/projects/:id/verify-target', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.project), validateBody(verificationSchema), async (request, response, next) => {
        try {
            const project = await platformService.verifyProject(request.platformIdentity.workspaceId, request.params.id, request.validatedBody.method);
            response.json({ project });
        } catch (error) { next(error); }
    });
    app.delete('/api/v1/projects/:id/verification', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.project), async (request, response, next) => {
        try { response.json({ project: await platformService.revokeProjectVerification(request.platformIdentity.workspaceId, request.params.id, request.platformIdentity.userId) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/scans', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.scan), analysisLimiter, validateBody(scanSchema), async (request, response, next) => {
        try {
            const operation = { ...mutationOperation(request, request.validatedBody), requestedByUserId: request.platformIdentity.userId };
            const scan = await platformService.createScan(request.platformIdentity.workspaceId, request.validatedBody, operation);
            response.status(202).json({ scan });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/scans/:id', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ scan: await platformService.getScan(request.platformIdentity.workspaceId, request.params.id) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/analysis-capabilities', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json(await platformService.capabilities()); } catch (error) { next(error); }
    });
    app.get('/api/v1/scans', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ scans: await platformService.listScans(request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/scans/:id/events', ...workspaceAuthentication, async (request, response, next) => {
        try {
            response.setHeader('Content-Type', 'text/event-stream');
            response.setHeader('Cache-Control', 'no-cache, no-transform');
            response.setHeader('Connection', 'keep-alive');
            response.flushHeaders?.();
            let cursor = Math.max(0, Number.parseInt(request.get('last-event-id') || request.query.after, 10) || 0);
            let closed = false;
            response.once('close', () => { closed = true; });
            const write = async (value) => {
                if (closed || response.writableEnded) return false;
                if (response.write(value)) return true;
                await new Promise((resolve) => { response.once('drain', resolve); response.once('close', resolve); });
                return !closed;
            };
            while (!closed) {
                const progress = await platformService.getScanProgress(request.platformIdentity.workspaceId, request.params.id, { after: cursor });
                for (const event of progress.events) {
                    cursor = Number(event.id);
                    if (!(await write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))) break;
                }
                if (['completed', 'partial', 'awaiting_operator', 'failed'].includes(progress.scan.status)) { if (!closed) response.end(); break; }
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
        } catch (error) { next(error); }
    });
    app.get('/api/v1/scans/:id/progress', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json(await platformService.getScanProgress(request.platformIdentity.workspaceId, request.params.id, { after: Math.max(0, Number.parseInt(request.query.after, 10) || 0) })); } catch (error) { next(error); }
    });
    app.get('/api/v1/reports', ...workspaceAuthentication, async (request, response, next) => {
        try {
            const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
            const cursor = decodeReportCursor(request.query.cursor) || (typeof request.query.before === 'string' && Number.isFinite(Date.parse(request.query.before)) ? { createdAt: new Date(request.query.before).toISOString(), id: '\uffff' } : null);
            const reports = await platformService.listReportSummaries(request.platformIdentity.workspaceId, { limit, cursor });
            response.json({ reports, nextCursor: encodeReportCursor(reports.nextCursor) });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/findings', ...workspaceAuthentication, async (request, response, next) => {
        try {
            const limit = Math.min(1_000, Math.max(1, Number.parseInt(request.query.limit, 10) || 200));
            const offset = Math.max(0, Number.parseInt(request.query.offset, 10) || 0);
            const minConfidenceValue = Number.parseFloat(request.query.minConfidence);
            response.json(await platformService.listFindings(request.platformIdentity.workspaceId, {
                limit, offset,
                source: typeof request.query.source === 'string' ? request.query.source.slice(0, 120) : undefined,
                moduleId: typeof request.query.module === 'string' ? request.query.module.slice(0, 80) : undefined,
                device: typeof request.query.device === 'string' ? request.query.device.slice(0, 40) : undefined,
                kind: typeof request.query.kind === 'string' ? request.query.kind.slice(0, 40) : undefined,
                minConfidence: Number.isFinite(minConfidenceValue) ? Math.max(0, Math.min(1, minConfidenceValue)) : undefined,
                coverage: ['complete', 'truncated'].includes(request.query.coverage) ? request.query.coverage : undefined
            }));
        } catch (error) { next(error); }
    });
    app.post(['/api/v1/findings/:fingerprint/remediation', '/api/v1/findings/:fingerprint/ai-remediation'], ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.scan), aiLimiter, validateBody(aiRemediationSchema), async (request, response, next) => {
        const client = requestController(request, response);
        let reservation = null;
        try {
            const fingerprint = String(request.params.fingerprint || '');
            if (!/^[A-Za-z0-9._:-]{1,160}$/.test(fingerprint)) throw new AppError('Finding fingerprint is invalid.', { status: 400, code: 'FINDING_FINGERPRINT_INVALID' });
            const workspaceId = request.platformIdentity.workspaceId;
            const finding = await platformService.getFinding(workspaceId, fingerprint);
            if (!finding) throw new AppError('Finding not found.', { status: 404, code: 'FINDING_NOT_FOUND' });
            const requestedModel = config.ai?.openrouter?.primaryModel || 'openrouter/configured-primary';
            const cacheKey = remediationCacheKey(finding, requestedModel);
            const operation = mutationOperation(request, { findingFingerprint: fingerprint, refresh: request.validatedBody.refresh, requestedModel, evidenceVersion: finding.evidenceVersion });
            if (!request.validatedBody.refresh) {
                const cached = await platformStore.getAiCache(workspaceId, cacheKey);
                if (cached) {
                    response.json({
                        remediation: cached.response,
                        cached: true,
                        semantics: 'ai_generated_suggestion',
                        generatedAt: cached.createdAt
                    });
                    return;
                }
            }

            const dailyCost = await platformStore.dailyAiCost(null);
            if (dailyCost >= config.ai.dailyCostHardLimitUsd) {
                throw new AppError('AI remediation is temporarily unavailable because the daily safety limit was reached.', { status: 503, code: 'AI_DAILY_COST_LIMIT_REACHED', expose: true });
            }
            const reservationInput = {
                userId: request.platformIdentity.userId,
                findingFingerprint: fingerprint,
                requestedModel,
                provider: 'openrouter',
                promptVersion: AI_REMEDIATION_PROMPT_VERSION,
                evidenceVersion: finding.evidenceVersion,
                idempotencyKey: `ai:${operation.idempotencyKey}`
            };
            reservation = await platformStore.consumeAiGeneration(workspaceId, reservationInput);
            if (reservation.idempotent && reservation.usage.status === 'reserved') {
                throw new AppError('An AI remediation for this finding is already in progress.', { status: 409, code: 'AI_GENERATION_IN_PROGRESS' });
            }
            if (reservation.idempotent && reservation.usage.status === 'completed') {
                const durableResult = reservation.usage.usageMetadata?.result;
                if (durableResult) {
                    response.json({ remediation: durableResult, cached: true, semantics: 'ai_generated_suggestion', usage: reservation.usage, quota: reservation.quota, generatedAt: reservation.usage.completedAt });
                    return;
                }
                throw new AppError('The previous AI result is not replayable.', { status: 409, code: 'AI_GENERATION_RESULT_UNAVAILABLE' });
            }
            if (reservation.idempotent && reservation.usage.status === 'failed') {
                throw new AppError('This AI operation already reached a terminal failure. Start an intentional retry with a new idempotency key.', { status: 409, code: 'AI_GENERATION_PREVIOUSLY_FAILED' });
            }

            const generated = await aiService.tryGenerateRemediation(finding, { signal: client.signal, requestId: operation.idempotencyKey });
            if (!generated.ok) {
                await platformStore.settleAiGeneration(workspaceId, reservation.usage.id, {
                    status: 'failed',
                    failureCode: generated.error.code,
                    usageMetadata: generated.error.metadata || {}
                });
                throw new AppError('AI remediation is temporarily unavailable. The core scan and measured finding remain available.', {
                    status: generated.error.status >= 400 && generated.error.status <= 599 ? generated.error.status : 503,
                    code: generated.error.code || 'AI_SERVICE_UNAVAILABLE',
                    expose: true
                });
            }
            const result = generated.result;
            const metadata = result.metadata || {};
            const costMetadata = providerCostMetadata(metadata);
            const settled = await platformStore.settleAiGeneration(workspaceId, reservation.usage.id, {
                status: 'completed',
                actualModel: metadata.actualModel || requestedModel,
                usageMetadata: {
                    requestedModel: metadata.requestedModel || requestedModel,
                    actualModel: metadata.actualModel || null,
                    actualProvider: metadata.actualProvider || null,
                    latencyMs: metadata.latencyMs ?? null,
                    usage: metadata.usage || {},
                    routing: metadata.routing || {},
                    privacy: metadata.privacy || {},
                    result: result.output
                },
                costMetadata
            });
            const cached = await platformStore.putAiCache({
                cacheKey,
                workspaceId,
                findingFingerprint: fingerprint,
                promptVersion: AI_REMEDIATION_PROMPT_VERSION,
                modelVersion: metadata.actualModel || requestedModel,
                evidenceVersion: finding.evidenceVersion,
                response: result.output,
                expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
            });
            const globalCost = await platformStore.dailyAiCost(null);
            if (globalCost >= config.ai.dailyCostSoftLimitUsd) logger.warn('AI daily soft cost limit reached', { costUsd: globalCost, hardLimitUsd: config.ai.dailyCostHardLimitUsd });
            response.status(201).json({
                remediation: result.output,
                cached: false,
                semantics: 'ai_generated_suggestion',
                usage: settled.usage,
                quota: reservation.quota,
                generatedAt: cached.createdAt
            });
        } catch (error) {
            if (reservation?.usage?.id && reservation.usage.status === 'reserved') {
                await platformStore.settleAiGeneration(request.platformIdentity.workspaceId, reservation.usage.id, {
                    status: 'failed', failureCode: error.code || 'AI_GENERATION_FAILED'
                }).catch(() => {});
            }
            next(error);
        } finally { client.cleanup(); }
    });
    app.get('/api/v1/reports/:id', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ report: await platformService.getReport(request.platformIdentity.workspaceId, request.params.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/reports/:id/expert-review-requests', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.review), validateBody(expertReviewRequestSchema), async (request, response, next) => {
        try { response.status(201).json({ review: await platformService.requestExpertReview(request.platformIdentity.workspaceId, request.params.id, request.validatedBody, request.platformIdentity.userId) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/expert-review-requests', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ reviews: await platformService.listExpertReviews(request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/expert-review-requests/:id', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ review: await platformService.getExpertReview(request.params.id, request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/reports/:id/share', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.share), validateBody(shareSchema), async (request, response, next) => {
        try {
            await platformService.assertCommercialCapability(request.platformIdentity.workspaceId, request.platformIdentity.userId, 'report_share');
            response.status(201).json(await platformService.createShareLink(request.platformIdentity.workspaceId, request.params.id, request.platformIdentity.userId, request.validatedBody.expiresInDays));
        } catch (error) { next(error); }
    });
    app.delete('/api/v1/reports/:id/share', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.share), async (request, response, next) => {
        try {
            await platformService.assertCommercialCapability(request.platformIdentity.workspaceId, request.platformIdentity.userId, 'report_share');
            response.json(await platformService.revokeShareLink(request.platformIdentity.workspaceId, request.params.id, request.platformIdentity.userId));
        } catch (error) { next(error); }
    });
    app.get('/api/v1/reports/compare/:leftId/:rightId', ...workspaceAuthentication, async (request, response, next) => {
        try {
            await platformService.assertCommercialCapability(request.platformIdentity.workspaceId, request.platformIdentity.userId, 'report_compare');
            response.json(await platformService.compareReports(request.platformIdentity.workspaceId, request.params.leftId, request.params.rightId));
        } catch (error) { next(error); }
    });
    app.get('/api/v1/shared-reports/:token', async (request, response, next) => {
        try { response.json({ report: await platformService.getSharedReport(request.params.token) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/source-inputs', ...workspaceAuthentication, requireWorkspacePermission(WORKSPACE_PERMISSIONS.sourceUpload), sourceUpload.single('source'), async (request, response, next) => {
        try {
            if (config.sourceExecutionDisabled && (!config.databaseUrl || typeof platformQueue.send !== 'function')) throw executionUnavailable('SOURCE_WORKER_REQUIRED', 'Source Audit is handled by the isolated worker.');
            if (!request.file?.path) throw new AppError('A ZIP source package is required.', { status: 400, code: 'SOURCE_FILE_REQUIRED' });
            if (!request.body.projectId || request.body.projectId.length > 128) throw new AppError('A valid projectId is required.', { status: 400, code: 'SOURCE_PROJECT_REQUIRED' });
            const operation = mutationOperation(request, { projectId: request.body.projectId, sha256: await sha256File(request.file.path) });
            const result = await sourceService.acceptZipFile(request.platformIdentity.workspaceId, { projectId: request.body.projectId, filePath: request.file.path, requestedByUserId: request.platformIdentity.userId, ...operation });
            response.status(result.sourceInput?.status === 'queued' ? 202 : 200).json(result);
        } catch (error) { if (request.file?.path) await fs.unlink(request.file.path).catch(() => {}); next(error); }
    });
    app.get('/api/v1/source-inputs', ...workspaceAuthentication, async (request, response, next) => {
        try { response.json({ sourceInputs: await platformStore.listSourceInputs(request.platformIdentity.workspaceId) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/source-inputs/:id', ...workspaceAuthentication, async (request, response, next) => {
        try {
            const sourceInput = await platformStore.getSourceInput(request.platformIdentity.workspaceId, request.params.id);
            if (!sourceInput) throw new AppError('Source Audit not found.', { status: 404, code: 'SOURCE_AUDIT_NOT_FOUND' });
            response.json({ sourceInput });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/reports/:id/export', ...workspaceAuthentication, async (request, response, next) => {
        try {
            await platformService.assertCommercialCapability(request.platformIdentity.workspaceId, request.platformIdentity.userId, 'report_export');
            const report = await platformService.getReport(request.platformIdentity.workspaceId, request.params.id);
            if (request.query.format === 'pdf') {
                if (config.pdfExecutionDisabled && !pdfExecutionAllowed) {
                    if (typeof platformStore.createExecutionResult !== 'function') throw executionUnavailable('PDF_WORKER_REQUIRED', 'PDF exports are handled by the isolated worker.');
                    const jobKey = `pdf:${request.platformIdentity.workspaceId}:${report.id}:${report.version || 1}`;
                    const execution = await platformStore.createExecutionResult({ jobKey, workspaceId: request.platformIdentity.workspaceId, kind: 'pdf', input: { reportId: report.id } });
                    try {
                        const jobId = await enqueueWorkerJob(platformQueue, 'pdf', { workspaceId: request.platformIdentity.workspaceId, reportId: report.id, executionId: execution.id, jobKey }, { singletonKey: jobKey });
                        response.status(202).json({ execution: { id: execution.id, status: execution.status, kind: 'pdf' }, jobId });
                    } catch (error) {
                        const claimed = await platformStore.claimExecutionResult?.(jobKey, { owner: 'api-enqueue-failure' });
                        if (claimed?.status === 'running') await platformStore.settleExecutionResult?.(jobKey, { owner: 'api-enqueue-failure', leaseToken: claimed.leaseToken, status: 'failed', failureCode: error.code || 'PDF_QUEUE_FAILED' });
                        throw error;
                    }
                    return;
                }
                const controller = requestController(request, response);
                let pdf;
                try { pdf = await pdfService.render(report, { signal: controller.signal }); }
                finally { controller.cleanup(); }
                response.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${report.id}.pdf"`);
                response.send(pdf);
                return;
            }
            if (request.query.format === 'html') {
                const safePayload = JSON.stringify(report.payload, null, 2).replaceAll('<', '\\u003c');
                response.type('html').send(`<!doctype html><html lang="${report.locale}"><meta charset="utf-8"><title>WPA Report ${report.id}</title><style>body{font:14px/1.5 system-ui;margin:40px;color:#17202a}pre{white-space:pre-wrap}@media print{body{margin:12mm}}</style><h1>WebPage Analyzer Report</h1><p>${report.status} · v${report.version}</p><pre>${safePayload}</pre></html>`);
                return;
            }
            response.setHeader('Content-Disposition', `attachment; filename="${report.id}.json"`);
            response.json(report);
        } catch (error) { next(error); }
    });
    app.get('/api/v1/executions/:id', ...workspaceAuthentication, async (request, response, next) => {
        try {
            const execution = await platformStore.getExecutionResult?.(request.platformIdentity.workspaceId, request.params.id);
            if (!execution) throw new AppError('Execution not found.', { status: 404, code: 'EXECUTION_NOT_FOUND' });
            response.json({ execution: { id: execution.id, kind: execution.kind, status: execution.status, failureCode: execution.failureCode || null, bytes: execution.bytes || null, contentType: execution.contentType || null, createdAt: execution.createdAt, updatedAt: execution.updatedAt, completedAt: execution.completedAt || null } });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/executions/:id/download', ...workspaceAuthentication, async (request, response, next) => {
        try {
            const execution = await platformStore.getExecutionResult?.(request.platformIdentity.workspaceId, request.params.id);
            if (!execution) throw new AppError('Execution not found.', { status: 404, code: 'EXECUTION_NOT_FOUND' });
            if (execution.status !== 'completed' || !execution.artifactPath) throw new AppError('Execution result is not ready.', { status: 409, code: 'EXECUTION_NOT_READY' });
            const root = path.resolve(config.workerResultDir || path.resolve(config.artifactDir, 'worker-results'));
            const target = path.resolve(execution.artifactPath);
            if (!target.startsWith(`${root}${path.sep}`)) throw new AppError('Execution artifact path is invalid.', { status: 500, code: 'EXECUTION_ARTIFACT_INVALID' });
            response.type(execution.contentType || 'application/octet-stream').send(await fs.readFile(target));
        } catch (error) { next(error); }
    });

    app.get('/api/v1/admin/access-status', async (request, response, next) => {
        try { response.json(await getAdminAccessStatus({ config, authService, store: platformStore, request })); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/reauth', adminReauthLimiter, validateBody(adminReauthSchema), adminReauthentication, (request, response) => response.json({
        reauthenticated: true,
        expiresAt: request.adminReauthentication?.expiresAt
    }));
    app.use('/api/v1/admin', adminAuthentication, adminAuthorization);
    app.get('/api/v1/admin/me', adminAuthentication, (request, response) => response.json({ admin: {
        actorId: request.adminIdentity.actorId,
        email: request.adminIdentity.email,
        role: request.adminIdentity.role,
        permissions: request.adminIdentity.permissions,
        via: request.adminIdentity.via,
        securityVersion: request.adminIdentity.securityVersion,
        webAuthnRequired: request.adminIdentity.webAuthnRequired,
        webAuthnCredentialCount: request.adminIdentity.webAuthnCredentialCount,
        webAuthnEnrollmentRequired: request.adminIdentity.webAuthnEnrollmentRequired,
        recommendedWebAuthnCredentialCount: request.adminIdentity.recommendedWebAuthnCredentialCount
    } }));
    app.get('/api/v1/admin/security/status', adminAuthentication, async (request, response, next) => {
        try {
            const [passkeys, accounts, marker, auditEvents] = await Promise.all([
                platformStore.listUserPasskeys?.(request.adminIdentity.actorId) || [],
                platformStore.listAdminAccounts?.() || [],
                platformStore.getAdminReauthentication?.(request.adminIdentity.sessionBinding, request.adminIdentity.actorId),
                platformStore.adminResources?.('audit') || []
            ]);
            const self = accounts.find((item) => item.userId === request.adminIdentity.actorId);
            const recentActivity = auditEvents.filter((event) =>
                String(event.action || '').startsWith('security.')
                && (event.actorId === request.adminIdentity.actorId || event.entityId === request.adminIdentity.actorId)
            ).slice(0, 10).map((event) => ({
                id: event.id,
                action: event.action,
                actorId: event.actorId,
                entityType: event.entityType,
                entityId: event.entityId,
                reason: event.reason || null,
                createdAt: event.createdAt
            }));
            response.json({
                role: request.adminIdentity.role,
                permissions: request.adminIdentity.permissions,
                policy: {
                    webAuthnRequired: request.adminIdentity.webAuthnRequired,
                    minimumCredentials: config.adminSecurity.minimumCredentialCount,
                    recommendedCredentials: config.adminSecurity.recommendedCredentialCount,
                    stepUpMaxAgeSeconds: Math.floor(config.adminSecurity.stepUpMaxAgeMs / 1_000)
                },
                passkeys,
                recoveryCodesRemaining: self?.recoveryCodesRemaining || 0,
                recentStepUp: marker ? { method: marker.method, verifiedAt: marker.verifiedAt, expiresAt: marker.expiresAt } : null,
                recentActivity
            });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/security/step-up/webauthn', adminReauthLimiter, validateBody(adminWebAuthnConfirmSchema), async (request, response, next) => {
        try {
            const expiresAt = new Date(Date.now() + config.adminSecurity.stepUpMaxAgeMs);
            const marker = await platformStore.confirmWebAuthnStepUp({
                userId: request.adminIdentity.actorId,
                sessionId: request.adminIdentity.sessionBinding,
                securityVersion: request.adminIdentity.securityVersion,
                expiresAt,
                requestId: request.id
            });
            response.json({ verified: true, method: marker.method, expiresAt: marker.expiresAt });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/security/recovery-codes', adminRecoveryLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const plaintextCodes = Array.from({ length: config.adminSecurity.recoveryCodeCount }, () => generateRecoveryCode());
            const batchId = `recovery_${crypto.randomUUID()}`;
            await platformStore.replaceAdminRecoveryCodes({
                userId: request.adminIdentity.actorId,
                batchId,
                codes: plaintextCodes.map((code) => ({ id: `recovery_code_${crypto.randomUUID()}`, codeHash: recoveryCodeHash(code, config.auth.secret) })),
                actorId: request.adminIdentity.actorId,
                requestId: request.id
            });
            const notification = await notifyAccountSecurity({ userId: request.adminIdentity.actorId, email: request.adminIdentity.email, state: 'recovery_generated' }, 'Yeni tek kullanımlık admin recovery kodları oluşturuldu', request.id);
            response.status(201).json({ batchId, codes: plaintextCodes, shownOnce: true, notification });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/security/recovery/use', adminRecoveryLimiter, validateBody(adminRecoveryUseSchema), async (request, response, next) => {
        try {
            try {
                const result = await authService.reauthenticate(request, request.validatedBody);
                if (result?.status !== true) throw new Error('verification_failed');
            } catch {
                await platformStore.logAudit?.({ actorId: request.adminIdentity.actorId, action: 'security.recovery_failed', entityType: 'admin_account', entityId: request.adminIdentity.actorId, requestId: request.id, metadata: { reason: 'credential_verification_failed' } }).catch(() => {});
                throw new AppError('Administrator recovery verification failed.', { status: 403, code: 'ADMIN_RECOVERY_FAILED' });
            }
            const recovery = await platformStore.useAdminRecoveryCode({
                userId: request.adminIdentity.actorId,
                codeHash: recoveryCodeHash(request.validatedBody.code, config.auth.secret),
                sessionBinding: request.adminIdentity.sessionBinding,
                sessionId: request.adminSessionId,
                expiresAt: new Date(Date.now() + config.adminSecurity.recoverySessionTtlMs),
                actorId: request.adminIdentity.actorId,
                requestId: request.id
            });
            const notification = await notifyAccountSecurity({ userId: request.adminIdentity.actorId, email: request.adminIdentity.email, state: 'recovery_used' }, 'Bir admin recovery kodu kullanıldı; diğer oturumlar iptal edildi ve yeni passkey enrollment gerekiyor', request.id);
            response.json({ recovered: true, enrollmentRequired: true, expiresAt: recovery.expiresAt, notification });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/security/admins', adminAuthentication, async (_request, response, next) => {
        try { response.json({ admins: await platformStore.listAdminAccounts() }); } catch (error) { next(error); }
    });
    app.put('/api/v1/admin/security/admins/:userId', adminMutationLimiter, validateBody(adminRoleAssignmentSchema), async (request, response, next) => {
        try {
            const account = await platformStore.changeAdminAccount({
                actorId: request.adminIdentity.actorId,
                targetUserId: request.params.userId,
                role: request.validatedBody.role,
                active: request.validatedBody.active,
                reason: request.validatedBody.reason,
                requestId: request.id
            });
            const notification = await notifyAccountSecurity({ userId: account.userId, email: account.email, state: 'role_changed' }, `Ayrıcalıklı rolünüz ${account.active ? account.role : 'inactive'} olarak güncellendi`, request.id);
            response.json({ account, notification });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/security/admins/:userId/mfa-reset', adminRecoveryLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const before = await platformStore.getAdminAccount(request.params.userId);
            const result = await platformStore.resetAdminMfa({ actorId: request.adminIdentity.actorId, targetUserId: request.params.userId, reason: request.validatedBody.reason, requestId: request.id });
            const notification = await notifyAccountSecurity({ userId: request.params.userId, email: before?.email, state: 'mfa_reset' }, 'Ayrıcalıklı hesap MFA credentialları sıfırlandı; yeniden enrollment gerekiyor', request.id);
            response.json({ result, notification });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/engine-lab/catalog', adminAuthentication, requireAdminRole('admin', 'super_admin'), async (request, response, next) => {
        try { response.json({ engines: await engineLabService.catalog({ requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/engine-lab/runs', adminAuthentication, requireAdminRole('admin', 'super_admin'), async (request, response, next) => {
        try { response.json({ runs: await engineLabService.listRuns({ requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/engine-lab/runs/:id', adminAuthentication, requireAdminRole('admin', 'super_admin'), async (request, response, next) => {
        try { response.json({ run: await engineLabService.getRun(request.params.id, { requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/engine-lab/runs/:id/artifacts/:engineId/:filename', adminAuthentication, requireAdminRole('admin', 'super_admin'), async (request, response, next) => {
        try {
            const artifact = await engineLabService.getArtifact(request.params.id, request.params.engineId, request.params.filename, { requestId: request.id });
            response.type(artifact.mimeType);
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Content-Disposition', `inline; filename="${request.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
            response.send(artifact.buffer);
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/engine-lab/runs', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, engineLabUpload.single('source'), async (request, response, next) => {
        try {
            if (config.browserExecutionDisabled && !browserExecutionAllowed) throw executionUnavailable('BROWSER_WORKER_REQUIRED', 'Browser execution is handled by the isolated worker.');
            const raw = { ...request.body };
            if (typeof raw.engineIds === 'string') raw.engineIds = JSON.parse(raw.engineIds);
            if (typeof raw.journey === 'string' && raw.journey.trim()) raw.journey = JSON.parse(raw.journey);
            else delete raw.journey;
            if (typeof raw.crawlerLimit === 'string') raw.crawlerLimit = Number(raw.crawlerLimit);
            const parsed = engineLabRunSchema.safeParse(raw);
            if (!parsed.success) throw new AppError('Engine Lab request validation failed.', { status: 400, code: 'VALIDATION_ERROR', details: parsed.error.issues });
            const idempotencyKey = normalizeIdempotencyKey(request.get('Idempotency-Key'), { required: false }) || `engine-lab:${request.id}`;
            const requestFingerprint = operationFingerprint({
                targetUrl: parsed.data.targetUrl,
                engineIds: [...new Set(parsed.data.engineIds)].sort(),
                journey: parsed.data.journey || null,
                crawlerLimit: parsed.data.crawlerLimit || 25,
                sourceSha256: request.file?.buffer ? crypto.createHash('sha256').update(request.file.buffer).digest('hex') : null
            });
            const run = await engineLabService.createRun({
                ...parsed.data,
                sourceBuffer: request.file?.buffer,
                actorId: request.adminIdentity.actorId,
                requestId: request.id,
                idempotencyKey,
                requestFingerprint
            });
            request.file?.buffer.fill(0);
            response.status(202).json({ run });
        } catch (error) {
            request.file?.buffer.fill(0);
            if (error instanceof SyntaxError) return next(new AppError('Engine Lab JSON fields are invalid.', { status: 400, code: 'VALIDATION_ERROR' }));
            next(error);
        }
    });
    app.post('/api/v1/admin/engine-lab/runs/:id/cancel', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ run: await engineLabService.cancelRun(request.params.id, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/overview', adminAuthentication, async (_request, response, next) => {
        try { response.json(await platformService.adminOverview()); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/resources/:kind', adminAuthentication, async (request, response, next) => {
        try {
            if (!['users', 'workspaces', 'grants', 'audit', 'scans', 'findings', 'reports'].includes(request.params.kind)) throw new AppError('Unknown admin resource.', { status: 404, code: 'ADMIN_RESOURCE_NOT_FOUND' });
            response.json({ resources: await platformService.adminResources(request.params.kind) });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/workspaces/:id', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), async (request, response, next) => {
        try {
            const workspace = await platformService.adminWorkspace(request.params.id);
            if (!workspace) throw new AppError('Workspace not found.', { status: 404, code: 'WORKSPACE_NOT_FOUND' });
            response.json({ workspace });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/users/:id', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), async (request, response, next) => {
        try {
            const user = await platformService.adminUser(request.params.id);
            if (!user) throw new AppError('User not found.', { status: 404, code: 'USER_NOT_FOUND' });
            response.json({ user });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/users/:id/ban', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const user = await platformStore.setUserState(request.params.id, 'banned', { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id });
            const notification = await notifyAccountSecurity(user, 'Hesabınız bir yönetici tarafından askıya alındı. Destek ile iletişime geçebilirsiniz.', request.id);
            response.json({ user, notification });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/users/:id/unban', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const user = await platformStore.setUserState(request.params.id, 'active', { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id });
            const notification = await notifyAccountSecurity(user, 'Hesabınız yeniden etkinleştirildi.', request.id);
            response.json({ user, notification });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:id/suspend', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ workspace: await platformStore.setWorkspaceState(request.params.id, 'suspended', { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:id/unsuspend', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ workspace: await platformStore.setWorkspaceState(request.params.id, 'active', { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/users/:id/credits', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminCreditAdjustmentSchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { userId: request.params.id, ...request.validatedBody });
            const adjustment = await platformService.adjustUserCredits(request.params.id, request.validatedBody.kind, request.validatedBody.amount, {
                actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id, expiresAt: request.validatedBody.expiresAt || null, ...operation
            });
            response.status(adjustment.idempotent ? 200 : 201).json({ adjustment, effective: await platformService.getUserEffectiveEntitlements(request.params.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/users/:id/entitlements', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminEntitlementGrantSchema), async (request, response, next) => {
        try {
            const input = request.validatedBody;
            const operation = mutationOperation(request, { userId: request.params.id, ...input });
            const grant = await platformService.grantUserEntitlement(request.params.id, {
                source: 'admin',
                temporaryPlanId: input.planId || null,
                entitlementOverrides: input.moduleId ? { [input.moduleId]: { executionMode: input.executionMode, limit: input.limit ?? null } } : {},
                expiresAt: input.expiresAt
            }, { actorId: request.adminIdentity.actorId, reason: input.reason, requestId: request.id, ...operation });
            response.status(grant.idempotent ? 200 : 201).json({ grant, effective: await platformService.getUserEffectiveEntitlements(request.params.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/entitlements/:id/revoke', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const grant = await platformService.revokeEntitlement(request.params.id, { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id });
            if (!grant) throw new AppError('Entitlement grant not found.', { status: 404, code: 'ENTITLEMENT_GRANT_NOT_FOUND' });
            response.json({ grant });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/redeem-codes', adminAuthentication, requireAdminRole('admin', 'super_admin'), async (_request, response, next) => {
        try { response.json({ codes: await platformService.listRedeemCodes({}) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/redeem-codes', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminRedeemCreateSchema), async (request, response, next) => {
        try {
            const input = request.validatedBody;
            const operation = mutationOperation(request, input);
            const code = await platformService.createRedeemCode({
                ...input,
                temporaryPlanId: input.temporaryPlan || null,
                createdBy: request.adminIdentity.actorId,
                requestId: request.id,
                ...operation
            });
            response.status(201).json({ code });
        } catch (error) { next(error); }
    });
    for (const [operation, patch] of [['disable', { active: false }], ['enable', { active: true }], ['revoke', { revoke: true }]]) {
        app.post(`/api/v1/admin/redeem-codes/:id/${operation}`, adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminRedeemMutationSchema), async (request, response, next) => {
            try {
                const code = await platformService.mutateRedeemCode(request.params.id, patch, { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id });
                if (!code) throw new AppError('Redeem code not found.', { status: 404, code: 'REDEEM_CODE_NOT_FOUND' });
                response.json({ code });
            } catch (error) { next(error); }
        });
    }
    app.get('/api/v1/admin/workspaces/:workspaceId/scans/:scanId', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), async (request, response, next) => {
        try { response.json({ scan: await platformService.getScan(request.params.workspaceId, request.params.scanId) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:workspaceId/scans/:scanId/cancel', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(adminScanMutationSchema), async (request, response, next) => {
        try { response.json({ scan: await platformService.cancelScan(request.params.workspaceId, request.params.scanId, request.validatedBody, request.adminIdentity.actorId, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:workspaceId/scans/:scanId/retry', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(adminScanMutationSchema), async (request, response, next) => {
        try { response.status(202).json({ scan: await platformService.retryScan(request.params.workspaceId, request.params.scanId, request.validatedBody, request.adminIdentity.actorId, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:id/billing/reconcile', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, requirePaidBilling, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const userId = await platformStore.resolveEntitlementUser?.(request.params.id, null);
            const result = await billingProvider.reconcileSubscription({ userId, workspaceId: request.params.id });
            await platformStore.logAudit({ workspaceId: request.params.id, actorId: request.adminIdentity.actorId, action: 'subscription.reconciliation_requested', entityType: 'workspace', entityId: request.params.id, reason: request.validatedBody.reason, requestId: request.id, metadata: { provider: billingProvider.provider, applied: Boolean(result?.applied) } });
            response.json(result);
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/webhook-outbox', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), async (request, response, next) => {
        try {
            const workspaceId = typeof request.query.workspaceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request.query.workspaceId) ? request.query.workspaceId : undefined;
            const status = typeof request.query.status === 'string' && ['pending', 'processing', 'retrying', 'delivered', 'dead_letter'].includes(request.query.status) ? request.query.status : undefined;
            const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
            response.json({ events: await platformStore.listWebhookOutboxAdmin({ workspaceId, status, limit }) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/webhook-outbox/:id/replay', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminWebhookReplaySchema), async (request, response, next) => {
        try {
            const workspaceId = request.validatedBody.workspaceId || null;
            const event = await platformStore.replayWebhookOutbox(request.params.id, request.adminIdentity.actorId, workspaceId, { reason: request.validatedBody.reason, requestId: request.id });
            if (!event) throw new AppError('Webhook event was not found or is not replayable.', { status: 404, code: 'WEBHOOK_OUTBOX_NOT_REPLAYABLE' });
            response.json({ event });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/support/tickets', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, async (request, response, next) => {
        try { response.json(await supportService.listAdminTickets(request.query)); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/support/tickets/:id', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, async (request, response, next) => {
        try { response.json({ ticket: await supportService.adminTicket(request.params.id) }); } catch (error) { next(error); }
    });
    app.patch('/api/v1/admin/support/tickets/:id', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, validateBody(supportAdminUpdateSchema), async (request, response, next) => {
        try { response.json({ ticket: await supportService.updateAdminTicket(request.params.id, request.adminIdentity.actorId, request.validatedBody, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/support/tickets/:id/notes', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, validateBody(supportReplySchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { ticketId: request.params.id, actorId: request.adminIdentity.actorId, intent: 'internal_note', body: request.validatedBody.body });
            response.status(201).json({ ticket: await supportService.adminNote(request.params.id, request.adminIdentity.actorId, request.validatedBody.body, operation, request.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/support/tickets/:id/replies', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, validateBody(supportReplySchema), async (request, response, next) => {
        try {
            const visibility = request.validatedBody.visibility || 'customer';
            const operation = mutationOperation(request, { ticketId: request.params.id, actorId: request.adminIdentity.actorId, intent: visibility === 'internal' ? 'internal_note' : 'admin_reply', visibility, body: request.validatedBody.body });
            response.status(201).json({ ticket: await supportService.adminMessage(request.params.id, request.adminIdentity.actorId, request.validatedBody.body, visibility, operation, request.id) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/support/tickets/:id/messages', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), supportAdminLimiter, validateBody(supportReplySchema), async (request, response, next) => {
        try {
            const visibility = request.validatedBody.visibility || 'customer';
            const operation = mutationOperation(request, { ticketId: request.params.id, actorId: request.adminIdentity.actorId, intent: visibility === 'internal' ? 'internal_note' : 'admin_reply', visibility, body: request.validatedBody.body });
            response.status(201).json({ ticket: await supportService.adminMessage(request.params.id, request.adminIdentity.actorId, request.validatedBody.body, visibility, operation, request.id) });
        } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/operator-tasks', adminAuthentication, async (request, response, next) => {
        try { response.json({ tasks: await platformService.listOperatorTasks(request.query.status || 'pending') }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/expert-reviews', adminAuthentication, async (_request, response, next) => {
        try { response.json({ reviews: await platformService.listExpertReviews() }); } catch (error) { next(error); }
    });
    app.get('/api/v1/admin/expert-reviews/:id', adminAuthentication, async (request, response, next) => {
        try { response.json({ review: await platformService.getExpertReview(request.params.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/expert-reviews/:id/claim', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ review: await platformService.claimExpertReview(request.params.id, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.put('/api/v1/admin/expert-reviews/:id/findings/:fingerprint', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(expertDecisionSchema), async (request, response, next) => {
        try {
            const { reason } = request.validatedBody;
            const decision = {
                decision: request.validatedBody.decision,
                priority: request.validatedBody.priority,
                rationale: request.validatedBody.rationale,
                ...(request.validatedBody.edits ? { edits: request.validatedBody.edits } : {})
            };
            response.json({ review: await platformService.decideExpertFinding(request.params.id, request.params.fingerprint, decision, request.adminIdentity.actorId, { reason, requestId: request.id }) });
        } catch (error) { next(error); }
    });
    app.put('/api/v1/admin/expert-reviews/:id/roadmap', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(roadmapSchema), async (request, response, next) => {
        try { response.json({ review: await platformService.setExpertRoadmap(request.params.id, request.validatedBody.items, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/expert-reviews/:id/finalize', adminAuthentication, requireAdminRole('admin', 'super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ review: await platformService.finalizeExpertReview(request.params.id, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/expert-reviews/:id/publish', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try { response.json({ review: await platformService.publishExpertReview(request.params.id, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id }) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/operator-tasks/:id/complete', adminAuthentication, requireAdminRole('operator', 'admin', 'super_admin'), adminMutationLimiter, validateBody(operatorCompletionSchema), async (request, response, next) => {
        try { response.json({ task: await platformService.completeOperatorTask(request.params.id, request.validatedBody, request.adminIdentity.actorId, request.id) }); } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/reports/:id/publish', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const report = await platformStore.getReportById?.(request.params.id);
            if (!report) throw new AppError('Report not found.', { status: 404, code: 'REPORT_NOT_FOUND' });
            response.json({ report: await platformService.publishReport(report.workspaceId, report.id, { actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id }) });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/users/:id/plan', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(planAssignmentSchema), async (request, response, next) => {
        try {
            const operation = mutationOperation(request, { userId: request.params.id, ...request.validatedBody });
            const result = await platformService.assignUserPlan(request.params.id, request.validatedBody.planId, {
                actorId: request.adminIdentity.actorId,
                reason: request.validatedBody.reason,
                requestId: request.id,
                source: 'admin',
                ...operation
            });
            response.status(result.idempotent ? 200 : 201).json(result);
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:id/deletion/authorize', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(adminReasonSchema), async (request, response, next) => {
        try {
            const deletion = await platformStore.authorizeWorkspaceDeletion(request.params.id, request.adminIdentity.actorId, { reason: request.validatedBody.reason, requestId: request.id });
            if (!deletion) throw new AppError('No pending deletion request exists for this workspace.', { status: 404, code: 'WORKSPACE_DELETION_NOT_FOUND' });
            response.json({ deletion });
        } catch (error) { next(error); }
    });
    app.post('/api/v1/admin/workspaces/:id/deletion/execute', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(adminDeletionExecuteSchema), async (request, response, next) => {
        try {
            const deletion = await platformStore.executeWorkspaceDeletion(request.params.id, { dryRun: request.validatedBody.dryRun, actorId: request.adminIdentity.actorId, reason: request.validatedBody.reason, requestId: request.id });
            response.json({ deletion });
        } catch (error) { next(error); }
    });
    app.put('/api/v1/admin/plans/:planId/entitlements/:moduleId', adminAuthentication, requireAdminRole('super_admin'), adminMutationLimiter, validateBody(entitlementSchema), async (request, response, next) => {
        try {
            const moduleId = adminGrantableModuleSchema.safeParse(request.params.moduleId);
            if (!moduleId.success) throw new AppError('This module cannot be granted.', { status: 400, code: 'ENTITLEMENT_MODULE_NOT_GRANTABLE' });
            response.json({ plan: await setPlanEntitlementWithAudit({
                store: platformStore,
                planId: request.params.planId,
                moduleId: moduleId.data,
                entitlement: { executionMode: request.validatedBody.executionMode, limit: request.validatedBody.limit },
                actorId: request.adminIdentity.actorId,
                reason: request.validatedBody.reason,
                requestId: request.id
            }) });
        } catch (error) { next(error); }
    });
    app.get('/api/analyze', legacyAuthentication, (_request, response) => response.json({
        message: "Send POST /api/analyze with JSON: { \"url\": \"https://example.com\" }."
    }));
    app.get('/api/solve', legacyAuthentication, (_request, response) => response.json({
        message: 'Send POST /api/solve with a validated issue object.'
    }));

    app.post('/api/analyze', legacyAuthentication, analysisLimiter, validateBody(analyzeSchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
            if (config.browserExecutionDisabled && !browserExecutionAllowed) throw executionUnavailable('BROWSER_WORKER_REQUIRED', 'Browser analysis is handled by the isolated worker.');
            const target = await validateUrl(request.validatedBody.url);
            logger.info('Analysis accepted', { requestId: request.id, hostname: target.hostname });
            const report = await pool.run(
                (signal) => analysisService.analyze(target, signal),
                { signal: client.signal, timeoutMs: config.timeouts.analysisMs }
            );
            response.json({ message: 'Analysis completed successfully.', url: target.url, report });
        } catch (error) {
            next(error);
        } finally {
            client.cleanup();
        }
    });

    app.post('/api/solve', legacyAuthentication, aiLimiter, validateBody(solveSchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
            const solution = legacyAiService
                ? await legacyAiService.solveIssue(request.validatedBody.issue, client.signal)
                : (await aiService.generateRemediation(request.validatedBody.issue, { signal: client.signal, requestId: request.id })).output;
            response.json({ solution });
        } catch (error) {
            next(error);
        } finally {
            client.cleanup();
        }
    });

    app.post('/api/executive-summary', legacyAuthentication, aiLimiter, validateBody(executiveSummarySchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
            const summary = legacyAiService
                ? await legacyAiService.generateExecutiveSummary(request.validatedBody.scores, client.signal)
                : (await aiService.generateExecutiveSummary(request.validatedBody.scores, { signal: client.signal, requestId: request.id })).output;
            response.json({ summary });
        } catch (error) {
            next(error);
        } finally {
            client.cleanup();
        }
    });

    app.delete('/api/logs', requireAdminApiKey(config.adminApiKeys), async (request, response, next) => {
        try {
            const deletedCount = await clearArtifactFiles();
            logger.info('Analyzer artifacts cleared', { requestId: request.id, deletedCount });
            response.json({ message: `Successfully cleared ${deletedCount} analyzer artifact files.`, deletedCount });
        } catch (error) {
            next(error);
        }
    });

    app.use((request, _response, next) => next(new AppError('The requested endpoint does not exist.', {
        status: 404,
        code: 'NOT_FOUND'
    })));

    app.use((error, request, response, _next) => {
        let normalizedError = error;
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            normalizedError = new AppError('The uploaded source package is too large.', { status: 413, code: 'SOURCE_FILE_TOO_LARGE' });
        } else if (error?.type === 'entity.too.large') {
            normalizedError = new AppError('The request body is too large.', { status: 413, code: 'REQUEST_TOO_LARGE' });
        } else if (error instanceof SyntaxError && error?.status === 400) {
            normalizedError = new AppError('The request body is not valid JSON.', { status: 400, code: 'INVALID_JSON' });
        }
        const status = Number.isInteger(normalizedError.status) ? normalizedError.status : 500;
        const safeStatus = status >= 400 && status <= 599 ? status : 500;
        const message = normalizedError.expose || safeStatus < 500 ? normalizedError.message : 'An unexpected server error occurred.';
        logger.error('HTTP request failed', {
            requestId: request.id,
            method: request.method,
            path: request.path,
            status: safeStatus,
            code: normalizedError.code || 'INTERNAL_ERROR',
            error: normalizedError
        });
        if (response.headersSent || response.destroyed) return;
        response.status(safeStatus).json({
            error: message,
            code: normalizedError.code || 'INTERNAL_ERROR',
            requestId: request.id
        });
    });

    return app;
}

module.exports = { createApp };
