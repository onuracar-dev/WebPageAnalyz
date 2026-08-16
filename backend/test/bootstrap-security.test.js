const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapFirstAdmin, provisionBootstrapToken, tokenHash } = require('../auth/bootstrap');
const { createApp } = require('../app');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const request = require('supertest');

const TOKEN = 'bootstrap-token-that-is-long-enough-for-one-time-use-2026';

function bootstrapPool({ verified = true } = {}) {
    const state = { adminCount: 0, provisionedTokenHash: null, consumed: false, commits: 0, rollbacks: 0, user: { id: 'user-1', email: 'admin@example.com', emailVerified: verified } };
    const queries = [];
    const client = {
        async query(sql, parameters = []) {
            queries.push({ sql, parameters });
            if (sql === 'BEGIN') return {};
            if (sql.includes('pg_advisory_xact_lock')) return {};
            if (sql.includes('SELECT count(*)::int AS count FROM wpa_admin_accounts')) return { rows: [{ count: state.adminCount }] };
            if (sql.includes('FROM "user"')) return { rows: [state.user] };
            if (sql.includes('SELECT consumed_at AS') || sql.includes('SELECT token_hash AS')) return { rows: state.provisionedTokenHash ? [{ tokenHash: state.provisionedTokenHash, consumedAt: state.consumed ? new Date().toISOString() : null }] : [] };
            if (sql.startsWith('INSERT INTO wpa_admin_bootstrap')) { state.provisionedTokenHash = parameters[0]; return { rowCount: 1 }; }
            if (sql.startsWith('INSERT INTO wpa_admin_accounts')) {
                if (state.adminCount > 0) return { rowCount: 0, rows: [] };
                state.adminCount = 1;
                return { rowCount: 1, rows: [{ userId: state.user.id, email: state.user.email, role: 'super_admin', active: true }] };
            }
            if (sql.startsWith('UPDATE wpa_admin_bootstrap')) { state.consumed = true; return { rowCount: 1 }; }
            if (sql.startsWith('INSERT INTO wpa_audit_log')) return { rowCount: 1 };
            if (sql === 'COMMIT') { state.commits += 1; return {}; }
            if (sql === 'ROLLBACK') { state.rollbacks += 1; return {}; }
            throw new Error(`Unexpected bootstrap query: ${sql}`);
        },
        release() {}
    };
    return { state, queries, pool: { async connect() { return client; } } };
}

test('bootstrap requires a separately provisioned token, verified email, no existing admin, and consumes once', async () => {
    const initial = bootstrapPool();
    await assert.rejects(() => bootstrapFirstAdmin({ pool: initial.pool, userId: 'user-1', email: 'admin@example.com', token: TOKEN, reason: 'initial admin' }), (error) => error.code === 'BOOTSTRAP_TOKEN_NOT_PROVISIONED');
    assert.equal(initial.state.adminCount, 0);

    await provisionBootstrapToken({ pool: initial.pool, token: TOKEN });
    assert.equal(initial.state.provisionedTokenHash, tokenHash(TOKEN));
    const result = await bootstrapFirstAdmin({ pool: initial.pool, userId: 'user-1', email: 'admin@example.com', token: TOKEN, reason: 'initial admin' });
    assert.equal(result.role, 'super_admin');
    assert.equal(initial.state.adminCount, 1);
    assert.equal(initial.state.consumed, true);
    await assert.rejects(() => bootstrapFirstAdmin({ pool: initial.pool, userId: 'user-1', email: 'admin@example.com', token: TOKEN, reason: 'retry' }), (error) => error.code === 'BOOTSTRAP_ADMIN_EXISTS' || error.code === 'BOOTSTRAP_ALREADY_CONSUMED');
});
test('bootstrap rejects an unverified account and leaves the provisioned token reusable', async () => {
    const harness = bootstrapPool({ verified: false });
    await provisionBootstrapToken({ pool: harness.pool, token: TOKEN });
    await assert.rejects(() => bootstrapFirstAdmin({ pool: harness.pool, userId: 'user-1', email: 'admin@example.com', token: TOKEN, reason: 'initial admin' }), (error) => error.code === 'BOOTSTRAP_EMAIL_UNVERIFIED');
    assert.equal(harness.state.adminCount, 0);
    assert.equal(harness.state.consumed, false);
    assert.equal(harness.state.rollbacks, 1);
});

test('a bootstrapped record cannot be used without 2FA', async (t) => {
    const store = new MemoryPlatformStore();
    await store.upsertAdminAccount({ userId: 'user-1', email: 'admin@example.com', role: 'super_admin', active: true });
    const config = loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://dashboard.example', APP_URL: 'https://dashboard.example', WORKER_ENABLED: 'false' });
    const app = createApp({
        config,
        platformStore: store,
        logger: { info() {}, warn() {}, error() {} },
        authService: { async session() { return { user: { id: 'user-1', email: 'admin@example.com', emailVerified: true, twoFactorEnabled: false }, session: { id: 'bootstrap-session' } }; }, async close() {} }
    });
    t.after(() => app.locals.closeResources());
    await request(app).get('/api/v1/admin/me').expect(403).expect(({ body }) => assert.equal(body.code, 'ADMIN_2FA_REQUIRED'));
});
