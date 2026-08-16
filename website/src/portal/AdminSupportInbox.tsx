import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle, ArrowLeft, Check, Clock3, Filter, LoaderCircle,
  MessageSquare, RefreshCw, Search, Send, ShieldAlert, UserRound,
} from 'lucide-react';
import { ApiError } from './api';
import { navigate } from './router';
import {
  getSupportTicket, listSupportTickets, sendSupportMessage, transitionSupportTicket,
  type SupportMessage, type SupportPriority, type SupportStatus, type SupportTicket,
} from './supportApi';
import '../auxiliary.css';

const statuses = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];
const priorities = ['low', 'normal', 'high', 'urgent'];

const dateTime = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const statusLabel = (status?: string) => ({ open: 'Open', in_progress: 'In progress', waiting_customer: 'Awaiting customer', pending: 'Awaiting reply', resolved: 'Resolved', closed: 'Closed' }[status || ''] || (status || 'Unknown').replaceAll('_', ' '));

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.status === 401) {
    navigate('/login', true);
    return '';
  }
  if (error instanceof ApiError && error.status === 403) return 'This administrator session is not authorized for support operations.';
  return error instanceof Error ? error.message : fallback;
}

function AdminState({ value, kind = 'status' }: { value?: string; kind?: 'status' | 'priority' }) {
  const normalized = (value || 'unknown').toLowerCase();
  const label = kind === 'priority'
    ? ({ low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }[normalized] || normalized)
    : statusLabel(normalized);
  return <span className={`aux-state aux-state--${normalized}`}><i aria-hidden="true" />{label}</span>;
}

function initials(name?: string) {
  return (name || 'WPA').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function requesterName(ticket: SupportTicket) {
  return ticket.requesterName || ticket.requesterEmail || ticket.requesterId || ticket.createdBy || 'Unknown requester';
}

function requesterLine(ticket: SupportTicket) {
  return [ticket.requesterName, ticket.requesterEmail, ticket.requesterId || ticket.createdBy].filter(Boolean).join(' · ') || 'Registered profile unavailable';
}

type Props = { role?: string; permissions?: string[] };

export default function AdminSupportInbox({ role, permissions = [] }: Props) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('ticket') || '');
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [composer, setComposer] = useState('');
  const [visibility, setVisibility] = useState<'customer' | 'internal'>('customer');
  const [draftStatus, setDraftStatus] = useState('');
  const [draftPriority, setDraftPriority] = useState('');
  const [draftAssignee, setDraftAssignee] = useState('');
  const canManage = permissions.includes('support.manage');
  const canReply = permissions.includes('support.reply');
  const canInternalNote = permissions.includes('support.internal_note');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (!needle) return true;
      return [ticket.subject, ticket.reference, ticket.requesterName, ticket.requesterEmail, ticket.id].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [query, tickets]);

  useEffect(() => {
    const selectedTicketId = selectedId || selected?.id || '';
    if (!query.trim() || !selectedTicketId) return;
    if (filtered.some((ticket) => ticket.id === selectedTicketId)) return;
    setSelectedId('');
    setSelected(null);
  }, [filtered, query, selected, selectedId]);

  async function loadQueue(preferredId = selectedId, options: { append?: boolean; cursor?: string } = {}) {
    const append = options.append === true;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const result = await listSupportTickets({ status: status || undefined, priority: priority || undefined, assignee: assignee || undefined, ...(options.cursor ? { cursor: options.cursor } : {}) }, true);
      if (append) {
        setTickets((current) => {
          const existing = new Set(current.map((ticket) => ticket.id));
          return [...current, ...result.tickets.filter((ticket) => !existing.has(ticket.id))];
        });
        setNextCursor(result.nextCursor);
        return;
      }
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
      const nextId = preferredId && result.tickets.some((ticket) => ticket.id === preferredId) ? preferredId : result.tickets[0]?.id || '';
      setSelectedId(nextId);
      if (nextId) await loadDetail(nextId, false);
      else setSelected(null);
    } catch (requestError) { setError(errorMessage(requestError, 'The support queue could not be loaded. No records were changed.')); }
    finally { if (append) setLoadingMore(false); else setLoading(false); }
  }

  async function loadMoreQueue() {
    if (!nextCursor || loadingMore) return;
    await loadQueue(selectedId, { append: true, cursor: nextCursor });
  }

  async function loadDetail(ticketId: string, showLoading = true) {
    if (showLoading) setDetailLoading(true);
    setError('');
    try {
      const ticket = await getSupportTicket(ticketId, true);
      setSelected(ticket);
      setDraftStatus(ticket.status);
      setDraftPriority(ticket.priority);
      setDraftAssignee(ticket.assignedTo || ticket.assigneeId || '');
    } catch (requestError) { setError(errorMessage(requestError, 'The selected case could not be opened.')); }
    finally { if (showLoading) setDetailLoading(false); }
  }

  useEffect(() => {
    void loadQueue();
    const onPopState = () => {
      const ticketId = new URLSearchParams(window.location.search).get('ticket') || '';
      setSelectedId(ticketId);
      if (ticketId) void loadDetail(ticketId);
      else setSelected(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // Filters are applied only through the explicit queue action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(ticketId: string) {
    setSelectedId(ticketId);
    window.history.pushState({}, '', `/admin/support?ticket=${encodeURIComponent(ticketId)}`);
    void loadDetail(ticketId);
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || composer.trim().length < 2) return;
    setBusy(true);
    setError('');
    try {
      await sendSupportMessage(selected.id, { body: composer.trim(), visibility }, true);
      setComposer('');
      await loadQueue(selected.id);
    } catch (requestError) { setError(errorMessage(requestError, 'The message could not be posted. Nothing was changed.')); }
    finally { setBusy(false); }
  }

  async function saveMetadata() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const updated = await transitionSupportTicket(selected.id, {
        status: draftStatus,
        priority: draftPriority as SupportPriority,
        assignedTo: draftAssignee.trim() || null,
      }, true);
      setSelected(updated);
      setTickets((current) => current.map((ticket) => ticket.id === updated.id ? { ...ticket, ...updated } : ticket));
    } catch (requestError) { setError(errorMessage(requestError, 'Case metadata could not be saved. Nothing was changed.')); }
    finally { setBusy(false); }
  }

  async function transition(statusValue: SupportStatus) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const updated = await transitionSupportTicket(selected.id, { status: statusValue }, true);
      setSelected(updated);
      setDraftStatus(updated.status);
      setTickets((current) => current.map((ticket) => ticket.id === updated.id ? { ...ticket, ...updated } : ticket));
    } catch (requestError) { setError(errorMessage(requestError, 'The case state could not be changed. Nothing was changed.')); }
    finally { setBusy(false); }
  }

  const messages = selected?.messages || [];
  const supportCount = tickets.filter((ticket) => !['closed', 'resolved'].includes(ticket.status)).length;

  return <section className="aux-admin-support" aria-labelledby="admin-support-title">
    <header className="aux-admin-support__heading">
      <div><span>CONTROL PLANE / CUSTOMER SIGNAL</span><h2 id="admin-support-title">Support inbox</h2><p>Resolve customer cases against the same evidence ledger the workspace can see.</p></div>
      <div className="aux-admin-support__summary"><strong>{supportCount}</strong><span>active in this view</span><button type="button" onClick={() => void loadQueue()} disabled={loading}><RefreshCw className={loading ? 'aux-spin' : ''} /> Refresh</button></div>
    </header>
    <div className="aux-admin-support__notice"><ShieldAlert /><span><strong>Operator boundary.</strong> Replies marked customer are visible to the requester. Internal notes stay inside this console. Server authorization still decides what this role may change.</span><em>{role || 'protected admin'}</em></div>
    {error && <div className="aux-alert aux-alert--page" role="alert"><AlertCircle />{error}<button type="button" onClick={() => void loadQueue()}><RefreshCw /> Retry</button></div>}
    <div className="aux-admin-support__filters" role="search">
      <label className="aux-search"><Search /><span className="sr-only">Search cases</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search subject, requester, case ID" /></label>
      <label><span className="sr-only">Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
      <label><span className="sr-only">Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{priorities.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
      <label className="aux-assignee-filter"><UserRound /><span className="sr-only">Assignee filter</span><input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="Assignee ID" /></label>
      <button type="button" className="aux-dark-button" onClick={() => void loadQueue()} disabled={loading}><Filter /> Apply</button>
    </div>
    <div className="aux-admin-support__workspace">
      <aside className="aux-admin-queue" aria-label="Support queue">
        <header><span>QUEUE</span><strong>{filtered.length} cases</strong></header>
        {loading && <div className="aux-list-state"><LoaderCircle className="aux-spin" /><span>Loading queue…</span></div>}
        {!loading && filtered.length === 0 && <div className="aux-list-state"><MessageSquare /><span>No cases match this filter.</span></div>}
        {!loading && filtered.map((ticket) => <button type="button" key={ticket.id} className={`aux-admin-queue__item${selectedId === ticket.id ? ' is-active' : ''}`} onClick={() => select(ticket.id)} aria-current={selectedId === ticket.id ? 'true' : undefined}>
          <span className="aux-admin-queue__line"><b>{ticket.reference || ticket.id.slice(0, 8).toUpperCase()}</b><time>{dateTime(ticket.lastActivityAt || ticket.lastMessageAt || ticket.updatedAt || ticket.createdAt)}</time></span>
          <strong>{ticket.subject}</strong><small>{requesterLine(ticket)}</small><span className="aux-admin-queue__states"><AdminState value={ticket.status} /><AdminState value={ticket.priority} kind="priority" /></span>
        </button>)}
        {!loading && nextCursor && <button type="button" className="aux-load-more aux-load-more--queue" onClick={() => void loadMoreQueue()} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="aux-spin" /> Loading more…</> : <>Load more cases <RefreshCw /></>}</button>}
      </aside>
      <section className="aux-admin-thread" aria-label="Selected support case">
        {detailLoading && <div className="aux-loading-panel"><LoaderCircle className="aux-spin" /><span>Opening case…</span></div>}
        {!detailLoading && !selected && <div className="aux-admin-thread__empty"><MessageSquare /><h3>Select a case</h3><p>The queue and the customer-visible thread will meet here.</p></div>}
        {!detailLoading && selected && <>
          <header className="aux-admin-thread__head"><button type="button" className="aux-back-link aux-admin-back" onClick={() => { setSelectedId(''); setSelected(null); window.history.pushState({}, '', '/admin/support'); }}><ArrowLeft /> Queue</button><div className="aux-thread__meta"><span>{selected.reference || `CASE ${selected.id.slice(0, 8).toUpperCase()}`}</span><AdminState value={selected.status} /><AdminState value={selected.priority} kind="priority" /></div><h3>{selected.subject}</h3><p>{(selected.category || 'support').replaceAll('_', ' ')} · Opened {dateTime(selected.createdAt)}</p><div className="aux-requester-identity" aria-label="Requester identity"><UserRound aria-hidden="true" /><div><strong>{requesterName(selected)}</strong>{selected.requesterEmail && <span>{selected.requesterEmail}</span>}<code>{selected.requesterId || selected.createdBy || 'User ID unavailable'}</code></div>{selected.requesterEmailVerified !== undefined && selected.requesterEmailVerified !== null && <em>{selected.requesterEmailVerified ? 'Verified email' : 'Unverified email'}</em>}</div></header>
          <div className="aux-admin-thread__body">
            <div className="aux-admin-timeline" aria-live="polite">
              {messages.length === 0 && <div className="aux-thread__empty"><Clock3 /><p>No messages yet. Record the first operator response or note.</p></div>}
              {messages.map((message: SupportMessage) => <article className={`aux-message${message.visibility === 'internal' ? ' is-internal' : message.authorRole === 'support' || message.authorRole === 'admin' || message.authorType === 'admin' ? ' is-support' : ''}`} key={message.id}>
                <div className="aux-message__avatar" aria-hidden="true">{initials(message.authorName || message.authorEmail)}</div><div className="aux-message__body"><header><strong>{message.authorName || (message.authorRole === 'support' || message.authorRole === 'admin' || message.authorType === 'admin' ? 'WPA Support' : 'Customer')}</strong><span className={`aux-visibility aux-visibility--${message.visibility || 'public'}`}>{message.visibility === 'internal' ? 'Internal note' : 'Customer visible'}</span><time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></header><p>{message.body}</p></div>
              </article>)}
            </div>
            <aside className="aux-admin-inspector" aria-label="Case controls">
              <div><span>CASE CONTROL</span><h4>State and ownership</h4></div>
              {canManage && <><label><span>Status</span><select value={draftStatus} onChange={(event) => setDraftStatus(event.target.value)} disabled={busy}>{statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
              <label><span>Priority</span><select value={draftPriority} onChange={(event) => setDraftPriority(event.target.value)} disabled={busy}>{priorities.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
              <label><span>Assignee ID <i>optional</i></span><input value={draftAssignee} onChange={(event) => setDraftAssignee(event.target.value)} placeholder="Leave blank to unassign" disabled={busy} /></label>
              <button type="button" className="aux-dark-button" onClick={() => void saveMetadata()} disabled={busy}><Check /> Save controls</button>
              <div className="aux-admin-inspector__quick"><span>SAFE TRANSITIONS</span><button type="button" onClick={() => void transition('waiting_customer')} disabled={busy || ['waiting_customer', 'pending'].includes(selected.status)}>Awaiting customer</button><button type="button" onClick={() => void transition('resolved')} disabled={busy || selected.status === 'resolved'}>Mark resolved</button><button type="button" onClick={() => void transition('closed')} disabled={busy || selected.status === 'closed'}>Close case</button></div></>}
              {!canManage && <p className="empty-state">This role may read and reply, but cannot change case state, priority or ownership.</p>}
              <dl><div><dt>Requester account</dt><dd>{selected.requesterState || 'State unavailable'}</dd></div><div><dt>Workspace ID</dt><dd>{selected.workspaceId || 'Unavailable'}</dd></div><div><dt>Target</dt><dd>{selected.targetUrl || 'Not attached'}</dd></div><div><dt>Report</dt><dd>{selected.reportId || 'Not attached'}</dd></div><div><dt>Context</dt><dd>{selected.context || 'Not attached'}</dd></div><div><dt>Last activity</dt><dd>{dateTime(selected.lastActivityAt || selected.lastMessageAt || selected.updatedAt || selected.createdAt)}</dd></div></dl>
            </aside>
          </div>
          {(canReply || canInternalNote) && <form className="aux-admin-composer" onSubmit={submitMessage} aria-busy={busy}><header><div><span>OPERATOR COMPOSER</span><strong>{visibility === 'internal' ? 'Private note' : 'Customer reply'}</strong></div><div className="aux-visibility-switch" role="group" aria-label="Message visibility">{canReply && <button type="button" className={visibility === 'customer' ? 'is-active' : ''} onClick={() => setVisibility('customer')}><Send /> Customer reply</button>}{canInternalNote && <button type="button" className={visibility === 'internal' ? 'is-active' : ''} onClick={() => setVisibility('internal')}><ShieldAlert /> Internal note</button>}</div></header><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={visibility === 'internal' ? 'Record context for the next operator…' : 'Write the response the customer will receive…'} rows={4} maxLength={5000} disabled={busy} /><footer><small>{composer.length}/5000 · {visibility === 'internal' ? 'Never shown to the requester.' : 'Visible in the customer thread.'}</small><button type="submit" className="aux-dark-button" disabled={busy || composer.trim().length < 2 || (visibility === 'internal' ? !canInternalNote : !canReply)}>{busy ? <><LoaderCircle className="aux-spin" /> Posting…</> : <><Send /> Post {visibility === 'internal' ? 'note' : 'reply'}</>}</button></footer></form>}
        </>}
      </section>
    </div>
  </section>;
}
