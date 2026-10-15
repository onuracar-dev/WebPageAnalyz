const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
const { validatePublicUrl } = require('./security/url-safety');
const { AppError } = require('./lib/errors');

const INCLUDED_ENGINES = Object.freeze([
    {
        id: 'lighthouse',
        name: 'Google Lighthouse',
        description: 'Chromium-based automated performance, accessibility, best practices, and SEO audit.',
        external: false
    },
    {
        id: 'axe',
        name: 'Axe Accessibility',
        description: 'Automated WCAG accessibility rule validation via Axe Puppeteer.',
        external: false
    },
    {
        id: 'yellowLab',
        name: 'Yellow Lab Tools',
        description: 'Frontend code quality, bad DOM patterns, and JavaScript execution audit.',
        external: true
    },
    {
        id: 'wpaPage',
        name: 'WPA Page Intelligence',
        description: 'Rendered link discovery, SEO, metadata, layout, and runtime diagnostics.',
        external: false
    },
    {
        id: 'performancePlus',
        name: 'Performance Plus',
        description: 'Core Web Vitals telemetry (LCP, CLS, long tasks) on desktop and mobile viewports.',
        external: false
    },
    {
        id: 'advancedGeo',
        name: 'Advanced GEO & Entity Signals',
        description: 'Schema.org structured data, entity completeness, and crawler access analysis.',
        external: false
    },
    {
        id: 'visualUx',
        name: 'Visual UX',
        description: 'Layout stability, viewport-dependent element sizing, and visual responsiveness.',
        external: false
    }
]);

const SANITIZED_JOB_MESSAGES = {
    SCAN_TIMEOUT: 'Scan exceeded total time limit.',
    SCAN_FAILED: 'Scan execution failed.',
    QUEUE_FULL: 'Scan queue is currently full.',
    QUEUE_CLOSED: 'Scan queue is closed.'
};

function sanitizeJobError(error) {
    if (!error) return { code: 'SCAN_FAILED', message: 'Scan execution failed.' };
    const code = error.code || 'SCAN_FAILED';
    return {
        code,
        message: SANITIZED_JOB_MESSAGES[code] || 'Scan execution failed.'
    };
}

function createApp({
    config,
    queue,
    runner = null,
    logger = null,
    urlValidator = null
} = {}) {
    const app = express();

    if (config.trustProxy) {
        app.set('trust proxy', config.trustProxy);
    }

    app.use(helmet());

    // CORS configuration: fail-closed in production if ALLOWED_ORIGIN is empty
    if (config.allowedOrigin) {
        app.use(cors({
            origin: config.allowedOrigin,
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));
    } else if (config.nodeEnv === 'development') {
        app.use(cors({
            origin: 'http://localhost:5173',
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));
    } else if (config.nodeEnv === 'test') {
        app.use(cors());
    } else {
        // Production with empty ALLOWED_ORIGIN: fail-closed, reject cross-origin requests
        app.use(cors({ origin: false }));
    }

    app.use(express.json({ limit: '10kb' }));

    // Rate limiter for scan submissions (validate header enabled for proper reverse proxy detection)
    const scanRateLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: config.rateLimitPerHour || 3,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json({
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message: 'Scan request limit exceeded. Please try again later.'
                }
            });
        }
    });

    // Health check endpoint
    app.get('/api/health', (_req, res) => {
        const stats = queue.getStats();
        res.json({
            ok: true,
            queue: stats
        });
    });

    // Supported engines endpoint
    app.get('/api/engines', (_req, res) => {
        res.json({
            engines: INCLUDED_ENGINES
        });
    });

    // Submit new scan
    app.post('/api/scans', scanRateLimiter, async (req, res, next) => {
        try {
            const { url, consent } = req.body || {};

            // 1. Consent verification
            if (!consent || consent.accepted !== true || consent.version !== config.consentVersion) {
                return res.status(400).json({
                    error: {
                        code: 'CONSENT_REQUIRED',
                        message: 'Valid consent acceptance and matching consent version are required.'
                    }
                });
            }

            // 2. Target URL validation (SSRF Protection)
            let targetResult;
            try {
                if (typeof urlValidator === 'function') {
                    targetResult = await urlValidator(url);
                } else {
                    targetResult = await validatePublicUrl(url, { allowedPorts: config.allowedPorts });
                }
            } catch (error) {
                return res.status(400).json({
                    error: {
                        code: 'URL_NOT_ALLOWED',
                        message: error?.message || 'The specified target URL is not allowed.'
                    }
                });
            }

            const targetUrl = targetResult.url;

            // 3. Queue deduplication check
            const activeJob = queue.findActiveByUrl(targetUrl);
            if (activeJob) {
                return res.status(202).json({
                    id: activeJob.id,
                    status: activeJob.status,
                    ...(activeJob.status === 'queued' ? { position: activeJob.position } : {})
                });
            }

            // 4. Queue capacity check
            if (queue.isFull()) {
                return res.status(429).json({
                    error: {
                        code: 'QUEUE_FULL',
                        message: 'The scan queue is currently full. Please try again later.'
                    }
                });
            }

            // 5. Consent audit logging to stdout (salt-hashed IP, never raw IP)
            const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
            const ipHash = crypto.createHash('sha256')
                .update(`${config.consentSalt}:${clientIp}`)
                .digest('hex');
            const scanId = crypto.randomUUID();

            console.log(JSON.stringify({
                event: 'consent',
                scanId,
                consentVersion: consent.version,
                at: new Date().toISOString(),
                ipHash
            }));

            // 6. Enqueue scan job
            const job = queue.enqueue({
                id: scanId,
                url: targetUrl
            });

            return res.status(202).json({
                id: job.id,
                status: job.status,
                position: job.position
            });
        } catch (error) {
            return next(error);
        }
    });

    // Query scan details and results
    app.get('/api/scans/:id', (req, res) => {
        const job = queue.getJob(req.params.id);
        if (!job) {
            return res.status(404).json({
                error: {
                    code: 'SCAN_NOT_FOUND',
                    message: 'The requested scan was not found or has expired.'
                }
            });
        }

        const response = {
            id: job.id,
            url: job.url,
            status: job.status,
            ...(job.status === 'queued' && job.position ? { position: job.position } : {}),
            ...(job.status === 'failed' && job.error ? { error: sanitizeJobError(job.error) } : {}),
            ...(job.startedAt ? { startedAt: job.startedAt } : {}),
            ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
            engines: job.engines || {},
            findings: job.findings || [],
            summary: job.summary || { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} }
        };

        return res.json(response);
    });

    // 404 Route Handler
    app.use((_req, res) => {
        res.status(404).json({
            error: {
                code: 'NOT_FOUND',
                message: 'Resource not found'
            }
        });
    });

    // Centralized JSON Error Handler
    app.use((err, _req, res, _next) => {
        const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
        const code = err.type === 'entity.too.large'
            ? 'PAYLOAD_TOO_LARGE'
            : (err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR'));
        const message = err.expose || status < 500
            ? err.message
            : 'An unexpected internal error occurred.';

        res.status(status).json({
            error: {
                code,
                message
            }
        });
    });

    return app;
}

module.exports = { createApp, INCLUDED_ENGINES, sanitizeJobError, SANITIZED_JOB_MESSAGES };
