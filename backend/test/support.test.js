const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { MemoryPlatformStore } = require('../platform/store');
const { createSupportService } = require('../support/service');
const { createApp } = require('../app');
const { loadConfig } = require('../config');

const silentLogger = { info() {}, warn() {}, error() {} };

test('support ticket lifecycle is durable, idempotent, paginated, and hides internal notes', async () => {
    const store = new MemoryPlatformStore();
    const service = createSupportService({ store, logger: silentLogger });
    await store.ensureWorkspace('ws_support_a');
    const first = await service.createTicket('ws_support_a', 'customer-a', { subject: 'Cannot export', body: 'The PDF export is unavailable.', priority: 'high' }, 'request-1');
    const replay = await service.createTicket('ws_support_a', 'customer-a', { subject: 'Different subject', body: 'Should not duplicate.' }, 'request-1');
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.ticket.id, first.ticket.id);
    await service.adminNote(first.ticket.id, 'admin-a', 'Checked provider state; do not expose this note.', 'request-admin-note');
    const customer = await service.customerTicket('ws_support_a', first.ticket.id);
    assert.equal(customer.messages.length, 1);
    assert.equal(customer.messages[0].body, 'The PDF export is unavailable.');
    const admin = await service.adminTicket(first.ticket.id);
    assert.equal(admin.messages.length, 2);
    assert.equal(admin.messages[1].visibility, 'internal');
    await service.adminReply(first.ticket.id, 'admin-a', 'We are investigating this now.', 'request-admin-reply');
    assert.equal((await service.customerTicket('ws_support_a', first.ticket.id)).status, 'waiting_customer');
    assert.equal((await service.listTickets('ws_support_a', { status: 'waiting_customer' })).tickets[0].status, 'waiting_customer');
    assert.equal((await service.listTickets('ws_support_a', { status: 'pending' })).tickets[0].status, 'waiting_customer');
    await service.replyCustomer('ws_support_a', 'customer-a', first.ticket.id, 'Thanks for checking.');
    assert.equal((await service.customerTicket('ws_support_a', first.ticket.id)).status, 'in_progress');
    await service.closeCustomer('ws_support_a', 'customer-a', first.ticket.id);
    await assert.rejects(service.replyCustomer('ws_support_a', 'customer-a', first.ticket.id, 'A late reply'), { code: 'SUPPORT_TICKET_CLOSED' });
    await service.reopenCustomer('ws_support_a', 'customer-a', first.ticket.id);
    assert.equal((await service.customerTicket('ws_support_a', first.ticket.id)).status, 'open');
    await service.updateAdminTicket(first.ticket.id, 'admin-a', { priority: 'urgent', assignedTo: 'admin-a' }, 'request-admin-update');

    for (const [action, reason, requestId] of [
        ['support_ticket.internal_note_added', 'admin_internal_note', 'request-admin-note'],
        ['support_ticket.admin_replied', 'admin_customer_reply', 'request-admin-reply'],
        ['support_ticket.admin_updated', 'admin_support_update', 'request-admin-update']
    ]) {
        const audit = store.auditLog.find((entry) => entry.action === action);
        assert.ok(audit, `${action} audit must exist`);
        assert.equal(audit.actorId, 'admin-a');
        assert.equal(audit.reason, reason);
        assert.equal(audit.requestId, requestId);
    }

    for (let index = 0; index < 3; index += 1) {
        await service.createTicket('ws_support_a', `customer-${index}`, { subject: `Ticket ${index}`, body: 'Bounded body' });
    }
    const page = await service.listTickets('ws_support_a', { limit: 2 });
    assert.equal(page.tickets.length, 2);
    assert.ok(page.nextCursor);
    const next = await service.listTickets('ws_support_a', { limit: 2, cursor: page.nextCursor });
    assert.ok(next.tickets.every((ticket) => !page.tickets.some((firstPageTicket) => firstPageTicket.id === ticket.id)));
    assert.equal((await service.listTickets('ws_support_a', { status: 'not-a-status' }).catch((error) => error.code)), 'SUPPORT_STATUS_INVALID');
    await assert.rejects(service.customerTicket('ws_support_b', first.ticket.id), { code: 'SUPPORT_TICKET_NOT_FOUND' });
});

test('admin support views identify the registered requester without exposing admin-only identity fields to customers', async () => {
    const store = new MemoryPlatformStore();
    const service = createSupportService({ store, logger: silentLogger });
    await store.registerUser({ id: 'customer-identity', name: 'Avery Example', email: 'avery@example.test' });
    await store.ensureWorkspace('ws_support_identity');
    const created = await service.createTicket('ws_support_identity', 'customer-identity', {
        subject: 'Identity is required in the inbox',
        body: 'An operator should know who opened this request.'
    });

    const customer = await service.customerTicket('ws_support_identity', created.ticket.id);
    assert.equal(customer.requesterName, undefined);
    assert.equal(customer.requesterEmail, undefined);
    assert.equal(customer.messages[0].authorEmail, undefined);

    const adminList = await service.listAdminTickets({});
    assert.equal(adminList.tickets[0].requesterId, 'customer-identity');
    assert.equal(adminList.tickets[0].requesterName, 'Avery Example');
    assert.equal(adminList.tickets[0].requesterEmail, 'avery@example.test');

    const adminDetail = await service.adminTicket(created.ticket.id);
    assert.equal(adminDetail.requesterId, 'customer-identity');
    assert.equal(adminDetail.requesterName, 'Avery Example');
    assert.equal(adminDetail.requesterEmail, 'avery@example.test');
    assert.equal(adminDetail.messages[0].authorName, 'Avery Example');
    assert.equal(adminDetail.messages[0].authorEmail, 'avery@example.test');
});

test('support parses the existing composer context envelope into structured ticket fields', async () => {
    const store = new MemoryPlatformStore();
    const service = createSupportService({ store, logger: silentLogger });
    await store.ensureWorkspace('ws_context');
    const result = await service.createTicket('ws_context', 'customer-context', {
        subject: 'Report context',
        body: 'The report link is not opening.\n\n— Context —\nCategory: analysis\nContext: Browser: Chrome\nScan stage: export\nTarget URL: https://example.com/report\nReport ID: rpt_123'
    });
    assert.equal(result.ticket.category, 'analysis');
    assert.equal(result.ticket.targetUrl, 'https://example.com/report');
    assert.equal(result.ticket.reportId, 'rpt_123');
    assert.equal(result.ticket.context, 'Browser: Chrome\nScan stage: export');
    assert.equal(result.ticket.messages[0].body, 'The report link is not opening.');
});

test('support notifications are idempotent, auditable, and fail soft when email is unavailable', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_notifications');
    await store.setUserState('customer-notify', 'active', {
        actorId: 'system',
        reason: 'test fixture',
        requestId: 'seed-user',
        email: 'customer@example.com'
    });
    const sent = [];
    const service = createSupportService({
        store,
        logger: silentLogger,
        supportEmail: 'support@example.com',
        emailTransport: {
            configured: true,
            provider: 'internal-email-service',
            async send(message) {
                sent.push(message);
                if (message.idempotencyKey.startsWith('customer_reply:')) {
                    const error = new Error('provider unavailable');
                    error.code = 'EMAIL_PROVIDER_UNAVAILABLE';
                    throw error;
                }
                return { accepted: true, provider: 'resend' };
            }
        }
    });

    const first = await service.createTicket('ws_notifications', 'customer-notify', {
        subject: 'Notification contract',
        body: 'Please keep the durable ticket even if delivery fails.'
    }, 'notification-key');
    const replay = await service.createTicket('ws_notifications', 'customer-notify', {
        subject: 'A replay must not send again',
        body: 'duplicate'
    }, 'notification-key');
    assert.equal(replay.created, false);
    assert.equal(sent.filter((message) => message.idempotencyKey.startsWith('support_created:')).length, 1);

    await service.replyCustomer('ws_notifications', 'customer-notify', first.ticket.id, 'Customer follow-up');
    const afterFailedNotification = await service.customerTicket('ws_notifications', first.ticket.id);
    assert.equal(afterFailedNotification.status, 'open');
    assert.equal(afterFailedNotification.messages.length, 2);
    await service.adminReply(first.ticket.id, 'admin-notify', 'Admin response');
    assert.equal(sent.at(-1).to, 'customer@example.com');
    assert.equal(sent.at(-1).kind, 'support');

    const actions = store.auditLog.map((entry) => entry.action);
    assert.ok(actions.includes('support_ticket.notification_sent'));
    assert.ok(actions.includes('support_ticket.notification_failed'));
});

test('support mutations roll back when their required audit record cannot be persisted', async () => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_support_atomic');
    const service = createSupportService({ store, logger: silentLogger });
    const created = await service.createTicket('ws_support_atomic', 'customer-atomic', {
        subject: 'Atomic audit fixture', body: 'Initial durable message.'
    }, 'support-atomic-create', 'request-create');
    const beforeTicket = structuredClone(await store.getSupportTicket('ws_support_atomic', created.ticket.id));
    const beforeMessages = structuredClone(await store.listSupportMessages('ws_support_atomic', created.ticket.id, { includeInternal: true }));
    store.logAudit = async () => { throw new Error('audit unavailable'); };

    await assert.rejects(() => service.adminNote(created.ticket.id, 'admin-atomic', 'Must not survive.', 'request-note'), /audit unavailable/);
    assert.deepEqual(await store.getSupportTicket('ws_support_atomic', created.ticket.id), beforeTicket);
    assert.deepEqual(await store.listSupportMessages('ws_support_atomic', created.ticket.id, { includeInternal: true }), beforeMessages);

    await assert.rejects(() => service.updateAdminTicket(created.ticket.id, 'admin-atomic', { priority: 'high' }, 'request-update'), /audit unavailable/);
    assert.deepEqual(await store.getSupportTicket('ws_support_atomic', created.ticket.id), beforeTicket);

    const ticketCount = store.supportTickets.size;
    await assert.rejects(() => service.createTicket('ws_support_atomic', 'customer-atomic', {
        subject: 'Creation must roll back', body: 'No orphaned mutation.'
    }, 'support-atomic-failed-create', 'request-failed-create'), /audit unavailable/);
    assert.equal(store.supportTickets.size, ticketCount);
    assert.equal(store.supportIdempotency.has('ws_support_atomic:support-atomic-failed-create'), false);
});

function testConfig(extra = {}) {
    return loadConfig({
        NODE_ENV: 'test',
        CORS_ORIGINS: 'https://dashboard.example',
        LEGACY_API_ENABLED: 'false',
        RATE_LIMIT_MAX: '1000',
        SUPPORT_RATE_LIMIT_MAX: '1000',
        SUPPORT_ADMIN_RATE_LIMIT_MAX: '1000',
        ...extra
    });
}

test('customer support routes are workspace-scoped and admin routes require active admin session', async (t) => {
    const store = new MemoryPlatformStore();
    await store.ensureWorkspace('ws_customer');
    const authService = { async session() { return null; }, async close() {} };
    const app = createApp({
        config: testConfig(),
        platformStore: store,
        authService,
        logger: silentLogger,
        analysisService: { async analyze() { return { scores: {}, categories: {} }; } },
        geminiService: { async solveIssue() { return ''; }, async generateExecutiveSummary() { return ''; } }
    });
    t.after(() => app.locals.closeResources());
    await request(app).options('/api/v1/support/tickets/demo').set('Origin', 'https://dashboard.example').set('Access-Control-Request-Method', 'PATCH').expect(204).expect('Access-Control-Allow-Credentials', 'true');
    const first = await request(app).post('/api/v1/support/tickets').set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'route-operation-0001').send({ subject: 'Route ticket', body: 'Initial request' }).expect(201);
    const replay = await request(app).post('/api/v1/support/tickets').set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'route-operation-0001').send({ subject: 'Route ticket', body: 'Initial request' }).expect(200);
    assert.equal(replay.body.ticket.id, first.body.ticket.id);
    const changedReplay = await request(app).post('/api/v1/support/tickets').set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'route-operation-0001').send({ subject: 'Changed', body: 'Must not bind to the first operation' }).expect(409);
    assert.equal(changedReplay.body.code, 'IDEMPOTENCY_KEY_REUSED');
    const uiShape = await request(app).post('/api/v1/support/tickets').set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'route-operation-0002').send({ category: 'analysis', subject: 'UI shape', message: 'The UI uses message, not body.', context: 'No secrets', targetUrl: 'https://example.com/path', reportId: 'rpt_demo' }).expect(201);
    assert.equal(uiShape.body.ticket.category, 'analysis');
    await request(app).post('/api/v1/support/tickets').set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').send({ subject: 'Credential-bearing URL', message: 'Must be rejected.', targetUrl: 'https://user:password@example.com/' }).expect(400);
    await request(app).post(`/api/v1/support/tickets/${uiShape.body.ticket.id}/messages`).set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').set('Idempotency-Key', 'route-message-0001').send({ body: 'A customer follow-up.', visibility: 'customer' }).expect(201);
    await request(app).patch(`/api/v1/support/tickets/${uiShape.body.ticket.id}`).set('X-Workspace-Id', 'ws_customer').set('Origin', 'https://dashboard.example').send({ status: 'closed' }).expect(200);
    assert.equal((await request(app).get(`/api/v1/support/tickets/${first.body.ticket.id}`).set('X-Workspace-Id', 'other-workspace')).status, 404);
    assert.equal((await request(app).get('/api/v1/admin/support/tickets')).status, 401);
});
