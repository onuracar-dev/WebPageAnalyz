const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, assertProductionConfig } = require('../config');

function productionApiEnv(overrides = {}) {
    return {
        NODE_ENV: 'production', EXECUTION_ROLE: 'api',
        DATABASE_URL: 'postgresql://db.example/wpa?sslmode=require', DATABASE_EXPECTED_ROLE: 'wpa_runtime',
        BETTER_AUTH_SECRET: 'a'.repeat(48), SOURCE_ENCRYPTION_KEY: 'b'.repeat(48),
        APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example',
        ENGINE_LAB_SERVICE_URL: 'http://engine-lab-worker:5030', ENGINE_LAB_SERVICE_TOKEN: 'l'.repeat(48),
        AI_SERVICE_URL: 'http://ai-service:5010', AI_SERVICE_TOKEN: 'i'.repeat(48), OPENROUTER_MODEL_PRIMARY: 'vendor/production-model',
        EMAIL_SERVICE_URL: 'http://email-service:5020', EMAIL_SERVICE_TOKEN: 'e'.repeat(48),
        PAYMENTS_ENABLED: 'true', BILLING_PROVIDER: 'paddle', PADDLE_API_KEY: 'pdl_live_' + 'p'.repeat(32),
        PADDLE_WEBHOOK_SECRET: 'w'.repeat(48), PADDLE_PRICE_SIGNAL: 'pri_signal', PADDLE_PRICE_STUDIO: 'pri_studio',
        ENTERPRISE_SALES_MODE: 'contact',
        LEGAL_OPERATOR_NAME: 'Configured Operator', LEGAL_COUNTRY: 'TR',
        LEGAL_BUSINESS_ADDRESS: 'Operator supplied business address', LEGAL_SUPPORT_EMAIL: 'support@example.test', LEGAL_EFFECTIVE_DATE: '2026-08-15',
        LEGAL_HOSTING_PROVIDER_NAME: 'Configured VDS Provider',
        ...overrides
    };
}

test('production runtime rejects memory storage, weak secrets and non-secure public origins', () => {
    const config = loadConfig({ NODE_ENV: 'production', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example' });
    assert.throws(() => assertProductionConfig(config), /DATABASE_URL|BETTER_AUTH_SECRET/);
});

test('production runtime accepts explicit durable storage and strong secrets', () => {
    const config = loadConfig(productionApiEnv());
    assert.equal(assertProductionConfig(config), config);
});

test('production early access accepts disabled payments without Paddle credentials', () => {
    const config = loadConfig(productionApiEnv({
        PAYMENTS_ENABLED: 'false',
        LEGAL_BUSINESS_ADDRESS: '',
        PADDLE_API_KEY: '',
        PADDLE_WEBHOOK_SECRET: '',
        PADDLE_PRICE_SIGNAL: '',
        PADDLE_PRICE_STUDIO: '',
        PADDLE_PRICE_ENTERPRISE: ''
    }));
    assert.equal(config.billing.paymentsEnabled, false);
    assert.equal(config.legal.businessAddress, '');
    assert.equal(assertProductionConfig(config), config);
});

test('production paid billing still requires an operator-supplied business address', () => {
    const config = loadConfig(productionApiEnv({ LEGAL_BUSINESS_ADDRESS: '' }));
    assert.throws(() => assertProductionConfig(config), /LEGAL_BUSINESS_ADDRESS/);
});

test('production early access still requires every non-address legal identity field', () => {
    for (const name of ['LEGAL_OPERATOR_NAME', 'LEGAL_COUNTRY', 'LEGAL_SUPPORT_EMAIL', 'LEGAL_EFFECTIVE_DATE', 'LEGAL_HOSTING_PROVIDER_NAME']) {
        const config = loadConfig(productionApiEnv({
            PAYMENTS_ENABLED: 'false',
            LEGAL_BUSINESS_ADDRESS: '',
            PADDLE_API_KEY: '',
            PADDLE_WEBHOOK_SECRET: '',
            PADDLE_PRICE_SIGNAL: '',
            PADDLE_PRICE_STUDIO: '',
            [name]: ''
        }));
        assert.throws(() => assertProductionConfig(config), new RegExp(name));
    }
});

test('production paid billing still fails closed when Paddle configuration is missing', () => {
    const config = loadConfig(productionApiEnv({
        PAYMENTS_ENABLED: 'true',
        PADDLE_API_KEY: '',
        PADDLE_WEBHOOK_SECRET: '',
        PADDLE_PRICE_SIGNAL: '',
        PADDLE_PRICE_STUDIO: ''
    }));
    assert.throws(() => assertProductionConfig(config), /PADDLE_API_KEY.*PADDLE_WEBHOOK_SECRET.*PADDLE_PRICE_SIGNAL.*PADDLE_PRICE_STUDIO/);
});

test('production runtime cannot disable privileged WebAuthn enforcement', () => {
    const disabled = loadConfig(productionApiEnv({ ADMIN_WEBAUTHN_REQUIRED: 'false' }));
    assert.throws(() => assertProductionConfig(disabled), /ADMIN_WEBAUTHN_REQUIRED/);
    const enabled = loadConfig(productionApiEnv({ ADMIN_WEBAUTHN_REQUIRED: 'true' }));
    assert.equal(assertProductionConfig(enabled), enabled);
});

test('privileged recovery and assertion TTL environment values use seconds consistently', () => {
    const config = loadConfig({
        NODE_ENV: 'development',
        ADMIN_RECOVERY_SESSION_TTL_SECONDS: '600',
        ADMIN_WEBAUTHN_ASSERTION_TTL_SECONDS: '90'
    });
    assert.equal(config.adminSecurity.recoverySessionTtlMs, 600_000);
    assert.equal(config.adminSecurity.assertionTtlMs, 90_000);
});

test('session-lifetime administrator re-authentication is restricted to local development', () => {
    const production = loadConfig(productionApiEnv({ ADMIN_REAUTH_SESSION_LIFETIME: 'true' }));
    assert.throws(() => assertProductionConfig(production), /local-development convenience/);
    const development = loadConfig({ NODE_ENV: 'development', ADMIN_REAUTH_SESSION_LIFETIME: 'true' });
    assert.equal(development.adminReauthSessionLifetime, true);
});

test('production runtime requires the actual hosting processor before legal readiness', () => {
    const config = loadConfig(productionApiEnv({ LEGAL_HOSTING_PROVIDER_NAME: '' }));
    assert.throws(() => assertProductionConfig(config), /LEGAL_HOSTING_PROVIDER_NAME/);
});

test('production runtime rejects well-sized placeholder secrets', () => {
    const config = loadConfig(productionApiEnv({ BETTER_AUTH_SECRET: 'replace-with-a-long-random-auth-secret-value' }));
    assert.throws(() => assertProductionConfig(config), /BETTER_AUTH_SECRET/);
});

test('production API cannot re-enable isolated execution or disable database TLS verification', () => {
    const config = loadConfig(productionApiEnv({ BROWSER_EXECUTION_DISABLED: 'false' }));
    assert.throws(() => assertProductionConfig(config), /execution must be disabled/);
    const tlsBypass = loadConfig(productionApiEnv({ DATABASE_SSL_REJECT_UNAUTHORIZED: '0' }));
    assert.throws(() => assertProductionConfig(tlsBypass), /TLS certificate verification/);
    const insecureUrl = loadConfig(productionApiEnv({ DATABASE_URL: 'postgresql://db.example/wpa?sslmode=disable' }));
    assert.throws(() => assertProductionConfig(insecureUrl), /must not disable TLS/);
    const invertedAiBudget = loadConfig(productionApiEnv({ AI_DAILY_COST_SOFT_LIMIT_USD: '11', AI_DAILY_COST_HARD_LIMIT_USD: '10' }));
    assert.throws(() => assertProductionConfig(invertedAiBudget), /SOFT_LIMIT_USD/);
});

test('production API requires an allowlisted authenticated Engine Lab worker service', () => {
    const missingToken = loadConfig(productionApiEnv({ ENGINE_LAB_SERVICE_TOKEN: '' }));
    assert.throws(() => assertProductionConfig(missingToken), /ENGINE_LAB_SERVICE_TOKEN/);
    const publicHost = loadConfig(productionApiEnv({ ENGINE_LAB_SERVICE_URL: 'https://engine-lab.example.test' }));
    assert.throws(() => assertProductionConfig(publicHost), /host must be allowlisted/);
    for (const invalidUrl of [
        'http://user:password@engine-lab-worker:5030',
        'http://engine-lab-worker:5030/private',
        'http://engine-lab-worker:5030?token=leak',
        'http://engine-lab-worker:5030#fragment'
    ]) {
        const invalid = loadConfig(productionApiEnv({ ENGINE_LAB_SERVICE_URL: invalidUrl }));
        assert.throws(() => assertProductionConfig(invalid), /origin-only URL/);
    }
});

test('production API does not require worker-only ZAP credentials and worker role does not require Better Auth', () => {
    const api = loadConfig(productionApiEnv());
    assert.equal(assertProductionConfig(api), api);
    const worker = loadConfig({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js', DATABASE_URL: 'postgresql://db.example/wpa', SOURCE_ENCRYPTION_KEY: 'b'.repeat(48), APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example' });
    assert.equal(assertProductionConfig(worker), worker);
    const enabledWorker = loadConfig({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js', DATABASE_URL: 'postgresql://db.example/wpa', SOURCE_ENCRYPTION_KEY: 'b'.repeat(48), ENGINE_LAB_SERVICE_ENABLED: 'true', ENGINE_LAB_SERVICE_TOKEN: 'l'.repeat(48), APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example' });
    assert.equal(assertProductionConfig(enabledWorker), enabledWorker);
    const missingEngineLabToken = loadConfig({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js', DATABASE_URL: 'postgresql://db.example/wpa', SOURCE_ENCRYPTION_KEY: 'b'.repeat(48), ENGINE_LAB_SERVICE_ENABLED: 'true', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example' });
    assert.throws(() => assertProductionConfig(missingEngineLabToken), /ENGINE_LAB_SERVICE_TOKEN/);
    const missingHandler = loadConfig({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgresql://db.example/wpa', SOURCE_ENCRYPTION_KEY: 'b'.repeat(48), APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example' });
    assert.throws(() => assertProductionConfig(missingHandler), /WORKER_HANDLER_MODULE/);
});

test('production maintenance role requires only its isolated handler and durable database', () => {
    const maintenance = loadConfig({
        NODE_ENV: 'production', EXECUTION_ROLE: 'maintenance', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js',
        DATABASE_URL: 'postgresql://db.example/wpa?sslmode=require',
        APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example',
        BROWSER_EXECUTION_DISABLED: 'true', PDF_EXECUTION_DISABLED: 'true', SOURCE_EXECUTION_DISABLED: 'true', OSV_EXECUTION_DISABLED: 'true'
    });
    assert.equal(maintenance.databaseExpectedRole, 'wpa_maintenance');
    assert.equal(assertProductionConfig(maintenance), maintenance);
    const browserEnabled = loadConfig({
        NODE_ENV: 'production', EXECUTION_ROLE: 'maintenance', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js',
        DATABASE_URL: 'postgresql://db.example/wpa?sslmode=require', APP_URL: 'https://dashboard.example', BETTER_AUTH_URL: 'https://dashboard.example',
        BROWSER_EXECUTION_DISABLED: 'false', PDF_EXECUTION_DISABLED: 'true', SOURCE_EXECUTION_DISABLED: 'true', OSV_EXECUTION_DISABLED: 'true'
    });
    assert.throws(() => assertProductionConfig(browserEnabled), /maintenance execution must keep .* disabled/);
});

test('execution roles default to distinct least-privilege database roles and disable hostile API execution', () => {
    const api = loadConfig({ NODE_ENV: 'production' });
    const worker = loadConfig({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker' });
    assert.equal(api.executionRole, 'api');
    assert.equal(api.databaseExpectedRole, 'wpa_runtime');
    assert.equal(api.browserExecutionDisabled, true);
    assert.equal(api.pdfExecutionDisabled, true);
    assert.equal(worker.databaseExpectedRole, 'wpa_worker');
    assert.equal(worker.browserExecutionDisabled, false);
});
