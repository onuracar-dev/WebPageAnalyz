const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
const { validatePublicUrl } = require('./security/url-safety');
const { resolveRedirects } = require('./security/url-resolver');
const { ScanLimiter } = require('./security/scan-limiter');
const { ContactLimiter } = require('./security/contact-limiter');
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

const ALLOWED_CONTACT_TOPICS = Object.freeze(['Feedback', 'Bug report', 'Abuse report', 'Other']);

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
    urlValidator = null,
    limiter = null,
    contactLimiter = null,
    nowFn = null,
    redirectResolver = null,
    lookup = null,
    fetchImpl = null
} = {}) {
    const app = express();

    const scanLimiter = limiter || new ScanLimiter({
        hostCooldownMs: config.hostCooldownMs,
        dailyScanLimit: config.dailyScanLimit,
        nowFn: nowFn || (() => Date.now())
    });

    const contactLimiterInstance = contactLimiter || new ContactLimiter({
        dailyContactLimit: config.contactDailyLimit,
        nowFn: nowFn || (() => Date.now())
    });

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

    // Rate limiter for contact submissions (separate counter from scan limiter)
    const contactRateLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: config.contactRateLimitPerHour || 3,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json({
                error: {
                    code: 'CONTACT_RATE_LIMITED',
                    message: 'Contact request limit exceeded. Please try again later.'
                }
            });
        }
    });

    // Health check endpoint
    app.get('/api/health', (_req, res) => {
        const stats = queue.getStats();
        res.json({
            ok: true,
            queue: stats,
            dailyRemaining: scanLimiter.getDailyRemaining(),
            contact: Boolean(config.resendApiKey && config.contactTo && config.contactFrom)
        });
    });

    // Supported engines endpoint
    app.get('/api/engines', (_req, res) => {
        res.json({
            engines: INCLUDED_ENGINES
        });
    });

    // Contact form endpoint
    app.post('/api/contact', contactRateLimiter, async (req, res, next) => {
        try {
            // Check if contact delivery is configured
            if (!config.resendApiKey || !config.contactTo || !config.contactFrom) {
                return res.status(503).json({
                    error: {
                        code: 'CONTACT_DISABLED',
                        message: 'Contact service is currently disabled.'
                    }
                });
            }

            const { name, email, topic, message, website } = req.body || {};

            // Honeypot: if website is filled, silently return 202 without sending email
            if (website && String(website).trim().length > 0) {
                return res.status(202).json({ ok: true });
            }

            // Input validation
            const fields = {};

            if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
                fields.name = 'Name must be between 1 and 100 characters.';
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (typeof email !== 'string' || email.trim().length === 0 || email.length > 200 || !emailRegex.test(email.trim())) {
                fields.email = 'A valid email address is required (maximum 200 characters).';
            }

            if (!ALLOWED_CONTACT_TOPICS.includes(topic)) {
                fields.topic = 'Topic must be one of: Feedback, Bug report, Abuse report, Other.';
            }

            if (typeof message !== 'string' || message.trim().length < 20 || message.trim().length > 2000) {
                fields.message = 'Message must be between 20 and 2000 characters.';
            }

            if (Object.keys(fields).length > 0) {
                return res.status(400).json({
                    error: {
                        code: 'CONTACT_INVALID',
                        message: 'Contact form validation failed.',
                        fields
                    }
                });
            }

            // Global daily limit check
            if (contactLimiterInstance.isDailyLimitReached()) {
                return res.status(429).json({
                    error: {
                        code: 'CONTACT_RATE_LIMITED',
                        message: 'Daily contact limit reached. Please try again tomorrow.'
                    }
                });
            }

            // Clean name for subject (strip CR/LF header injection, trim, max 80 chars)
            const cleanName = String(name).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
            const subject = `[WPA Lite] ${topic} from ${cleanName}`;
            const text = [
                `Name: ${cleanName}`,
                `Email: ${email.trim()}`,
                `Topic: ${topic}`,
                `Submitted At: ${new Date().toISOString()}`,
                '',
                'Message:',
                message.trim()
            ].join('\n');

            const fetcher = fetchImpl || globalThis.fetch;
            try {
                const response = await fetcher('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${config.resendApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from: config.contactFrom,
                        to: [config.contactTo],
                        reply_to: email.trim(),
                        subject,
                        text
                    }),
                    signal: AbortSignal.timeout(8000)
                });

                if (!response.ok) {
                    logger?.error?.('Resend API returned error status', { status: response.status });
                    return res.status(502).json({
                        error: {
                            code: 'CONTACT_FAILED',
                            message: 'Failed to deliver contact message.'
                        }
                    });
                }
            } catch (err) {
                logger?.error?.('Resend delivery exception', { error: err.message });
                return res.status(502).json({
                    error: {
                        code: 'CONTACT_FAILED',
                        message: 'Failed to deliver contact message.'
                    }
                });
            }

            contactLimiterInstance.recordSubmission();

            // Audit log: only topic, at, ipHash (never name, email, or message body)
            const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
            const ipHash = crypto.createHash('sha256')
                .update(`${config.consentSalt}:${clientIp}`)
                .digest('hex');

            console.log(JSON.stringify({
                event: 'contact',
                topic,
                at: new Date().toISOString(),
                ipHash
            }));

            return res.status(202).json({ ok: true });
        } catch (error) {
            return next(error);
        }
    });

    // Submit new scan
    // Order: consent -> url validation -> redirect resolution -> active job dedup -> result cache -> host cooldown -> daily limit -> queue capacity
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
            let initialTargetResult;
            try {
                if (typeof urlValidator === 'function') {
                    initialTargetResult = await urlValidator(url);
                } else {
                    initialTargetResult = await validatePublicUrl(url, { allowedPorts: config.allowedPorts });
                }
            } catch (error) {
                return res.status(400).json({
                    error: {
                        code: 'URL_NOT_ALLOWED',
                        message: error?.message || 'The specified target URL is not allowed.'
                    }
                });
            }

            const requestedUrl = initialTargetResult.url;

            // 2b. Server-side redirect resolution (follows up to 5 hops, validates each hop for SSRF)
            let resolvedUrl = requestedUrl;
            try {
                const resolverFn = redirectResolver || resolveRedirects;
                const redirectOpts = {
                    maxHops: 5,
                    timeoutMs: 8000,
                    allowedPorts: config.allowedPorts,
                    validator: typeof urlValidator === 'function' ? urlValidator : validatePublicUrl
                };
                if (lookup) {
                    redirectOpts.lookup = lookup;
                }
                const redirectRes = await resolverFn(requestedUrl, redirectOpts);
                resolvedUrl = redirectRes.resolvedUrl;
            } catch (err) {
                if (err.code === 'URL_NOT_ALLOWED' || err.code === 'PRIVATE_TARGET_BLOCKED' || err.status === 400) {
                    return res.status(400).json({
                        error: {
                            code: 'URL_NOT_ALLOWED',
                            message: err.message || 'Redirect target URL is not allowed.'
                        }
                    });
                }
                resolvedUrl = requestedUrl;
            }

            const targetUrl = resolvedUrl;
            let targetHostname;
            try {
                targetHostname = new URL(targetUrl).hostname.toLowerCase();
            } catch {
                return res.status(400).json({
                    error: {
                        code: 'URL_NOT_ALLOWED',
                        message: 'Invalid target URL.'
                    }
                });
            }

            // 3. Queue deduplication check (active jobs)
            const activeJob = queue.findActiveByUrl(targetUrl);
            if (activeJob) {
                return res.status(202).json({
                    id: activeJob.id,
                    status: activeJob.status,
                    url: activeJob.url,
                    requestedUrl: activeJob.requestedUrl || requestedUrl,
                    ...(activeJob.status === 'queued' ? { position: activeJob.position } : {})
                });
            }

            // 4. Sonuc cache (if host in cooldown and exact URL has completed result in memory)
            const hostRemainingMs = scanLimiter.getHostRemainingCooldownMs(targetHostname);
            const isHostInCooldown = hostRemainingMs > 0;

            if (isHostInCooldown) {
                const cachedJob = queue.findCompletedByUrl(targetUrl);
                if (cachedJob) {
                    return res.status(200).json({
                        id: cachedJob.id,
                        status: 'completed',
                        cached: true,
                        url: cachedJob.url,
                        requestedUrl: cachedJob.requestedUrl || requestedUrl
                    });
                }
            }

            // 5. Host cooldown check (if host is in cooldown and not matched by cached result above)
            if (isHostInCooldown) {
                const retryAfterSeconds = Math.max(1, Math.ceil(hostRemainingMs / 1000));
                res.setHeader('Retry-After', String(retryAfterSeconds));
                return res.status(429).json({
                    error: {
                        code: 'HOST_COOLDOWN',
                        message: 'This host was scanned recently. Please wait before requesting another scan.',
                        retryAfterSeconds
                    },
                    retryAfterSeconds
                });
            }

            // 6. Gunluk global limit check
            if (scanLimiter.isDailyLimitReached()) {
                return res.status(429).json({
                    error: {
                        code: 'DAILY_LIMIT_REACHED',
                        message: 'Daily scan limit reached. Please try again tomorrow.'
                    }
                });
            }

            // 7. Queue capacity check
            if (queue.isFull()) {
                return res.status(429).json({
                    error: {
                        code: 'QUEUE_FULL',
                        message: 'The scan queue is currently full. Please try again later.'
                    }
                });
            }

            // 8. Consent audit logging to stdout (salt-hashed IP, never raw IP)
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

            // 9. Enqueue scan job and record in limiter
            const job = queue.enqueue({
                id: scanId,
                url: targetUrl,
                requestedUrl
            });
            scanLimiter.recordScan(targetHostname);

            return res.status(202).json({
                id: job.id,
                status: job.status,
                position: job.position,
                url: job.url,
                requestedUrl: job.requestedUrl
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
            requestedUrl: job.requestedUrl || job.url,
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

module.exports = { createApp, INCLUDED_ENGINES, sanitizeJobError, SANITIZED_JOB_MESSAGES, ScanLimiter, ContactLimiter };
