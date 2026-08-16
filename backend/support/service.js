const { AppError } = require('../lib/errors');

const SUPPORT_STATUSES = Object.freeze(['open', 'pending', 'in_progress', 'resolved', 'closed']);
const SUPPORT_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const SUPPORT_CATEGORIES = Object.freeze(['analysis', 'account', 'billing', 'security', 'general']);
const SUPPORT_CONTEXT_MARKER = '\n\n— Context —\n';

function parseStructuredMessage(body) {
    if (typeof body !== 'string') return { body };
    const markerIndex = body.lastIndexOf(SUPPORT_CONTEXT_MARKER);
    if (markerIndex < 1) return { body };
    const message = body.slice(0, markerIndex).trim();
    if (!message) return { body };
    const fields = {};
    let current = null;
    for (const line of body.slice(markerIndex + SUPPORT_CONTEXT_MARKER.length).split(/\r?\n/)) {
        const match = line.match(/^(Category|Context|Target URL|Report ID):\s*(.*)$/i);
        if (match) {
            current = match[1].toLowerCase().replaceAll(' ', '');
            fields[current] = match[2].trim();
        } else if (current === 'context' && line.trim()) {
            fields.context = `${fields.context || ''}\n${line.trim()}`.trim();
        }
    }
    const categoryValue = fields.category?.toLowerCase();
    const category = SUPPORT_CATEGORIES.includes(categoryValue) ? categoryValue : undefined;
    let targetUrl;
    try {
        const parsed = fields.targeturl ? new URL(fields.targeturl) : null;
        if (parsed && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) targetUrl = parsed.toString();
    } catch { /* malformed optional context is ignored, not treated as a target */ }
    const reportId = fields.reportid?.slice(0, 128) || undefined;
    const context = fields.context?.slice(0, 2_000) || undefined;
    return { body: message, category, targetUrl, reportId, context };
}

function encodeCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
    if (!value) return null;
    if (typeof value !== 'string' || value.length > 512) {
        throw new AppError('The support pagination cursor is invalid.', { status: 400, code: 'SUPPORT_CURSOR_INVALID' });
    }
    try {
        const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || typeof decoded.id !== 'string' || !decoded.id || typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))) throw new Error('invalid cursor');
        return { at: new Date(decoded.at).toISOString(), id: decoded.id };
    } catch {
        throw new AppError('The support pagination cursor is invalid.', { status: 400, code: 'SUPPORT_CURSOR_INVALID' });
    }
}

function pageOptions({ limit, cursor, status, priority, assignedTo, assignee } = {}) {
    let safeLimit = 25;
    if (limit !== undefined) {
        if (typeof limit !== 'string' && typeof limit !== 'number') throw new AppError('The support page size is invalid.', { status: 400, code: 'SUPPORT_LIMIT_INVALID' });
        const value = String(limit);
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new AppError('The support page size must be between 1 and 100.', { status: 400, code: 'SUPPORT_LIMIT_INVALID' });
        safeLimit = Number(value);
    }
    if (status === 'waiting_customer') status = 'pending';
    if (status !== undefined && !SUPPORT_STATUSES.includes(status)) throw new AppError('The support status filter is invalid.', { status: 400, code: 'SUPPORT_STATUS_INVALID' });
    if (priority !== undefined && !SUPPORT_PRIORITIES.includes(priority)) throw new AppError('The support priority filter is invalid.', { status: 400, code: 'SUPPORT_PRIORITY_INVALID' });
    assignedTo = assignedTo ?? assignee;
    if (assignedTo !== undefined && (typeof assignedTo !== 'string' || assignedTo.length < 1 || assignedTo.length > 128)) throw new AppError('The support assignee filter is invalid.', { status: 400, code: 'SUPPORT_ASSIGNEE_INVALID' });
    return { limit: safeLimit, after: decodeCursor(cursor), status, priority, assignedTo };
}

function publicMessage(message) {
    return {
        id: message.id,
        ticketId: message.ticketId,
        authorType: message.authorType,
        authorRole: message.authorType === 'admin' ? 'support' : message.authorType,
        visibility: 'customer',
        body: message.body,
        createdAt: message.createdAt
    };
}

// Keep the durable database value short and migration-compatible while
// exposing the product's customer/operator vocabulary at the HTTP boundary.
// The portal calls this state `waiting_customer`; older API clients may still
// submit or filter `pending`, so pageOptions() accepts both forms.
function publicStatus(status) {
    return status === 'pending' ? 'waiting_customer' : status;
}

function messageView(message, actor = null) {
    return {
        id: message.id,
        ticketId: message.ticketId,
        authorId: message.authorId,
        authorName: actor?.name || null,
        authorEmail: actor?.email || null,
        authorType: message.authorType,
        authorRole: message.authorType === 'admin' ? 'support' : message.authorType,
        visibility: message.visibility === 'public' ? 'customer' : 'internal',
        body: message.body,
        createdAt: message.createdAt
    };
}

function ticketView(ticket, messages, { admin = false, actors = new Map() } = {}) {
    const requester = admin ? actors.get(ticket.createdBy) : null;
    const view = {
        id: ticket.id,
        workspaceId: ticket.workspaceId,
        reference: ticket.id.replace(/^ticket_/, '').slice(0, 8).toUpperCase(),
        category: ticket.category || 'general',
        subject: ticket.subject,
        status: publicStatus(ticket.status),
        priority: ticket.priority,
        assignedTo: ticket.assignedTo || null,
        assigneeId: ticket.assignedTo || null,
        createdBy: ticket.createdBy,
        requesterId: ticket.createdBy,
        targetUrl: ticket.targetUrl || undefined,
        reportId: ticket.reportId || undefined,
        context: ticket.context || undefined,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        lastMessageAt: ticket.lastMessageAt || null,
        lastActivityAt: ticket.lastMessageAt || ticket.updatedAt,
        closedAt: ticket.closedAt || null,
        reopenedAt: ticket.reopenedAt || null,
        notificationState: ticket.notificationState || { externalEmail: 'not_configured' },
        messages: messages.map(admin ? (message) => messageView(message, actors.get(message.authorId)) : publicMessage)
    };
    if (admin) {
        Object.assign(view, {
            requesterName: requester?.name || null,
            requesterEmail: requester?.email || null,
            requesterEmailVerified: requester?.emailVerified ?? null,
            requesterState: requester?.state || null
        });
    }
    return view;
}

function cursorFor(items) {
    const last = items.at(-1);
    return last ? encodeCursor({ at: last.updatedAt, id: last.id }) : null;
}

function normalizeOperationContext(value) {
    if (typeof value === 'string') {
        return { idempotencyKey: value.trim() || null, requestFingerprint: null };
    }
    if (!value || typeof value !== 'object') {
        return { idempotencyKey: null, requestFingerprint: null };
    }
    return {
        idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() || null : null,
        requestFingerprint: typeof value.requestFingerprint === 'string' ? value.requestFingerprint.trim() || null : null
    };
}

function mutationContext(requestIdOrOperation, operationContext) {
    if (requestIdOrOperation && typeof requestIdOrOperation === 'object') {
        return {
            requestId: typeof operationContext === 'string' ? operationContext : null,
            operation: normalizeOperationContext(requestIdOrOperation)
        };
    }
    return {
        requestId: typeof requestIdOrOperation === 'string' ? requestIdOrOperation : null,
        operation: normalizeOperationContext(operationContext)
    };
}

function operationInput(operation) {
    return {
        idempotencyKey: operation.idempotencyKey,
        requestFingerprint: operation.requestFingerprint
    };
}

function createSupportService({ store, logger = { warn() {} }, emailTransport = null, supportEmail = '' }) {
    async function supportActors(userIds) {
        const ids = [...new Set(userIds.filter(Boolean))];
        if (!ids.length) return new Map();
        const records = typeof store.getSupportActors === 'function'
            ? await store.getSupportActors(ids)
            : (await Promise.all(ids.map((userId) => store.getCommercialUser?.(userId)))).filter(Boolean);
        return new Map(records.map((record) => [record.id || record.userId, record]));
    }

    async function auditNotification(ticket, actorId, action, metadata = {}) {
        try {
            await store.logAudit({
                workspaceId: ticket?.workspaceId || null,
                actorId: actorId || null,
                action,
                entityType: 'support_ticket',
                entityId: ticket?.id || null,
                metadata
            });
        } catch (error) {
            // The support mutation is already bounded and durable; do not claim
            // an external notification was sent when audit persistence is down.
            logger.warn('Support audit persistence failed', { action, ticketId: ticket?.id, error: error?.message });
        }
    }

    async function notify(ticket, actorId, to, event) {
        if (!emailTransport?.configured || !to) return { status: 'not_configured' };
        try {
            const result = await emailTransport.send({
                kind: 'support',
                to,
                data: { ticketId: ticket.id },
                idempotencyKey: `${event}:${ticket.id}:${ticket.lastMessageAt || ticket.updatedAt || ticket.createdAt}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 256)
            });
            await auditNotification(ticket, actorId, 'support_ticket.notification_sent', { event, provider: result?.provider || emailTransport.provider || 'email' });
            return { status: 'accepted', provider: result?.provider || emailTransport.provider || 'email' };
        } catch (error) {
            logger.warn('Support email notification failed', { ticketId: ticket.id, event, errorCode: error?.code || 'EMAIL_PROVIDER_UNAVAILABLE' });
            await auditNotification(ticket, actorId, 'support_ticket.notification_failed', { event, errorCode: error?.code || 'EMAIL_PROVIDER_UNAVAILABLE' });
            return { status: 'failed', errorCode: error?.code || 'EMAIL_PROVIDER_UNAVAILABLE' };
        }
    }

    async function customerTicket(workspaceId, ticketId) {
        const ticket = await store.getSupportTicket(workspaceId, ticketId);
        if (!ticket) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        const messages = await store.listSupportMessages(workspaceId, ticketId, { includeInternal: false });
        return ticketView(ticket, messages);
    }

    async function adminTicket(ticketId) {
        const ticket = await store.getSupportTicket(null, ticketId, { allowAnyWorkspace: true });
        if (!ticket) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        const messages = await store.listSupportMessages(ticket.workspaceId, ticketId, { includeInternal: true });
        const actors = await supportActors([ticket.createdBy, ...messages.map((message) => message.authorId)]);
        return ticketView(ticket, messages, { admin: true, actors });
    }

    async function createTicket(workspaceId, actorId, input, idempotencyOrOperation = null, requestId = null) {
        const operation = normalizeOperationContext(idempotencyOrOperation);
        const structured = parseStructuredMessage(input.body);
        const category = structured.category || input.category || 'general';
        const result = await store.createSupportTicket(workspaceId, {
            category,
            subject: input.subject,
            priority: input.priority || 'normal',
            createdBy: actorId,
            context: input.context || structured.context || null,
            targetUrl: input.targetUrl || structured.targetUrl || null,
            reportId: input.reportId || structured.reportId || null,
            ...operationInput(operation),
            notificationState: { externalEmail: 'not_configured' },
            initialMessage: { authorId: actorId, authorType: 'customer', visibility: 'public', body: structured.body },
            audit: { actorId, action: 'support_ticket.created', reason: 'customer_request', requestId, metadata: { priority: input.priority || 'normal' } }
        });
        const ticket = result.ticket || result;
        const created = result.created !== false && result.idempotent !== true;
        if (created) {
            await notify(ticket, actorId, supportEmail, 'support_created');
        }
        return { ticket: await customerTicket(workspaceId, ticket.id), created };
    }

    async function listTickets(workspaceId, query) {
        const options = pageOptions(query);
        const page = await store.listSupportTickets(workspaceId, options);
        const tickets = await Promise.all(page.tickets.map(async (ticket) => ticketView(ticket, await store.listSupportMessages(workspaceId, ticket.id, { includeInternal: false }))));
        return { tickets, limit: options.limit, nextCursor: page.hasMore ? cursorFor(page.tickets) : null };
    }

    async function replyCustomer(workspaceId, actorId, ticketId, body, requestIdOrOperation = null, operationContext = null) {
        const { requestId, operation } = mutationContext(requestIdOrOperation, operationContext);
        const ticket = await store.getSupportTicket(workspaceId, ticketId);
        if (!ticket) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        if (ticket.status === 'closed') throw new AppError('Reopen the support ticket before replying.', { status: 409, code: 'SUPPORT_TICKET_CLOSED' });
        // Keep nextStatus for older stores; transitionIntent is authoritative
        // for stores that recompute the state while holding the ticket lock.
        const nextStatus = ['resolved', 'pending'].includes(ticket.status) ? 'in_progress' : ticket.status;
        const result = await store.appendSupportMessage(workspaceId, ticketId, {
            authorId: actorId,
            authorType: 'customer',
            visibility: 'public',
            body,
            nextStatus,
            transitionIntent: 'customer_reply',
            ...operationInput(operation),
            audit: { actorId, action: 'support_ticket.customer_replied', reason: 'customer_reply', requestId }
        });
        if (!result) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        if (result.idempotent !== true) await notify(result.ticket, actorId, supportEmail, 'customer_reply');
        return customerTicket(workspaceId, ticketId);
    }

    async function transitionCustomer(workspaceId, actorId, ticketId, status, requestId = null) {
        if (status === 'closed') return closeCustomer(workspaceId, actorId, ticketId, requestId);
        if (status === 'open') return reopenCustomer(workspaceId, actorId, ticketId, requestId);
        throw new AppError('Customers may only open or close their support ticket.', { status: 403, code: 'SUPPORT_TRANSITION_FORBIDDEN' });
    }

    async function closeCustomer(workspaceId, actorId, ticketId, requestId = null) {
        const ticket = await store.getSupportTicket(workspaceId, ticketId);
        if (!ticket) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        await store.updateSupportTicket(workspaceId, ticketId, { status: 'closed', closedAt: ticket.closedAt || new Date().toISOString(), audit: { actorId, action: 'support_ticket.customer_closed', reason: 'customer_close', requestId } });
        return customerTicket(workspaceId, ticketId);
    }

    async function reopenCustomer(workspaceId, actorId, ticketId, requestId = null) {
        const ticket = await store.getSupportTicket(workspaceId, ticketId);
        if (!ticket) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        await store.updateSupportTicket(workspaceId, ticketId, { status: 'open', reopenedAt: new Date().toISOString(), closedAt: null, audit: { actorId, action: 'support_ticket.customer_reopened', reason: 'customer_reopen', requestId } });
        return customerTicket(workspaceId, ticketId);
    }

    async function listAdminTickets(query) {
        const options = pageOptions(query);
        const page = await store.listSupportTickets(null, { ...options, allowAnyWorkspace: true });
        const records = await Promise.all(page.tickets.map(async (ticket) => ({
            ticket,
            messages: await store.listSupportMessages(ticket.workspaceId, ticket.id, { includeInternal: true })
        })));
        const actors = await supportActors(records.flatMap(({ ticket, messages }) => [ticket.createdBy, ...messages.map((message) => message.authorId)]));
        const tickets = records.map(({ ticket, messages }) => ticketView(ticket, messages, { admin: true, actors }));
        return { tickets, limit: options.limit, nextCursor: page.hasMore ? cursorFor(page.tickets) : null };
    }

    async function updateAdminTicket(ticketId, actorId, input, requestId = null) {
        const current = await store.getSupportTicket(null, ticketId, { allowAnyWorkspace: true });
        if (!current) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        const patch = {};
        if (input.status !== undefined) {
            if (input.status === 'closed') patch.closedAt = current.closedAt || new Date().toISOString();
            if (input.status !== 'closed' && current.status === 'closed') patch.reopenedAt = new Date().toISOString();
            if (input.status !== 'closed') patch.closedAt = null;
            patch.status = input.status;
        }
        if (input.priority !== undefined) patch.priority = input.priority;
        if (Object.hasOwn(input, 'assignedTo')) patch.assignedTo = input.assignedTo;
        patch.audit = { actorId, action: 'support_ticket.admin_updated', reason: 'admin_support_update', requestId, metadata: { status: input.status, priority: input.priority, assignedTo: input.assignedTo } };
        await store.updateSupportTicket(current.workspaceId, ticketId, patch);
        return adminTicket(ticketId);
    }

    async function adminNote(ticketId, actorId, body, requestIdOrOperation = null, operationContext = null) {
        const { requestId, operation } = mutationContext(requestIdOrOperation, operationContext);
        const current = await store.getSupportTicket(null, ticketId, { allowAnyWorkspace: true });
        if (!current) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        const result = await store.appendSupportMessage(current.workspaceId, ticketId, {
            authorId: actorId,
            authorType: 'admin',
            visibility: 'internal',
            body,
            nextStatus: current.status,
            transitionIntent: 'internal_note',
            ...operationInput(operation),
            audit: { actorId, action: 'support_ticket.internal_note_added', reason: 'admin_internal_note', requestId }
        });
        if (!result) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        return adminTicket(ticketId);
    }

    async function adminReply(ticketId, actorId, body, requestIdOrOperation = null, operationContext = null) {
        const { requestId, operation } = mutationContext(requestIdOrOperation, operationContext);
        const current = await store.getSupportTicket(null, ticketId, { allowAnyWorkspace: true });
        if (!current) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        if (current.status === 'closed') throw new AppError('Reopen the support ticket before replying.', { status: 409, code: 'SUPPORT_TICKET_CLOSED' });
        const result = await store.appendSupportMessage(current.workspaceId, ticketId, {
            authorId: actorId,
            authorType: 'admin',
            visibility: 'public',
            body,
            nextStatus: 'pending',
            transitionIntent: 'admin_reply',
            ...operationInput(operation),
            audit: { actorId, action: 'support_ticket.admin_replied', reason: 'admin_customer_reply', requestId }
        });
        if (!result) throw new AppError('Support ticket not found.', { status: 404, code: 'SUPPORT_TICKET_NOT_FOUND' });
        if (result.idempotent !== true) {
            const requester = typeof store.getUserState === 'function' ? await store.getUserState(current.createdBy) : null;
            await notify(result.ticket, actorId, requester?.email, 'admin_reply');
        }
        return adminTicket(ticketId);
    }

    async function adminMessage(ticketId, actorId, body, visibility = 'customer', requestIdOrOperation = null, operationContext = null) {
        return visibility === 'internal'
            ? adminNote(ticketId, actorId, body, requestIdOrOperation, operationContext)
            : adminReply(ticketId, actorId, body, requestIdOrOperation, operationContext);
    }

    return { createTicket, listTickets, customerTicket, replyCustomer, closeCustomer, reopenCustomer, transitionCustomer, listAdminTickets, adminTicket, updateAdminTicket, adminNote, adminReply, adminMessage };
}

module.exports = { SUPPORT_CATEGORIES, SUPPORT_CONTEXT_MARKER, SUPPORT_STATUSES, SUPPORT_PRIORITIES, createSupportService, decodeCursor, encodeCursor, mutationContext, normalizeOperationContext, operationInput, pageOptions, parseStructuredMessage, publicStatus, ticketView };
