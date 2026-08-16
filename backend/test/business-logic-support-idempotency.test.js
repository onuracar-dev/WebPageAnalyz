const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore } = require('../platform/store');
const { createSupportService } = require('../support/service');

const silentLogger = { warn() {} };

test('support message service passes operation context and transition intent, suppressing replay notifications', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_support_business_logic');
    await store.setUserState('customer-support', 'active', {
        actorId: 'fixture',
        reason: 'support service fixture',
        requestId: 'fixture-user',
        email: 'customer-support@example.com'
    });

    const append = store.appendSupportMessage.bind(store);
    const createSupportTicket = store.createSupportTicket.bind(store);
    let createInput = null;
    store.createSupportTicket = async (workspaceId, input) => {
        createInput = { ...input };
        return createSupportTicket(workspaceId, input);
    };
    const appendCalls = [];
    const seenKeys = new Set();
    store.appendSupportMessage = async (workspaceId, ticketId, input) => {
        appendCalls.push({ workspaceId, ticketId, input: { ...input } });
        if (input.idempotencyKey && seenKeys.has(input.idempotencyKey)) {
            const ticket = await store.getSupportTicket(workspaceId, ticketId, { allowAnyWorkspace: !workspaceId });
            const messages = await store.listSupportMessages(workspaceId, ticketId, { includeInternal: true });
            return { ticket, message: messages.at(-1), idempotent: true };
        }
        if (input.idempotencyKey) seenKeys.add(input.idempotencyKey);
        return { ...(await append(workspaceId, ticketId, input)), idempotent: false };
    };

    const sent = [];
    const service = createSupportService({
        store,
        logger: silentLogger,
        supportEmail: 'support@example.com',
        emailTransport: {
            configured: true,
            provider: 'test-email',
            async send(message) {
                sent.push(message);
                return { provider: 'test-email' };
            }
        }
    });

    const created = await service.createTicket('ws_support_business_logic', 'customer-support', {
        subject: 'Operation context',
        body: 'Initial ticket'
    }, { idempotencyKey: 'support-create-op', requestFingerprint: 'support-create-fp' }, 'request-create');
    const ticketId = created.ticket.id;
    assert.equal(createInput.idempotencyKey, 'support-create-op');
    assert.equal(createInput.requestFingerprint, 'support-create-fp');

    await service.replyCustomer(
        'ws_support_business_logic',
        'customer-support',
        ticketId,
        'Customer reply',
        'request-customer',
        { idempotencyKey: 'customer-reply-op', requestFingerprint: 'customer-reply-fp' }
    );
    await service.replyCustomer(
        'ws_support_business_logic',
        'customer-support',
        ticketId,
        'Customer reply replay',
        { idempotencyKey: 'customer-reply-op', requestFingerprint: 'customer-reply-fp' }
    );
    await service.adminNote(ticketId, 'admin-support', 'Internal note', {
        idempotencyKey: 'internal-note-op',
        requestFingerprint: 'internal-note-fp'
    });
    await service.adminReply(ticketId, 'admin-support', 'Admin reply', 'request-admin', {
        idempotencyKey: 'admin-reply-op',
        requestFingerprint: 'admin-reply-fp'
    });
    await service.adminReply(ticketId, 'admin-support', 'Admin reply replay', {
        idempotencyKey: 'admin-reply-op',
        requestFingerprint: 'admin-reply-fp'
    });

    const customerCalls = appendCalls.filter(({ input }) => input.transitionIntent === 'customer_reply');
    assert.equal(customerCalls.length, 2);
    assert.equal(customerCalls[0].input.idempotencyKey, 'customer-reply-op');
    assert.equal(customerCalls[0].input.requestFingerprint, 'customer-reply-fp');
    assert.equal(customerCalls[0].input.audit.requestId, 'request-customer');
    assert.equal(customerCalls[0].input.transitionIntent, 'customer_reply');

    const noteCall = appendCalls.find(({ input }) => input.transitionIntent === 'internal_note');
    assert.equal(noteCall.input.idempotencyKey, 'internal-note-op');
    assert.equal(noteCall.input.requestFingerprint, 'internal-note-fp');

    const adminCalls = appendCalls.filter(({ input }) => input.transitionIntent === 'admin_reply');
    assert.equal(adminCalls.length, 2);
    assert.equal(adminCalls[0].input.idempotencyKey, 'admin-reply-op');
    assert.equal(adminCalls[0].input.requestFingerprint, 'admin-reply-fp');
    assert.equal(adminCalls[0].input.audit.requestId, 'request-admin');

    assert.equal(sent.filter(({ idempotencyKey }) => idempotencyKey.startsWith('customer_reply:')).length, 1);
    assert.equal(sent.filter(({ idempotencyKey }) => idempotencyKey.startsWith('admin_reply:')).length, 1);
});
