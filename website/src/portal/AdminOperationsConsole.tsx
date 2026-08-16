import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, BadgeCheck, ChevronDown, CircleStop, Coins, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, UserRoundCog, UsersRound } from 'lucide-react';
import { apiFetch, jsonRequest, privilegedApiFetch } from './api';
import './admin-operations.css';

export type OperationsView = 'users' | 'workspaces' | 'scans' | 'entitlements' | 'redeem' | 'audit';
type AnyRecord = Record<string, unknown>;
const FEATURE_OVERRIDE_MODULES = [
  { id: 'core_audit', label: 'Core Audit' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'seo', label: 'SEO' },
  { id: 'geo', label: 'GEO' },
  { id: 'design', label: 'Design' },
  { id: 'backend_surface', label: 'Backend Surface' },
  { id: 'full_site_crawl', label: 'Full-site Crawl' },
  { id: 'performance_plus', label: 'Performance Plus' },
  { id: 'passive_security', label: 'Passive Security' },
  { id: 'source_audit', label: 'Source Audit' },
  { id: 'journey_test', label: 'Journey Test' },
  { id: 'expert_review', label: 'Expert Review' },
  { id: 'api_webhooks', label: 'API Webhooks' },
  { id: 'ai_remediation', label: 'AI Remediation' },
] as const;
type FeatureOverrideModule = typeof FEATURE_OVERRIDE_MODULES[number]['id'];
type FeatureOverrideMode = 'automated' | 'operator_assisted' | 'disabled';
type WorkspaceDetail = {
  workspace: AnyRecord;
  subscription?: AnyRecord | null;
  effective?: AnyRecord;
  usage?: AnyRecord;
  grants?: AnyRecord[];
  creditAdjustments?: AnyRecord[];
  projects?: AnyRecord[];
  recentScans?: AnyRecord[];
  failedScans?: AnyRecord[];
  aiUsage?: AnyRecord[];
  supportTickets?: AnyRecord[];
  audit?: AnyRecord[];
};
type UserAccessDetail = {
  user: AnyRecord;
  profile?: AnyRecord;
  effective?: AnyRecord;
  usage?: AnyRecord;
  grants?: AnyRecord[];
  creditAdjustments?: AnyRecord[];
  workspaces?: AnyRecord[];
  subscription?: AnyRecord | null;
  aiUsage?: AnyRecord[];
  audit?: AnyRecord[];
};

function text(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : fallback;
}

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((item): item is AnyRecord => Boolean(item && typeof item === 'object')) : [];
}

function dateTime(value: unknown) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function expiryIso(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function Status({ value }: { value: unknown }) {
  const label = text(value, 'unknown');
  return <span className={`admin-operation-status is-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`}>{label.replaceAll('_', ' ')}</span>;
}

function SummaryValue({ label, value }: { label: string; value: unknown }) {
  return <div><span>{label}</span><strong>{text(value, '0')}</strong></div>;
}

function objectRecord(value: unknown): AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) ? value as AnyRecord : {};
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : '';
}

const SENSITIVE_AUDIT_FIELD = /(password|passphrase|secret|token|authorization|credential|cookie|api[_-]?key|private[_-]?key)/i;

function redactAuditValue(value: unknown, field = '', depth = 0): unknown {
  if (SENSITIVE_AUDIT_FIELD.test(field)) return '[REDACTED]';
  if (depth >= 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as AnyRecord).slice(0, 100).map(([key, item]) => [key, redactAuditValue(item, key, depth + 1)]));
  }
  return value;
}

function humanizeAuditKey(value: unknown) {
  const normalized = optionalText(value).replaceAll('.', ' ').replaceAll('_', ' ').replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll(/\s+/g, ' ').trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Audit event';
}

function planLabel(value: unknown) {
  const plan = optionalText(value);
  return plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : 'unknown plan';
}

function auditPrincipal(event: AnyRecord, kind: 'actor' | 'targetUser') {
  const principal = objectRecord(event[kind]);
  const metadata = objectRecord(event.metadata);
  const after = objectRecord(event.after);
  const before = objectRecord(event.before);
  const id = optionalText(principal.id) || (kind === 'actor'
    ? optionalText(event.actorId)
    : optionalText(metadata.targetUserId) || optionalText(after.userId) || optionalText(after.entitlementUserId) || optionalText(before.userId) || optionalText(before.entitlementUserId));
  const name = optionalText(principal.name);
  const email = optionalText(principal.email);
  return {
    id,
    name,
    email,
    short: email || name || id,
    full: [...new Set([name, email, id].filter(Boolean))].join(' · '),
  };
}

function auditSummary(event: AnyRecord) {
  const action = optionalText(event.action).toLowerCase();
  const metadata = objectRecord(event.metadata);
  const after = objectRecord(event.after);
  const before = objectRecord(event.before);
  const target = auditPrincipal(event, 'targetUser').short;
  const entity = optionalText(event.entityId);
  const destination = target || entity || 'the recorded subject';
  const rawAmount = metadata.amount ?? after.amount ?? before.amount;
  const amount = Number(rawAmount);

  if ((action.includes('credit') || action.includes('credits')) && Number.isFinite(amount) && amount !== 0) {
    const creditType = optionalText(metadata.creditType || after.creditType || before.creditType).toLowerCase();
    const kind = creditType === 'ai' ? 'AI' : creditType === 'page' ? 'page' : creditType || 'usage';
    const absolute = Math.abs(amount);
    const quantity = new Intl.NumberFormat().format(absolute);
    const noun = absolute === 1 ? 'credit' : 'credits';
    return amount > 0 ? `Added ${quantity} ${kind} ${noun} to ${destination}.` : `Removed ${quantity} ${kind} ${noun} from ${destination}.`;
  }
  if (action.includes('plan_changed') || action.includes('plan_assigned')) {
    return `Changed ${destination}'s plan from ${planLabel(before.planId)} to ${planLabel(after.planId)}.`;
  }
  if (action.includes('entitlement') && (action.includes('grant') || action.includes('created'))) {
    const temporaryPlanId = after.temporaryPlanId || metadata.temporaryPlanId;
    const overrides = objectRecord(after.entitlementOverrides || metadata.entitlementOverrides);
    const access = temporaryPlanId
      ? `${planLabel(temporaryPlanId)} temporary plan access`
      : Object.keys(overrides).length
        ? `${Object.keys(overrides).map(humanizeAuditKey).join(', ')} feature access`
        : 'temporary feature access';
    return `Granted ${access} to ${destination}.`;
  }
  if (action.includes('entitlement') && (action.includes('revoke') || action.includes('expired'))) return `Revoked temporary access from ${destination}.`;
  if (action.endsWith('unbanned')) return `Restored account access for ${destination}.`;
  if (action.endsWith('banned')) return `Blocked account access for ${destination}.`;
  if (action.endsWith('unsuspended')) return `Restored workspace access for ${destination}.`;
  if (action.endsWith('suspended')) return `Suspended workspace access for ${destination}.`;
  if (action.includes('scan.cancel')) return `Cancelled scan ${entity || destination}.`;
  if (action.includes('scan.retr')) return `Requeued scan ${entity || destination}.`;
  if (action.includes('redeem') && action.includes('created')) return `Created redeem code ${entity || destination}.`;
  if (action.includes('redeem') && action.includes('disabled')) return `Disabled redeem code ${entity || destination}.`;
  if (action.includes('redeem') && action.includes('revoked')) return `Revoked redeem code ${entity || destination}.`;
  return `Recorded ${humanizeAuditKey(event.action).toLowerCase()} for ${destination}.`;
}

function AuditDetailValue({ field, value }: { field?: string; value: unknown }) {
  const safeValue = redactAuditValue(value, field);
  if (safeValue === null || safeValue === undefined || safeValue === '') return <span className="admin-audit-empty-value">Not recorded</span>;
  if (typeof safeValue === 'object') return <pre>{JSON.stringify(safeValue, null, 2)}</pre>;
  return <code>{String(safeValue)}</code>;
}

function AuditRow({ event }: { event: AnyRecord }) {
  const [expanded, setExpanded] = useState(false);
  const eventId = optionalText(event.id) || 'event';
  const safeId = eventId.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
  const triggerId = `admin-audit-trigger-${safeId}`;
  const panelId = `admin-audit-detail-${safeId}`;
  const actor = auditPrincipal(event, 'actor');
  const target = auditPrincipal(event, 'targetUser');
  const before = objectRecord(event.before);
  const after = objectRecord(event.after);
  const metadata = objectRecord(event.metadata);
  const changeKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(redactAuditValue(before[key], key)) !== JSON.stringify(redactAuditValue(after[key], key)));
  const occurredAt = dateTime(event.createdAt);
  const targetDescription = target.full || 'No registered user target';
  const actorDescription = actor.full || 'System actor not recorded';

  return <article className={`admin-audit-row${expanded ? ' is-open' : ''}`}>
    <button id={triggerId} type="button" className="admin-audit-trigger" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((current) => !current)}>
      <span className="admin-audit-icon" aria-hidden="true"><ShieldCheck /></span>
      <span className="admin-audit-copy">
        <span className="admin-audit-action">{humanizeAuditKey(event.action)}</span>
        <strong>{auditSummary(event)}</strong>
        <span className="admin-audit-preview">Affected: {target.short || optionalText(event.entityId) || 'system event'} · By: {actor.short || 'system'}</span>
      </span>
      <span className="admin-audit-request"><time dateTime={optionalText(event.createdAt)}>{occurredAt}</time><code>{text(event.requestId, 'no request id')}</code></span>
      <ChevronDown className="admin-audit-chevron" aria-hidden="true" />
    </button>
    {expanded && <section id={panelId} role="region" aria-labelledby={triggerId} className="admin-audit-detail">
      <div className="admin-audit-context">
        <div><span>Affected user</span><strong>{targetDescription}</strong></div>
        <div><span>Performed by</span><strong>{actorDescription}</strong></div>
        <div><span>Occurred at</span><strong>{occurredAt}</strong></div>
        <div><span>Workspace</span><strong>{text(event.workspaceId, 'No workspace')}</strong></div>
      </div>
      <div className="admin-audit-reason"><span>Recorded reason</span><p>{text(event.reason, 'No operator reason was required for this system event.')}</p></div>
      <dl className="admin-audit-identifiers">
        <div><dt>Action key</dt><dd><AuditDetailValue value={event.action} /></dd></div>
        <div><dt>Entity type</dt><dd><AuditDetailValue value={event.entityType} /></dd></div>
        <div><dt>Entity ID</dt><dd><AuditDetailValue value={event.entityId} /></dd></div>
        <div><dt>Request ID</dt><dd><AuditDetailValue value={event.requestId} /></dd></div>
      </dl>
      <div className="admin-audit-section">
        <h4>Recorded changes</h4>
        {changeKeys.length ? <div className="admin-audit-change-table"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{changeKeys.map((key) => <tr key={key}><th scope="row">{humanizeAuditKey(key)}</th><td><AuditDetailValue field={key} value={before[key]} /></td><td><AuditDetailValue field={key} value={after[key]} /></td></tr>)}</tbody></table></div> : <p className="admin-audit-empty">No before/after field change was stored for this event.</p>}
      </div>
      <div className="admin-audit-snapshots">
        <div><h4>Before state</h4><AuditDetailValue value={event.before} /></div>
        <div><h4>After state</h4><AuditDetailValue value={event.after} /></div>
        <div><h4>Operation metadata</h4><AuditDetailValue value={metadata} /></div>
      </div>
    </section>}
  </article>;
}

export default function AdminOperationsConsole({ view, permissions = [] }: { view: OperationsView; permissions?: string[] }) {
  const operationKeys = useRef(new Map<string, string>());
  const loadRequest = useRef(0);
  const [items, setItems] = useState<AnyRecord[]>([]);
  const [codes, setCodes] = useState<AnyRecord[]>([]);
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetail | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => view === 'workspaces' ? new URLSearchParams(window.location.search).get('workspace') || '' : '');
  const [userDetail, setUserDetail] = useState<UserAccessDetail | null>(null);
  const [selectedUserId, setSelectedUserId] = useState(() => view === 'users' ? new URLSearchParams(window.location.search).get('user') || '' : '');
  const userInspectorRef = useRef<HTMLElement>(null);
  const revealUserInspector = useRef(Boolean(selectedUserId));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [creditKind, setCreditKind] = useState<'page' | 'ai'>('page');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditExpiry, setCreditExpiry] = useState('');
  const [assignedPlan, setAssignedPlan] = useState<'free' | 'signal' | 'studio' | 'enterprise'>('free');
  const [grantPlan, setGrantPlan] = useState<'signal' | 'studio' | 'enterprise'>('studio');
  const [grantExpiry, setGrantExpiry] = useState('');
  const [featureModule, setFeatureModule] = useState<FeatureOverrideModule>('expert_review');
  const [featureMode, setFeatureMode] = useState<FeatureOverrideMode>('operator_assisted');
  const [featureExpiry, setFeatureExpiry] = useState('');
  const [createdPlainCode, setCreatedPlainCode] = useState('');
  const [query, setQuery] = useState('');
  const [scanDetail, setScanDetail] = useState<AnyRecord | null>(null);

  const hasPermission = useCallback((permission: string) => permissions.includes(permission), [permissions]);
  const canManageCredits = hasPermission('credits.manage');
  const canManageEntitlements = hasPermission('entitlements.manage');
  const canAssignPlan = hasPermission('plans.manage');
  const canBanUsers = hasPermission('users.ban') || hasPermission('users.unban');
  const canSuspendWorkspaces = hasPermission('workspaces.suspend') || hasPermission('workspaces.unsuspend');
  const canReconcileBilling = hasPermission('billing.reconcile');
  const canCancelScans = hasPermission('scans.cancel');
  const canRetryScans = hasPermission('scans.retry');
  const canMutateScans = canCancelScans || canRetryScans;
  const canManageRedeem = hasPermission('redeem.manage');
  const canManageUserCommerce = canManageCredits || canManageEntitlements || canAssignPlan;
  const canConfirmCurrentView = view === 'users'
    ? canBanUsers || canManageUserCommerce
    : view === 'workspaces'
      ? canSuspendWorkspaces || canReconcileBilling
      : view === 'scans'
        ? canMutateScans
        : view === 'entitlements'
          ? canManageEntitlements
          : view === 'redeem'
            ? canManageRedeem
            : false;
  const hasConfirmation = reason.trim().length > 0 && confirmed;
  const authorizationBlocker = !reason.trim()
    ? 'Enter an audit reason for this user above.'
    : !confirmed
      ? 'Check the confirmation box above.'
      : '';
  const creditAmountNumber = Number(creditAmount);
  const creditAmountIssue = !creditAmount.trim()
    ? 'Enter a signed whole-number amount.'
    : !Number.isInteger(creditAmountNumber) || creditAmountNumber === 0 || Math.abs(creditAmountNumber) > 100_000
      ? 'Amount must be a non-zero whole number between -100,000 and 100,000.'
      : '';
  const creditActionBlocker = creditAmountIssue || authorizationBlocker;
  const permanentPlanBlocker = authorizationBlocker;
  const temporaryPlanBlocker = !grantExpiry ? 'Choose the required expiry first.' : authorizationBlocker;
  const featureOverrideBlocker = !featureExpiry ? 'Choose the feature expiry first.' : authorizationBlocker;

  const loadWorkspace = useCallback(async (workspaceId: string) => {
    if (!workspaceId) { setWorkspaceDetail(null); return; }
    const result = await apiFetch<{ workspace: WorkspaceDetail }>(`/api/v1/admin/workspaces/${encodeURIComponent(workspaceId)}`);
    setWorkspaceDetail(result.workspace);
  }, []);

  const loadUser = useCallback(async (userId: string) => {
    if (!userId) { setUserDetail(null); return; }
    const result = await apiFetch<{ user: UserAccessDetail }>(`/api/v1/admin/users/${encodeURIComponent(userId)}`);
    setUserDetail(result.user);
    const currentPlan = result.user.effective?.effectivePlanId || result.user.profile?.planId;
    if (['free', 'signal', 'studio', 'enterprise'].includes(String(currentPlan))) setAssignedPlan(String(currentPlan) as typeof assignedPlan);
  }, []);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError('');
    try {
      if (view === 'redeem') {
        const result = await apiFetch<{ codes: AnyRecord[] }>('/api/v1/admin/redeem-codes');
        if (requestId !== loadRequest.current) return;
        setCodes(result.codes || []);
        setItems([]);
      } else {
        const resource = view === 'entitlements' ? 'grants' : view;
        const result = await apiFetch<{ resources: AnyRecord[] }>(`/api/v1/admin/resources/${resource}`);
        if (requestId !== loadRequest.current) return;
        setItems(result.resources || []);
        setCodes([]);
      }
      if (selectedWorkspaceId && view === 'workspaces') await loadWorkspace(selectedWorkspaceId);
      if (selectedUserId && view === 'users') await loadUser(selectedUserId);
    } catch (requestError) {
      if (requestId === loadRequest.current) setError(requestError instanceof Error ? requestError.message : 'Admin operation data could not be loaded.');
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [loadUser, loadWorkspace, selectedUserId, selectedWorkspaceId, view]);

  useEffect(() => {
    loadRequest.current += 1;
    setItems([]);
    setCodes([]);
    setLoading(true);
    if (view !== 'users') setUserDetail(null);
    if (view !== 'workspaces') setWorkspaceDetail(null);
    if (view !== 'scans') setScanDetail(null);
    setQuery('');
    setMessage('');
    setError('');
    setReason('');
    setConfirmed(false);
  }, [view]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!userDetail || !revealUserInspector.current) return;
    const frame = window.requestAnimationFrame(() => {
      const inspector = userInspectorRef.current;
      if (!inspector) return;
      revealUserInspector.current = false;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      inspector.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      inspector.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [userDetail]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }, [items, query]);
  const filteredCodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return codes;
    return codes.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }, [codes, query]);

  const operate = useCallback(async (key: string, url: string, body: AnyRecord, success: string) => {
    const intent = `${key}:${JSON.stringify(body)}`;
    const operationKey = operationKeys.current.get(intent) || `admin:${key}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    operationKeys.current.set(intent, operationKey);
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const payload = Object.hasOwn(body, 'idempotencyKey') ? { ...body, idempotencyKey: operationKey } : body;
      const init = jsonRequest('POST', payload);
      init.headers = { ...init.headers, 'Idempotency-Key': operationKey };
      await privilegedApiFetch(url, init);
      operationKeys.current.delete(intent);
      setMessage(success);
      setConfirmed(false);
      setReason('');
      await load();
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The operation could not be completed.');
      return false;
    } finally { setBusy(''); }
  }, [load]);

  async function inspectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    setBusy(`inspect:${workspaceId}`);
    try { await loadWorkspace(workspaceId); setError(''); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Workspace detail could not be loaded.'); }
    finally { setBusy(''); }
  }

  async function inspectScan(workspaceId: string, scanId: string) {
    setBusy(`inspect-scan:${scanId}`);
    setError('');
    try {
      const result = await apiFetch<{ scan: AnyRecord }>(`/api/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/scans/${encodeURIComponent(scanId)}`);
      setScanDetail(result.scan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Scan evidence could not be loaded.');
    } finally { setBusy(''); }
  }

  function resetMutationDrafts() {
    operationKeys.current.clear();
    setReason('');
    setConfirmed(false);
    setCreditKind('page');
    setCreditAmount('');
    setCreditExpiry('');
    setAssignedPlan('free');
    setGrantPlan('studio');
    setGrantExpiry('');
    setFeatureModule('expert_review');
    setFeatureMode('operator_assisted');
    setFeatureExpiry('');
    setMessage('');
  }

  async function inspectUser(userId: string) {
    if (userId !== selectedUserId) resetMutationDrafts();
    revealUserInspector.current = true;
    setSelectedUserId(userId);
    setUserDetail(null);
    const url = new URL(window.location.href);
    url.searchParams.set('user', userId);
    url.searchParams.delete('workspace');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setBusy(`inspect-user:${userId}`);
    try { await loadUser(userId); setError(''); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'User access detail could not be loaded.'); }
    finally { setBusy(''); }
  }

  async function adjustCredits(event: FormEvent) {
    event.preventDefault();
    const amount = Number(creditAmount);
    if (!selectedUserId || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000 || !hasConfirmation) return;
    const completed = await operate(`credits:${selectedUserId}`, `/api/v1/admin/users/${encodeURIComponent(selectedUserId)}/credits`, {
      kind: creditKind, amount, reason: reason.trim(), expiresAt: expiryIso(creditExpiry), confirm: true,
    }, 'The user credit adjustment was recorded.');
    if (completed) { setCreditAmount(''); setCreditExpiry(''); }
  }

  async function assignPlan(event: FormEvent) {
    event.preventDefault();
    if (!selectedUserId || !canAssignPlan || !hasConfirmation) return;
    await operate(`plan:${selectedUserId}`, `/api/v1/admin/users/${encodeURIComponent(selectedUserId)}/plan`, {
      planId: assignedPlan, reason: reason.trim(), confirm: true,
    }, 'The user plan was changed.');
  }

  async function grantEntitlement(event: FormEvent) {
    event.preventDefault();
    const expiresAt = expiryIso(grantExpiry);
    if (!selectedUserId || !expiresAt || !hasConfirmation) return;
    const completed = await operate(`grant:${selectedUserId}`, `/api/v1/admin/users/${encodeURIComponent(selectedUserId)}/entitlements`, {
      planId: grantPlan, expiresAt, reason: reason.trim(), confirm: true,
    }, 'The temporary user entitlement was recorded.');
    if (completed) setGrantExpiry('');
  }

  async function grantFeatureOverride(event: FormEvent) {
    event.preventDefault();
    const expiresAt = expiryIso(featureExpiry);
    if (!selectedUserId || !expiresAt || !hasConfirmation) return;
    const completed = await operate(`feature:${selectedUserId}`, `/api/v1/admin/users/${encodeURIComponent(selectedUserId)}/entitlements`, {
      moduleId: featureModule, executionMode: featureMode, expiresAt, reason: reason.trim(), confirm: true,
    }, 'The feature override was recorded without changing the billing plan.');
    if (completed) setFeatureExpiry('');
  }

  async function createRedeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const plainCode = String(form.get('code') || '').trim();
    const startsAt = expiryIso(String(form.get('startsAt') || ''));
    const expiresAt = expiryIso(String(form.get('expiresAt') || ''));
    if (!plainCode || !hasConfirmation) return;
    const body = {
      code: plainCode,
      active: true,
      startsAt,
      expiresAt,
      durationDays: Number(form.get('durationDays')) || null,
      maxGlobalRedemptions: Number(form.get('maxGlobalRedemptions')) || 1,
      maxPerWorkspace: Number(form.get('maxPerWorkspace')) || 1,
      temporaryPlan: String(form.get('temporaryPlan') || '') || null,
      bonusPageCredits: Number(form.get('bonusPageCredits')) || 0,
      bonusAiCredits: Number(form.get('bonusAiCredits')) || 0,
      entitlementOverrides: {},
      adminNote: String(form.get('adminNote') || '').trim(),
      reason: reason.trim(),
      confirm: true,
    };
    setBusy('redeem:create');
    setError('');
    const intent = `redeem:create:${JSON.stringify(body)}`;
    const operationKey = operationKeys.current.get(intent) || `admin:redeem-create:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    operationKeys.current.set(intent, operationKey);
    try {
      const init = jsonRequest('POST', body);
      init.headers = { ...init.headers, 'Idempotency-Key': operationKey };
      await privilegedApiFetch('/api/v1/admin/redeem-codes', init);
      operationKeys.current.delete(intent);
      setCreatedPlainCode(plainCode);
      setMessage('Redeem code created. Copy the plaintext value now; only a secure hash is stored.');
      setConfirmed(false);
      setReason('');
      formElement.reset();
      await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Redeem code could not be created.'); }
    finally { setBusy(''); }
  }

  const selectedUserLabel = userDetail
    ? `${text(userDetail.user.email, text(userDetail.user.name, selectedUserId))} (${text(userDetail.user.id, selectedUserId)})`
    : selectedUserId;
  const confirmation = canConfirmCurrentView ? <fieldset className="admin-operation-confirmation">
    <legend>Mutation authorization</legend>
    <label><span>Audit reason (required)</span><textarea aria-describedby="admin-operation-reason-help" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Why is this operation necessary?" /><small id="admin-operation-reason-help">Saved with your admin identity, target, time and request ID in the audit log. Reference the ticket or concrete operational cause; never include passwords or secrets.</small></label>
    <label className="admin-operation-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{view === 'users' && selectedUserLabel ? `I reviewed user ${selectedUserLabel} and confirm this audited operation.` : 'I reviewed the target and confirm this audited operation.'}</span></label>
  </fieldset> : <div className="admin-operation-readonly"><ShieldCheck /><span>Your operator role is read-only for account, billing and entitlement mutations.</span></div>;

  const workspaceRows = useMemo(() => filteredItems.map((item) => {
    const id = text(item.id, '');
    return <article className="admin-operation-row" key={id}>
      <UsersRound /><div><b>{text(item.name, id)}</b><small>{id} · sponsor plan {text(item.planId)} · {text(item.projects, '0')} projects · {text(item.scans, '0')} scans</small></div><Status value={item.state} />
      <button type="button" onClick={() => void inspectWorkspace(id)} disabled={busy === `inspect:${id}`}>{busy === `inspect:${id}` ? 'Opening…' : 'Inspect'}</button>
      {canSuspendWorkspaces && <button type="button" className="is-danger" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`workspace:${id}`, `/api/v1/admin/workspaces/${encodeURIComponent(id)}/${item.state === 'suspended' ? 'unsuspend' : 'suspend'}`, { reason: reason.trim(), confirm: true }, item.state === 'suspended' ? 'Workspace restored.' : 'Workspace suspended.')}>{item.state === 'suspended' ? 'Unsuspend' : 'Suspend'}</button>}
    </article>;
  }), [busy, canSuspendWorkspaces, filteredItems, hasConfirmation, operate, reason]);

  if (loading && !items.length && !codes.length) return <div className="portal-loading"><i />Loading audited operations</div>;

  return <section className="admin-operations" data-view={view}>
    <header><div><span>DEFINED OPERATIONS / NO RAW DB ACCESS</span><h2>{view.replaceAll('_', ' ')}</h2><p>Every mutation is server-authorized, rate-limited, reasoned, confirmed and audit-recorded.</p></div><button type="button" onClick={() => void load()} disabled={loading}><RefreshCw /> Refresh</button></header>
    <label className="admin-operation-search"><span>Filter this register</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${view.replaceAll('_', ' ')} by name, email, ID or state`} /><small>{view === 'redeem' ? filteredCodes.length : filteredItems.length} of {view === 'redeem' ? codes.length : items.length} records shown</small></label>
    {view === 'entitlements' && <div className="admin-operation-explainer"><ShieldCheck /><div><b>Feature-level and temporary-plan access</b><p>These time-boxed user grants are composed with the base plan. They can temporarily raise a plan or override one executable feature and its execution mode; they do not change the paid subscription or credit ledger. Grants expire automatically and can be revoked here.</p></div></div>}
    {error && <div className="portal-alert" role="alert">{error}</div>}
    {message && <div className="admin-operation-success" role="status"><BadgeCheck />{message}{createdPlainCode && <code>{createdPlainCode}</code>}</div>}
    {view !== 'audit' && view !== 'users' && confirmation}

    {view === 'users' && <><div className="admin-operation-list">{filteredItems.length ? filteredItems.map((user) => {
      const id = text(user.id, '');
      const workspaces = records(user.workspaces);
      const accessOpen = selectedUserId === id && Boolean(userDetail);
      return <article className={`admin-operation-card${accessOpen ? ' is-selected' : ''}`} key={id}><header><UserRoundCog /><div><b>{text(user.name, text(user.email, id))}</b><small>{text(user.email)} · {id}</small></div><Status value={user.state} /></header><div className="admin-operation-meta"><span>Email {user.emailVerified ? 'verified' : 'unverified'}</span><span>2FA {user.twoFactorEnabled ? 'enabled' : 'not enabled'}</span><span>{workspaces.length} workspace(s)</span><span>Created {dateTime(user.createdAt)}</span><span>Last activity {dateTime(user.lastActivityAt)}</span></div>{workspaces.length > 0 && <div className="admin-operation-linked">{workspaces.map((workspace) => <button type="button" key={text(workspace.id)} onClick={() => { window.history.pushState({}, '', `/admin/workspaces?workspace=${encodeURIComponent(text(workspace.id, ''))}`); window.dispatchEvent(new PopStateEvent('popstate')); }}>{text(workspace.name, text(workspace.id))} · {text(workspace.planId)}</button>)}</div>}<button type="button" aria-expanded={accessOpen} aria-controls="admin-user-access-inspector" onClick={() => void inspectUser(id)} disabled={Boolean(busy)}>{busy === `inspect-user:${id}` ? 'Opening…' : 'Manage access'}</button></article>;
    }) : <p className="empty-state">No users are registered.</p>}</div>{userDetail && <section ref={userInspectorRef} id="admin-user-access-inspector" tabIndex={-1} aria-label={`Access controls for ${text(userDetail.user.email, text(userDetail.user.name, selectedUserId))}`} className="admin-subject-inspector admin-user-inspector">
      <header><div><span>USER ACCESS INSPECTOR</span><h3>{text(userDetail.user.name, text(userDetail.user.email, selectedUserId))}</h3><small>{text(userDetail.user.email)} · immutable user id {text(userDetail.user.id, selectedUserId)}</small></div><div className="admin-subject-actions"><Status value={userDetail.user.state} />{canBanUsers && <button type="button" className="is-danger" aria-describedby="admin-operation-reason-help" title={authorizationBlocker || undefined} disabled={Boolean(authorizationBlocker) || Boolean(busy)} onClick={() => void operate(`user:${selectedUserId}`, `/api/v1/admin/users/${encodeURIComponent(selectedUserId)}/${text(userDetail.user.state, 'active') === 'banned' ? 'unban' : 'ban'}`, { reason: reason.trim(), confirm: true }, text(userDetail.user.state, 'active') === 'banned' ? 'User access restored.' : 'User access blocked.')}>{text(userDetail.user.state, 'active') === 'banned' ? 'Unban user' : 'Ban user'}</button>}</div></header>
      <div className="admin-operation-summary"><SummaryValue label="Effective plan" value={userDetail.effective?.effectivePlanId || userDetail.profile?.planId} /><SummaryValue label="Page credit limit" value={(userDetail.effective?.limits as AnyRecord | undefined)?.pageCredits} /><SummaryValue label="AI credit limit" value={(userDetail.effective?.limits as AnyRecord | undefined)?.aiRemediations} /><SummaryValue label="Workspaces" value={userDetail.workspaces?.length} /><SummaryValue label="Active grants" value={userDetail.grants?.filter((grant) => !grant.revokedAt).length} /><SummaryValue label="Billing state" value={userDetail.subscription?.status} /></div>
      {(canBanUsers || canManageUserCommerce) && confirmation}
      {canManageUserCommerce && <div className="admin-operation-forms admin-operation-forms--user"><form onSubmit={adjustCredits}><h4><Coins /> Credit adjustment</h4><p>Credits belong to this user across their authorized workspaces. Positive values add credits; negative values revoke them.</p><label><span>Ledger</span><select value={creditKind} onChange={(event) => setCreditKind(event.target.value as 'page' | 'ai')}><option value="page">Page credits</option><option value="ai">AI credits</option></select></label><label><span>Signed amount</span><input type="number" required step={1} min={-100000} max={100000} aria-invalid={Boolean(creditAmountIssue && creditAmount)} aria-describedby="credit-adjustment-requirement" value={creditAmount} onChange={(event) => setCreditAmount(event.target.value)} /></label><label><span>Optional expiry</span><input type="datetime-local" value={creditExpiry} onChange={(event) => setCreditExpiry(event.target.value)} /></label><small id="credit-adjustment-requirement" className={`admin-operation-requirement${creditActionBlocker ? '' : ' is-ready'}`} aria-live="polite">{creditActionBlocker || 'Ready to record this credit adjustment.'}</small><button title={creditActionBlocker || undefined} disabled={Boolean(creditActionBlocker) || Boolean(busy)}>Record adjustment</button></form>
      {canAssignPlan && <form onSubmit={assignPlan}><h4><ShieldAlert /> Permanent plan</h4><p>Changes the user's assigned plan. Provider billing remains separately reconciled.</p><label><span>Plan</span><select aria-label="Permanent plan" value={assignedPlan} onChange={(event) => setAssignedPlan(event.target.value as typeof assignedPlan)}><option value="free">Free</option><option value="signal">Signal</option><option value="studio">Studio</option><option value="enterprise">Enterprise</option></select></label><small className={`admin-operation-requirement${permanentPlanBlocker ? '' : ' is-ready'}`} aria-live="polite">{permanentPlanBlocker || 'Ready to change the assigned plan.'}</small><button title={permanentPlanBlocker || undefined} disabled={Boolean(permanentPlanBlocker) || Boolean(busy)}>Change user plan</button></form>}
      <form onSubmit={grantEntitlement}><h4><ShieldAlert /> Temporary plan</h4><p>Time-boxed user access; the underlying paid billing plan remains unchanged.</p><label><span>Plan</span><select value={grantPlan} onChange={(event) => setGrantPlan(event.target.value as typeof grantPlan)}><option value="signal">Signal</option><option value="studio">Studio</option><option value="enterprise">Enterprise</option></select></label><label><span>Required expiry</span><input type="datetime-local" required value={grantExpiry} onChange={(event) => setGrantExpiry(event.target.value)} /></label><small className={`admin-operation-requirement${temporaryPlanBlocker ? '' : ' is-ready'}`} aria-live="polite">{temporaryPlanBlocker || 'Ready to grant temporary plan access.'}</small><button title={temporaryPlanBlocker || undefined} disabled={Boolean(temporaryPlanBlocker) || Boolean(busy)}>Grant temporarily</button></form>
      <form onSubmit={grantFeatureOverride}><h4><ShieldCheck /> Feature override</h4><p>Launch-executable user module only; monitoring and white-label access cannot be granted.</p><label><span>Feature</span><select aria-label="Feature" value={featureModule} onChange={(event) => { const moduleId = event.target.value as FeatureOverrideModule; setFeatureModule(moduleId); setFeatureMode(moduleId === 'expert_review' ? 'operator_assisted' : 'automated'); }}>{FEATURE_OVERRIDE_MODULES.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</select></label><label><span>Execution mode</span><select aria-label="Execution mode" value={featureMode} onChange={(event) => setFeatureMode(event.target.value as FeatureOverrideMode)}><option value="automated">Automated</option><option value="operator_assisted">Operator assisted</option><option value="disabled">Disabled</option></select></label><label><span>Feature expiry</span><input aria-label="Feature expiry" type="datetime-local" required value={featureExpiry} onChange={(event) => setFeatureExpiry(event.target.value)} /></label><small className={`admin-operation-requirement${featureOverrideBlocker ? '' : ' is-ready'}`} aria-live="polite">{featureOverrideBlocker || 'Ready to grant this feature override.'}</small><button title={featureOverrideBlocker || undefined} disabled={Boolean(featureOverrideBlocker) || Boolean(busy)}>Grant feature override</button></form></div>}
      {!canManageUserCommerce && <div className="admin-operation-readonly"><ShieldCheck /><span>User plan, credits and feature access are read-only for this role.</span></div>}
      <div className="admin-operation-timeline"><h4>User-owned entitlement grants</h4>{userDetail.grants?.length ? userDetail.grants.map((grant) => <div key={text(grant.id)}><span><b>{text(grant.temporaryPlanId, 'Feature override')}</b><small>{text(grant.id)} · user {text(userDetail.user.email)} ({text(userDetail.user.id, selectedUserId)}) · expires {dateTime(grant.expiresAt)}</small></span><Status value={grant.revokedAt ? 'revoked' : 'active'} />{canManageEntitlements && !grant.revokedAt && <button type="button" className="is-danger" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`revoke:${text(grant.id)}`, `/api/v1/admin/entitlements/${encodeURIComponent(text(grant.id, ''))}/revoke`, { reason: reason.trim(), confirm: true }, 'User entitlement revoked without changing the paid subscription.')}>Revoke</button>}</div>) : <p className="empty-state">No user entitlement grants are registered.</p>}</div>
    </section>}</>}

    {view === 'workspaces' && <><div className="admin-operation-list">{workspaceRows.length ? workspaceRows : <p className="empty-state">No workspaces are registered.</p>}</div>{workspaceDetail && <section className="admin-workspace-inspector">
      <header><div><span>WORKSPACE INSPECTOR</span><h3>{text(workspaceDetail.workspace.name, selectedWorkspaceId)}</h3><small>{selectedWorkspaceId}</small></div><Status value={workspaceDetail.workspace.state} /></header>
      <div className="admin-operation-summary"><SummaryValue label="Sponsor plan" value={workspaceDetail.effective?.effectivePlanId} /><SummaryValue label="Entitlement owner" value={workspaceDetail.workspace.entitlementOwnerUserId} /><SummaryValue label="Billing state" value={workspaceDetail.subscription?.status} /><SummaryValue label="Projects" value={workspaceDetail.projects?.length} /><SummaryValue label="Recent scans" value={workspaceDetail.recentScans?.length} /><SummaryValue label="AI usage records" value={workspaceDetail.aiUsage?.length} /></div>
      {canReconcileBilling && workspaceDetail.subscription && <button type="button" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`reconcile:${selectedWorkspaceId}`, `/api/v1/admin/workspaces/${encodeURIComponent(selectedWorkspaceId)}/billing/reconcile`, { reason: reason.trim(), confirm: true }, 'Provider subscription reconciliation completed and was audited.')}><RefreshCw /> Reconcile billing state</button>}
      <div className="admin-operation-timeline"><h4>Failed scans and retry eligibility</h4>{workspaceDetail.failedScans?.length ? workspaceDetail.failedScans.map((scan) => <div key={text(scan.id)}><span><b>{text(scan.id)}</b><small>{text(scan.failureCode)} · {dateTime(scan.completedAt)}</small></span><Status value={scan.status} /></div>) : <p className="empty-state">No failed scans in the recent window.</p>}</div>
    </section>}</>}

    {view === 'scans' && <><div className="admin-operation-list">{filteredItems.length ? filteredItems.map((scan) => {
      const id = text(scan.id, ''); const workspaceId = text(scan.workspaceId, ''); const terminal = ['completed', 'partial', 'awaiting_operator', 'cancelled'].includes(text(scan.status, '').toLowerCase());
      return <article className="admin-operation-row" key={id}><Activity /><div><b>{id}</b><small>workspace {workspaceId} · {text(scan.failureCode, 'no failure code')} · {dateTime(scan.createdAt)}</small></div><Status value={scan.status} /><button type="button" onClick={() => void inspectScan(workspaceId, id)} disabled={busy === `inspect-scan:${id}`}>{busy === `inspect-scan:${id}` ? 'Opening…' : 'Inspect'}</button>{canCancelScans && !terminal && <button type="button" className="is-danger" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`cancel:${id}`, `/api/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/scans/${encodeURIComponent(id)}/cancel`, { reason: reason.trim(), confirm: true, idempotencyKey: '' }, 'Scan cancelled and reserved credits released.')}><CircleStop /> Cancel</button>}{canRetryScans && <button type="button" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`retry:${id}`, `/api/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/scans/${encodeURIComponent(id)}/retry`, { reason: reason.trim(), confirm: true, idempotencyKey: '' }, 'Safe retry requested on the existing scan authority.')}><RefreshCw /> Retry</button>}</article>;
    }) : <p className="empty-state">No scans match this register.</p>}</div>{scanDetail && <section className="admin-subject-inspector admin-scan-inspector"><header><div><span>SCAN EVIDENCE INSPECTOR</span><h3>{text(scanDetail.id)}</h3><small>workspace {text(scanDetail.workspaceId)} · project {text(scanDetail.projectId)}</small></div><Status value={scanDetail.status} /></header><div className="admin-operation-summary"><SummaryValue label="State" value={scanDetail.status} /><SummaryValue label="Failure" value={scanDetail.failureCode} /><SummaryValue label="Requested by" value={scanDetail.requestedByUserId} /><SummaryValue label="Entitlement user" value={scanDetail.entitlementUserId} /><SummaryValue label="Created" value={dateTime(scanDetail.createdAt)} /><SummaryValue label="Completed" value={dateTime(scanDetail.completedAt)} /></div><div className="admin-operation-timeline"><h4>Persisted manifest and progress</h4><pre>{JSON.stringify({ manifest: scanDetail.manifest || null, progress: scanDetail.progress || null }, null, 2)}</pre></div></section>}</>}

    {view === 'entitlements' && <div className="admin-operation-list">{filteredItems.length ? filteredItems.map((grant) => <article className="admin-operation-row" key={text(grant.id)}><ShieldCheck /><div><b>{text(grant.temporaryPlanId, 'Feature override')}</b><small>{text(grant.id)} · user {text(grant.userEmail, text(grant.userId))} ({text(grant.userId)}) · expires {dateTime(grant.expiresAt)}</small></div><Status value={grant.revokedAt ? 'revoked' : 'active'} />{canManageEntitlements && !grant.revokedAt && <button type="button" className="is-danger" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`revoke:${text(grant.id)}`, `/api/v1/admin/entitlements/${encodeURIComponent(text(grant.id, ''))}/revoke`, { reason: reason.trim(), confirm: true }, 'User entitlement revoked without changing the paid subscription.')}>Revoke</button>}</article>) : <p className="empty-state">No entitlement grants match this register.</p>}</div>}

    {view === 'redeem' && <>{canManageRedeem && <form className="admin-redeem-form" onSubmit={createRedeem}><h3><KeyRound /> Create hashed redeem code</h3><div><label><span>Plaintext code</span><input name="code" minLength={6} maxLength={64} pattern="[A-Za-z0-9_-]+" required autoComplete="off" /></label><label><span>Temporary plan</span><select name="temporaryPlan" defaultValue="studio"><option value="">No plan override</option><option value="signal">Signal</option><option value="studio">Studio</option><option value="enterprise">Enterprise</option></select></label><label><span>Duration days</span><input name="durationDays" type="number" min="1" max="366" defaultValue="30" /></label><label><span>Global max</span><input name="maxGlobalRedemptions" type="number" min="1" defaultValue="20" required /></label><label><span>Per workspace</span><input name="maxPerWorkspace" type="number" min="1" max="100" defaultValue="1" required /></label><label><span>Page credits</span><input name="bonusPageCredits" type="number" min="0" defaultValue="0" /></label><label><span>AI credits</span><input name="bonusAiCredits" type="number" min="0" defaultValue="0" /></label><label><span>Starts at</span><input name="startsAt" type="datetime-local" /></label><label><span>Expires at</span><input name="expiresAt" type="datetime-local" /></label><label className="is-wide"><span>Admin note</span><input name="adminNote" maxLength={2000} /></label></div><button disabled={!hasConfirmation || Boolean(busy)}>{busy === 'redeem:create' ? 'Creating…' : 'Create code'}</button></form>}
    <div className="admin-operation-list">{filteredCodes.length ? filteredCodes.map((code) => <article className="admin-operation-row" key={text(code.id)}><KeyRound /><div><b>{text(code.codeHint)}</b><small>{text(code.id)} · {text(code.redemptionCount, '0')} redemptions · expires {dateTime(code.expiresAt)}</small></div><Status value={code.revokedAt ? 'revoked' : code.active ? 'active' : 'disabled'} />{canManageRedeem && !code.revokedAt && <><button type="button" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`toggle:${text(code.id)}`, `/api/v1/admin/redeem-codes/${encodeURIComponent(text(code.id, ''))}/${code.active ? 'disable' : 'enable'}`, { reason: reason.trim(), confirm: true }, code.active ? 'Redeem code disabled.' : 'Redeem code enabled.')}>{code.active ? 'Disable' : 'Enable'}</button><button type="button" className="is-danger" disabled={!hasConfirmation || Boolean(busy)} onClick={() => void operate(`revoke-code:${text(code.id)}`, `/api/v1/admin/redeem-codes/${encodeURIComponent(text(code.id, ''))}/revoke`, { reason: reason.trim(), confirm: true }, 'Redeem code and active grants revoked.')}>Revoke</button></>}</article>) : <p className="empty-state">No redeem codes match this register.</p>}</div></>}

    {view === 'audit' && <div className="admin-operation-list">{filteredItems.length ? filteredItems.map((event) => <AuditRow event={event} key={text(event.id)} />) : <p className="empty-state">No audit events match this register.</p>}</div>}
  </section>;
}
