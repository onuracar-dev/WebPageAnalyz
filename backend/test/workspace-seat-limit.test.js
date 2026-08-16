const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../config');
const { createApp } = require('../app');
const { attachWorkspaceMembership } = require('../auth/workspace-policy');
const { MemoryPlatformStore } = require('../platform/store');

const silentLogger = { info() {}, warn() {}, error() {} };

async function organizationStore({ planId = 'free', role = 'member', seatPosition = 1 } = {}) {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('org-1', { name: 'Seat contract', planId });
    await store.setWorkspacePlan('org-1', planId);
    const queries = [];
    store.pool = {
        async query(sql, parameters) {
            queries.push({ sql, parameters });
            if (sql.includes('row_number() OVER')) {
                return { rows: role ? [{ userId: parameters[1], role, seatPosition }] : [] };
            }
            if (sql.startsWith('INSERT INTO wpa_memberships')) {
                return { rows: [{ workspaceId: parameters[0], userId: parameters[1], role: parameters[2] }] };
            }
            if (sql.startsWith('DELETE FROM wpa_memberships')) return { rowCount: 1, rows: [] };
            throw new Error(`Unexpected membership query: ${sql}`);
        }
    };
    return { store, queries };
}

async function runMembershipPolicy(store, userId = 'user-1') {
    const requestContext = {
        platformIdentity: {
            userId,
            workspaceId: 'org-1',
            session: { session: { activeOrganizationId: 'org-1' } }
        }
    };
    let nextError = null;
    await attachWorkspaceMembership({ config: { nodeEnv: 'production' }, store })(requestContext, {}, (error) => { nextError = error || null; });
    return { requestContext, error: nextError };
}

function apiFor(t, config, store, session) {
    const app = createApp({
        config,
        platformStore: store,
        logger: silentLogger,
        authService: {
            async session() { return session; },
            async reauthenticate() { return { status: true }; },
            async close() {}
        },
        validateUrl: async () => ({ url: 'https://example.com/', hostname: 'example.com', port: 443, address: '8.8.8.8', family: 4, addresses: [{ address: '8.8.8.8', family: 4 }] }),
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return 'solution'; }, async generateExecutiveSummary() { return 'summary'; } }
    });
    t.after(() => app.locals.closeResources());
    return app;
}

test('organization seats are stable: owner first, then creation time and member id', async () => {
    const { store, queries } = await organizationStore({ planId: 'free', role: 'owner', seatPosition: 1 });
    const result = await runMembershipPolicy(store);

    assert.equal(result.error, null);
    assert.equal(result.requestContext.platformIdentity.role, 'owner');
    const ranking = queries.find(({ sql }) => sql.includes('row_number() OVER'));
    assert.ok(ranking);
    assert.match(ranking.sql, /CASE WHEN role='owner' THEN 0 ELSE 1 END,"createdAt",id/);
    assert.deepEqual(ranking.parameters, ['org-1', 'user-1']);
    assert.equal(queries.some(({ sql }) => sql.startsWith('INSERT INTO wpa_memberships')), true);
});

test('free and Signal plans reject a second Better Auth organization member and remove any mirrored membership', async () => {
    for (const planId of ['free', 'signal']) {
        const { store, queries } = await organizationStore({ planId, role: 'member', seatPosition: 2 });
        const result = await runMembershipPolicy(store, `user-${planId}`);

        assert.equal(result.error?.status, 403);
        assert.equal(result.error?.code, 'WORKSPACE_SEAT_LIMIT_REACHED');
        assert.equal(queries.some(({ sql }) => sql.startsWith('INSERT INTO wpa_memberships')), false);
        const cleanup = queries.find(({ sql }) => sql.startsWith('DELETE FROM wpa_memberships'));
        assert.deepEqual(cleanup?.parameters, ['org-1', `user-${planId}`]);
    }
});

test('effective plan changes are enforced immediately at the Studio five-seat boundary', async () => {
    const fifth = await organizationStore({ planId: 'studio', role: 'member', seatPosition: 5 });
    const admitted = await runMembershipPolicy(fifth.store, 'user-5');
    assert.equal(admitted.error, null);
    assert.equal(admitted.requestContext.platformIdentity.role, 'analyst');

    const sixth = await organizationStore({ planId: 'studio', role: 'member', seatPosition: 6 });
    const rejected = await runMembershipPolicy(sixth.store, 'user-6');
    assert.equal(rejected.error?.code, 'WORKSPACE_SEAT_LIMIT_REACHED');

    await sixth.store.setWorkspacePlan('org-1', 'enterprise');
    const admittedAfterUpgrade = await runMembershipPolicy(sixth.store, 'user-6');
    assert.equal(admittedAfterUpgrade.error, null);
});

test('workspace API fails closed with the stable seat-limit error for an excess organization member', async (t) => {
    const config = loadConfig({ NODE_ENV: 'test', WORKER_ENABLED: 'false' });
    const { store } = await organizationStore({ planId: 'free', role: 'member', seatPosition: 2 });
    const session = {
        user: { id: 'user-2', email: 'member@example.com', emailVerified: true },
        session: { id: 'session-seat-2', activeOrganizationId: 'org-1' }
    };
    const app = apiFor(t, config, store, session);

    await request(app)
        .get('/api/v1/workspace')
        .expect(403)
        .expect(({ body }) => assert.equal(body.code, 'WORKSPACE_SEAT_LIMIT_REACHED'));
});

test('missing or invalid plan seat capacity fails closed', async () => {
    const { store } = await organizationStore({ planId: 'free', role: 'owner', seatPosition: 1 });
    store.getEffectiveEntitlements = async () => ({ id: 'broken', limits: { seats: 0 } });
    const result = await runMembershipPolicy(store);

    assert.equal(result.error?.status, 503);
    assert.equal(result.error?.code, 'WORKSPACE_SEAT_LIMIT_UNAVAILABLE');
});
