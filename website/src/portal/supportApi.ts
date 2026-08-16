import { apiFetch, jsonRequest } from './api';

/**
 * Support keeps its transport contract in one place so the customer and
 * operator surfaces cannot silently drift apart. The server remains the
 * source of truth for ownership, permissions, state transitions and priority.
 */
export type SupportStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed' | string;
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent' | string;
export type SupportVisibility = 'customer' | 'internal';

export type SupportMessage = {
  id: string;
  authorId?: string;
  body: string;
  visibility?: SupportVisibility | 'public';
  authorName?: string;
  authorEmail?: string;
  authorRole?: string;
  authorType?: string;
  createdAt: string;
};

export type SupportTicket = {
  id: string;
  reference?: string;
  category?: string;
  subject: string;
  message?: string;
  status: SupportStatus;
  priority: SupportPriority;
  createdAt: string;
  updatedAt?: string;
  lastActivityAt?: string;
  lastMessageAt?: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterId?: string;
  requesterEmailVerified?: boolean | null;
  requesterState?: string | null;
  assigneeName?: string;
  assigneeId?: string;
  assignedTo?: string | null;
  createdBy?: string;
  targetUrl?: string;
  reportId?: string;
  context?: string;
  workspaceId?: string;
  messages?: SupportMessage[];
};

export type SupportListQuery = {
  status?: string;
  priority?: string;
  assignee?: string;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type CreateSupportTicketInput = {
  category: string;
  subject: string;
  message: string;
  targetUrl?: string;
  reportId?: string;
  context?: string;
  priority?: SupportPriority;
};

export type SupportTransition = {
  status?: SupportStatus;
  priority?: SupportPriority;
  assigneeId?: string | null;
  assignedTo?: string | null;
};

export type SupportMessageInput = {
  body: string;
  visibility?: SupportVisibility;
};

const customerRoot = '/api/v1/support/tickets';
const adminRoot = '/api/v1/admin/support/tickets';
const supportOperationKeys = new Map<string, string>();
const supportOperationStoragePrefix = 'wpa-support-operation:';

export type SupportOperation = {
  intent: string;
  key: string;
};

function supportStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function supportFingerprint(payload: unknown) {
  const serialized = JSON.stringify(payload) || '';
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function supportOperationKey(scope: string, payload: unknown): SupportOperation {
  const intent = `${scope}:${supportFingerprint(payload)}`;
  const storageKey = `${supportOperationStoragePrefix}${intent}`;
  const storage = supportStorage();
  const existing = supportOperationKeys.get(intent) || storage?.getItem(storageKey);
  if (existing) {
    supportOperationKeys.set(intent, existing);
    return { intent, key: existing };
  }
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const key = `support:${random}`;
  supportOperationKeys.set(intent, key);
  try {
    storage?.setItem(storageKey, key);
  } catch {
    // The in-memory map still keeps retries in the current page stable when
    // browser storage is unavailable or full.
  }
  return { intent, key };
}

export function completeSupportOperation(operation: SupportOperation) {
  if (supportOperationKeys.get(operation.intent) === operation.key) supportOperationKeys.delete(operation.intent);
  const storage = supportStorage();
  const storageKey = `${supportOperationStoragePrefix}${operation.intent}`;
  try {
    if (storage?.getItem(storageKey) === operation.key) storage.removeItem(storageKey);
  } catch {
    // A successful request has already completed; storage cleanup is best effort.
  }
}

function unwrap<T>(payload: unknown, keys: string[]): T {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (key in record) return record[key] as T;
    }
  }
  return payload as T;
}

function toQuery(query: SupportListQuery) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([rawKey, value]) => {
    if (!value) return;
    const key = rawKey === 'assignee' ? 'assignedTo' : rawKey;
    params.set(key, String(value));
  });
  const search = params.toString();
  return search ? `?${search}` : '';
}

export async function listSupportTickets(query: SupportListQuery = {}, admin = false) {
  const payload = await apiFetch<unknown>(`${admin ? adminRoot : customerRoot}${toQuery(query)}`);
  const tickets = unwrap<SupportTicket[]>(payload, ['tickets', 'items', 'data']);
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    tickets: Array.isArray(tickets) ? tickets : [],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
  };
}

export async function getSupportTicket(ticketId: string, admin = false) {
  const payload = await apiFetch<unknown>(`${admin ? adminRoot : customerRoot}/${encodeURIComponent(ticketId)}`);
  return unwrap<SupportTicket>(payload, ['ticket', 'data']);
}

export async function createSupportTicket(input: CreateSupportTicketInput) {
  // The support service now persists these fields separately so operators can
  // filter and inspect context without parsing customer-authored prose.
  const body = {
    category: input.category,
    subject: input.subject,
    body: input.message,
    ...(input.context ? { context: input.context } : {}),
    ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
    ...(input.reportId ? { reportId: input.reportId } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
  };
  const operation = supportOperationKey('ticket-create', body);
  const init = jsonRequest('POST', body);
  init.headers = { ...init.headers, 'Idempotency-Key': operation.key };
  const payload = await apiFetch<unknown>(customerRoot, init);
  const ticket = unwrap<SupportTicket>(payload, ['ticket', 'data']);
  completeSupportOperation(operation);
  return ticket;
}

export async function sendSupportMessage(ticketId: string, input: SupportMessageInput, admin = false) {
  const root = admin ? adminRoot : customerRoot;
  const body = {
    body: input.body,
    ...(input.visibility ? { visibility: input.visibility } : {}),
  };
  const operation = supportOperationKey(`message:${admin ? 'admin' : 'customer'}:${ticketId}`, body);
  const init = jsonRequest('POST', body);
  init.headers = { ...init.headers, 'Idempotency-Key': operation.key };
  const payload = await apiFetch<unknown>(`${root}/${encodeURIComponent(ticketId)}/messages`, init);
  const message = unwrap<SupportMessage | SupportTicket>(payload, ['message', 'ticket', 'data']);
  completeSupportOperation(operation);
  return message;
}

export async function transitionSupportTicket(ticketId: string, input: SupportTransition, admin = false) {
  const root = admin ? adminRoot : customerRoot;
  if (!admin && input.status === 'closed') {
    const payload = await apiFetch<unknown>(`${root}/${encodeURIComponent(ticketId)}/close`, jsonRequest('POST'));
    return unwrap<SupportTicket>(payload, ['ticket', 'data']);
  }
  if (!admin && input.status === 'open') {
    const payload = await apiFetch<unknown>(`${root}/${encodeURIComponent(ticketId)}/reopen`, jsonRequest('POST'));
    return unwrap<SupportTicket>(payload, ['ticket', 'data']);
  }
  if (!admin) throw new Error('This customer case state is controlled by the support team.');
  const payload = await apiFetch<unknown>(`${root}/${encodeURIComponent(ticketId)}`, jsonRequest('PATCH', {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(Object.hasOwn(input, 'assignedTo') || Object.hasOwn(input, 'assigneeId') ? { assignedTo: input.assignedTo ?? input.assigneeId ?? null } : {}),
  }));
  return unwrap<SupportTicket>(payload, ['ticket', 'data']);
}
