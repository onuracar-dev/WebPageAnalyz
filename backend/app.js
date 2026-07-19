const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { loadConfig } = require('./config');
const { logger: defaultLogger } = require('./lib/logger');
const { AppError } = require('./lib/errors');
const { TaskPool } = require('./lib/task-pool');
const { runWithTimeout } = require('./lib/abort');
const { validatePublicUrl } = require('./security/url-safety');
const { createAnalysisService } = require('./services/analysis-service');
const { clearArtifacts } = require('./services/artifact-service');
const { createGeminiService } = require('./analyzers/gemini');
const { analyzeSchema, executiveSummarySchema, solveSchema } = require('./validation/schemas');
const { validateBody } = require('./middleware/validate');
const { optionalApiKey, requireAdminApiKey } = require('./middleware/auth');
const { limiter } = require('./middleware/rate-limit');

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

function createApp(options = {}) {
    const config = options.config || loadConfig();
    const logger = options.logger || defaultLogger;
    const pool = options.pool || new TaskPool({
        maxConcurrent: config.maxConcurrentAnalyses,
        maxQueue: config.maxQueuedAnalyses
    });
    const analysisService = options.analysisService || createAnalysisService({ config, logger });
    const geminiService = options.geminiService || createGeminiService({
        apiKey: config.geminiApiKey,
        modelName: config.geminiModel,
        timeoutMs: config.timeouts.aiMs
    });
    const validateUrl = options.validateUrl || ((url) => validatePublicUrl(url, {
        allowedPorts: config.allowedTargetPorts
    }));
    const clearArtifactFiles = options.clearArtifacts || (() => clearArtifacts(config.artifactDir));

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.locals.closeResources = () => pool.close();

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
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
        exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
        maxAge: 600,
        optionsSuccessStatus: 204
    }));
    app.use(express.json({ limit: config.bodyLimit, strict: true, type: 'application/json' }));

    const generalLimiter = limiter({
        windowMs: config.rateLimits.generalWindowMs,
        max: config.rateLimits.generalMax,
        message: 'Too many API requests. Try again later.'
    });
    const analysisLimiter = limiter({
        windowMs: config.rateLimits.analysisWindowMs,
        max: config.rateLimits.analysisMax,
        message: 'The analysis quota has been reached. Try again later.'
    });
    const aiLimiter = limiter({
        windowMs: config.rateLimits.aiWindowMs,
        max: config.rateLimits.aiMax,
        message: 'The AI quota has been reached. Try again later.'
    });
    const apiAuthentication = optionalApiKey(config.apiKeys);

    app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
    app.get('/readyz', (_request, response) => response.json({
        status: 'ready',
        analysisCapacity: pool.stats,
        aiConfigured: Boolean(config.geminiApiKey)
    }));

    app.use('/api', generalLimiter);
    app.get('/api/analyze', (_request, response) => response.json({
        message: "Send POST /api/analyze with JSON: { \"url\": \"https://example.com\" }."
    }));
    app.get('/api/solve', (_request, response) => response.json({
        message: 'Send POST /api/solve with a validated issue object.'
    }));

    app.post('/api/analyze', apiAuthentication, analysisLimiter, validateBody(analyzeSchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
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

    app.post('/api/solve', apiAuthentication, aiLimiter, validateBody(solveSchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
            const solution = await runWithTimeout(
                (signal) => geminiService.solveIssue(request.validatedBody.issue, signal),
                config.timeouts.aiMs,
                'AI solution request',
                client.signal
            );
            response.json({ solution });
        } catch (error) {
            next(error);
        } finally {
            client.cleanup();
        }
    });

    app.post('/api/executive-summary', apiAuthentication, aiLimiter, validateBody(executiveSummarySchema), async (request, response, next) => {
        const client = requestController(request, response);
        try {
            const summary = await runWithTimeout(
                (signal) => geminiService.generateExecutiveSummary(request.validatedBody.scores, signal),
                config.timeouts.aiMs,
                'Executive summary request',
                client.signal
            );
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
        if (error?.type === 'entity.too.large') {
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
