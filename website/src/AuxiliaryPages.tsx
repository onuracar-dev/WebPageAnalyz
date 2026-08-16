import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle, ArrowRight, Check, ChevronDown, CircleHelp, Clock3,
  LifeBuoy, Mail, MapPin, RefreshCw, ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { ApiError, apiFetch, jsonRequest } from './portal/api';
import { BrandMark, PortalButtonLink } from './portal/Brand';
import LegalContent, { type LegalKind } from './LegalContent';
import './auxiliary.css';

type AuxiliaryKind = 'faq' | 'status' | 'contact' | 'forgot-password' | 'verify-email' | LegalKind | 'shared-report' | '404';

type StatusComponent = { id: string; label: string; status: string; detail?: string };
type PublicStatusPayload = { overall?: string; checkedAt?: string; components?: StatusComponent[] };
// This is the unauthenticated, redacted public contract. Workspace details
// live at /api/v1/status/details and must never be rendered on this page.
const PUBLIC_STATUS_ENDPOINT = '/api/v1/status';

type SharedReportRecord = {
  id?: string;
  version?: number;
  status?: string;
  locale?: string;
  createdAt?: string;
  publishedAt?: string;
  payload?: unknown;
};

type SharedReportView = {
  id: string;
  version: string;
  status: string;
  publishedAt?: string;
  terminalState: string;
  requestedPages?: number;
  completedPages?: number;
  incompletePages?: number;
  failedPages?: number;
  unavailablePages?: number;
  modules: Array<{ id: string; status: string; engines: string }>;
  pages: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sharedPageLabel(value: unknown) {
  try {
    const candidate = typeof value === 'string'
      ? value
      : record(value).url || record(value).href || record(value).location;
    if (typeof candidate !== 'string') return '';
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.origin}${url.pathname}`.slice(0, 260);
  } catch { return ''; }
}

function normalizeSharedReport(input: SharedReportRecord): SharedReportView {
  const payload = record(input.payload);
  const summary = record(payload.summary || input);
  const modules = record(payload.modules);
  const pages = Array.isArray(payload.pages) ? payload.pages.map(sharedPageLabel).filter(Boolean).slice(0, 24) : [];
  return {
    id: typeof input.id === 'string' ? input.id : 'shared-report',
    version: input.version ? `v${input.version}` : 'Published',
    status: typeof input.status === 'string' ? input.status : 'published',
    publishedAt: typeof input.publishedAt === 'string' ? input.publishedAt : undefined,
    terminalState: typeof summary.terminalState === 'string' ? summary.terminalState : (typeof input.status === 'string' ? input.status : 'published'),
    requestedPages: numberValue(summary.requestedPages),
    completedPages: numberValue(summary.completedPages),
    incompletePages: numberValue(summary.incompletePages),
    failedPages: numberValue(summary.failedPages),
    unavailablePages: numberValue(summary.unavailablePages),
    modules: Object.entries(modules).slice(0, 18).map(([id, value]) => {
      const module = record(value);
      const engines = Array.isArray(module.engines) ? `${module.engines.length} engine${module.engines.length === 1 ? '' : 's'}` : 'Evidence recorded';
      return { id: id.replaceAll('_', ' '), status: typeof module.status === 'string' ? module.status : 'recorded', engines };
    }),
    pages,
  };
}

const faq = [
  { q: 'What does WebPageAnalyz actually inspect?', a: 'WPA runs evidence-linked website analysis against a verified public target. Depending on access and availability, the workspace can show route and response evidence, page/runtime signals, performance and accessibility measurements, Visual UX and GEO heuristics, read-only Journey Test results, passive security checks, and source-audit availability. A missing engine is shown as unavailable rather than silently presented as a pass.' },
  { q: 'Do I need to install anything on my website?', a: 'No. WebPageAnalyz is a hosted analysis and reporting service. Public-link analysis can start with a target URL; ownership verification is an optional boundary for capabilities that require it. WPA does not deliver your source code or ask you to install an agent.' },
  { q: 'Can a report claim that every check passed?', a: 'No. A report can be complete, partial, failed, or unavailable at the module and page level. Evidence is attached to the result where possible, and the workspace keeps incomplete coverage visible so a missing provider or runtime does not become a false green.' },
  { q: 'What is Expert Review?', a: 'Expert Review is a human/admin-assigned service workflow. It is not automatically granted by choosing a plan name, and it does not turn automated or heuristic output into human approval. A review request remains visible as a service state until an authorized reviewer acts.' },
  { q: 'How is workspace data handled?', a: 'Workspace and report access are authenticated and scoped server-side. The public Privacy, KVKK and Subprocessor pages load the deployed operator, version and provider register from the server; when that configuration is missing they fail visibly instead of inventing a legal identity.' },
  { q: 'What should I include when asking for support?', a: 'Include the case subject, what you expected, what happened, and a non-sensitive target or report reference if relevant. Do not include passwords, API keys, cookies, authentication codes, or other secrets. Support cases preserve the exchange so a later reply can be checked against the same context.' },
];

function dateTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function PublicFrame({ kind, children }: { kind: AuxiliaryKind; children: React.ReactNode }) {
  return <main className={`aux-public aux-public--${kind}`}><header className="aux-public__nav"><BrandMark /><nav aria-label="Public navigation"><PortalButtonLink href="/faq">FAQ</PortalButtonLink><PortalButtonLink href="/status">Status</PortalButtonLink><PortalButtonLink href="/login">Sign in</PortalButtonLink><PortalButtonLink href="/register" className="aux-public__start">Start</PortalButtonLink></nav></header>{children}<footer className="aux-public__footer"><span>WPA / EVIDENCE-LED ANALYSIS</span><nav aria-label="Legal navigation"><PortalButtonLink href="/terms">Terms</PortalButtonLink><PortalButtonLink href="/privacy">Privacy</PortalButtonLink><PortalButtonLink href="/kvkk">KVKK</PortalButtonLink><PortalButtonLink href="/acceptable-use">Acceptable use</PortalButtonLink><PortalButtonLink href="/refund">Refunds</PortalButtonLink><PortalButtonLink href="/subprocessors">Subprocessors</PortalButtonLink><PortalButtonLink href="/contact">Contact</PortalButtonLink></nav></footer></main>;
}

function PageHeader({ index, eyebrow, title, detail }: { index: string; eyebrow: string; title: string; detail: string }) {
  return <header className="aux-public__heading"><span className="aux-index">{index}</span><div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div></header>;
}

export function FaqPage() {
  return <PublicFrame kind="faq"><section className="aux-public__body aux-faq"><PageHeader index="01 / QUESTIONS" eyebrow="PUBLIC REFERENCE" title="Answers, with the edges left visible." detail="A short map of what WPA does, what it needs, and where the system will deliberately say unavailable." /><div className="aux-faq__list">{faq.map((item, index) => <details key={item.q} open={index === 0}><summary><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.q}</strong><ChevronDown aria-hidden="true" /></summary><div><p>{item.a}</p></div></details>)}</div><section className="aux-callout"><LifeBuoy /><div><span>STILL NEED A HUMAN THREAD?</span><h2>Bring the case into your workspace.</h2><p>Sign in to attach a URL or report reference, see the ticket history, and keep replies with the evidence.</p></div><PortalButtonLink href="/login" className="aux-dark-button">Open support <ArrowRight /></PortalButtonLink></section></section></PublicFrame>;
}

export function StatusPage() {
  const [components, setComponents] = useState<StatusComponent[]>([]);
  const [overall, setOverall] = useState('unknown');
  const [checkedAt, setCheckedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const result = await apiFetch<PublicStatusPayload>(PUBLIC_STATUS_ENDPOINT);
      setOverall(result.overall || 'unknown'); setCheckedAt(result.checkedAt || ''); setComponents(result.components || []);
    } catch (requestError) {
      setOverall('unavailable');
      setError(requestError instanceof ApiError ? requestError.message : 'The live status endpoint could not be reached.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);
  const operational = overall === 'operational';
  return <PublicFrame kind="status"><section className="aux-public__body aux-status"><PageHeader index="02 / SIGNAL" eyebrow="PUBLIC STATUS" title="A clear read of the system." detail="This page reports the deployed status endpoint. It does not infer health from a static illustration or a cached promise." /><div className="aux-status__panel"><header><div><span>OVERALL</span><strong className={`aux-status-word aux-status-word--${overall}`}>{loading ? 'Checking…' : overall.replaceAll('_', ' ')}</strong></div><button type="button" className="aux-light-button" onClick={() => void load()} disabled={loading}><RefreshCw /> Check again</button></header>{error && <div className="aux-alert" role="alert"><AlertCircle />{error}</div>}<div className="aux-status__rail">{components.length ? components.map((component) => <article key={component.id}><span className={`aux-status-dot aux-status-dot--${component.status}`} aria-hidden="true" /><div><strong>{component.label}</strong><small>{component.detail || component.status.replaceAll('_', ' ')}</small></div><em>{component.status.replaceAll('_', ' ')}</em></article>) : <div className="aux-status__empty"><TriangleAlert /><p>{loading ? 'Waiting for the status service…' : 'No component detail was returned.'}</p></div>}</div><footer><span><Clock3 /> Last checked {checkedAt ? dateTime(checkedAt) : 'not available'}</span><span>{operational ? <><Check /> Public status is operational</> : <><TriangleAlert /> Treat unavailable checks as unproven</>}</span></footer></div></section></PublicFrame>;
}

function SharedReportState({ state, token }: { state: 'invalid' | 'not-found' | 'expired' | 'error'; token: string }) {
  const copy = state === 'expired'
    ? ['This share link has expired.', 'The report is no longer available through this public address. Ask the owner to issue a fresh link.']
    : state === 'not-found'
      ? ['This shared report was not found.', 'The link may be incomplete, revoked, or no longer available. No workspace information was disclosed.']
      : state === 'invalid'
        ? ['This share link is not valid.', 'Use the complete link from the report owner. Tokens are checked before any request is sent.']
        : ['The report could not be opened.', 'The public report service did not respond with a usable report. Try again later or request a fresh link.'];
  return <section className="aux-shared-report__state" role="alert"><AlertCircle /><span>PUBLIC REPORT / UNAVAILABLE</span><h2>{copy[0]}</h2><p>{copy[1]}</p><code>{token ? `${token.slice(0, 8)}…` : 'missing token'}</code><PortalButtonLink href="/faq" className="aux-light-button">Read the FAQ <ArrowRight /></PortalButtonLink></section>;
}

export function SharedReportPage({ token }: { token: string }) {
  const validToken = /^[A-Za-z0-9_-]{16,256}$/.test(token);
  const [state, setState] = useState<'loading' | 'success' | 'invalid' | 'not-found' | 'expired' | 'error'>(validToken ? 'loading' : 'invalid');
  const [report, setReport] = useState<SharedReportView | null>(null);

  useEffect(() => {
    if (!validToken) return undefined;
    let cancelled = false;
    void apiFetch<{ report?: SharedReportRecord }>(`/api/v1/shared-reports/${encodeURIComponent(token)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.report) { setState('error'); return; }
        setReport(normalizeSharedReport(result.report));
        setState('success');
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof ApiError && (requestError.code === 'SHARED_REPORT_EXPIRED' || /expired/i.test(requestError.message))) setState('expired');
        else if (requestError instanceof ApiError && requestError.status === 404) setState('not-found');
        else setState('error');
      });
    return () => { cancelled = true; };
  }, [token, validToken]);

  return <PublicFrame kind="shared-report"><section className="aux-public__body aux-shared-report"><PageHeader index="08 / SHARED REPORT" eyebrow="READ-ONLY EVIDENCE" title="A report, opened at its public edge." detail="This view shows only the evidence summary carried by the share contract. Workspace navigation, private account data and operator controls stay outside the link." />
    {state === 'loading' && <section className="aux-shared-report__state" role="status" aria-live="polite"><span>PUBLIC REPORT / CHECKING</span><h2>Opening the evidence register…</h2><p>The token is being checked by the report service. No private workspace data is requested by the browser.</p><i className="aux-shared-report__loader" aria-hidden="true" /></section>}
    {state !== 'loading' && state !== 'success' && <SharedReportState state={state} token={token} />}
    {state === 'success' && report && <article className="aux-shared-report__content">
      <header className="aux-shared-report__hero"><div><span>REPORT / {report.id}</span><h2>Evidence is sealed for reading.</h2><p>Published {report.publishedAt ? dateTime(report.publishedAt) : 'date not supplied'} · {report.version} · {report.status.replaceAll('_', ' ')}</p></div><span className="aux-shared-report__badge"><Check /> Public link</span></header>
      <dl className="aux-shared-report__metrics"><div><dt>Terminal state</dt><dd>{report.terminalState.replaceAll('_', ' ')}</dd></div><div><dt>Requested pages</dt><dd>{report.requestedPages ?? '—'}</dd></div><div><dt>Completed pages</dt><dd>{report.completedPages ?? '—'}</dd></div><div><dt>Incomplete / unavailable</dt><dd>{[report.incompletePages, report.unavailablePages].some((value) => value !== undefined) ? `${report.incompletePages ?? 0} / ${report.unavailablePages ?? 0}` : '—'}</dd></div></dl>
      <section className="aux-shared-report__section"><header><span>01 / MODULE REGISTER</span><h3>What the report recorded</h3></header>{report.modules.length ? <div className="aux-shared-report__table-wrap"><table><thead><tr><th scope="col">Module</th><th scope="col">State</th><th scope="col">Coverage</th></tr></thead><tbody>{report.modules.map((module) => <tr key={module.id}><th scope="row">{module.id}</th><td><span className="aux-shared-report__status-dot" />{module.status.replaceAll('_', ' ')}</td><td>{module.engines}</td></tr>)}</tbody></table></div> : <p className="aux-shared-report__empty">The public payload did not include module-level detail.</p>}</section>
      <section className="aux-shared-report__section"><header><span>02 / PAGE EVIDENCE</span><h3>Pages in the public summary</h3></header>{report.pages.length ? <ol className="aux-shared-report__pages">{report.pages.map((page, index) => <li key={`${page}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><code>{page}</code></li>)}</ol> : <p className="aux-shared-report__empty">No page list was included in this public summary.</p>}</section>
      <footer className="aux-shared-report__footnote"><span><Check /> Read-only public view</span><span>Private workspace data is intentionally omitted.</span></footer>
    </article>}
  </section></PublicFrame>;
}

export function ContactPage() {
  const enterprise = new URLSearchParams(window.location.search).get('plan') === 'enterprise';
  return <PublicFrame kind="contact"><section className="aux-public__body aux-contact"><PageHeader index="03 / PATH" eyebrow={enterprise ? 'ENTERPRISE SALES' : 'CONTACT'} title={enterprise ? 'Start the Enterprise conversation.' : 'The shortest path to a useful answer.'} detail={enterprise ? 'Enterprise is an invitation plan. This public handoff preserves the plan context without starting a charge or pretending that a human review is automatic.' : 'Customer support starts inside the authenticated workspace so URLs, reports and replies remain scoped to the right account.'} /><div className="aux-contact__grid">{enterprise ? <article><Mail /><span>ENTERPRISE INQUIRY</span><h2>Reach the sales inbox.</h2><p>Describe the organization, expected website volume and the capabilities you need. Do not include credentials, source archives or other secrets.</p><a href="mailto:onuracar.work@gmail.com?subject=WebPageAnalyz%20Enterprise%20inquiry" className="aux-dark-button">Email Enterprise sales <ArrowRight /></a></article> : <article><LifeBuoy /><span>WORKSPACE SUPPORT</span><h2>Keep a durable case.</h2><p>Create a case after signing in. Include the target or report reference only when it helps; never include credentials or secrets.</p><PortalButtonLink href="/login" className="aux-dark-button">Sign in to support <ArrowRight /></PortalButtonLink></article>}<article><CircleHelp /><span>BEFORE YOU WRITE</span><h2>Check the public reference.</h2><p>FAQ explains the boundaries of the analysis, unavailable states, ownership verification and human Expert Review.</p><PortalButtonLink href="/faq" className="aux-light-button">Read FAQ <ArrowRight /></PortalButtonLink></article></div><div className="aux-contact__note"><Mail /><span>{enterprise ? 'This link opens a manual sales email; it does not create an account, activate Enterprise, or trigger a charge.' : 'For account access issues, use the sign-in recovery path. Public email addresses are not a substitute for a scoped support case.'}</span></div></section></PublicFrame>;
}

function AuthAuxPage({ kind }: { kind: 'forgot-password' | 'verify-email' }) {
  const reset = kind === 'forgot-password';
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetToken, setResetToken] = useState(() => reset ? new URLSearchParams(window.location.search).get('token') || '' : '');
  const [callbackURL, setCallbackURL] = useState('');
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reset) return;
    setBusy(true); setMessage(''); setError('');
    try {
      // Better Auth accepts a relative redirect and validates absolute URLs
      // against trustedOrigins. A relative callback is valid in every hosted
      // origin and avoids coupling recovery to a dev-server port.
      await apiFetch('/api/auth/request-password-reset', jsonRequest('POST', { email: email.trim(), redirectTo: '/forgot-password' }));
      setMessage('If this address belongs to an account, the configured auth service will send the next step. No account existence was disclosed here.');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'Password recovery is not available from this deployment. Nothing was sent.');
    } finally { setBusy(false); }
  }

  async function submitNewPassword(event: FormEvent) {
    event.preventDefault();
    if (!resetToken || newPassword.length < 8) { setError('Use at least eight characters for the new password.'); return; }
    setBusy(true); setMessage(''); setError('');
    try {
      await apiFetch('/api/auth/reset-password', jsonRequest('POST', { newPassword, token: resetToken }));
      setNewPassword(''); setResetToken('');
      window.history.replaceState({}, '', '/forgot-password');
      setMessage('Your password was updated. You can sign in with the new password.');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'The password could not be updated. The token may have expired.');
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (reset) {
      setResetToken(new URLSearchParams(window.location.search).get('token') || '');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const rawCallback = params.get('callbackURL') || '';
    if (rawCallback) {
      try {
        const parsed = new URL(rawCallback, window.location.origin);
        if (parsed.origin === window.location.origin) setCallbackURL(`${parsed.pathname}${parsed.search}${parsed.hash}`);
      } catch { /* malformed callback is intentionally ignored */ }
    }
    const callbackError = params.get('error');
    if (!token) {
      if (callbackError) { setVerifyState('error'); setError(`Email verification could not be completed (${callbackError.replaceAll('_', ' ').toLowerCase()}).`); }
      return;
    }
    let cancelled = false;
    setVerifyState('loading'); setError(''); setMessage('');
    void apiFetch<{ status?: boolean }>(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((result) => {
        if (cancelled) return;
        if (result.status === false) throw new Error('The authentication service did not confirm verification.');
        setVerifyState('success');
        setMessage('Your email address is verified. The workspace can now trust this sign-in address.');
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setVerifyState('error');
        setError(requestError instanceof ApiError ? requestError.message : 'The verification link is invalid or has expired.');
      });
    return () => { cancelled = true; };
  }, [reset]);

  return <PublicFrame kind={kind}><section className="aux-public__body aux-auth-aux"><PageHeader index={reset ? '04 / RECOVER' : '05 / VERIFY'} eyebrow={reset ? 'ACCOUNT ACCESS' : 'EMAIL VERIFICATION'} title={reset ? 'Reset the route back in.' : 'Verify the address that owns the workspace.'} detail={reset ? 'Request a recovery step through the configured authentication service. The browser never confirms whether an account exists.' : 'Verification is completed by the configured authentication service. This page reports the server response and never infers success from the presence of a token.'} /><section className="aux-auth-aux__panel">{reset ? (resetToken ? <form onSubmit={submitNewPassword}><label><span>New password</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 8 characters" minLength={8} required disabled={busy} /></label><button type="submit" className="aux-dark-button" disabled={busy}>{busy ? 'Updating…' : 'Set new password'} <ArrowRight /></button></form> : <form onSubmit={submit}><label><span>Email address</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required disabled={busy} /></label><button type="submit" className="aux-dark-button" disabled={busy}>{busy ? 'Requesting…' : 'Request recovery step'} <ArrowRight /></button></form>) : <div className="aux-verify-state"><ShieldCheck className={verifyState === 'loading' ? 'aux-spin' : undefined} /><h2>{verifyState === 'loading' ? 'Checking the verification token…' : verifyState === 'success' ? 'Address verified.' : 'Open the link from your inbox.'}</h2><p>{verifyState === 'success' ? 'The authentication service confirmed the address. Continue to the workspace when you are ready.' : 'If you arrived here without a valid verification link, return to sign in and request a fresh message from the configured auth service. This page will never claim verification without a server response.'}</p>{verifyState === 'success' && callbackURL && <PortalButtonLink href={callbackURL} className="aux-dark-button">Continue <ArrowRight /></PortalButtonLink>}{verifyState !== 'success' && <PortalButtonLink href="/login" className="aux-dark-button">Return to sign in <ArrowRight /></PortalButtonLink>}</div>}{message && <div className="aux-success" role="status"><Check />{message}</div>}{error && <div className="aux-alert" role="alert"><AlertCircle />{error}</div>}</section></section></PublicFrame>;
}

export function LegalPage({ kind }: { kind: LegalKind }) {
  return <PublicFrame kind={kind}><LegalContent kind={kind} /></PublicFrame>;
}

export function NotFoundPage({ path }: { path: string }) {
  return <PublicFrame kind="404"><section className="aux-public__body aux-not-found"><span className="aux-index">404 / OUTSIDE THE LEDGER</span><div className="aux-not-found__mark" aria-hidden="true">404</div><h1>This route is not in the register.</h1><p><code>{path || '/'}</code> did not resolve to a public or workspace surface. The requested address was not changed.</p><div><PortalButtonLink href="/" className="aux-dark-button">Return home <ArrowRight /></PortalButtonLink><PortalButtonLink href="/faq" className="aux-light-button">Read FAQ <ArrowRight /></PortalButtonLink></div><span className="aux-not-found__rule"><MapPin /> If you followed a saved link, check the path or open the workspace again.</span></section></PublicFrame>;
}

export default function AuxiliaryPage({ kind, path, token }: { kind: AuxiliaryKind; path?: string; token?: string }) {
  if (kind === 'faq') return <FaqPage />;
  if (kind === 'status') return <StatusPage />;
  if (kind === 'contact') return <ContactPage />;
  if (kind === 'forgot-password' || kind === 'verify-email') return <AuthAuxPage kind={kind} />;
  if (['privacy', 'terms', 'kvkk', 'acceptable-use', 'refund', 'subprocessors'].includes(kind)) return <LegalPage kind={kind as LegalKind} />;
  if (kind === 'shared-report') return <SharedReportPage token={token || ''} />;
  return <NotFoundPage path={path || window.location.pathname} />;
}
