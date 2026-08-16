import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, Check,
  LifeBuoy, LoaderCircle, MessageSquare, Plus, RotateCcw, Send, X,
} from 'lucide-react';
import PortalShell from './PortalShell';
import { ApiError, apiFetch } from './api';
import { navigate } from './router';
import { workspaceNav } from './workspaceNav';
import {
  createSupportTicket, getSupportTicket, listSupportTickets, sendSupportMessage,
  transitionSupportTicket, type CreateSupportTicketInput,
  type SupportStatus, type SupportTicket,
} from './supportApi';
import '../auxiliary.css';

const categories = [
  ['analysis', 'Analysis or report'],
  ['account', 'Account access'],
  ['billing', 'Billing'],
  ['security', 'Security'],
  ['general', 'Something else'],
] as const;

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_customer: 'Awaiting reply',
  pending: 'Awaiting reply',
  resolved: 'Resolved',
  closed: 'Closed',
};

const priorityLabels: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const dateTime = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

function statusLabel(status?: string) {
  return statusLabels[status || ''] || (status || 'Unknown').replaceAll('_', ' ');
}

function initials(name?: string) {
  return (name || 'WPA').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.status === 401) {
    navigate('/login', true);
    return '';
  }
  return error instanceof Error ? error.message : fallback;
}

type FormState = {
  category: string;
  subject: string;
  message: string;
  targetUrl: string;
  reportId: string;
  context: string;
};

const emptyForm: FormState = { category: 'analysis', subject: '', message: '', targetUrl: '', reportId: '', context: '' };

type SupportAccountContext = {
  identity: { name?: string; email?: string; role?: string } | null;
  usage: {
    planName: string;
    pageCredits: { limit: number; used: number; remaining: number };
    aiRemediations: { limit: number; used: number; remaining: number };
    projects: { limit: number; used: number; remaining: number };
    sourceAudits: { limit: number; used: number; remaining: number };
  } | null;
};
type SupportUsageAllowances = Omit<NonNullable<SupportAccountContext['usage']>, 'planName'>;

function SupportStatus({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return <span className={`aux-state aux-state--${normalized}`}><i aria-hidden="true" />{statusLabel(normalized)}</span>;
}

function TicketList({
  tickets,
  selectedId,
  onSelect,
  loading,
  onNew,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  tickets: SupportTicket[];
  selectedId: string;
  onSelect: (id: string) => void;
  loading: boolean;
  onNew: () => void;
  nextCursor?: string;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return <aside className="aux-support-list" aria-label="Your support tickets">
    <div className="aux-support-list__head">
      <div><span>CASE REGISTER</span><strong>{tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}</strong></div>
      <button type="button" className="aux-icon-button" onClick={onNew} aria-label="Create a new support ticket" title="New ticket"><Plus /></button>
    </div>
    {loading && <div className="aux-list-state"><LoaderCircle className="aux-spin" aria-hidden="true" /><span>Loading your history…</span></div>}
    {!loading && tickets.length === 0 && <div className="aux-list-state"><LifeBuoy aria-hidden="true" /><span>No cases yet.<br /><b>Open the first one when you need a hand.</b></span></div>}
    {!loading && tickets.length > 0 && <div className="aux-ticket-items">{tickets.map((ticket) => <button type="button" key={ticket.id} className={`aux-ticket-item${ticket.id === selectedId ? ' is-active' : ''}`} onClick={() => onSelect(ticket.id)} aria-current={ticket.id === selectedId ? 'true' : undefined}>
      <span className="aux-ticket-item__index">{ticket.reference || ticket.id.slice(0, 8).toUpperCase()}</span>
      <span className="aux-ticket-item__body"><strong>{ticket.subject}</strong><small>{(ticket.category || 'support').replaceAll('_', ' ')} · {dateTime(ticket.lastActivityAt || ticket.lastMessageAt || ticket.updatedAt || ticket.createdAt)}</small></span>
      <SupportStatus status={ticket.status} />
    </button>)}{nextCursor && <button type="button" className="aux-load-more" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="aux-spin" /> Loading more…</> : <>Load more cases <ArrowRight /></>}</button>}</div>}
  </aside>;
}

function TicketThread({
  ticket,
  onBack,
  onRefresh,
  onTransition,
}: {
  ticket: SupportTicket;
  onBack: () => void;
  onRefresh: () => void;
  onTransition: (status: SupportStatus) => Promise<void>;
}) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const messages = ticket.messages || [];

  async function submitReply(event: FormEvent) {
    event.preventDefault();
    const body = reply.trim();
    if (body.length < 2) { setError('Add a little more detail before sending.'); return; }
    setBusy(true);
    setError('');
    try {
      await sendSupportMessage(ticket.id, { body, visibility: 'customer' });
      setReply('');
      onRefresh();
    } catch (requestError) {
      setError(errorMessage(requestError, 'Your reply could not be sent. Nothing was changed.'));
    } finally { setBusy(false); }
  }

  async function transition(status: SupportStatus) {
    setBusy(true);
    setError('');
    try { await onTransition(status); }
    catch (requestError) { setError(errorMessage(requestError, 'That case state could not be changed.')); }
    finally { setBusy(false); }
  }

  return <section className="aux-thread" aria-labelledby="support-ticket-title">
    <header className="aux-thread__head">
      <button type="button" className="aux-back-link" onClick={onBack}><ArrowLeft /> All tickets</button>
      <div className="aux-thread__meta"><span>{ticket.reference || `CASE ${ticket.id.slice(0, 8).toUpperCase()}`}</span><SupportStatus status={ticket.status} /><em className={`aux-priority aux-priority--${ticket.priority}`}>{priorityLabels[ticket.priority] || ticket.priority}</em></div>
      <h2 id="support-ticket-title">{ticket.subject}</h2>
      <p>{(ticket.category || 'support').replaceAll('_', ' ')} · Opened {dateTime(ticket.createdAt)}{ticket.targetUrl ? ` · ${ticket.targetUrl}` : ''}</p>
      {ticket.context && <div className="aux-thread__context"><span>Relevant context</span><p>{ticket.context}</p></div>}
    </header>

    <div className="aux-thread__timeline" aria-live="polite">
      {messages.length === 0 && <div className="aux-thread__empty"><MessageSquare aria-hidden="true" /><p>This case is open. Add context below and the support team will have the full trail.</p></div>}
      {messages.map((message) => <article className={`aux-message${message.authorRole === 'support' || message.authorRole === 'admin' || message.authorType === 'admin' ? ' is-support' : ''}`} key={message.id}>
        <div className="aux-message__avatar" aria-hidden="true">{initials(message.authorName || message.authorEmail)}</div>
        <div className="aux-message__body"><header><strong>{message.authorName || (message.authorRole === 'support' || message.authorRole === 'admin' || message.authorType === 'admin' ? 'WPA Support' : 'You')}</strong><time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></header><p>{message.body}</p></div>
      </article>)}
    </div>

    {error && <div className="aux-alert" role="alert"><AlertCircle />{error}</div>}
    {ticket.status !== 'closed' && <form className="aux-reply" onSubmit={submitReply} aria-busy={busy}>
      <label htmlFor="support-reply">Reply to this case</label>
      <textarea id="support-reply" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Share a result, URL, or the next detail we should inspect…" rows={4} maxLength={5000} disabled={busy} />
      <footer><small>{reply.length}/5000 · Replies remain attached to this case.</small><button type="submit" className="aux-dark-button" disabled={busy || reply.trim().length < 2}>{busy ? <><LoaderCircle className="aux-spin" /> Sending…</> : <><Send /> Send reply</>}</button></footer>
    </form>}
    <footer className="aux-thread__actions">
      {ticket.status === 'closed' || ticket.status === 'resolved' ? <button type="button" onClick={() => void transition('open')} disabled={busy}><RotateCcw /> Reopen case</button> : <button type="button" onClick={() => void transition('closed')} disabled={busy}><Check /> Close case</button>}
      <button type="button" onClick={onRefresh} disabled={busy}><RotateCcw /> Refresh thread</button>
    </footer>
  </section>;
}

function NewTicket({ onCancel, onCreated, enterpriseSales = false }: { onCancel: () => void; onCreated: (ticket: SupportTicket) => void; enterpriseSales?: boolean }) {
  const [form, setForm] = useState<FormState>(() => enterpriseSales ? {
    ...emptyForm,
    category: 'billing',
    subject: 'Enterprise plan request',
    message: 'I would like to discuss Enterprise access for this workspace.',
  } : emptyForm);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input: CreateSupportTicketInput = {
      category: form.category,
      subject: form.subject.trim(),
      message: form.message.trim(),
      ...(form.targetUrl.trim() ? { targetUrl: form.targetUrl.trim() } : {}),
      ...(form.reportId.trim() ? { reportId: form.reportId.trim() } : {}),
      ...(form.context.trim() ? { context: form.context.trim() } : {}),
    };
    if (input.subject.length < 4) { setError('Use at least four characters for the subject.'); return; }
    if (input.message.length < 12) { setError('Add at least a sentence so the team can start from evidence.'); return; }
    setBusy(true);
    setError('');
    try { onCreated(await createSupportTicket(input)); }
    catch (requestError) { setError(errorMessage(requestError, 'The case could not be created. Nothing was submitted.')); }
    finally { setBusy(false); }
  }

  return <section className="aux-new-ticket" aria-labelledby="new-ticket-title">
    <header><button type="button" className="aux-back-link" onClick={onCancel}><ArrowLeft /> Ticket history</button><span>NEW CASE / 01</span><h2 id="new-ticket-title">Put the signal on paper.</h2><p>Give the support team a clear trail. Your case will be stored in the workspace and can be reopened at any time.</p></header>
    <form onSubmit={submit} aria-busy={busy}>
      {error && <div className="aux-alert" role="alert"><AlertCircle />{error}</div>}
      <div className="aux-form-grid">
        <label><span>Category</span><select value={form.category} onChange={(event) => set('category', event.target.value)} disabled={busy}>{categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="aux-form-grid__wide"><span>Subject</span><input value={form.subject} onChange={(event) => set('subject', event.target.value)} placeholder="What should we inspect?" maxLength={160} disabled={busy} required /></label>
        <label className="aux-form-grid__wide"><span>Message</span><textarea value={form.message} onChange={(event) => set('message', event.target.value)} placeholder="Include what you expected, what happened, and where it happened." rows={7} maxLength={5000} disabled={busy} required /><small>{form.message.length}/5000</small></label>
        <div className="aux-form-grid__wide aux-context-heading"><span>Relevant context <i>optional</i></span><small>These fields help us locate the right evidence. Do not include passwords, tokens, or secrets.</small></div>
        <label><span>Target URL</span><input type="url" value={form.targetUrl} onChange={(event) => set('targetUrl', event.target.value)} placeholder="https://…" disabled={busy} /></label>
        <label><span>Report ID</span><input value={form.reportId} onChange={(event) => set('reportId', event.target.value)} placeholder="Optional report reference" disabled={busy} /></label>
        <label className="aux-form-grid__wide"><span>What should we know?</span><textarea value={form.context} onChange={(event) => set('context', event.target.value)} placeholder="Browser, scan stage, or other non-sensitive context" rows={3} maxLength={1000} disabled={busy} /></label>
      </div>
      <footer><button type="button" className="aux-light-button" onClick={onCancel} disabled={busy}><X /> Cancel</button><button type="submit" className="aux-dark-button" disabled={busy}>{busy ? <><LoaderCircle className="aux-spin" /> Sending…</> : <><Send /> Create case</>}</button></footer>
    </form>
  </section>;
}

export default function SupportCenter() {
  const enterpriseSales = new URLSearchParams(window.location.search).get('new') === 'enterprise-sales';
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('ticket') || '');
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [newTicket, setNewTicket] = useState(enterpriseSales);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<SupportAccountContext>({ identity: null, usage: null });

  const selectedFromList = useMemo(() => tickets.find((ticket) => ticket.id === selectedId) || null, [selectedId, tickets]);

  async function loadTickets(preferredId = selectedId) {
    setLoading(true);
    setError('');
    try {
      const result = await listSupportTickets();
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
      const nextId = preferredId && result.tickets.some((ticket) => ticket.id === preferredId) ? preferredId : result.tickets[0]?.id || '';
      setSelectedId(nextId);
      if (nextId) await loadDetail(nextId, false);
      else setSelected(null);
    } catch (requestError) { setError(errorMessage(requestError, 'Support history is unavailable right now. Your account is unchanged.')); }
    finally { setLoading(false); }
  }

  async function loadMoreTickets() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const result = await listSupportTickets({ cursor: nextCursor });
      setTickets((current) => {
        const existing = new Set(current.map((ticket) => ticket.id));
        return [...current, ...result.tickets.filter((ticket) => !existing.has(ticket.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (requestError) { setError(errorMessage(requestError, 'More support history could not be loaded. The current list is unchanged.')); }
    finally { setLoadingMore(false); }
  }

  async function loadDetail(ticketId: string, showLoading = true) {
    if (showLoading) setDetailLoading(true);
    try { setSelected(await getSupportTicket(ticketId)); }
    catch (requestError) { setError(errorMessage(requestError, 'This case could not be opened. Try refreshing the history.')); }
    finally { if (showLoading) setDetailLoading(false); }
  }

  function selectTicket(ticketId: string, push = true) {
    setSelectedId(ticketId);
    setNewTicket(false);
    if (push) window.history.pushState({}, '', `/app/support?ticket=${encodeURIComponent(ticketId)}`);
    void loadDetail(ticketId);
  }

  useEffect(() => {
    void loadTickets();
    const onPopState = () => {
      const ticketId = new URLSearchParams(window.location.search).get('ticket') || '';
      setSelectedId(ticketId);
      setNewTicket(false);
      if (ticketId) void loadDetail(ticketId);
      else setSelected(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // The first load intentionally owns the initial URL selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      apiFetch<{
        plan?: { name?: string };
        allowances?: SupportUsageAllowances;
      }>('/api/v1/dashboard'),
      apiFetch<{ user?: { name?: string; email?: string } }>('/api/auth/get-session'),
    ]).then(([dashboardResult, sessionResult]) => {
      if (cancelled) return;
      const dashboard = dashboardResult.status === 'fulfilled' ? dashboardResult.value : null;
      const user = sessionResult.status === 'fulfilled' ? sessionResult.value?.user : null;
      setAccount({
        identity: user ? { name: user.name, email: user.email, role: 'Workspace member' } : null,
        usage: dashboard?.allowances && dashboard.plan?.name ? {
          planName: dashboard.plan.name,
          pageCredits: dashboard.allowances.pageCredits,
          aiRemediations: dashboard.allowances.aiRemediations,
          projects: dashboard.allowances.projects,
          sourceAudits: dashboard.allowances.sourceAudits,
        } : null,
      });
    });
    return () => { cancelled = true; };
  }, []);

  async function transition(status: SupportStatus) {
    if (!selected) return;
    const next = await transitionSupportTicket(selected.id, { status });
    setSelected(next);
    setTickets((current) => current.map((ticket) => ticket.id === next.id ? { ...ticket, ...next } : ticket));
  }

  function created(ticket: SupportTicket) {
    setNewTicket(false);
    setSelected(ticket);
    setSelectedId(ticket.id);
    window.history.pushState({}, '', `/app/support?ticket=${encodeURIComponent(ticket.id)}`);
    setTickets((current) => [ticket, ...current.filter((item) => item.id !== ticket.id)]);
  }

  const activeTicket = selected || selectedFromList;

  return <PortalShell active="support" nav={workspaceNav} onNavigate={(destination) => {
    if (destination === 'support') return;
    navigate(destination === 'overview' ? '/app' : `/app/${destination}`);
  }} identity={account.identity} profileUsage={account.usage}>
    <main className="aux-support-page" id="support-main">
      <header className="aux-page-heading">
        <div><span>WORKSPACE / SUPPORT DESK</span><h1>Support, with a paper trail.</h1><p>Ask a precise question, keep the evidence close, and see every reply in one durable thread.</p></div>
        <button type="button" className="aux-dark-button" onClick={() => setNewTicket(true)}><Plus /> New case</button>
      </header>
      {error && <div className="aux-alert aux-alert--page" role="alert"><AlertCircle />{error}<button type="button" onClick={() => void loadTickets()}><RotateCcw /> Retry</button></div>}
      {newTicket ? <NewTicket enterpriseSales={enterpriseSales} onCancel={() => setNewTicket(false)} onCreated={created} /> : <div className="aux-support-layout">
        <TicketList tickets={tickets} selectedId={selectedId} onSelect={selectTicket} loading={loading} onNew={() => setNewTicket(true)} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={() => void loadMoreTickets()} />
        {detailLoading && <section className="aux-thread aux-loading-panel"><LoaderCircle className="aux-spin" /><span>Opening case…</span></section>}
        {!detailLoading && activeTicket && <TicketThread ticket={activeTicket} onBack={() => { setSelectedId(''); setSelected(null); window.history.pushState({}, '', '/app/support'); }} onRefresh={() => void loadDetail(activeTicket.id)} onTransition={transition} />}
        {!detailLoading && !activeTicket && !loading && <section className="aux-thread aux-thread--empty"><LifeBuoy aria-hidden="true" /><span>Select a case or open a new one.</span><button type="button" className="aux-dark-button" onClick={() => setNewTicket(true)}><Plus /> New case</button></section>}
      </div>}
    </main>
  </PortalShell>;
}
