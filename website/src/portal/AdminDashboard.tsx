import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Boxes, CheckCircle2, ClipboardCheck, Database, FileSearch, FileText,
  Fingerprint, FlaskConical, Gauge, KeyRound, LayoutDashboard, LifeBuoy, Plug, ScanLine, Settings, ShieldCheck, Users, UsersRound, XCircle,
} from 'lucide-react';
import PortalShell, { type PortalNavItem } from './PortalShell';
import SecuritySetup from './SecuritySetup';
import ExpertReviewConsole from './ExpertReviewConsole';
import AdminEngineLab from './AdminEngineLab';
import AdminEngineLabResults from './AdminEngineLabResults';
import AdminSupportInbox from './AdminSupportInbox';
import AdminOperationsConsole, { type OperationsView } from './AdminOperationsConsole';
import AdminSecurity from './AdminSecurity';
import { ApiError, apiFetch, jsonRequest } from './api';
import { navigate, useRoutePath } from './router';
import { adminPathForView, adminViewFromPath, type AdminView } from './adminRoutes';

type AdminIdentity = {
  actorId: string;
  email?: string;
  role: string;
  permissions: string[];
  via: string;
  webAuthnRequired?: boolean;
  webAuthnCredentialCount?: number;
  webAuthnEnrollmentRequired?: boolean;
};
type AdminActivity = { id: string; action: string; actorId?: string; entityType?: string; entityId?: string; createdAt: string };
type Health = { id: string; label: string; status: string; value: string };
type Overview = {
  totals: { users: number; scans: number; reports: number; findings: number; critical: number };
  activity: AdminActivity[];
  health: Health[];
};
type OperatorTask = { id: string; workspaceId: string; scanId: string; moduleId: string; status: string; dueAt?: string; createdAt: string };

const nav: PortalNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'workspaces', label: 'Workspaces', icon: UsersRound },
  { id: 'scans', label: 'Scans', icon: Activity },
  { id: 'entitlements', label: 'Entitlements', icon: ShieldCheck },
  { id: 'redeem', label: 'Redeem Codes', icon: KeyRound },
  { id: 'audit', label: 'Audit Log', icon: ClipboardCheck },
  { id: 'findings', label: 'Findings', icon: FileSearch },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'support', label: 'Support Inbox', icon: LifeBuoy },
  { id: 'expert_reviews', label: 'Expert Reviews', icon: ClipboardCheck },
  { id: 'engine_lab', label: 'Engine Test Lab', icon: FlaskConical },
  { id: 'lab_results', label: 'Lab Results', icon: FileSearch },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'security', label: 'Security', icon: Fingerprint },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const NAV_PERMISSION: Record<AdminView, string> = {
  dashboard: 'system.read',
  users: 'users.read',
  workspaces: 'workspaces.read',
  scans: 'scans.read',
  entitlements: 'entitlements.read',
  redeem: 'redeem.read',
  audit: 'audit.read',
  findings: 'scans.read',
  reports: 'reports.read',
  support: 'support.read',
  expert_reviews: 'expert_reviews.read',
  engine_lab: 'engine_lab.read',
  lab_results: 'engine_lab.read',
  integrations: 'webhooks.read',
  security: 'security.self.read',
  settings: 'security.self.read',
};

const actionLabels: Record<string, string> = {
  'project.created': 'Project created',
  'scan.queued': 'Scan queued',
  'operator_task.completed': 'Operator task completed',
  'workspace.plan_changed': 'Workspace plan changed',
};

function AdminRouteNotFound({ path }: { path: string }) {
  return <section className="aux-admin-route-not-found" aria-labelledby="admin-route-not-found-title">
    <span>404 / CONTROL PLANE</span>
    <h2 id="admin-route-not-found-title">This admin route is not registered.</h2>
    <p><code>{path}</code> is not an available control-plane view. Your administrator session remains protected; no resource was opened.</p>
    <div><button type="button" className="aux-dark-button" onClick={() => navigate('/admin')}>Open dashboard</button><button type="button" className="aux-light-button" onClick={() => navigate('/admin/support')}>Open support inbox</button></div>
  </section>;
}

export default function AdminDashboard() {
  const [active, setActive] = useState<AdminView | 'not_found'>(() => adminViewFromPath(window.location.pathname) || 'not_found');
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tasks, setTasks] = useState<OperatorTask[]>([]);
  const [resources, setResources] = useState<Array<Record<string, unknown>>>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<'2fa' | 'denied' | null>(null);
  const [error, setError] = useState('');
  const [busyTask, setBusyTask] = useState('');
  const routePath = useRoutePath();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await apiFetch<{ admin: AdminIdentity }>('/api/v1/admin/me');
      const [snapshot, taskData] = await Promise.all([
        apiFetch<Overview>('/api/v1/admin/overview'),
        me.admin.permissions.includes('expert_reviews.read')
          ? apiFetch<{ tasks: OperatorTask[] }>('/api/v1/admin/operator-tasks')
          : Promise.resolve({ tasks: [] as OperatorTask[] }),
      ]);
      setIdentity(me.admin);
      setOverview(snapshot);
      setTasks(taskData.tasks);
      setGate(null);
      setError('');
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) { navigate('/login', true); return; }
      if (apiError.code === 'ADMIN_2FA_REQUIRED') { setGate('2fa'); return; }
      if (['ADMIN_ROLE_REQUIRED', 'ADMIN_PERMISSION_DENIED'].includes(apiError.code || '')) { setGate('denied'); return; }
      setError(apiError.message || 'Admin data could not be loaded.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const next = adminViewFromPath(routePath);
    if (!next) { setActive('not_found'); return; }
    const canonical = adminPathForView(next);
    if (routePath !== canonical) window.history.replaceState({}, '', `${canonical}${window.location.search}${window.location.hash}`);
    setActive(next);
  }, [routePath]);
  useEffect(() => {
    if (!['findings', 'reports'].includes(active)) { setResources([]); return; }
    setResourcesLoading(true);
    apiFetch<{ resources: Array<Record<string, unknown>> }>(`/api/v1/admin/resources/${active}`)
      .then((result) => setResources(result.resources))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Admin records could not be loaded.'))
      .finally(() => setResourcesLoading(false));
  }, [active]);
  const visibleNav = useMemo(() => {
    if (!identity) return nav.filter((item) => item.id === 'dashboard');
    return nav.filter((item) => identity.permissions.includes(NAV_PERMISSION[item.id as AdminView]));
  }, [identity]);
  useEffect(() => {
    if (!identity || active === 'not_found') return;
    if (!visibleNav.some((item) => item.id === active)) navigate('/admin', true);
  }, [active, identity, visibleNav]);

  async function completeTask(taskId: string) {
    const reason = window.prompt('Reason for completing this operator task')?.trim();
    if (!reason || !window.confirm(`Confirm completion of operator task ${taskId}?`)) return;
    setBusyTask(taskId);
    try {
      await apiFetch(`/api/v1/admin/operator-tasks/${taskId}/complete`, jsonRequest('POST', { notes: 'Completed from the protected admin console.', reason, confirm: true }));
      await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Task could not be completed.'); }
    finally { setBusyTask(''); }
  }

  if (gate === '2fa') return <main className="admin-gate"><div className="admin-gate__panel"><ShieldCheck /><span>PROTECTED ADMIN AREA</span><h1>Two-factor authentication required.</h1><p>Your account has an administrator role, but the control plane remains locked until you verify an authenticator.</p><SecuritySetup required onComplete={() => void load()} /></div></main>;
  if (gate === 'denied') return <main className="admin-gate"><div className="admin-gate__panel"><XCircle /><span>ACCESS DENIED</span><h1>This account is not an administrator.</h1><p>Signing in does not grant admin access. Roles are assigned server-side and cannot be changed from the browser.</p><button onClick={() => navigate('/app')}>Return to workspace</button></div></main>;

  const statusCard = <div className="system-status-mini"><ShieldCheck /><div><small>System status</small><b>{overview?.health.every((row) => row.status === 'operational') ? 'All systems operational' : 'Configuration review'}</b></div></div>;

  function handleNavigate(next: string) {
    const view = visibleNav.some((item) => item.id === next) ? next as AdminView : null;
    if (!view) return;
    setActive(view);
    navigate(adminPathForView(view));
  }

  return <PortalShell admin active={active} nav={visibleNav} onNavigate={handleNavigate} footerCard={statusCard} identity={{ name: 'Admin', email: identity?.email, role: identity?.role }}>
    {loading && !overview ? <div className="portal-loading"><i />Loading protected console</div> : <>
      {active === 'not_found' ? <AdminRouteNotFound path={routePath} /> : <>
      <header className="portal-heading portal-heading--proof"><div><span>{active === 'dashboard' ? 'CONTROL PLANE / AUDIT RECORDER' : 'CONTROL PLANE / PROTECTED REGISTER'}</span><h1>{active === 'dashboard' ? 'Admin proof room' : visibleNav.find((item) => item.id === active)?.label}</h1><p>{active === 'dashboard' ? 'Live platform totals, operator actions and system checks on one immutable trace.' : 'Protected operational controls and platform records.'}</p></div></header>
      {error && <div className="portal-alert" role="alert">{error}</div>}
      {active === 'dashboard' && overview && <>
        <section className="admin-proof-register"><div><span>01 / USERS</span><strong>{overview.totals.users.toLocaleString()}</strong><small>live total</small></div><div><span>02 / SCANS</span><strong>{overview.totals.scans.toLocaleString()}</strong><small>live total</small></div><div><span>03 / FINDINGS</span><strong>{overview.totals.findings.toLocaleString()}</strong><small>live total</small></div><div className="is-critical"><span>04 / CRITICAL</span><strong>{overview.totals.critical.toLocaleString()}</strong><small>requires attention</small></div></section>
        <section className="admin-recorder">
          <article className="admin-recorder__trace"><div className="portal-panel__title"><div><span>CONTINUOUS TRACE</span><h2>Recent operator activity</h2></div><em>{overview.activity.length} marks</em></div><div className="activity-list">{overview.activity.length ? overview.activity.map((item, index) => <div key={item.id}><span className="activity-index">{String(index + 1).padStart(2, '0')}</span><span className="activity-icon"><Activity /></span><span><b>{actionLabels[item.action] || item.action}</b><small>{item.entityType || 'platform'} {item.entityId ? `- ${item.entityId}` : ''}</small></span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>) : <p className="empty-state">No audit activity yet.</p>}</div></article>
          <article className="admin-recorder__health"><div className="portal-panel__title"><div><span>PRESS CHANNELS</span><h2>System health</h2></div><span className="health-summary"><i />Live checks</span></div><div className="health-list">{overview.health.map((row) => <div key={row.id}><span className="activity-icon">{row.id === 'database' ? <Database /> : row.id === 'workers' ? <Boxes /> : <Gauge />}</span><span><b>{row.label}</b><small className={row.status === 'operational' ? 'is-good' : 'is-review'}>{row.status.replaceAll('_', ' ')}</small></span><em>{row.value}</em><i className={row.status === 'operational' ? 'is-good' : 'is-review'} /></div>)}</div></article>
        </section>
      </>}
      {active === 'support' && <AdminSupportInbox role={identity?.role} permissions={identity?.permissions || []} />}
      {['users', 'workspaces', 'scans', 'entitlements', 'redeem', 'audit'].includes(active) && <AdminOperationsConsole view={active as OperationsView} permissions={identity?.permissions || []} />}
      {active === 'expert_reviews' && <section className="portal-panel admin-resource"><ExpertReviewConsole actorId={identity?.actorId} canFinalize={identity?.permissions.includes('expert_reviews.finalize') || false} canPublish={identity?.permissions.includes('expert_reviews.publish') || false} /></section>}
      {active === 'engine_lab' && <AdminEngineLab />}
      {active === 'lab_results' && <AdminEngineLabResults />}
      {active === 'security' && <AdminSecurity permissions={identity?.permissions || []} />}
      {active !== 'dashboard' && active !== 'support' && active !== 'expert_reviews' && active !== 'engine_lab' && active !== 'lab_results' && active !== 'security' && !['users', 'workspaces', 'scans', 'entitlements', 'redeem', 'audit'].includes(active) && <section className="portal-panel admin-resource"><div className="portal-panel__title"><div><span>ADMIN CONTROL</span><h2>{visibleNav.find((item) => item.id === active)?.label}</h2></div></div>
        {active === 'scans' || active === 'findings' || active === 'reports' ? <div className="resource-stats"><div><strong>{overview?.totals.scans ?? 0}</strong><span>Total scans</span></div><div><strong>{overview?.totals.findings ?? 0}</strong><span>Findings</span></div><div><strong>{overview?.totals.reports ?? 0}</strong><span>Reports</span></div></div> : null}
        {active === 'users' && <div className="resource-stats"><div><strong>{overview?.totals.users ?? 0}</strong><span>Registered users</span></div><div><strong>{identity?.role || '-'}</strong><span>Your role</span></div></div>}
        {active === 'integrations' && overview && <div className="health-list health-list--wide">{overview.health.filter((row) => ['storage', 'integrations'].includes(row.id)).map((row) => <div key={row.id}><CheckCircle2 /><span><b>{row.label}</b><small>{row.status.replaceAll('_', ' ')}</small></span><em>{row.value}</em></div>)}</div>}
        {active === 'settings' && <div className="admin-policy"><ShieldCheck /><div><h3>Admin security policy</h3><p>Administrator authority is enforced by the API using a server-side role record. Every interactive admin must also pass an authenticator challenge.</p></div></div>}
        {['users', 'scans', 'findings', 'reports'].includes(active) && <div className="admin-records">{resourcesLoading ? <p className="empty-state">Loading records...</p> : resources.length ? resources.map((record, index) => {
          const title = String(record.name || record.title || record.id || `${active} record ${index + 1}`);
          const detail = String(record.email || record.pageUrl || record.workspaceId || record.scanId || record.status || 'Platform record');
          const state = String(record.severity || record.status || (record.twoFactorEnabled ? '2FA enabled' : record.emailVerified ? 'Email verified' : 'Registered'));
          return <div className="admin-record" key={String(record.id || record.fingerprint || index)}><span className="activity-icon">{active === 'users' ? <Users /> : active === 'reports' ? <FileText /> : active === 'findings' ? <FileSearch /> : <Activity />}</span><span><b>{title}</b><small>{detail}</small></span><em>{state}</em><time>{record.createdAt ? new Date(String(record.createdAt)).toLocaleString() : ''}</time></div>;
        }) : <p className="empty-state">No {active} records yet.</p>}</div>}
        {identity?.permissions.includes('expert_reviews.read') && <div className="operator-queue"><div className="portal-panel__title"><h3>Operator-assisted queue</h3><span>{tasks.length} pending</span></div>{tasks.length ? tasks.map((task) => <div className="operator-task" key={task.id}><ScanLine /><span><b>{task.moduleId.replaceAll('_', ' ')}</b><small>Scan {task.scanId} - workspace {task.workspaceId}</small></span><time>{task.dueAt ? new Date(task.dueAt).toLocaleDateString() : 'No due date'}</time>{identity.permissions.includes('expert_reviews.manage') && <button disabled={busyTask === task.id} onClick={() => void completeTask(task.id)}>{busyTask === task.id ? 'Saving...' : 'Complete'}</button>}</div>) : <p className="empty-state">No operator-assisted tasks are waiting.</p>}</div>}
      </section>}
      </>}
    </>}
  </PortalShell>;
}
