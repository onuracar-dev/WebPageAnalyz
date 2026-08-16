const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs').promises;
const path = require('node:path');
const { assertChromiumSandbox, assertDatabaseRole, assertWorkerBoundary, workerDatabasePoolOptions } = require('../scripts/analysis-worker');
const { assertMaintenanceBoundary, assertMaintenanceDatabaseRole, maintenanceDatabasePoolOptions } = require('../scripts/maintenance-worker');

const root = path.join(__dirname, '..', '..');

test('API and worker images have separate tool boundaries', async () => {
    const apiDockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    const workerDockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile.worker'), 'utf8');
    const maintenanceDockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile.maintenance'), 'utf8');
    const workerEntrypoint = await fs.readFile(path.join(__dirname, '..', 'scripts', 'analysis-worker.js'), 'utf8');
    assert.doesNotMatch(apiDockerfile, /\bchromium(?:-sandbox)?\b/i);
    assert.doesNotMatch(apiDockerfile, /osv-scanner/i);
    assert.doesNotMatch(apiDockerfile, /db:migrate/);
    assert.match(workerDockerfile, /chromium-sandbox/);
    assert.match(workerDockerfile, /osv-scanner/);
    assert.match(workerDockerfile, /USER node/);
    assert.match(workerEntrypoint, /--dump-dom/);
    assert.doesNotMatch(workerEntrypoint, /['"]--no-sandbox['"]/);
    assert.doesNotMatch(maintenanceDockerfile, /\bchromium(?:-sandbox)?\b|osv-scanner/i);
    assert.match(maintenanceDockerfile, /CMD \["node", "scripts\/maintenance-worker\.js"\]/);
});

test('Compose keeps API secrets and hostile execution on different services', async () => {
    const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    const postgres = compose.slice(compose.indexOf('\n  postgres:'), compose.indexOf('\n  db-bootstrap:'));
    const api = compose.slice(compose.indexOf('\n  backend:'), compose.indexOf('\n  ai-service:'));
    const ai = compose.slice(compose.indexOf('\n  ai-service:'), compose.indexOf('\n  email-service:'));
    const email = compose.slice(compose.indexOf('\n  email-service:'), compose.indexOf('\n  analysis-worker:'));
    const worker = compose.slice(compose.indexOf('\n  analysis-worker:'), compose.indexOf('\n  maintenance-worker:'));
    const maintenance = compose.slice(compose.indexOf('\n  maintenance-worker:'), compose.indexOf('\n  zap:'));
    const zap = compose.slice(compose.indexOf('\n  zap:'), compose.indexOf('\n  frontend:'));
    assert.match(postgres, /cap_add:[\s\S]*CHOWN[\s\S]*FOWNER[\s\S]*SETUID[\s\S]*SETGID[\s\S]*DAC_OVERRIDE/);
    assert.match(api, /EXECUTION_ROLE: api/);
    assert.match(api, /BROWSER_EXECUTION_DISABLED: "true"/);
    assert.match(api, /PDF_EXECUTION_DISABLED: "true"/);
    assert.match(api, /SOURCE_EXECUTION_DISABLED: "true"/);
    assert.match(api, /OSV_EXECUTION_DISABLED: "true"/);
    assert.match(api, /DATABASE_EXPECTED_ROLE: wpa_runtime/);
    assert.match(api, /user: "node"/);
    assert.match(api, /WORKER_RESULT_DIR: \/app\/worker-results/);
    assert.match(api, /ENGINE_LAB_SERVICE_URL: http:\/\/engine-lab-worker:5030/);
    assert.match(api, /ENGINE_LAB_SERVICE_TOKEN/);
    assert.match(api, /DATABASE_SSL_REJECT_UNAUTHORIZED: "true"/);
    assert.doesNotMatch(api, /CHROME_PATH|ZAP_API_KEY|OSV_SCANNER_PATH/);
    assert.match(worker, /EXECUTION_ROLE: worker/);
    assert.match(worker, /WORKER_SANDBOX_REQUIRED: "true"/);
    assert.match(worker, /WORKER_HANDLER_MODULE: \/app\/platform\/worker-handler\.js/);
    assert.match(worker, /DATABASE_EXPECTED_ROLE: wpa_worker/);
    assert.match(worker, /WORKER_RESULT_DIR: \/app\/worker-results/);
    assert.match(worker, /DATABASE_SSL_REJECT_UNAUTHORIZED: "true"/);
    assert.match(worker, /ZAP_API_KEY/);
    assert.match(worker, /ENGINE_LAB_SERVICE_ENABLED: "true"/);
    assert.match(worker, /ENGINE_LAB_SERVICE_TOKEN/);
    assert.match(worker, /expose:[\s\S]*- "5030"/);
    assert.match(api, /analyzer-internal/);
    assert.match(worker, /analyzer-internal/);
    assert.match(worker, /aliases:[\s\S]*engine-lab-worker/);
    assert.doesNotMatch(worker, /app-internal/);
    assert.doesNotMatch(worker, /BETTER_AUTH_SECRET|GEMINI_API_KEY|STRIPE_SECRET_KEY|GITHUB_CLIENT_SECRET/);
    assert.doesNotMatch(worker, /POSTGRES_(?:ADMIN|OWNER|RUNTIME|MIGRATOR|QUEUE)_PASSWORD/);
    assert.match(worker, /source-staging:\/app\/logs\/source-inputs:rw/);
    assert.match(api, /worker-results:\/app\/worker-results:ro/);
    assert.match(worker, /worker-results:\/app\/worker-results:rw/);
    assert.match(api, /AI_SERVICE_URL: http:\/\/ai-service:5010/);
    assert.match(api, /EMAIL_PROVIDER: resend/);
    assert.match(api, /EMAIL_DELIVERY_ENABLED: "true"/);
    assert.match(api, /EMAIL_SERVICE_URL: http:\/\/email-service:5020/);
    assert.doesNotMatch(api, /OPENROUTER_API_KEY|RESEND_API_KEY/);
    assert.match(ai, /dockerfile: Dockerfile\.ai/);
    assert.match(ai, /OPENROUTER_API_KEY/);
    assert.match(ai, /AI_SERVICE_TOKEN/);
    assert.match(ai, /ai-egress/);
    assert.doesNotMatch(ai, /PADDLE_(?:API_KEY|WEBHOOK_SECRET)|RESEND_API_KEY|BETTER_AUTH_SECRET|DATABASE_URL/);
    assert.match(email, /dockerfile: Dockerfile\.email/);
    assert.match(email, /RESEND_API_KEY/);
    assert.match(email, /EMAIL_SERVICE_TOKEN/);
    assert.match(email, /email-egress/);
    assert.doesNotMatch(email, /OPENROUTER_API_KEY|PADDLE_(?:API_KEY|WEBHOOK_SECRET)|BETTER_AUTH_SECRET|DATABASE_URL/);
    assert.match(api, /connect_timeout=/);
    assert.match(worker, /statement_timeout=/);
    assert.match(api, /sslmode=\$\{DATABASE_SSLMODE:-require\}/);
    assert.match(worker, /sslmode=\$\{DATABASE_SSLMODE:-require\}/);
    assert.match(worker, /read_only: true/);
    assert.match(worker, /- ALL/);
    assert.match(worker, /no-new-privileges:true/);
    assert.match(worker, /analysis-egress/);
    assert.doesNotMatch(api, /analysis-egress/);
    assert.match(maintenance, /dockerfile: Dockerfile\.maintenance/);
    assert.match(maintenance, /EXECUTION_ROLE: maintenance/);
    assert.match(maintenance, /WORKER_KIND: maintenance/);
    assert.match(maintenance, /DATABASE_EXPECTED_ROLE: wpa_maintenance/);
    assert.match(maintenance, /BROWSER_EXECUTION_DISABLED: "true"/);
    assert.match(maintenance, /PDF_EXECUTION_DISABLED: "true"/);
    assert.match(maintenance, /SOURCE_EXECUTION_DISABLED: "true"/);
    assert.match(maintenance, /OSV_EXECUTION_DISABLED: "true"/);
    assert.match(maintenance, /source-staging:\/app\/logs\/source-inputs:rw/);
    assert.match(maintenance, /worker-results:\/app\/worker-results:rw/);
    assert.match(maintenance, /data-internal/);
    assert.doesNotMatch(maintenance, /analysis-egress|ZAP_API_KEY|ZAP_URL|CHROME_PATH|OSV_SCANNER_PATH|SOURCE_ENCRYPTION_KEY|BETTER_AUTH_SECRET|STRIPE_SECRET_KEY/);
    assert.doesNotMatch(maintenance, /seccomp:/);
    assert.doesNotMatch(compose, /CHROME_NO_SANDBOX:\s*"true"/);
    assert.match(compose, /MIGRATION_REQUIRE_TLS: \$\{MIGRATION_REQUIRE_TLS:-true\}/);
    assert.match(compose, /RATE_LIMIT_MAX: \$\{RATE_LIMIT_MAX:-120\}/);
    const localEnv = await fs.readFile(path.join(root, '.env.example'), 'utf8');
    assert.match(localEnv, /DATABASE_SSLMODE=require/);
    assert.match(localEnv, /MIGRATION_DATABASE_SSLMODE=require/);
    assert.match(localEnv, /MIGRATION_REQUIRE_TLS=true/);
    const localCompose = await fs.readFile(path.join(root, 'docker-compose.local.yml'), 'utf8');
    assert.match(localCompose, /NODE_ENV: development/);
    assert.match(localCompose, /sslmode=disable/);
    assert.match(localCompose, /MIGRATION_REQUIRE_TLS: "false"/);
    assert.match(localCompose, /RATE_LIMIT_MAX: "2000"/);
    assert.match(localCompose, /maintenance-worker:[\s\S]*NODE_ENV: development[\s\S]*wpa_maintenance:[\s\S]*sslmode=disable/);
    assert.match(zap, /curl -fsS http:\/\/127\.0\.0\.1:8080\/JSON\/core\/view\/version\/\?apikey=\$\$\{ZAP_API_KEY\}/);
    assert.doesNotMatch(zap, /curl -fsS ['"]http:\/\/127\.0\.0\.1:8080[\s\S]*apikey=/);
});

test('PostgreSQL one-shot services share one configurable bootstrap administrator identity', async () => {
    const compose = await fs.readFile(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    assert.equal((compose.match(/POSTGRES_ADMIN_USER: \$\{POSTGRES_ADMIN_USER:-postgres\}/g) || []).length, 2);
    assert.match(compose, /POSTGRES_USER: \$\{POSTGRES_ADMIN_USER:-postgres\}/);
    assert.match(compose, /pg_isready -U \\"\$\$\{POSTGRES_USER\}\\" -d \\"\$\$\{POSTGRES_DB\}\\"/);
});

test('release workflow publishes the canonical website image and retains legacy frontend only for development', async () => {
    const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'containers.yml'), 'utf8');
    assert.match(workflow, /component: website/);
    assert.doesNotMatch(workflow, /context: frontend|image: frontend|component: frontend/);
    const legacyReadme = await fs.readFile(path.join(root, 'frontend', 'README.md'), 'utf8');
    assert.match(legacyReadme, /not part of the production Compose route/i);
});

test('frontend container is hardened without requiring a privileged nginx master', async () => {
    const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    const frontend = compose.slice(compose.indexOf('\n  frontend:'), compose.indexOf('\nvolumes:'));
    const dockerfile = await fs.readFile(path.join(root, 'website', 'Dockerfile'), 'utf8');
    assert.match(frontend, /user: "nginx"/);
    assert.match(frontend, /read_only: true/);
    assert.match(frontend, /cap_drop:[\s\S]*- ALL/);
    assert.match(frontend, /no-new-privileges:true/);
    assert.match(frontend, /\/var\/cache\/nginx/);
    assert.match(frontend, /\/var\/run/);
    assert.match(frontend, /pids_limit: 128/);
    assert.match(frontend, /cpus: 1\.0/);
    assert.match(frontend, /mem_limit: 256m/);
    assert.match(dockerfile, /FROM node@sha256:/);
    assert.match(dockerfile, /FROM nginx@sha256:/);
    assert.match(dockerfile, /USER nginx/);
});

test('worker selects only the reviewed Playwright seccomp derivative', async () => {
    const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    const worker = compose.slice(compose.indexOf('\n  analysis-worker:'), compose.indexOf('\n  maintenance-worker:'));
    const profile = JSON.parse(await fs.readFile(path.join(root, 'infra', 'seccomp', 'playwright-worker.json'), 'utf8'));
    assert.match(worker, /seccomp:\.\/infra\/seccomp\/playwright-worker\.json/);
    assert.doesNotMatch(compose, /seccomp=unconfined|SYS_ADMIN|--no-sandbox/);
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
    assert.deepEqual(profile.syscalls[0].names, ['chroot', 'clone', 'setns', 'unshare']);
    assert.equal(profile.syscalls[0].action, 'SCMP_ACT_ALLOW');
});

test('worker refuses API/provider secrets', () => {
    assert.throws(() => assertWorkerBoundary({ EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker', GEMINI_API_KEY: 'must-not-be-here' }), /WORKER_SECRET_BOUNDARY_VIOLATION/);
    for (const name of ['POSTGRES_ADMIN_PASSWORD', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_MIGRATOR_PASSWORD', 'POSTGRES_QUEUE_PASSWORD', 'QUEUE_DATABASE_URL', 'EMAIL_PROVIDER_API_KEY']) {
        assert.throws(() => assertWorkerBoundary({ EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker', [name]: 'must-not-be-here' }), /WORKER_SECRET_BOUNDARY_VIOLATION/);
    }
    assert.doesNotThrow(() => assertWorkerBoundary({ EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker', SOURCE_ENCRYPTION_KEY: 'allowed-for-source-job', ENGINE_LAB_SERVICE_TOKEN: 'allowed-internal-control-token' }));
});

test('maintenance boundary refuses analysis/provider/browser inputs and requires disabled execution', () => {
    const base = {
        NODE_ENV: 'production', EXECUTION_ROLE: 'maintenance', DATABASE_URL: 'postgres://maintenance',
        DATABASE_EXPECTED_ROLE: 'wpa_maintenance', WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js',
        BROWSER_EXECUTION_DISABLED: 'true', PDF_EXECUTION_DISABLED: 'true', SOURCE_EXECUTION_DISABLED: 'true', OSV_EXECUTION_DISABLED: 'true'
    };
    assert.doesNotThrow(() => assertMaintenanceBoundary(base));
    for (const name of ['SOURCE_ENCRYPTION_KEY', 'ZAP_API_KEY', 'CHROME_PATH', 'OSV_SCANNER_PATH', 'BETTER_AUTH_SECRET', 'STRIPE_SECRET_KEY']) {
        assert.throws(() => assertMaintenanceBoundary({ ...base, [name]: 'must-not-be-here' }), /MAINTENANCE_SECRET_BOUNDARY_VIOLATION/);
    }
    assert.throws(() => assertMaintenanceBoundary({ ...base, SOURCE_EXECUTION_DISABLED: 'false' }), /MAINTENANCE_EXECUTION_DISABLED_REQUIRED/);
    assert.throws(() => assertMaintenanceBoundary({ ...base, EXECUTION_ROLE: 'worker' }), /MAINTENANCE_ROLE_REQUIRED/);
});

test('maintenance validates its dedicated database role, TLS and timeouts before Pool creation', async () => {
    let constructed = 0;
    class FakePool {
        constructor(options) { constructed += 1; this.options = options; }
        async query() { return { rows: [{ role: 'wpa_maintenance' }] }; }
        async end() {}
    }
    const base = {
        NODE_ENV: 'production', EXECUTION_ROLE: 'maintenance', DATABASE_EXPECTED_ROLE: 'wpa_maintenance',
        WORKER_HANDLER_MODULE: '/app/platform/worker-handler.js', BROWSER_EXECUTION_DISABLED: 'true', PDF_EXECUTION_DISABLED: 'true', SOURCE_EXECUTION_DISABLED: 'true', OSV_EXECUTION_DISABLED: 'true'
    };
    assert.throws(() => maintenanceDatabasePoolOptions({ ...base, DATABASE_URL: 'postgres://maintenance@db/wpa?sslmode=disable' }), /MAINTENANCE_DATABASE_TLS_REQUIRED/);
    await assertMaintenanceDatabaseRole({ ...base, DATABASE_URL: 'postgres://maintenance@db/wpa?connect_timeout=5&statement_timeout=30000&lock_timeout=10000&idle_in_transaction_session_timeout=60000&sslmode=require' }, FakePool);
    assert.equal(constructed, 1);
});

test('production worker cannot be configured to expect an application or migrator role', () => {
    assert.throws(() => assertWorkerBoundary({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker', DATABASE_EXPECTED_ROLE: 'wpa_migrator' }), /WORKER_DATABASE_ROLE_REQUIRED/);
    assert.doesNotThrow(() => assertWorkerBoundary({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker', DATABASE_EXPECTED_ROLE: 'wpa_worker' }));
});

test('worker rejects every common Chromium sandbox bypass spelling', async () => {
    const fsImpl = { access: async () => {}, stat: async () => ({ uid: 0, mode: 0o4000 }) };
    for (const value of ['1', 'true', 'yes', 'on']) {
        await assert.rejects(
            assertChromiumSandbox({ CHROME_PATH: '/usr/bin/chromium', CHROME_NO_SANDBOX: value }, fsImpl, () => { throw new Error('must not spawn'); }),
            /CHROME_NO_SANDBOX bypass is forbidden/
        );
    }
});

test('worker refuses a database role mismatch', async () => {
    class FakePool {
        constructor() {}
        async query() { return { rows: [{ role: 'wpa_runtime' }] }; }
        async end() {}
    }
    await assert.rejects(
        assertDatabaseRole({ NODE_ENV: 'production', EXECUTION_ROLE: 'worker', DATABASE_URL: 'postgres://worker?sslmode=require&connect_timeout=5&statement_timeout=30000&lock_timeout=10000&idle_in_transaction_session_timeout=60000', DATABASE_EXPECTED_ROLE: 'wpa_worker' }, FakePool),
        /WORKER_DATABASE_ROLE_MISMATCH/
    );
});

test('worker validates role, TLS and startup timeouts before creating its Pool', async () => {
    let constructed = 0;
    class FakePool {
        constructor(options) { constructed += 1; this.options = options; }
        async query() { return { rows: [{ role: 'wpa_worker' }] }; }
        async end() {}
    }
    const invalid = {
        NODE_ENV: 'production', EXECUTION_ROLE: 'worker', DATABASE_EXPECTED_ROLE: 'wpa_worker',
        DATABASE_URL: 'postgresql://worker@db/wpa?sslmode=disable', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true'
    };
    assert.throws(() => workerDatabasePoolOptions(invalid), /WORKER_DATABASE_TLS_REQUIRED/);
    await assert.rejects(() => assertDatabaseRole(invalid, FakePool), /WORKER_DATABASE_TLS_REQUIRED/);
    assert.equal(constructed, 0);

    const valid = {
        ...invalid,
        DATABASE_URL: 'postgresql://worker@db/wpa?connect_timeout=5&statement_timeout=30000&lock_timeout=10000&idle_in_transaction_session_timeout=60000&sslmode=require'
    };
    const options = workerDatabasePoolOptions(valid);
    assert.equal(options.connectionTimeoutMillis, 5000);
    assert.match(options.connectionString, /statement_timeout=30000/);
    await assertDatabaseRole(valid, FakePool);
    assert.equal(constructed, 1);
});

test('worker sandbox probe fails closed when the runtime cannot launch Chromium sandbox', async () => {
    const fsImpl = { access: async () => {}, stat: async () => ({ uid: 0, mode: 0o4000 }) };
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => child.emit('close', 1, null));
        return child;
    };
    await assert.rejects(
        assertChromiumSandbox({ CHROME_PATH: '/usr/bin/chromium' }, fsImpl, spawnImpl),
        /WORKER_SANDBOX_UNAVAILABLE/
    );
});
