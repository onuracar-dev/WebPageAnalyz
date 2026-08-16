const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore, PostgresPlatformStore } = require('../platform/store');

async function supportStoreContract(store, suffix) {
    const workspaceId = `ws_support_store_${suffix}`;
    await store.ensureWorkspace(workspaceId);
    const createKey = `support-create-${suffix}-0001`;
    const createInput = {
        subject: 'Durable support operation',
        createdBy: 'customer-1',
        idempotencyKey: createKey,
        requestFingerprint: 'support-create-fingerprint-a',
        initialMessage: { authorId: 'customer-1', authorType: 'customer', visibility: 'public', body: 'Initial request' }
    };
    const first = await store.createSupportTicket(workspaceId, createInput);
    const replay = await store.createSupportTicket(workspaceId, createInput);
    assert.equal(replay.ticket.id, first.ticket.id);
    assert.equal(replay.idempotent, true);
    await assert.rejects(() => store.createSupportTicket(workspaceId, {
        ...createInput,
        subject: 'Changed request',
        requestFingerprint: 'support-create-fingerprint-b'
    }), { code: 'IDEMPOTENCY_KEY_REUSED' });

    const messageInput = {
        authorId: 'customer-1',
        authorType: 'customer',
        visibility: 'public',
        body: 'Retry-safe reply',
        transitionIntent: 'customer_reply',
        idempotencyKey: `support-message-${suffix}-0001`,
        requestFingerprint: 'support-message-fingerprint-a'
    };
    const [left, right] = await Promise.all([
        store.appendSupportMessage(workspaceId, first.ticket.id, messageInput),
        store.appendSupportMessage(workspaceId, first.ticket.id, messageInput)
    ]);
    assert.equal(left.message.id, right.message.id);
    assert.equal([left.idempotent, right.idempotent].filter(Boolean).length, 1);
    await assert.rejects(() => store.appendSupportMessage(workspaceId, first.ticket.id, {
        ...messageInput,
        body: 'Changed reply',
        requestFingerprint: 'support-message-fingerprint-b'
    }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    const messages = await store.listSupportMessages(workspaceId, first.ticket.id, { includeInternal: true });
    assert.equal(messages.length, 2, 'initial message plus one logical reply must be durable');
}

test('Memory support store binds operation keys to one request and one message', async () => {
    await supportStoreContract(new MemoryPlatformStore(), 'memory');
});

test('PostgreSQL support actor lookup batches registered identities without duplicating user IDs', async () => {
    const calls = [];
    const store = Object.create(PostgresPlatformStore.prototype);
    store.pool = {
        async query(sql, values) {
            calls.push({ sql, values });
            return { rows: [{ id: 'customer-1', name: 'Avery Example', email: 'avery@example.test', emailVerified: true, state: 'active' }] };
        }
    };
    const actors = await store.getSupportActors(['customer-1', 'customer-1']);
    assert.equal(actors[0].email, 'avery@example.test');
    assert.deepEqual(calls[0].values, [['customer-1']]);
    assert.match(calls[0].sql, /FROM "user" WHERE id=ANY\(\$1::text\[\]\)/);
    assert.match(calls[0].sql, /"emailVerified" AS "emailVerified"/);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL support store binds operation keys to one request and one message', { skip: !databaseUrl }, async () => {
    const store = new PostgresPlatformStore(databaseUrl);
    try { await supportStoreContract(store, `pg-${Date.now()}`); }
    finally { await store.close(); }
});
