const path = require('node:path');

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function finiteNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boolean(value, fallback = false) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function csv(value, fallback = []) {
    if (!value) return fallback;
    return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function bodyLimit(value) {
    return /^\d+(?:kb|mb)$/i.test(value || '') ? value : '32kb';
}

function exactOrigin(value) {
    try { return new URL(value).origin; } catch { return null; }
}

function databasePoolOptions(configOrConnectionString, { max = 10, applicationName = 'webpage-analyzer' } = {}) {
    const config = typeof configOrConnectionString === 'string' ? null : configOrConnectionString;
    const connectionString = config ? config.databaseUrl : configOrConnectionString;
    const production = config?.nodeEnv === 'production';
    return {
        connectionString,
        max,
        application_name: applicationName,
        connectionTimeoutMillis: config?.databaseConnectionTimeoutMs || 10_000,
        idleTimeoutMillis: config?.databaseIdleTimeoutMs || 30_000,
        ...(production ? { ssl: { rejectUnauthorized: config.databaseRejectUnauthorized !== false } } : {})
    };
}

function assertProductionConfig(config) {
    if (config.nodeEnv !== 'production') return config;
    if (config.adminReauthSessionLifetime) throw new Error('ADMIN_REAUTH_SESSION_LIFETIME is a local-development convenience and cannot be enabled in production.');
    if (config.executionRole === 'api') {
        if (config.adminSecurity?.webAuthnRequired !== true) throw new Error('ADMIN_WEBAUTHN_REQUIRED must remain enabled for the production API.');
        if (!config.adminSecurity.privilegedRoles.includes('super_admin') || !config.adminSecurity.privilegedRoles.includes('admin')) {
            throw new Error('ADMIN_PRIVILEGED_ROLES must include super_admin and admin in production.');
        }
    }
    if (!['api', 'worker', 'maintenance', 'ai', 'email'].includes(config.executionRole)) throw new Error('EXECUTION_ROLE must be api, worker, maintenance, ai or email in production.');
    const expectedRole = config.executionRole === 'api' ? 'wpa_runtime' : config.executionRole === 'maintenance' ? 'wpa_maintenance' : config.executionRole === 'worker' ? 'wpa_worker' : '';
    if (expectedRole && config.databaseExpectedRole !== expectedRole) throw new Error(`DATABASE_EXPECTED_ROLE must be ${expectedRole} for ${config.executionRole}.`);
    if (['worker', 'maintenance'].includes(config.executionRole) && !['platform/worker-handler.js', '/app/platform/worker-handler.js'].includes(config.workerHandlerModule)) throw new Error('WORKER_HANDLER_MODULE must point to platform/worker-handler.js in production.');
    if (config.executionRole === 'api' && (!config.browserExecutionDisabled || !config.pdfExecutionDisabled || !config.sourceExecutionDisabled || !config.osvExecutionDisabled)) {
        throw new Error('Production API execution must be disabled for browser, PDF, source and OSV jobs.');
    }
    if (config.executionRole === 'maintenance' && (!config.browserExecutionDisabled || !config.pdfExecutionDisabled || !config.sourceExecutionDisabled || !config.osvExecutionDisabled)) {
        throw new Error('Production maintenance execution must keep browser, PDF, source and OSV jobs disabled.');
    }
    if (expectedRole) {
        if (config.databaseRejectUnauthorized !== true) throw new Error('Production PostgreSQL TLS certificate verification must remain enabled.');
        try {
            const sslMode = new URL(config.databaseUrl).searchParams.get('sslmode');
            if (sslMode && ['disable', 'allow', 'prefer'].includes(sslMode.toLowerCase())) throw new Error('Production PostgreSQL connection strings must not disable TLS.');
        } catch (error) {
            if (error.message.includes('must not disable TLS')) throw error;
            throw new Error('DATABASE_URL must be a valid PostgreSQL connection string in production.');
        }
    }
    if (config.executionRole === 'worker' && config.chromeNoSandbox) throw new Error('CHROME_NO_SANDBOX is forbidden for production workers.');
    const required = [];
    if (expectedRole) required.push(['DATABASE_URL', config.databaseUrl, 1]);
    if (config.executionRole === 'api') required.push(
        ['BETTER_AUTH_SECRET', config.auth.secret, 32],
        ['SOURCE_ENCRYPTION_KEY', config.sourceEncryptionKey, 32],
        ['ENGINE_LAB_SERVICE_URL', config.engineLab.serviceUrl, 1],
        ['ENGINE_LAB_SERVICE_TOKEN', config.engineLab.internalToken, 32],
        ['AI_SERVICE_URL', config.ai.serviceUrl, 1],
        ['AI_SERVICE_TOKEN', config.ai.internalToken, 32],
        ['OPENROUTER_MODEL_PRIMARY', config.ai.openrouter.primaryModel, 3],
        ['EMAIL_SERVICE_URL', config.email.serviceUrl, 1],
        ['EMAIL_SERVICE_TOKEN', config.email.internalToken, 32],
        ['LEGAL_OPERATOR_NAME', config.legal.operatorName, 1],
        ['LEGAL_COUNTRY', config.legal.country, 2],
        ['LEGAL_BUSINESS_ADDRESS', config.legal.businessAddress, 5],
        ['LEGAL_SUPPORT_EMAIL', config.legal.supportEmail, 3],
        ['LEGAL_EFFECTIVE_DATE', config.legal.effectiveDate, 8],
        ['LEGAL_HOSTING_PROVIDER_NAME', config.legal.hostingProviderName, 2]
    );
    if (config.executionRole === 'worker') required.push(
        ['SOURCE_ENCRYPTION_KEY', config.sourceEncryptionKey, 32],
        ...(config.engineLab.enabled ? [['ENGINE_LAB_SERVICE_TOKEN', config.engineLab.internalToken, 32]] : [])
    );
    if (config.executionRole === 'ai') required.push(
        ['AI_SERVICE_TOKEN', config.ai.internalToken, 32],
        ['OPENROUTER_API_KEY', config.ai.openrouter.apiKey, 16],
        ['OPENROUTER_MODEL_PRIMARY', config.ai.openrouter.primaryModel, 3],
        ['OPENROUTER_SITE_URL', config.ai.openrouter.siteUrl, 1],
        ['OPENROUTER_APP_NAME', config.ai.openrouter.appName, 1]
    );
    if (config.executionRole === 'email') required.push(
        ['EMAIL_SERVICE_TOKEN', config.email.internalToken, 32],
        ['RESEND_API_KEY', config.email.resendApiKey, 16],
        ['EMAIL_FROM', config.email.from, 3],
        ['SUPPORT_EMAIL', config.email.supportEmail, 3]
    );
    if (config.executionRole === 'worker' && config.zap.url) required.push(['ZAP_API_KEY', config.zap.apiKey, 32]);
    const insecurePlaceholder = /^(?:replace-with|local-development|change-me|example|test[-_])/i;
    if (config.executionRole === 'api' && config.billing.provider !== 'paddle') throw new Error('BILLING_PROVIDER must be paddle in production.');
    if (config.executionRole === 'ai' && config.ai.provider !== 'openrouter') throw new Error('AI_PROVIDER must be openrouter for the production AI service.');
    if (config.executionRole === 'email' && config.email.provider !== 'resend') throw new Error('EMAIL_PROVIDER must be resend for the production email service.');
    if (['api', 'ai'].includes(config.executionRole) && config.ai.dailyCostSoftLimitUsd > config.ai.dailyCostHardLimitUsd) throw new Error('AI_DAILY_COST_SOFT_LIMIT_USD must not exceed AI_DAILY_COST_HARD_LIMIT_USD.');
    if (!['contact', 'invite_only'].includes(config.billing.enterpriseSalesMode)) throw new Error('ENTERPRISE_SALES_MODE must be contact or invite_only in production.');
    if (config.executionRole === 'api' && config.billing.paymentsEnabled) required.push(
        ['PADDLE_API_KEY', config.billing.paddle.apiKey, 16],
        ['PADDLE_WEBHOOK_SECRET', config.billing.paddle.webhookSecret, 16],
        ['PADDLE_PRICE_SIGNAL', config.billing.paddle.prices.signal, 3],
        ['PADDLE_PRICE_STUDIO', config.billing.paddle.prices.studio, 3]
    );
    const lateMissing = required.filter(([, value, minLength]) => typeof value !== 'string' || value.length < minLength || insecurePlaceholder.test(value)).map(([name]) => name);
    if (lateMissing.length) throw new Error(`Production configuration is incomplete or weak: ${lateMissing.join(', ')}.`);
    const publicUrls = config.executionRole === 'api'
        ? [['APP_URL', config.appUrl], ['BETTER_AUTH_URL', config.auth.baseUrl], ['ENGINE_LAB_SERVICE_URL', config.engineLab.serviceUrl], ['AI_SERVICE_URL', config.ai.serviceUrl], ['EMAIL_SERVICE_URL', config.email.serviceUrl]]
        : config.executionRole === 'ai' ? [['OPENROUTER_SITE_URL', config.ai.openrouter.siteUrl]] : [];
    for (const [name, value] of publicUrls) {
        const parsed = new URL(String(value));
        const internalService = ['ENGINE_LAB_SERVICE_URL', 'AI_SERVICE_URL', 'EMAIL_SERVICE_URL'].includes(name) && parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !internalService && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error(`${name} must use https:// in production.`);
        if (name === 'ENGINE_LAB_SERVICE_URL') {
            if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('ENGINE_LAB_SERVICE_URL must be an origin-only URL without credentials, path, query or fragment.');
            if (!new Set(config.engineLab.allowedHosts.map((host) => host.toLowerCase())).has(parsed.hostname.toLowerCase())) throw new Error('ENGINE_LAB_SERVICE_URL host must be allowlisted.');
        }
    }
    return config;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const executionRole = env.EXECUTION_ROLE || 'api';
    const appUrl = env.APP_URL || 'http://localhost:5173';
    const sourceUploadMaxBytes = integer(env.SOURCE_UPLOAD_MAX_BYTES, 50 * 1024 * 1024, { min: 1024, max: 200 * 1024 * 1024 });
    const appOrigin = exactOrigin(appUrl);
    const allowedPorts = csv(env.ALLOWED_TARGET_PORTS, ['80', '443'])
        .map((port) => integer(port, null, { min: 1, max: 65535 }))
        .filter(Boolean);
    const apiKeys = csv(env.API_KEYS);
    const legacyApiEnabled = boolean(env.LEGACY_API_ENABLED, false);
    const authBaseUrl = env.BETTER_AUTH_URL || `http://localhost:${integer(env.PORT, 5000, { min: 1, max: 65535 })}`;
    const adminPrivilegedRoles = csv(env.ADMIN_PRIVILEGED_ROLES, ['super_admin', 'admin']);
    const invalidAdminRoles = adminPrivilegedRoles.filter((role) => !['super_admin', 'admin', 'moderator', 'support'].includes(role));
    if (invalidAdminRoles.length) throw new Error(`ADMIN_PRIVILEGED_ROLES contains unknown roles: ${invalidAdminRoles.join(', ')}.`);
    const stepUpMaxAgeMs = env.ADMIN_STEP_UP_MAX_AGE_SECONDS !== undefined
        ? integer(env.ADMIN_STEP_UP_MAX_AGE_SECONDS, 600, { min: 30, max: 86_400 }) * 1_000
        : integer(env.ADMIN_REAUTH_MAX_AGE_MS, 10 * 60 * 1000, { min: 30_000, max: 24 * 60 * 60 * 1000 });
    const allowUnauthenticatedDevelopment = nodeEnv !== 'production'
        && boolean(env.LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT, false);
    if (legacyApiEnabled && !apiKeys.length && !allowUnauthenticatedDevelopment) {
        throw new Error('LEGACY_API_ENABLED requires API_KEYS; only an explicit non-production development exception may omit them.');
    }

    return Object.freeze({
        nodeEnv,
        executionRole,
        databaseExpectedRole: env.DATABASE_EXPECTED_ROLE || (executionRole === 'worker' ? 'wpa_worker' : executionRole === 'maintenance' ? 'wpa_maintenance' : executionRole === 'api' ? 'wpa_runtime' : ''),
        workerHandlerModule: env.WORKER_HANDLER_MODULE || '',
        browserExecutionDisabled: boolean(env.BROWSER_EXECUTION_DISABLED, executionRole === 'api' && nodeEnv === 'production'),
        pdfExecutionDisabled: boolean(env.PDF_EXECUTION_DISABLED, executionRole === 'api' && nodeEnv === 'production'),
        sourceExecutionDisabled: boolean(env.SOURCE_EXECUTION_DISABLED, executionRole === 'api' && nodeEnv === 'production'),
        osvExecutionDisabled: boolean(env.OSV_EXECUTION_DISABLED, executionRole === 'api' && nodeEnv === 'production'),
        port: integer(env.PORT, 5000, { min: 1, max: 65535 }),
        trustProxy: boolean(env.TRUST_PROXY, false) ? 1 : false,
        corsOrigins: [...new Set([...csv(env.CORS_ORIGINS, ['http://localhost:5173', 'http://127.0.0.1:5173']), ...(appOrigin ? [appOrigin] : [])])],
        apiKeys,
        adminApiKeys: csv(env.ADMIN_API_KEYS || env.ADMIN_API_KEY),
        legacyApi: { enabled: legacyApiEnabled, allowUnauthenticatedDevelopment },
        adminReauthMaxAgeMs: stepUpMaxAgeMs,
        adminReauthSessionLifetime: boolean(env.ADMIN_REAUTH_SESSION_LIFETIME, false),
        adminSecurity: {
            webAuthnRequired: boolean(env.ADMIN_WEBAUTHN_REQUIRED, nodeEnv === 'production'),
            privilegedRoles: adminPrivilegedRoles,
            stepUpMaxAgeMs,
            minimumCredentialCount: integer(env.ADMIN_WEBAUTHN_MIN_CREDENTIALS, 1, { min: 1, max: 10 }),
            recommendedCredentialCount: integer(env.ADMIN_WEBAUTHN_RECOMMENDED_CREDENTIALS, 2, { min: 1, max: 10 }),
            recoveryCodeCount: integer(env.ADMIN_RECOVERY_CODE_COUNT, 10, { min: 4, max: 20 }),
            recoverySessionTtlMs: integer(env.ADMIN_RECOVERY_SESSION_TTL_SECONDS, 15 * 60, { min: 5 * 60, max: 60 * 60 }) * 1_000,
            assertionTtlMs: integer(env.ADMIN_WEBAUTHN_ASSERTION_TTL_SECONDS, 120, { min: 30, max: 300 }) * 1_000,
            rpId: env.ADMIN_WEBAUTHN_RP_ID || new URL(authBaseUrl).hostname,
            rpName: env.ADMIN_WEBAUTHN_RP_NAME || 'WebPageAnalyzer Admin'
        },
        verificationTtlMs: integer(env.VERIFICATION_TTL_MS, 24 * 60 * 60 * 1000, { min: 5 * 60 * 1000, max: 7 * 24 * 60 * 60 * 1000 }),
        databaseUrl: env.DATABASE_URL || '',
        databaseConnectionTimeoutMs: integer(env.DATABASE_CONNECTION_TIMEOUT_MS, 10_000, { min: 1_000, max: 60_000 }),
        databaseIdleTimeoutMs: integer(env.DATABASE_IDLE_TIMEOUT_MS, 30_000, { min: 1_000, max: 300_000 }),
        databaseRejectUnauthorized: boolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
        auth: {
            secret: env.BETTER_AUTH_SECRET || '',
            baseUrl: authBaseUrl,
            googleClientId: env.GOOGLE_CLIENT_ID || '',
            googleClientSecret: env.GOOGLE_CLIENT_SECRET || ''
        },
        email: {
            deliveryEnabled: boolean(env.EMAIL_DELIVERY_ENABLED, true),
            provider: String(env.EMAIL_PROVIDER || (nodeEnv === 'production' ? 'resend' : 'none')).trim().toLowerCase(),
            serviceUrl: env.EMAIL_SERVICE_URL || '',
            internalToken: env.EMAIL_SERVICE_TOKEN || '',
            providerUrl: env.EMAIL_PROVIDER_URL || 'https://api.resend.com/emails',
            apiKey: env.RESEND_API_KEY || env.EMAIL_PROVIDER_API_KEY || '',
            resendApiKey: env.RESEND_API_KEY || '',
            from: env.EMAIL_FROM || '',
            supportEmail: env.SUPPORT_EMAIL || env.LEGAL_SUPPORT_EMAIL || '',
            providerHostAllowlist: csv(env.EMAIL_PROVIDER_HOST_ALLOWLIST, ['api.resend.com']),
            timeoutMs: integer(env.EMAIL_PROVIDER_TIMEOUT_MS, 10_000, { min: 1_000, max: 30_000 })
        },
        demoWorkspaceId: env.DEMO_WORKSPACE_ID || 'ws_demo',
        appUrl,
        sourceEncryptionKey: env.SOURCE_ENCRYPTION_KEY || '',
        sourceArtifactDir: env.SOURCE_ARTIFACT_DIR ? path.resolve(env.SOURCE_ARTIFACT_DIR) : path.resolve(__dirname, path.join(env.ARTIFACT_DIR || 'logs', 'source-inputs')),
        sourceUploadMaxBytes,
        engineLabConcurrency: integer(env.ENGINE_LAB_CONCURRENCY, 3, { min: 1, max: 6 }),
        engineLab: {
            enabled: boolean(env.ENGINE_LAB_SERVICE_ENABLED, false),
            serviceUrl: env.ENGINE_LAB_SERVICE_URL || '',
            internalToken: env.ENGINE_LAB_SERVICE_TOKEN || '',
            allowedHosts: csv(env.ENGINE_LAB_SERVICE_ALLOWED_HOSTS, ['engine-lab-worker', 'analysis-worker', 'localhost', '127.0.0.1', '::1']),
            host: env.ENGINE_LAB_SERVICE_HOST || '0.0.0.0',
            port: integer(env.ENGINE_LAB_SERVICE_PORT, 5030, { min: 1, max: 65_535 }),
            requestTimeoutMs: integer(env.ENGINE_LAB_SERVICE_REQUEST_TIMEOUT_MS, 30_000, { min: 1_000, max: 120_000 }),
            maxBodyBytes: integer(env.ENGINE_LAB_SERVICE_MAX_BODY_BYTES, Math.ceil(sourceUploadMaxBytes / 3) * 4 + 256 * 1024, { min: 64 * 1024, max: 300 * 1024 * 1024 }),
            maxResponseBytes: integer(env.ENGINE_LAB_SERVICE_MAX_RESPONSE_BYTES, 16 * 1024 * 1024, { min: 64 * 1024, max: 64 * 1024 * 1024 }),
            maxArtifactBytes: integer(env.ENGINE_LAB_SERVICE_MAX_ARTIFACT_BYTES, 9 * 1024 * 1024, { min: 64 * 1024, max: 32 * 1024 * 1024 }),
            maxConcurrentRequests: integer(env.ENGINE_LAB_SERVICE_MAX_CONCURRENT_REQUESTS, 16, { min: 1, max: 64 }),
            maxConcurrentRuns: integer(env.ENGINE_LAB_MAX_CONCURRENT_RUNS, 1, { min: 1, max: 4 }),
            maxQueuedRuns: integer(env.ENGINE_LAB_MAX_QUEUED_RUNS, 8, { min: 0, max: 100 }),
            historyLimit: integer(env.ENGINE_LAB_HISTORY_LIMIT, 50, { min: 1, max: 200 }),
            artifactTtlMs: integer(env.ENGINE_LAB_ARTIFACT_TTL_MS, 24 * 60 * 60_000, { min: 60_000, max: 7 * 24 * 60 * 60_000 }),
            artifactJanitorMs: integer(env.ENGINE_LAB_ARTIFACT_JANITOR_MS, 15 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 }),
            shutdownDrainMs: integer(env.ENGINE_LAB_SHUTDOWN_DRAIN_MS, 15_000, { min: 1_000, max: 60_000 })
        },
        zap: {
            url: env.ZAP_URL || '',
            apiKey: env.ZAP_API_KEY || '',
            proxyBindHost: env.ZAP_PROXY_BIND_HOST || '0.0.0.0',
            proxyAdvertisedHost: env.ZAP_PROXY_ADVERTISED_HOST || 'backend',
            maxUrls: integer(env.ZAP_MAX_URLS, 100, { min: 1, max: 500 }),
            maxAlerts: integer(env.ZAP_MAX_ALERTS, 1_000, { min: 1, max: 10_000 }),
            maxPollAttempts: integer(env.ZAP_MAX_POLL_ATTEMPTS, 180, { min: 10, max: 600 })
        },
        osv: { executable: env.OSV_SCANNER_PATH || 'osv-scanner', isolationRunner: env.OSV_ISOLATION_RUNNER || '', isolationArgs: csv(env.OSV_ISOLATION_ARGS) },
        workerEnabled: boolean(env.WORKER_ENABLED, true),
        webhookOutboxPollMs: integer(env.WEBHOOK_OUTBOX_POLL_MS, 15_000, { min: 1_000, max: 5 * 60_000 }),
        webhookOutboxBatchSize: integer(env.WEBHOOK_OUTBOX_BATCH_SIZE, 25, { min: 1, max: 100 }),
        sourceStagingJanitorMs: integer(env.SOURCE_STAGING_JANITOR_MS, 15 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 }),
        sourceArtifactJanitorMs: integer(env.SOURCE_ARTIFACT_JANITOR_MS, 15 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 }),
        retentionPollMs: integer(env.RETENTION_POLL_MS, 6 * 60 * 60_000, { min: 60_000, max: 7 * 24 * 60 * 60_000 }),
        workerLeaseMs: integer(env.WORKER_LEASE_MS, 120_000, { min: 10_000, max: 24 * 60 * 60_000 }),
        reportPayloadMaxBytes: integer(env.REPORT_PAYLOAD_MAX_BYTES, 20 * 1024 * 1024, { min: 64 * 1024, max: 100 * 1024 * 1024 }),
        requireExternalProviderConsent: boolean(env.REQUIRE_EXTERNAL_PROVIDER_CONSENT, nodeEnv === 'production'),
        billing: {
            paymentsEnabled: boolean(env.PAYMENTS_ENABLED, nodeEnv !== 'production'),
            provider: String(env.BILLING_PROVIDER || (nodeEnv === 'production' ? 'paddle' : 'paddle')).trim().toLowerCase(),
            enterpriseSalesMode: String(env.ENTERPRISE_SALES_MODE || 'contact').trim().toLowerCase(),
            paddle: {
                apiKey: env.PADDLE_API_KEY || '',
                webhookSecret: env.PADDLE_WEBHOOK_SECRET || '',
                environment: String(env.PADDLE_ENVIRONMENT || 'sandbox').trim().toLowerCase(),
                baseUrl: env.PADDLE_API_BASE_URL || (String(env.PADDLE_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com'),
                prices: {
                    signal: env.PADDLE_PRICE_SIGNAL || '',
                    studio: env.PADDLE_PRICE_STUDIO || '',
                    enterprise: env.PADDLE_PRICE_ENTERPRISE || ''
                }
            }
        },
        stripe: {
            secretKey: env.STRIPE_SECRET_KEY || '',
            webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
            prices: {
                signal: env.STRIPE_PRICE_SIGNAL || '',
                studio: env.STRIPE_PRICE_STUDIO || '',
                enterprise: env.STRIPE_PRICE_ENTERPRISE || ''
            }
        },
        integrations: {
            github: { clientId: env.GITHUB_CLIENT_ID || '', clientSecret: env.GITHUB_CLIENT_SECRET || '' },
            gitlab: { clientId: env.GITLAB_CLIENT_ID || '', clientSecret: env.GITLAB_CLIENT_SECRET || '' },
            bitbucket: { clientId: env.BITBUCKET_CLIENT_ID || '', clientSecret: env.BITBUCKET_CLIENT_SECRET || '' }
        },
        bodyLimit: bodyLimit(env.REQUEST_BODY_LIMIT),
        allowedTargetPorts: allowedPorts.length > 0 ? allowedPorts : [80, 443],
        rateLimits: {
            generalWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            generalMax: integer(env.RATE_LIMIT_MAX, 120),
            scanProgressWindowMs: integer(env.SCAN_PROGRESS_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            scanProgressMax: integer(env.SCAN_PROGRESS_RATE_LIMIT_MAX, 600, { min: 30, max: 10_000 }),
            adminWindowMs: integer(env.ADMIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            adminMax: integer(env.ADMIN_RATE_LIMIT_MAX, 600),
            adminReauthWindowMs: integer(env.ADMIN_REAUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            adminReauthMax: integer(env.ADMIN_REAUTH_RATE_LIMIT_MAX, 5, { min: 1, max: 100 }),
            adminRecoveryWindowMs: integer(env.ADMIN_RECOVERY_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            adminRecoveryMax: integer(env.ADMIN_RECOVERY_RATE_LIMIT_MAX, 5, { min: 1, max: 50 }),
            passkeyWindowMs: integer(env.ADMIN_PASSKEY_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            passkeyMax: integer(env.ADMIN_PASSKEY_RATE_LIMIT_MAX, 30, { min: 4, max: 200 }),
            authWindowMs: integer(env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            authMax: integer(env.AUTH_RATE_LIMIT_MAX, 60, { min: 1, max: 1_000 }),
            loginWindowMs: integer(env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            loginMax: integer(env.LOGIN_RATE_LIMIT_MAX, 10, { min: 1, max: 500 }),
            passwordResetWindowMs: integer(env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
            passwordResetMax: integer(env.PASSWORD_RESET_RATE_LIMIT_MAX, 5, { min: 1, max: 100 }),
            analysisWindowMs: integer(env.ANALYZE_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
            analysisMax: integer(env.ANALYZE_RATE_LIMIT_MAX, 10),
            aiWindowMs: integer(env.AI_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
            aiMax: integer(env.AI_RATE_LIMIT_MAX, 20),
            supportWindowMs: integer(env.SUPPORT_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            supportMax: integer(env.SUPPORT_RATE_LIMIT_MAX, 20, { min: 1, max: 500 }),
            supportAdminWindowMs: integer(env.SUPPORT_ADMIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            supportAdminMax: integer(env.SUPPORT_ADMIN_RATE_LIMIT_MAX, 120, { min: 1, max: 1_000 }),
            redeemWindowMs: integer(env.REDEEM_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            redeemMax: integer(env.REDEEM_RATE_LIMIT_MAX, 10, { min: 1, max: 100 }),
            adminMutationWindowMs: integer(env.ADMIN_MUTATION_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
            adminMutationMax: integer(env.ADMIN_MUTATION_RATE_LIMIT_MAX, 60, { min: 1, max: 500 })
        },
        maxConcurrentAnalyses: integer(env.MAX_CONCURRENT_ANALYSES, 1, { min: 1, max: 16 }),
        maxQueuedAnalyses: integer(env.MAX_QUEUED_ANALYSES, 8, { min: 0, max: 100 }),
        maxConcurrentPdfExports: integer(env.MAX_CONCURRENT_PDF_EXPORTS, 1, { min: 1, max: 4 }),
        maxQueuedPdfExports: integer(env.MAX_QUEUED_PDF_EXPORTS, 4, { min: 0, max: 32 }),
        timeouts: {
            analysisMs: integer(env.ANALYSIS_TIMEOUT_MS, 4 * 60 * 1000),
            lighthouseMs: integer(env.LIGHTHOUSE_TIMEOUT_MS, 3 * 60 * 1000),
            axeMs: integer(env.AXE_TIMEOUT_MS, 90 * 1000),
            yellowLabMs: integer(env.YELLOWLAB_TIMEOUT_MS, 150 * 1000),
            aiMs: integer(env.AI_TIMEOUT_MS, 45 * 1000),
            wpaPageMs: integer(env.WPA_PAGE_TIMEOUT_MS, 120 * 1000),
            advancedBrowserMs: integer(env.ADVANCED_BROWSER_TIMEOUT_MS, 150 * 1000),
            zapMs: integer(env.ZAP_TIMEOUT_MS, 5 * 60 * 1000),
            osvMs: integer(env.OSV_TIMEOUT_MS, 3 * 60 * 1000),
            proxyConnectMs: integer(env.PROXY_CONNECT_TIMEOUT_MS, 10 * 1000)
        },
        proxyLimits: {
            maxConnections: integer(env.PROXY_MAX_CONNECTIONS, 100, { min: 1, max: 1000 }),
            maxResponseBytes: integer(env.PROXY_MAX_RESPONSE_BYTES, 25 * 1024 * 1024),
            maxTotalBytes: integer(env.PROXY_MAX_TOTAL_BYTES, 250 * 1024 * 1024)
        },
        artifactDir: path.resolve(__dirname, env.ARTIFACT_DIR || 'logs'),
        workerResultDir: env.WORKER_RESULT_DIR ? path.resolve(env.WORKER_RESULT_DIR) : path.resolve(__dirname, path.join(env.ARTIFACT_DIR || 'logs', 'worker-results')),
        keepArtifacts: boolean(env.KEEP_ANALYZER_ARTIFACTS, false),
        ai: {
            provider: String(env.AI_PROVIDER || (nodeEnv === 'production' ? 'openrouter' : 'openrouter')).trim().toLowerCase(),
            serviceUrl: env.AI_SERVICE_URL || '',
            internalToken: env.AI_SERVICE_TOKEN || '',
            maxRequestsPerMinute: integer(env.AI_MAX_REQUESTS_PER_MINUTE, 30, { min: 1, max: 10_000 }),
            maxConcurrentRequests: integer(env.AI_MAX_CONCURRENT_REQUESTS, 2, { min: 1, max: 100 }),
            maxInputTokens: integer(env.AI_MAX_INPUT_TOKENS, 4_096, { min: 128, max: 1_000_000 }),
            maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 1_200, { min: 64, max: 100_000 }),
            dailyCostSoftLimitUsd: finiteNumber(env.AI_DAILY_COST_SOFT_LIMIT_USD, 5, { min: 0, max: 1_000_000 }),
            dailyCostHardLimitUsd: finiteNumber(env.AI_DAILY_COST_HARD_LIMIT_USD, 10, { min: 0.01, max: 1_000_000 }),
            openrouter: {
                apiKey: env.OPENROUTER_API_KEY || '',
                baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
                primaryModel: env.OPENROUTER_MODEL_PRIMARY || '',
                fallbackModels: csv(env.OPENROUTER_MODEL_FALLBACKS),
                siteUrl: env.OPENROUTER_SITE_URL || appUrl,
                appName: env.OPENROUTER_APP_NAME || 'WebPageAnalyzer',
                dataCollection: String(env.OPENROUTER_DATA_COLLECTION || 'deny').trim().toLowerCase(),
                zeroDataRetention: boolean(env.OPENROUTER_ZDR, false),
                metadataEnabled: boolean(env.OPENROUTER_METADATA_ENABLED, true)
            }
        },
        legal: {
            operatorName: env.LEGAL_OPERATOR_NAME || '',
            operatorType: env.LEGAL_OPERATOR_TYPE || '',
            country: env.LEGAL_COUNTRY || '',
            businessAddress: env.LEGAL_BUSINESS_ADDRESS || '',
            supportEmail: env.LEGAL_SUPPORT_EMAIL || env.SUPPORT_EMAIL || '',
            supportPhone: env.LEGAL_SUPPORT_PHONE || '',
            effectiveDate: env.LEGAL_EFFECTIVE_DATE || '',
            hostingProviderName: env.LEGAL_HOSTING_PROVIDER_NAME || '',
            hostingProviderRegion: env.LEGAL_HOSTING_PROVIDER_REGION || '',
            hostingProviderPrivacyUrl: env.LEGAL_HOSTING_PROVIDER_PRIVACY_URL || '',
            edgeProviderName: env.LEGAL_EDGE_PROVIDER_NAME || '',
            edgeProviderRegion: env.LEGAL_EDGE_PROVIDER_REGION || '',
            edgeProviderPrivacyUrl: env.LEGAL_EDGE_PROVIDER_PRIVACY_URL || ''
        },
        crawler: {
            maxSitemaps: integer(env.CRAWLER_MAX_SITEMAPS, 20, { min: 1, max: 200 }),
            maxSitemapDepth: integer(env.CRAWLER_MAX_SITEMAP_DEPTH, 3, { min: 1, max: 10 }),
            maxSitemapUrls: integer(env.CRAWLER_MAX_SITEMAP_URLS, 5_000, { min: 1, max: 100_000 }),
            maxSitemapBytes: integer(env.CRAWLER_MAX_SITEMAP_BYTES, 2 * 1024 * 1024, { min: 1_024, max: 50 * 1024 * 1024 }),
            maxSitemapDecompressedBytes: integer(env.CRAWLER_MAX_SITEMAP_DECOMPRESSED_BYTES, 8 * 1024 * 1024, { min: 1_024, max: 100 * 1024 * 1024 }),
            maxPathDepth: integer(env.CRAWLER_MAX_PATH_DEPTH, 12, { min: 1, max: 100 }),
            maxQueryVariantsPerPath: integer(env.CRAWLER_MAX_QUERY_VARIANTS_PER_PATH, 5, { min: 1, max: 100 })
        },
        geminiApiKey: env.GEMINI_API_KEY || '',
        geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
        yellowLabMaxPollAttempts: integer(env.YELLOWLAB_MAX_POLL_ATTEMPTS, 24, { min: 1, max: 60 }),
        chromePath: env.CHROME_PATH || '',
        chromeNoSandbox: boolean(env.CHROME_NO_SANDBOX, false)
    });
}

module.exports = { loadConfig, assertProductionConfig, databasePoolOptions, boolean, finiteNumber };
