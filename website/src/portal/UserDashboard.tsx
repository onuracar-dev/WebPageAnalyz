import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Crosshair,
  Database,
  ExternalLink,
  FileText,
  Gauge,
  GitBranch,
  Globe2,
  LockKeyhole,
  Mail,
  Plug,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { gsap } from "gsap";
import PortalShell from "./PortalShell";
import ScanProgressPanel, { type ScanProgressEvent, type ScanProgressSnapshot } from "./ScanProgressPanel";
import SecuritySetup from "./SecuritySetup";
import { ApiError, apiFetch, jsonRequest } from "./api";
import { navigate } from "./router";
import { workspaceNav } from "./workspaceNav";
import { normalizeLegalConfig, type PublicLegalConfig } from "../LegalContent";
import { flushPendingLegalAcceptance, queuePendingLegalAcceptance } from "./legalAcceptance";
import "./ai-remediation.css";
import "./billing-redeem.css";
import "./scan-consent.css";

type Finding = {
  fingerprint?: string;
  title?: string;
  description?: string;
  severity?: string;
  category?: string;
  pageUrl?: string;
  createdAt?: string;
  ruleId?: string;
  kind?: string;
  confidence?: number;
  remediation?: string;
  normalizedImpact?: number;
  evidence?: Array<Record<string, unknown>>;
  source?: string | { name?: string; version?: string };
  reportId?: string;
  reportVersion?: number;
  state?: "active" | "resolved";
  resolvedAt?: string;
  moduleId?: string;
  engineId?: string;
  device?: string;
  coverage?: { truncated?: boolean } & Record<string, unknown>;
};
type AiRemediationOutput = {
  schemaVersion: string;
  summary: string;
  likelyCause: string;
  steps: string[];
  codeExample: string | null;
  caveats: string[];
  confidence: "low" | "medium" | "high";
};
type AiRemediationState = {
  busy?: boolean;
  error?: string;
  output?: AiRemediationOutput;
  cached?: boolean;
  generatedAt?: string;
  quota?: { limit?: number; used?: number; remaining?: number };
};
type FindingFilter =
  | "active"
  | "high_priority"
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "resolved";
type SettingsSection = "workspace" | "notifications" | "security" | "billing";
type Project = {
  id: string;
  name: string;
  origin: string;
  verifiedAt?: string | null;
  verificationToken?: string;
  previewOnly?: boolean;
};
type ModuleStatus = {
  status: string;
  engines?: string[];
  coverage?: Record<string, unknown> | null;
  errorCode?: string | null;
};
type Report = {
  id: string;
  scanId: string;
  status: string;
  createdAt: string;
  version: number;
  share?: ReportShare;
  payload?: {
    pages?: Array<{ url: string }>;
    summary?: {
      requestedPages?: number;
      completedPages?: number;
      incompletePages?: number;
      failedPages?: number;
      unavailablePages?: number;
      requestedModules?: number;
      moduleCounts?: Record<string, number>;
      terminalState?: string;
    };
    modules?: Record<string, ModuleStatus>;
    manifest?: {
      project?: { id?: string };
      entitlements?: Record<string, { executionMode?: string; limit?: string | number | null }>;
      devices?: string[];
      capabilityContractVersion?: string | null;
    };
  };
};
type CheckoutPlan = {
  id: string;
  name: string;
  priceUsd: number;
  description?: string;
};
type ReportShare = {
  reportId?: string;
  token?: string;
  pagePath?: string;
  status?: "active" | "revoked";
  expiresInDays?: number;
  expiresAt?: string | null;
};
type ReportComparison = {
  left: string;
  right: string;
  newFindings?: string[];
  fixedFindings?: string[];
  unchangedFindings?: string[];
};
type Scan = {
  id: string;
  projectId?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  failureCode?: string;
  manifest?: { urls?: string[] };
  progress?: Record<string, number>;
};
type SourceInput = {
  id: string;
  projectId: string;
  status: string;
  failureCode?: string;
  createdAt: string;
  result?: {
    schemaVersion?: string;
    module?: { findingCount?: number; remediation?: string };
    findings?: Finding[];
    coverage?: Record<string, unknown>;
  };
};
type Dashboard = {
  workspace: { id: string; name: string };
  plan: {
    id: string;
    name: string;
    limits: { pageCredits: number; projects: number; aiRemediations: number; sourceAudits: number };
    entitlements?: Record<
      string,
      { executionMode: string; limit?: string | number | null }
    >;
  };
  usage: { consumed: number; reserved: number };
  allowances?: {
    periodStart: string;
    pageCredits: { limit: number; used: number; remaining: number; consumed: number; reserved: number };
    aiRemediations: { limit: number; used: number; remaining: number };
    projects: { limit: number; used: number; remaining: number };
    sourceAudits: { limit: number; used: number; remaining: number };
  };
  projects: Project[];
  scans: Scan[];
  metrics: {
    activeFindings: number;
    critical: number;
    highPriority: number;
    resolved: number;
    totalPages: number;
  };
  recentFindings: Finding[];
  trend: Array<{ at: string; count: number }>;
};
type Integration = {
  provider: "github" | "gitlab" | "bitbucket" | "webhook";
  label: string;
  available: boolean;
  serverConfigured: boolean;
  status: string;
  displayName?: string | null;
  connectedAt?: string | null;
  lastVerifiedAt?: string | null;
};
type StatusData = {
  checkedAt: string;
  overall: string;
  components: Array<{
    id: string;
    label: string;
    status: string;
    detail: string;
  }>;
};
type SettingsData = {
  workspace: { name: string };
  settings: {
    defaultLocale: "tr" | "en";
    notifyScanComplete: boolean;
    notifyHighPriority: boolean;
    weeklyDigest: boolean;
  };
  subscription?: { status: string; currentPeriodEnd?: string } | null;
};
type AnalysisCapabilities = {
  version?: string;
  findingSchema?: string;
  reportSchema?: string;
  engines?: Record<string, { requiredInput?: string; dependency?: string; devices?: string[]; kind?: string }>;
};
type WorkspaceSurface =
  | "dashboard"
  | "reports"
  | "findings"
  | "status"
  | "integrations"
  | "settings"
  | "capabilities";
type SurfaceErrors = Partial<Record<WorkspaceSurface, string>>;

type DashboardSurface = "overview" | "findings" | "reports" | "targets" | "integrations" | "settings" | "status";
type BillingReturn = "success" | "cancelled" | "return";
const dashboardSurfaceAliases: Record<string, DashboardSurface> = {
  overview: "overview",
  dashboard: "overview",
  findings: "findings",
  finding: "findings",
  reports: "reports",
  report: "reports",
  targets: "targets",
  target: "targets",
  integrations: "integrations",
  integration: "integrations",
  settings: "settings",
  setting: "settings",
  status: "status",
  "system-status": "status",
};

function dashboardSurfaceFromPath(path: string): { active: DashboardSurface; valid: boolean } {
  const match = path.match(/^\/app(?:\/([^/]+))?(?:\/([^/]+))?\/?$/i);
  if (!match) return { active: "overview", valid: false };
  if (!match[1]) return { active: "overview", valid: true };
  const active = dashboardSurfaceAliases[match[1].toLowerCase()];
  if (!active) return { active: "overview", valid: false };
  if (match[2] && !(active === "settings" && match[2].toLowerCase() === "billing")) return { active: "overview", valid: false };
  return { active, valid: true };
}

function dashboardPathForSurface(surface: DashboardSurface) {
  return surface === "overview" ? "/app" : `/app/${surface}`;
}

function safeTargetHandoff(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalShareUrl(pagePath: string | undefined) {
  if (!pagePath || !/^\/shared-reports\/[A-Za-z0-9_-]{16,256}$/.test(pagePath)) return null;
  return new URL(pagePath, window.location.origin).toString();
}

function surfaceFailure(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function plainFindingText(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const withoutMarkup = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return withoutMarkup || fallback;
}

function parseUrlList(value: string, max: number) {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))].slice(0, max);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function SurfaceUnavailable({ label, message, onRetry }: { label: string; message: string; onRetry: () => void }) {
  return (
    <section className="workspace-unavailable portal-card portal-section-unavailable" role="alert">
      <div className="workspace-unavailable__icon"><CircleAlert /></div>
      <div className="workspace-unavailable__copy">
        <span className="workspace-unavailable__eyebrow">{label.toUpperCase()} / UNAVAILABLE</span>
        <h1>{label} is unavailable.</h1>
        <p>{message} Other workspace surfaces remain available. Try again when the service is ready.</p>
        <div className="workspace-unavailable__actions">
          <button className="portal-primary" onClick={onRetry}><Activity /> Try again</button>
        </div>
      </div>
    </section>
  );
}

type TargetAccessMode = "public_link" | "dns";
const FOCUSABLE_SELECTOR = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"])";
const productEngines = [
  { id: "wpa-page", label: "WPA Page", engineId: "wpaPage", moduleId: null, sourceName: "WPA Page" },
  { id: "wpa-site-crawler", label: "WPA Site Crawler", engineId: "crawler", moduleId: "full_site_crawl", sourceName: "WPA Crawler" },
  { id: "performance-plus", label: "Performance Plus", engineId: "performancePlus", moduleId: "performance_plus", sourceName: "WPA performance plus" },
  { id: "advanced-geo", label: "Advanced GEO", engineId: "advancedGeo", moduleId: "advanced_geo", sourceName: "WPA advanced geo" },
  { id: "visual-ux", label: "Visual UX", engineId: "visualUx", moduleId: "visual_ux", sourceName: "WPA visual ux" },
  { id: "journey-test", label: "Journey Test", engineId: "journey", moduleId: "journey_test", sourceName: "WPA journey test" },
] as const;

type ProductEngine = (typeof productEngines)[number];

function findingMatchesEngine(finding: Finding, engine: ProductEngine) {
  if (finding.engineId) return finding.engineId === engine.engineId;
  if (engine.moduleId && finding.moduleId === engine.moduleId) return true;
  const source = typeof finding.source === "string" ? finding.source : finding.source?.name;
  return source?.toLocaleLowerCase() === engine.sourceName.toLocaleLowerCase();
}

function AnimatedNumber({ value }: { value: number }) {
  const ref = useRef<HTMLElement>(null);
  const previous = useRef(value);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = String(value);
      previous.current = value;
      return;
    }
    const state = { value: previous.current };
    const tween = gsap.to(state, {
      value,
      duration: .72,
      ease: "power3.out",
      onUpdate: () => { node.textContent = String(Math.round(state.value)); },
    });
    previous.current = value;
    return () => { tween.kill(); };
  }, [value]);
  return <strong ref={ref}>{value}</strong>;
}

function safeHostname(value?: string) {
  if (!value) return "";
  try {
    return new URL(value).hostname || value;
  } catch {
    return value.replace(/^https?:\/\//i, "").split("/")[0] || value;
  }
}

function safePathname(value?: string) {
  if (!value) return "";
  try {
    return new URL(value).pathname || "/";
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

const providerCopy: Record<string, string> = {
  github:
    "Connect a permission-limited GitHub App identity for source workflows.",
  gitlab: "Connect GitLab with read_user, read_api and read_repository scopes.",
  bitbucket:
    "Connect a Bitbucket workspace identity for repository source workflows.",
  webhook: "Deliver signed report.created events to one public HTTPS endpoint.",
};

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  note: string;
}> = [
  { id: "workspace", label: "Workspace", note: "Identity and report defaults" },
  { id: "notifications", label: "Notifications", note: "Signals worth receiving" },
  { id: "security", label: "Security", note: "Authentication and sessions" },
  { id: "billing", label: "Billing", note: "Plan and subscription" },
];

function SeverityBadge({ severity = "medium" }: { severity?: string }) {
  return (
    <span className={`severity-badge severity-badge--${severity}`}>
      {severity[0]?.toUpperCase() + severity.slice(1)}
    </span>
  );
}

export default function UserDashboard() {
  const operationKeysRef = useRef(new Map<string, string>());
  const operationKey = (scope: string, payload: unknown) => {
    const intent = `${scope}:${JSON.stringify(payload)}`;
    const existing = operationKeysRef.current.get(intent);
    if (existing) return { intent, key: existing };
    const key = crypto.randomUUID();
    operationKeysRef.current.set(intent, key);
    return { intent, key };
  };
  const completeOperation = (intent: string) => operationKeysRef.current.delete(intent);
  const [active, setActive] = useState<DashboardSurface>(() => dashboardSurfaceFromPath(window.location.pathname).active);
  const [activeEngine, setActiveEngine] = useState("performance-plus");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [sourceInputs, setSourceInputs] = useState<SourceInput[]>([]);
  const [platformStatus, setPlatformStatus] = useState<StatusData | null>(null);
  const [capabilities, setCapabilities] = useState<AnalysisCapabilities | null>(null);
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [defaultLocale, setDefaultLocale] = useState<"tr" | "en">("en");
  const [notifyScanComplete, setNotifyScanComplete] = useState(true);
  const [notifyHighPriority, setNotifyHighPriority] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [findingsTotal, setFindingsTotal] = useState(0);
  const [activeFindingsTotal, setActiveFindingsTotal] = useState(0);
  const [resolvedFindingsTotal, setResolvedFindingsTotal] = useState(0);
  const [findingFilter, setFindingFilter] = useState<FindingFilter>("active");
  const [findingModule, setFindingModule] = useState("");
  const [findingSource, setFindingSource] = useState("");
  const [findingDevice, setFindingDevice] = useState("");
  const [findingKind, setFindingKind] = useState("");
  const [findingConfidence, setFindingConfidence] = useState("");
  const [findingCoverage, setFindingCoverage] = useState("");
  const [aiRemediations, setAiRemediations] = useState<Record<string, AiRemediationState>>({});
  const [session, setSession] = useState<{
    user?: { name?: string; email?: string; twoFactorEnabled?: boolean };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspaceFailure, setWorkspaceFailure] = useState<ApiError | null>(null);
  const [legalAcceptanceRequired, setLegalAcceptanceRequired] = useState(false);
  const [legalGateAccepted, setLegalGateAccepted] = useState(false);
  const [surfaceErrors, setSurfaceErrors] = useState<SurfaceErrors>({});
  const [message, setMessage] = useState("");
  const [progressTransport, setProgressTransport] = useState<"polling" | "stream">("polling");
  const [scanProgressSnapshots, setScanProgressSnapshots] = useState<Record<string, ScanProgressSnapshot>>({});
  const scanProgressCursors = useRef<Record<string, number | string>>({});
  const [billingReturn, setBillingReturn] = useState<BillingReturn | null>(() => {
    const value = new URLSearchParams(window.location.search).get("billing");
    if (value === "success" || value === "cancelled") return value;
    if (value === "return" || value === "portal_return") return "return";
    return null;
  });
  const [targetName, setTargetName] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [targetAuthorizationAccepted, setTargetAuthorizationAccepted] = useState(false);
  const [authorizedSubdomainsText, setAuthorizedSubdomainsText] = useState("");
  const [additionalUrlsText, setAdditionalUrlsText] = useState("");
  const [externalAnalyzerAccepted, setExternalAnalyzerAccepted] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [sourceProject, setSourceProject] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [generatedSecret, setGeneratedSecret] = useState("");
  const [exporting, setExporting] = useState("");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [reportDetails, setReportDetails] = useState<Record<string, Report>>({});
  const [reportDetailLoading, setReportDetailLoading] = useState("");
  const [reportDetailError, setReportDetailError] = useState("");
  const [compareLeftId, setCompareLeftId] = useState("");
  const [compareRightId, setCompareRightId] = useState("");
  const [compareResult, setCompareResult] = useState<ReportComparison | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState("");
  const [reportShares, setReportShares] = useState<Record<string, ReportShare>>({});
  const [shareExpiryDays, setShareExpiryDays] = useState("30");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [focusedTargetId, setFocusedTargetId] = useState("");
  const [targetRegistryOpen, setTargetRegistryOpen] = useState(false);
  const [targetComposerOpen, setTargetComposerOpen] = useState(false);
  const targetHandoffAppliedRef = useRef(false);
  const [targetAccessMode, setTargetAccessMode] =
    useState<TargetAccessMode>("public_link");
  const [dnsSetupTargetId, setDnsSetupTargetId] = useState("");
  const [legalConfig, setLegalConfig] = useState<PublicLegalConfig | null>(null);
  const [checkoutPlan, setCheckoutPlan] = useState<CheckoutPlan | null>(null);
  const [checkoutAccepted, setCheckoutAccepted] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemError, setRedeemError] = useState("");
  const [redeemMessage, setRedeemMessage] = useState("");
  const checkoutCloseRef = useRef<HTMLButtonElement>(null);
  const checkoutReturnRef = useRef<HTMLElement | null>(null);
  const [activeIntegration, setActiveIntegration] = useState("github");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>(() => /^\/app\/settings\/billing\/?$/i.test(window.location.pathname) ? "billing" : "security");

  useEffect(() => {
    const syncSurface = () => {
      // Support is a sibling route with its own PortalShell. Do not let the
      // workspace surface validator redirect that route back to Overview
      // while App is handing control to SupportCenter.
      if (/^\/app\/support(?:\/|$)/i.test(window.location.pathname)) return;
      const route = dashboardSurfaceFromPath(window.location.pathname);
      setActive(route.active);
      if (/^\/app\/settings\/billing\/?$/i.test(window.location.pathname)) setSettingsSection("billing");
      if (!route.valid && window.location.pathname.startsWith("/app/")) {
        navigate("/app", true);
      }
    };
    syncSurface();
    window.addEventListener("popstate", syncSurface);
    return () => window.removeEventListener("popstate", syncSurface);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("target")) return;
    const target = safeTargetHandoff(params.get("target"));
    if (!target || !dashboard || targetHandoffAppliedRef.current) {
      if (!target) {
        params.delete("target");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }
      return;
    }
    targetHandoffAppliedRef.current = true;
    if (window.location.pathname !== "/app/targets") {
      setActive("targets");
    }
    setTargetUrl(target);
    setTargetAccessMode("public_link");
    setTargetComposerOpen(true);
    setTargetRegistryOpen(true);
    setMessage("Target URL is ready. Review the access mode and confirm Add target to continue.");
    params.delete("target");
    const query = params.toString();
    const targetPath = `/app/targets${query ? `?${query}` : ""}`;
    if (window.location.pathname === "/app/targets") {
      window.history.replaceState({}, "", targetPath);
    } else {
      navigate(targetPath, true);
    }
  }, [dashboard]);

  useEffect(() => {
    if (!billingReturn) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("billing");
    params.delete("session_id");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    if (billingReturn === "cancelled") {
      setMessage("Checkout was cancelled. No entitlement change was assumed.");
      setBillingReturn(null);
      return;
    }
    setMessage("Billing return received. Refreshing workspace entitlement before reporting a change.");
  }, [billingReturn]);

  useEffect(() => {
    if (!dashboard || !billingReturn || billingReturn === "cancelled") return;
    setMessage(`Workspace refreshed. Current entitlement: ${dashboard.plan.name}.`);
    setBillingReturn(null);
  }, [billingReturn, dashboard]);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<PublicLegalConfig>("/api/v1/legal/config")
      .then((result) => { if (!cancelled) setLegalConfig(normalizeLegalConfig(result)); })
      .catch(() => { if (!cancelled) setLegalConfig(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!dashboard) return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("checkout");
    if (!requested || !["signal", "studio"].includes(requested)) return;
    params.delete("checkout");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    void openCheckout(requested);
  }, [dashboard]);

  useEffect(() => {
    if (!checkoutPlan) return undefined;
    checkoutReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeCheckout(); return; }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".checkout-confirmation__dialog");
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) || []).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    requestAnimationFrame(() => checkoutCloseRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => checkoutReturnRef.current?.isConnected && checkoutReturnRef.current.focus());
    };
  }, [checkoutPlan]);
  const targetRegistryRef = useRef<HTMLElement>(null);
  const targetRegistryCloseRef = useRef<HTMLButtonElement>(null);
  const targetRegistryReturnRef = useRef<HTMLElement | null>(null);
  const targetRegistryWasOpenRef = useRef(false);
  const targetRegistryOverflowRef = useRef<string | null>(null);

  useEffect(() => {
    if (targetRegistryOpen && !targetRegistryWasOpenRef.current) {
      targetRegistryReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      targetRegistryOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => targetRegistryCloseRef.current?.focus());
    }
    if (!targetRegistryOpen && targetRegistryWasOpenRef.current) {
      document.body.style.overflow = targetRegistryOverflowRef.current || "";
      targetRegistryOverflowRef.current = null;
      requestAnimationFrame(() => {
        if (targetRegistryReturnRef.current?.isConnected) targetRegistryReturnRef.current.focus();
        targetRegistryReturnRef.current = null;
      });
    }
    targetRegistryWasOpenRef.current = targetRegistryOpen;
  }, [targetRegistryOpen]);

  useEffect(() => () => {
    if (targetRegistryOverflowRef.current !== null) {
      document.body.style.overflow = targetRegistryOverflowRef.current;
      targetRegistryOverflowRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!targetRegistryOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setTargetRegistryOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const container = targetRegistryRef.current;
      if (!container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [targetRegistryOpen]);

  useLayoutEffect(() => {
    if (active !== "overview" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      gsap.fromTo(".cutaway-engine", { x: 18, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: .2, stagger: .025, ease: "power3.out", clearProps: "transform,opacity,visibility" });
      gsap.fromTo(".reference-priority > *", { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: .2, stagger: .025, delay: .08, ease: "power3.out", clearProps: "transform,opacity,visibility" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const load = useCallback(async () => {
    setLoading(true);
    try { await flushPendingLegalAcceptance(); } catch { /* Protected requests below surface the authoritative session/legal state. */ }
    const [dashboardResult, reportsResult, findingsResult, sessionResult, statusResult, integrationsResult, settingsResult, capabilitiesResult, sourceResult] = await Promise.allSettled([
      apiFetch<Dashboard>("/api/v1/dashboard"),
      apiFetch<{ reports: Report[] }>("/api/v1/reports"),
      apiFetch<{
        findings: Finding[];
        total: number;
        activeTotal: number;
        resolvedTotal: number;
      }>("/api/v1/findings?limit=1000"),
      apiFetch<{
        user?: { name?: string; email?: string; twoFactorEnabled?: boolean };
      }>("/api/auth/get-session").catch(() => null),
      apiFetch<StatusData>("/api/v1/status"),
      apiFetch<{ integrations: Integration[] }>("/api/v1/integrations"),
      apiFetch<SettingsData>("/api/v1/settings"),
      apiFetch<AnalysisCapabilities>("/api/v1/analysis-capabilities"),
      apiFetch<{ sourceInputs: SourceInput[] }>("/api/v1/source-inputs").catch(
        () => ({ sourceInputs: [] }),
      ),
    ]);

    if (dashboardResult.status === "fulfilled") {
      setDashboard(dashboardResult.value);
      setLegalAcceptanceRequired(false);
      setWorkspaceFailure(null);
    }
    if (dashboardResult.status === "rejected" && (dashboardResult.reason as { status?: number })?.status === 401) {
      navigate("/login", true);
      return;
    }

    const nextSurfaceErrors: SurfaceErrors = {};
    if (dashboardResult.status === "rejected") {
      setDashboard(null);
      const acceptanceRequired = (dashboardResult.reason as { code?: string })?.code === "LEGAL_ACCEPTANCE_REQUIRED";
      setLegalAcceptanceRequired(acceptanceRequired);
      setWorkspaceFailure(!acceptanceRequired && dashboardResult.reason instanceof ApiError ? dashboardResult.reason : null);
      if (!acceptanceRequired) nextSurfaceErrors.dashboard = surfaceFailure(dashboardResult.reason, "Workspace could not be loaded.");
    }
    if (reportsResult.status === "fulfilled") {
      setReports(reportsResult.value.reports);
    } else {
      setReports([]);
      setCompareResult(null);
      nextSurfaceErrors.reports = surfaceFailure(reportsResult.reason, "Reports are unavailable right now.");
    }
    if (findingsResult.status === "fulfilled") {
      setFindings(findingsResult.value.findings);
      setFindingsTotal(findingsResult.value.total);
      setActiveFindingsTotal(findingsResult.value.activeTotal);
      setResolvedFindingsTotal(findingsResult.value.resolvedTotal);
    } else {
      setFindings([]);
      setFindingsTotal(0);
      setActiveFindingsTotal(0);
      setResolvedFindingsTotal(0);
      nextSurfaceErrors.findings = surfaceFailure(findingsResult.reason, "Findings are unavailable right now.");
    }
    if (sessionResult.status === "fulfilled") {
      setSession(sessionResult.value);
    } else {
      setSession(null);
    }
    if (statusResult.status === "fulfilled") {
      setPlatformStatus(statusResult.value);
    } else {
      setPlatformStatus(null);
      nextSurfaceErrors.status = surfaceFailure(statusResult.reason, "System status is unavailable right now.");
    }
    if (integrationsResult.status === "fulfilled") {
      setIntegrations(integrationsResult.value.integrations);
    } else {
      setIntegrations([]);
      nextSurfaceErrors.integrations = surfaceFailure(integrationsResult.reason, "Integrations are unavailable right now.");
    }
    if (settingsResult.status === "fulfilled") {
      const settingsResponse = settingsResult.value;
      setSettingsData(settingsResponse);
      setWorkspaceName(settingsResponse.workspace.name);
      setDefaultLocale(settingsResponse.settings.defaultLocale);
      setNotifyScanComplete(settingsResponse.settings.notifyScanComplete);
      setNotifyHighPriority(settingsResponse.settings.notifyHighPriority);
      setWeeklyDigest(settingsResponse.settings.weeklyDigest);
    } else {
      setSettingsData(null);
      nextSurfaceErrors.settings = surfaceFailure(settingsResult.reason, "Settings are unavailable right now.");
    }
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
    } else {
      setCapabilities(null);
      nextSurfaceErrors.capabilities = surfaceFailure(capabilitiesResult.reason, "The analysis capability contract is unavailable right now.");
    }
    if (sourceResult.status === "fulfilled") {
      setSourceInputs(sourceResult.value.sourceInputs);
    } else {
      setSourceInputs([]);
    }
    setSurfaceErrors(nextSurfaceErrors);
    setError(nextSurfaceErrors.dashboard || "");
    setLoading(false);
  }, []);

  async function acceptCurrentLegalDocuments() {
    const termsVersion = legalConfig?.documents?.terms?.version;
    const acceptableUseVersion = legalConfig?.documents?.acceptableUse?.version;
    if (!legalGateAccepted || !legalConfig?.ready || !termsVersion || !acceptableUseVersion) {
      setError("The active Terms and Acceptable Use versions are unavailable.");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      queuePendingLegalAcceptance(termsVersion, acceptableUseVersion);
      await flushPendingLegalAcceptance();
      setLegalGateAccepted(false);
      setLegalAcceptanceRequired(false);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Legal acceptance could not be recorded.");
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);
  const refreshScanProgress = useCallback(async (scanId: string) => {
    try {
      const after = scanProgressCursors.current[scanId] || 0;
      const progress = await apiFetch<ScanProgressSnapshot>(`/api/v1/scans/${scanId}/progress?after=${encodeURIComponent(String(after))}`);
      const events = Array.isArray(progress.events) ? progress.events : [];
      const pages = Array.isArray(progress.pages) ? progress.pages : [];
      const counts = progress.counts || {};
      const lastEventId = progress.lastEventId ?? events.at(-1)?.id ?? after;
      scanProgressCursors.current[scanId] = lastEventId;
      setScanProgressSnapshots((current) => {
        const mergedEvents = [...(current[scanId]?.events || []), ...events];
        const uniqueEvents = new Map<string, ScanProgressEvent>();
        mergedEvents.forEach((event) => uniqueEvents.set(String(event.id), event));
        return {
          ...current,
          [scanId]: {
            scan: progress.scan,
            counts,
            pages,
            events: [...uniqueEvents.values()].slice(-200),
            lastEventId,
          },
        };
      });
      setDashboard((current) => current ? {
        ...current,
        scans: current.scans.map((scan) => scan.id === scanId ? { ...scan, ...progress.scan, progress: counts } : scan),
      } : current);
      if (!["queued", "running"].includes(progress.scan.status)) void load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Scan progress could not be refreshed.");
    }
  }, [load]);
  const activeScanId = dashboard?.scans.find((scan) => ["queued", "running"].includes(scan.status))?.id || "";
  useEffect(() => {
    if (!activeScanId) return;
    scanProgressCursors.current[activeScanId] = 0;
    void refreshScanProgress(activeScanId);
  }, [activeScanId, refreshScanProgress]);
  useEffect(() => {
    if (!activeScanId || progressTransport === "stream") return undefined;
    const timer = window.setInterval(() => void refreshScanProgress(activeScanId), 5_000);
    return () => window.clearInterval(timer);
  }, [activeScanId, progressTransport, refreshScanProgress]);
  useEffect(() => {
    if (!activeScanId || typeof window.EventSource === "undefined") return undefined;
    const activeScan = { id: activeScanId };
    let cancelled = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let stream: EventSource | null = null;
    let lastEventId = "";
    const eventTypes = ["scan.queued", "scan.running", "scan.completed", "scan.partial", "scan.awaiting_operator", "scan.failed", "page.running", "page.completed", "page.incomplete", "page.failed", "page.unavailable", "page.retrying", "analysis.plan", "engine.running", "engine.completed", "engine.failed", "engine.timeout", "engine.unavailable", "engine.cancelled"];
    const connect = () => {
      if (cancelled) return;
      const endpoint = new URL(`/api/v1/scans/${encodeURIComponent(activeScan.id)}/events`, window.location.origin);
      if (lastEventId) endpoint.searchParams.set("after", lastEventId);
      const nextStream = new EventSource(endpoint.pathname + endpoint.search, { withCredentials: true });
      stream = nextStream;
      const refresh = (event: Event) => {
        const eventId = (event as MessageEvent).lastEventId;
        if (eventId) lastEventId = eventId;
        void refreshScanProgress(activeScan.id);
      };
      const reconnect = () => {
        if (cancelled || reconnectTimer) return;
        setProgressTransport("polling");
        eventTypes.forEach((eventType) => nextStream.removeEventListener(eventType, refresh));
        nextStream.close();
        stream = null;
        const delay = Math.min(15_000, 1_000 * (2 ** Math.min(reconnectAttempt, 4)));
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      };
      nextStream.onopen = () => {
        reconnectAttempt = 0;
        setProgressTransport("stream");
      };
      nextStream.onerror = reconnect;
      eventTypes.forEach((eventType) => nextStream.addEventListener(eventType, refresh));
    };
    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      stream?.close();
      setProgressTransport("polling");
    };
  }, [activeScanId, refreshScanProgress]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("result") === "connected") {
      setMessage(
        `${query.get("integration") || "Provider"} connected successfully.`,
      );
      window.history.replaceState({}, "", "/app");
    }
  }, []);

  const percent = dashboard
    ? Math.min(
        100,
        ((dashboard.usage.consumed + dashboard.usage.reserved) /
          dashboard.plan.limits.pageCredits) *
          100,
      )
    : 0;
  const upgradeTarget =
    dashboard?.plan.id === "free"
      ? "signal"
      : dashboard?.plan.id === "signal"
      ? "studio"
      : dashboard?.plan.id === "studio"
        ? "enterprise"
        : null;
  const paymentsEnabled = legalConfig?.billing?.paymentsEnabled === true;
  const currentPlanRank = ({ free: 0, signal: 1, studio: 2, enterprise: 3 } as Record<string, number>)[dashboard?.plan.id || "free"] ?? 0;
  const canExportReports = currentPlanRank >= 1;
  const canCompareReports = currentPlanRank >= 2;
  const canShareReports = currentPlanRank >= 2;
  const activeScan = dashboard?.scans.find((scan) => ["queued", "running"].includes(scan.status));
  const storedScanProgress = activeScan ? scanProgressSnapshots[activeScan.id] : undefined;
  const liveScanProgress: ScanProgressSnapshot | null = activeScan ? {
    scan: { ...activeScan, ...(storedScanProgress?.scan || {}) },
    counts: storedScanProgress?.counts || activeScan.progress || {},
    pages: storedScanProgress?.pages || [],
    events: storedScanProgress?.events || [],
    lastEventId: storedScanProgress?.lastEventId,
  } : null;
  const planCard = dashboard && (
    <div className="plan-usage">
      <b>{dashboard.plan.name}</b>
      <span>
        <strong>{dashboard.usage.consumed + dashboard.usage.reserved}</strong> /{" "}
        {dashboard.plan.limits.pageCredits} pages
      </span>
      <i>
        <em style={{ width: `${percent}%` }} />
      </i>
      <small>Monthly page-credit usage</small>
      {upgradeTarget ? (
        <button onClick={() => void openCheckout(upgradeTarget)}>
          {upgradeTarget === "enterprise" ? "Contact sales" : paymentsEnabled ? "Upgrade plan" : "Redeem access"} <ArrowRight />
        </button>
      ) : (
        <span className="plan-max">
          <CheckCircle2 /> Highest plan active
        </span>
      )}
    </div>
  );

  const notifications = useMemo(() => {
    if (!dashboard) return [];
    const preferences = settingsData?.settings;
    const rows =
      preferences?.notifyScanComplete === false
        ? []
        : dashboard.scans
            .slice(0, 3)
            .map((scan) => ({
              id: scan.id,
              title:
                scan.status === "failed"
                  ? "Scan needs attention"
                  : `Scan ${scan.status.replaceAll("_", " ")}`,
              detail: new Date(scan.createdAt).toLocaleString(),
              tone:
                scan.status === "failed"
                  ? ("warning" as const)
                  : ("good" as const),
            }));
    if (
      preferences?.notifyHighPriority !== false &&
      dashboard.metrics.highPriority
    )
      rows.unshift({
        id: "high-priority",
        title: `${dashboard.metrics.highPriority} high-priority findings`,
        detail: "Open Findings to review the measured evidence.",
        tone: "warning" as const,
      });
    if (preferences?.weeklyDigest)
      rows.unshift({
        id: "weekly-digest",
        title: "Workspace digest",
        detail: `${dashboard.metrics.activeFindings} active findings across ${dashboard.metrics.totalPages} analyzed pages.`,
        tone: "good" as const,
      });
    return rows.slice(0, 4);
  }, [dashboard, settingsData]);

  const targetAccessBenefits = useMemo(() => {
    const entitlements = dashboard?.plan.entitlements || {};
    const enabled = (moduleId: string) =>
      Boolean(
        entitlements[moduleId] &&
          entitlements[moduleId].executionMode !== "disabled",
      );
    const publicLink = [
      (enabled("core_audit") || enabled("runtime")) &&
        "WPA Page + Lighthouse, Axe and YellowLab",
      enabled("performance_plus") && "Performance Plus",
      entitlements.geo?.limit === "advanced" &&
        entitlements.design?.limit === "advanced"
        ? "Advanced GEO + Visual UX"
        : entitlements.geo?.limit === "advanced"
          ? "Advanced GEO"
          : entitlements.design?.limit === "advanced"
            ? "Visual UX"
            : false,
      enabled("source_audit") && "Secure ZIP Source Audit",
    ].filter(Boolean) as string[];
    const dns = [
      enabled("full_site_crawl") && "WPA Site Crawler across the verified origin",
      enabled("passive_security") && "Passive security inspection",
      enabled("journey_test") && "Read-only Journey Test",
    ].filter(Boolean) as string[];
    return { publicLink, dns };
  }, [dashboard]);
  const canUnlockWithDns = targetAccessBenefits.dns.length > 0;
  const canUseAdditionalUrls = Boolean(dashboard?.plan.entitlements?.full_site_crawl && dashboard.plan.entitlements.full_site_crawl.executionMode !== "disabled");
  const canUseSourceAudit = Boolean(dashboard?.plan.entitlements?.source_audit && dashboard.plan.entitlements.source_audit.executionMode !== "disabled");
  const targetAuthorizationVersion = legalConfig?.documents?.targetAuthorization?.version;

  function closeCheckout() {
    if (checkoutLoading) return;
    setCheckoutPlan(null);
    setCheckoutAccepted(false);
    setCheckoutError("");
  }

  async function openCheckout(planId: string) {
    if (planId === "enterprise") {
      navigate("/app/support?new=enterprise-sales");
      return;
    }
    if (!["signal", "studio"].includes(planId)) {
      setError("This plan is not available through self-serve checkout.");
      return;
    }
    if (!paymentsEnabled) {
      navigate("/app/settings/billing");
      setMessage("Paid checkout is paused during early access. Enter a WebPageAnalyz redeem code or use an administrator invitation.");
      return;
    }
    setActionBusy(true);
    setError("");
    setCheckoutError("");
    try {
      const result = await apiFetch<{ plans: CheckoutPlan[] }>("/api/v1/plans");
      const canonicalPlan = result.plans.find((plan) => plan.id === planId);
      if (!canonicalPlan || !Number.isFinite(canonicalPlan.priceUsd) || canonicalPlan.priceUsd <= 0) throw new Error("The server did not return a purchasable canonical plan and price.");
      setCheckoutAccepted(false);
      setCheckoutPlan(canonicalPlan);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Checkout confirmation could not load.",
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmCheckout(event: FormEvent) {
    event.preventDefault();
    if (!checkoutPlan || !checkoutAccepted) return;
    if (!paymentsEnabled) {
      setCheckoutError("Paid checkout is disabled during redeem-only early access.");
      return;
    }
    const termsVersion = legalConfig?.documents?.terms?.version;
    const refundPolicyVersion = legalConfig?.documents?.refund?.version;
    if (!legalConfig?.ready || !termsVersion || !refundPolicyVersion || !legalConfig.billing?.merchantOfRecord) {
      setCheckoutError("Checkout is unavailable until the server publishes active Terms, Refund Policy and merchant-of-record configuration.");
      return;
    }
    setCheckoutLoading(true);
    setCheckoutError("");
    const payload = {
      planId: checkoutPlan.id,
      accepted: true,
      recurringAcknowledged: true,
      termsVersion,
      refundPolicyVersion,
    };
    const operation = operationKey("checkout", payload);
    try {
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      const result = await apiFetch<{ url?: string; checkout?: { url?: string } }>("/api/v1/billing/checkout", init);
      const checkoutUrl = result.url || result.checkout?.url;
      if (!checkoutUrl || !/^https:\/\//i.test(checkoutUrl)) throw new Error("The billing service did not return a secure checkout URL.");
      completeOperation(operation.intent);
      window.location.assign(checkoutUrl);
    } catch (requestError) {
      setCheckoutError(requestError instanceof Error ? requestError.message : "Checkout could not start.");
      setCheckoutLoading(false);
    }
  }
  async function manageBilling() {
    if (!paymentsEnabled) {
      setMessage("The provider billing portal is unavailable during redeem-only early access.");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      const result = await apiFetch<{ url: string }>("/api/v1/billing/portal", {
        method: "POST",
      });
      window.location.assign(result.url);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Billing portal could not open.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function redeemEntitlement(event: FormEvent) {
    event.preventDefault();
    const code = redeemCode.trim();
    if (!code) return;
    setRedeemBusy(true);
    setRedeemError("");
    setRedeemMessage("");
    const payload = { code };
    const operation = operationKey("redeem", payload);
    try {
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      const result = await apiFetch<{
        effective?: {
          name?: string;
          effectivePlanId?: string;
          limits?: { pageCredits?: number; aiRemediations?: number };
        };
      }>("/api/v1/redeem", init);
      const planName = result.effective?.name || result.effective?.effectivePlanId || "updated entitlement";
      const pageCredits = result.effective?.limits?.pageCredits;
      const aiCredits = result.effective?.limits?.aiRemediations;
      const creditSummary = [
        Number.isFinite(pageCredits) ? `${pageCredits} page credits` : "",
        Number.isFinite(aiCredits) ? `${aiCredits} AI generations` : "",
      ].filter(Boolean).join(" · ");
      setRedeemCode("");
      completeOperation(operation.intent);
      setRedeemMessage(`Code applied. Effective plan: ${planName}${creditSummary ? ` · ${creditSummary}` : ""}.`);
      await load();
    } catch (requestError) {
      setRedeemError(requestError instanceof Error ? requestError.message : "The redeem code could not be applied.");
    } finally {
      setRedeemBusy(false);
    }
  }
  async function createTarget(event: FormEvent) {
    event.preventDefault();
    const normalizedName = targetName.trim();
    if (normalizedName.length < 2) {
      setError("Project name must contain at least two visible characters.");
      return;
    }
    if (!targetAuthorizationAccepted || !targetAuthorizationVersion) {
      setError("Confirm target authorization after the server publishes the active authorization version.");
      return;
    }
    setActionBusy(true);
    setError("");
    setMessage("");
    const payload = {
      name: normalizedName,
      url: /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`,
      locale: defaultLocale,
      authorizationAttested: true,
      authorizationVersion: targetAuthorizationVersion,
      additionalSubdomains: parseUrlList(authorizedSubdomainsText, 20),
    };
    const operation = operationKey("project", payload);
    try {
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      const result = await apiFetch<{ project: Project } | Project>(
        "/api/v1/projects",
        init,
      );
      const project = "project" in result ? result.project : result;
      setTargetName("");
      setTargetUrl("");
      setTargetAuthorizationAccepted(false);
      setAuthorizedSubdomainsText("");
      setTargetComposerOpen(false);
      setFocusedTargetId(project.id);
      completeOperation(operation.intent);
      if (targetAccessMode === "dns" && canUnlockWithDns) {
        setDnsSetupTargetId(project.id);
        setMessage("Target added. Publish the DNS record shown below to unlock ownership-only engines.");
      } else {
        setDnsSetupTargetId("");
        setMessage("Target added in public-link mode. You can start the available analysis now.");
      }
      setTargetAccessMode("public_link");
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Target could not be created.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function startScan(project: Project) {
    const existingScan = dashboard?.scans.find((scan) => scan.projectId === project.id && ["queued", "running"].includes(scan.status));
    if (existingScan) {
      setMessage(`A scan for this target is already ${existingScan.status}. Follow its progress before starting another.`);
      return;
    }
    if (!externalAnalyzerAccepted) {
      setError("Confirm the external analyzer disclosure before starting this scan.");
      return;
    }
    const requestedAdditionalUrls = canUseAdditionalUrls ? parseUrlList(additionalUrlsText, 500) : [];
    if (requestedAdditionalUrls.length && !project.verifiedAt) {
      setError("Additional URLs require a DNS-verified target. Clear the list or scan a DNS-enabled target.");
      return;
    }
    setActionBusy(true);
    setError("");
    const submittedAdditionalUrls = project.verifiedAt ? requestedAdditionalUrls : [];
    const payload = { projectId: project.id, locale: defaultLocale, additionalUrls: submittedAdditionalUrls, externalProviderConsent: true };
    const operation = operationKey("scan", payload);
    try {
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      await apiFetch(
        "/api/v1/scans",
        init,
      );
      completeOperation(operation.intent);
      setExternalAnalyzerAccepted(false);
      setMessage(
        `${project.verifiedAt ? "Full target scan" : "Public-link scan"} queued${submittedAdditionalUrls.length ? " with additive manual URLs" : ""}. ${project.verifiedAt ? "It will appear in notifications when its state changes." : "Ownership-only engines were left out; this public-link scan remains limited to the selected root URL."}`,
      );
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Scan could not start.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function startJourney(project: Project) {
    if (!externalAnalyzerAccepted) {
      setError("Confirm the external analyzer disclosure before starting this journey scan.");
      return;
    }
    const raw = window.prompt(
      "Define a real same-origin read-only journey. A body-only smoke is not accepted as user-journey evidence.",
      JSON.stringify(
        {
          name: "Primary navigation",
          steps: [
            { action: "goto", path: "/" },
            { action: "expectVisible", selector: "main" },
          ],
        },
        null,
        2,
      ),
    );
    if (!raw) return;
    setActionBusy(true);
    setError("");
    let journey: unknown;
    try {
      journey = JSON.parse(raw);
      const payload = { projectId: project.id, locale: defaultLocale, modules: ["core_audit", "journey_test"], externalProviderConsent: true, journey };
      const operation = operationKey("journey-scan", payload);
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      await apiFetch(
        "/api/v1/scans",
        init,
      );
      completeOperation(operation.intent);
      setExternalAnalyzerAccepted(false);
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Journey Test could not start.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function uploadSource(event: FormEvent) {
    event.preventDefault();
    if (!sourceFile || !sourceProject) return;
    const body = new FormData();
    body.set("projectId", sourceProject);
    body.set("source", sourceFile);
    setActionBusy(true);
    setError("");
    const operation = operationKey("source-upload", { projectId: sourceProject, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
    try {
      const result = await apiFetch<{ sourceInput: SourceInput }>(
        "/api/v1/source-inputs",
        { method: "POST", body, headers: { "Idempotency-Key": operation.key } },
      );
      setSourceFile(null);
      completeOperation(operation.intent);
      setMessage(
        result.sourceInput.status === "completed"
          ? `Source Audit completed with ${result.sourceInput.result?.module?.findingCount || 0} dependency finding(s).`
          : `Source Audit ended ${result.sourceInput.status}: ${result.sourceInput.failureCode || "result unavailable"}.`,
      );
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Source Audit could not run.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function connectIntegration(provider: string) {
    setActionBusy(true);
    setError("");
    try {
      const result = await apiFetch<{ url: string }>(
        `/api/v1/integrations/${provider}/connect`,
        { method: "POST" },
      );
      window.location.assign(result.url);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : `${provider} could not connect.`,
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function disconnectIntegration(provider: string) {
    setActionBusy(true);
    setError("");
    try {
      await apiFetch(`/api/v1/integrations/${provider}`, { method: "DELETE" });
      setMessage(`${provider} disconnected.`);
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : `${provider} could not disconnect.`,
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function configureWebhook(event: FormEvent) {
    event.preventDefault();
    setActionBusy(true);
    setError("");
    setGeneratedSecret("");
    try {
      const result = await apiFetch<{ generatedSecret?: string | null }>(
        "/api/v1/integrations/webhook",
        jsonRequest("PUT", {
          url: webhookUrl.trim(),
          ...(webhookSecret.trim() ? { secret: webhookSecret.trim() } : {}),
        }),
      );
      if (result.generatedSecret) setGeneratedSecret(result.generatedSecret);
      setMessage("Signed webhook configured.");
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Webhook could not be configured.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setActionBusy(true);
    setError("");
    try {
      await apiFetch(
        "/api/v1/settings",
        jsonRequest("PUT", {
          workspaceName,
          defaultLocale,
          notifyScanComplete,
          notifyHighPriority,
          weeklyDigest,
        }),
      );
      setMessage("Workspace settings saved.");
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Settings could not be saved.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function requestExpertReview(report: Report) {
    const pageUrls = [
      ...new Set((report.payload?.pages || []).map((page) => page.url)),
    ].slice(0, 25);
    if (!pageUrls.length) {
      setError("This report has no completed pages to review.");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/v1/reports/${report.id}/expert-review-requests`,
        jsonRequest("POST", { pageUrls, idempotencyKey: crypto.randomUUID() }),
      );
      setMessage("Expert Review requested.");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Expert Review could not be requested.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function downloadReport(report: Report, format: "pdf" | "json") {
    const key = `${report.id}:${format}`;
    setExporting(key);
    setError("");
    try {
      let response = await fetch(
        `/api/v1/reports/${report.id}/export?format=${format}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error || `Report export failed (${response.status}).`,
        );
      }
      if (format === "pdf" && response.status === 202) {
        const queued = (await response.json().catch(() => ({}))) as { execution?: { id?: string; status?: string } };
        const executionId = queued.execution?.id;
        if (!executionId) throw new Error("The PDF worker did not return a trackable execution.");
        setMessage("PDF generation queued. This page will download the verified artifact when it is ready.");
        let terminal: { status?: string; failureCode?: string | null } | null = null;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          const result = await apiFetch<{ execution?: { status?: string; failureCode?: string | null } }>(`/api/v1/executions/${encodeURIComponent(executionId)}`);
          terminal = result.execution || null;
          if (terminal?.status === "completed") break;
          if (["failed", "unavailable", "cancelled"].includes(terminal?.status || "")) {
            throw new Error(`PDF generation ended ${terminal?.status}${terminal?.failureCode ? ` (${terminal.failureCode})` : ""}. Try again when the worker is available.`);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
        if (terminal?.status !== "completed") throw new Error("The PDF is still being prepared. Retry the download in a moment; the queued job was not duplicated.");
        response = await fetch(`/api/v1/executions/${encodeURIComponent(executionId)}/download`, { credentials: "include" });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `The completed PDF artifact could not be downloaded (${response.status}).`);
        }
      }
      const blob = await response.blob();
      if (format === "pdf" && await blob.slice(0, 5).text() !== "%PDF-") {
        throw new Error("The export service did not return a valid PDF artifact. Nothing was downloaded.");
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wpa-report-v${report.version}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`${format.toUpperCase()} report downloaded.`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Report export could not be downloaded.",
      );
    } finally {
      setExporting("");
    }
  }
  async function compareSelectedReports() {
    if (!compareLeftId || !compareRightId || compareLeftId === compareRightId) {
      setCompareError("Choose two different report versions to compare.");
      setCompareResult(null);
      return;
    }
    setCompareLoading(true);
    setCompareError("");
    setCompareResult(null);
    try {
      const result = await apiFetch<ReportComparison>(`/api/v1/reports/compare/${encodeURIComponent(compareLeftId)}/${encodeURIComponent(compareRightId)}`);
      if (!result || typeof result.left !== "string" || typeof result.right !== "string") {
        throw new Error("The comparison response was incomplete.");
      }
      setCompareResult(result);
    } catch (requestError) {
      setCompareError(requestError instanceof Error ? requestError.message : "These report versions could not be compared.");
    } finally {
      setCompareLoading(false);
    }
  }
  async function createReportShare(report: Report) {
    setShareBusy(true);
    setShareError("");
    setShareMessage("");
    try {
      const result = await apiFetch<ReportShare>(
        "/api/v1/reports/" + encodeURIComponent(report.id) + "/share",
        jsonRequest("POST", { expiresInDays: Number(shareExpiryDays) }),
      );
      if (result?.status !== "active" || !canonicalShareUrl(result.pagePath)) {
        throw new Error("The share service did not return its canonical public page path.");
      }
      setReportShares((current) => ({ ...current, [report.id]: result }));
      setShareMessage(result.expiresInDays
        ? "Share link created. The server confirmed a " + result.expiresInDays + "-day expiry."
        : result.expiresAt
          ? "Share link created. The server will expire it on " + new Date(result.expiresAt).toLocaleDateString() + "."
        : "Share link created. The server will apply its configured expiry.");
    } catch (requestError) {
      setShareError(requestError instanceof Error ? requestError.message : "The report could not be shared.");
    } finally {
      setShareBusy(false);
    }
  }
  async function copyReportShare(report: Report) {
    const share = reportShares[report.id] || report.share;
    const url = canonicalShareUrl(share?.pagePath);
    if (!url) {
      setShareError("A canonical public page path is not available for this share.");
      return;
    }
    setShareError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(url);
      setShareMessage("Share link copied.");
    } catch {
      setShareMessage("Share link ready. Select the field to copy it manually.");
    }
  }
  async function revokeReportShare(report: Report) {
    setShareBusy(true);
    setShareError("");
    setShareMessage("");
    try {
      const result = await apiFetch<{ reportId?: string; status?: string }>(
        "/api/v1/reports/" + encodeURIComponent(report.id) + "/share",
        { method: "DELETE" },
      );
      if (result?.status !== "revoked") throw new Error("The share service did not confirm revocation.");
      setReportShares((current) => ({
        ...current,
        [report.id]: { ...(current[report.id] || report.share || {}), status: "revoked" },
      }));
      setShareMessage("Share link revoked. The public page is no longer available.");
    } catch (requestError) {
      setShareError(requestError instanceof Error ? requestError.message : "The share link could not be revoked.");
    } finally {
      setShareBusy(false);
    }
  }
  async function verifyTarget(project: Project) {
    setActionBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/v1/projects/${project.id}/verify-target`,
        jsonRequest("POST", { method: "dns" }),
      );
      setMessage("DNS ownership verified.");
      setDnsSetupTargetId("");
      await load();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "DNS ownership could not be verified.",
      );
    } finally {
      setActionBusy(false);
    }
  }

  const recentFindings = useMemo(
    () => dashboard?.recentFindings || [],
    [dashboard],
  );
  const productEngineAvailable = (engine: ProductEngine) => {
    const entitlements = dashboard?.plan.entitlements || {};
    if (!engine.moduleId) return true;
    if (engine.moduleId === "advanced_geo") return entitlements.geo?.limit === "advanced";
    if (engine.moduleId === "visual_ux") return entitlements.design?.limit === "advanced";
    const entitlement = entitlements[engine.moduleId];
    return Boolean(entitlement && entitlement.executionMode !== "disabled");
  };
  const activeProductEngine =
    productEngines.find((engine) => engine.id === activeEngine && productEngineAvailable(engine)) || productEngines[0];
  const activeEngineFindings = useMemo(() => {
    const matched = (findings.length ? findings : recentFindings).filter((finding) =>
      findingMatchesEngine(finding, activeProductEngine),
    );
    return [
      ...matched.filter((finding) => finding.state !== "resolved"),
      ...matched.filter((finding) => finding.state === "resolved"),
    ];
  }, [activeProductEngine, findings, recentFindings]);
  const activeEnginePriority = activeEngineFindings.find(
    (finding) => finding.state !== "resolved",
  );
  const selectedReportSummary = reports.find((report) => report.id === selectedReportId) || reports[0];
  const selectedReport = selectedReportSummary ? reportDetails[selectedReportSummary.id] || selectedReportSummary : undefined;
  const activeEngineModuleId = ({
    "wpa-site-crawler": "full_site_crawl",
    "performance-plus": "performance_plus",
    "advanced-geo": "geo",
    "visual-ux": "design",
    "journey-test": "journey_test",
  } as Record<string, string>)[activeProductEngine.id];
  const activeEngineModuleState = activeEngineModuleId ? selectedReport?.payload?.modules?.[activeEngineModuleId] : undefined;
  const activeEngineEmptyState = activeEngineModuleState && activeEngineModuleState.status !== "completed"
    ? activeEngineModuleState.status.replaceAll("_", " ")
    : "clear";
  const selectedReportShare = selectedReport
    ? reportShares[selectedReport.id] || selectedReport.share
    : undefined;
  const selectedReportShareUrl = canonicalShareUrl(selectedReportShare?.pagePath);
  const canRequestExpertReview = Boolean(dashboard?.plan.entitlements?.expert_review && dashboard.plan.entitlements.expert_review.executionMode !== "disabled");
  const fullSiteCoverage = objectRecord(selectedReport?.payload?.modules?.full_site_crawl?.coverage);
  const crawlerCoverage = objectRecord(fullSiteCoverage.crawler || fullSiteCoverage);
  const crawlerSources = objectRecord(crawlerCoverage.sources);
  useEffect(() => {
    const reportId = selectedReportSummary?.id;
    if (!reportId || reportDetails[reportId]) return undefined;
    let cancelled = false;
    setReportDetailLoading(reportId);
    setReportDetailError("");
    void apiFetch<{ report: Report }>(`/api/v1/reports/${encodeURIComponent(reportId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.report || result.report.id !== reportId) throw new Error("The report detail response did not match the selected summary.");
        setReportDetails((current) => ({ ...current, [reportId]: result.report }));
      })
      .catch((requestError: unknown) => { if (!cancelled) setReportDetailError(surfaceFailure(requestError, "Report detail is unavailable.")); })
      .finally(() => { if (!cancelled) setReportDetailLoading((current) => current === reportId ? "" : current); });
    return () => { cancelled = true; };
  }, [reportDetails, selectedReportSummary?.id]);
  useEffect(() => {
    const chronological = [...reports].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    setCompareLeftId((current) => current || chronological[0]?.id || "");
    setCompareRightId((current) => current || chronological[1]?.id || "");
  }, [reports]);
  useEffect(() => {
    setShareError("");
    setShareMessage("");
  }, [selectedReportId]);
  const selectedIntegration =
    integrations.find((integration) => integration.provider === activeIntegration) ||
    integrations[0];
  const visibleTargetProjects = useMemo<Project[]>(() => {
    const projects = dashboard?.projects || [];
    if (!import.meta.env.DEV) return projects;
    return [
      ...projects,
      { id: "preview-project-004", name: "Northstar Commerce", origin: "https://shop.northstar.example", verifiedAt: "2026-08-12T12:00:00.000Z", previewOnly: true },
      { id: "preview-project-005", name: "Northstar Careers", origin: "https://careers.northstar.example", verifiedAt: null, verificationToken: "preview-only", previewOnly: true },
      { id: "preview-project-006", name: "Northstar Journal", origin: "https://journal.northstar.example", verifiedAt: "2026-08-11T12:00:00.000Z", previewOnly: true },
    ];
  }, [dashboard?.projects]);
  const runwayProjects = useMemo(() => {
    const projects = visibleTargetProjects;
    if (!projects.length) return [];
    const focused =
      projects.find((project) => project.id === focusedTargetId) || projects[0];
    return [focused, ...projects.filter((project) => project.id !== focused.id)].slice(
      0,
      2,
    );
  }, [focusedTargetId, visibleTargetProjects]);
  const severityCounts = useMemo(
    () =>
      Object.fromEntries(
        ["critical", "high", "medium", "low", "info"].map((severity) => [
          severity,
          findings.filter(
            (finding) =>
              finding.state !== "resolved" && finding.severity === severity,
          ).length,
        ]),
      ),
    [findings],
  );
  const filteredFindings = useMemo(
    () =>
      findings.filter((finding) => {
        if (findingModule && finding.moduleId !== findingModule) return false;
        const source =
          typeof finding.source === "string"
            ? finding.source
            : finding.source?.name || finding.category || "WPA";
        if (findingSource && source !== findingSource) return false;
        if (findingDevice && finding.device !== findingDevice) return false;
        if (findingKind && finding.kind !== findingKind) return false;
        if (
          findingConfidence &&
          Number(finding.confidence || 0) < Number(findingConfidence)
        )
          return false;
        if (
          findingCoverage === "complete" &&
          finding.coverage?.truncated !== false
        )
          return false;
        if (findingCoverage === "truncated" && !finding.coverage?.truncated)
          return false;
        if (findingFilter === "resolved") return finding.state === "resolved";
        if (finding.state === "resolved") return false;
        if (findingFilter === "active") return true;
        if (findingFilter === "high_priority")
          return ["critical", "high"].includes(finding.severity || "");
        return finding.severity === findingFilter;
      }),
    [
      findings,
      findingFilter,
      findingModule,
      findingSource,
      findingDevice,
      findingKind,
      findingConfidence,
      findingCoverage,
    ],
  );
  const goToSurface = (surface: DashboardSurface) => {
    setError("");
    setMessage("");
    navigate(dashboardPathForSurface(surface));
  };
  const openFindings = (filter: FindingFilter) => {
    setFindingFilter(filter);
    goToSurface("findings");
  };
  const openEngineFindings = (finding?: Finding) => {
    setFindingModule(activeProductEngine.moduleId || "");
    setFindingSource(activeProductEngine.moduleId ? "" : activeProductEngine.sourceName);
    openFindings(
      finding?.state === "resolved"
        ? "resolved"
        : ["critical", "high"].includes(finding?.severity || "")
          ? "high_priority"
          : "active",
    );
  };
  async function generateAiRemediation(finding: Finding, refresh = false) {
    const fingerprint = finding.fingerprint;
    if (!fingerprint) return;
    setAiRemediations((current) => ({ ...current, [fingerprint]: { ...current[fingerprint], busy: true, error: "" } }));
    const payload = { refresh };
    const operation = operationKey("ai-remediation", { fingerprint, ...payload });
    try {
      const init = jsonRequest("POST", payload);
      init.headers = { ...init.headers, "Idempotency-Key": operation.key };
      const result = await apiFetch<{
        remediation: AiRemediationOutput;
        cached?: boolean;
        generatedAt?: string;
        quota?: { limit?: number; used?: number; remaining?: number };
      }>(`/api/v1/findings/${encodeURIComponent(fingerprint)}/remediation`, init);
      completeOperation(operation.intent);
      setAiRemediations((current) => ({
        ...current,
        [fingerprint]: { output: result.remediation, cached: result.cached === true, generatedAt: result.generatedAt, quota: result.quota, busy: false, error: "" },
      }));
      if (result.quota) {
        setDashboard((current) => {
          if (!current?.allowances) return current;
          return {
            ...current,
            allowances: {
              ...current.allowances,
              aiRemediations: {
                limit: result.quota?.limit ?? current.allowances.aiRemediations.limit,
                used: result.quota?.used ?? current.allowances.aiRemediations.used,
                remaining: result.quota?.remaining ?? current.allowances.aiRemediations.remaining,
              },
            },
          };
        });
      }
    } catch (requestError) {
      setAiRemediations((current) => ({
        ...current,
        [fingerprint]: { ...current[fingerprint], busy: false, error: requestError instanceof Error ? requestError.message : "AI remediation is temporarily unavailable. The measured finding remains available." },
      }));
    }
  }
  const contractFilters = (
    <div className="finding-filters finding-filters--contract">
      <select
        aria-label="Filter by module"
        value={findingModule}
        onChange={(event) => setFindingModule(event.target.value)}
      >
        <option value="">All modules</option>
        {[
          ...new Set(
            findings
              .map((finding) => finding.moduleId)
              .filter((value): value is string => Boolean(value)),
          ),
        ].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <select
        aria-label="Filter by source"
        value={findingSource}
        onChange={(event) => setFindingSource(event.target.value)}
      >
        <option value="">All sources</option>
        {[
          ...new Set(
            findings.map((finding) =>
              typeof finding.source === "string"
                ? finding.source
                : finding.source?.name || finding.category || "WPA",
            ),
          ),
        ].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <select
        aria-label="Filter by device"
        value={findingDevice}
        onChange={(event) => setFindingDevice(event.target.value)}
      >
        <option value="">All devices</option>
        {[
          ...new Set(
            findings
              .map((finding) => finding.device)
              .filter((value): value is string => Boolean(value)),
          ),
        ].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <select
        aria-label="Filter by evidence kind"
        value={findingKind}
        onChange={(event) => setFindingKind(event.target.value)}
      >
        <option value="">All evidence kinds</option>
        <option value="measured">Measured</option>
        <option value="heuristic">Heuristic</option>
        <option value="human">Human</option>
        <option value="ai">AI</option>
      </select>
      <select
        aria-label="Filter by confidence"
        value={findingConfidence}
        onChange={(event) => setFindingConfidence(event.target.value)}
      >
        <option value="">Any confidence</option>
        <option value="0.9">90%+</option>
        <option value="0.75">75%+</option>
        <option value="0.5">50%+</option>
      </select>
      <select
        aria-label="Filter by coverage"
        value={findingCoverage}
        onChange={(event) => setFindingCoverage(event.target.value)}
      >
        <option value="">Any coverage</option>
        <option value="complete">Complete coverage</option>
        <option value="truncated">Truncated coverage</option>
      </select>
    </div>
  );
  const workspaceRateLimited = workspaceFailure?.status === 429 || workspaceFailure?.code === "RATE_LIMIT_EXCEEDED";
  const retryAfterMinutes = workspaceFailure?.retryAfterSeconds === undefined
    ? null
    : Math.max(1, Math.ceil(workspaceFailure.retryAfterSeconds / 60));
  return (
    <PortalShell
      active={active}
      nav={workspaceNav}
      onNavigate={(destination) => {
        if (destination === "support") {
          navigate("/app/support", true);
          return;
        }
        const surface = dashboardSurfaceAliases[destination.toLowerCase()];
        if (surface) goToSurface(surface);
      }}
      footerCard={planCard}
      identity={session?.user || null}
      profileUsage={dashboard?.allowances ? {
        planName: dashboard.plan.name,
        pageCredits: dashboard.allowances.pageCredits,
        aiRemediations: dashboard.allowances.aiRemediations,
        projects: dashboard.allowances.projects,
        sourceAudits: dashboard.allowances.sourceAudits,
      } : null}
      notifications={notifications}
    >
      {(actionBusy || exporting) && <span className="sr-only" role="status" aria-live="polite">{exporting ? "Preparing report export…" : "Updating workspace…"}</span>}
      {loading && (
        <div className="portal-loading" role="status" aria-live="polite" aria-busy="true">
          <i />
          <span>Loading your workspace…</span>
        </div>
      )}
      {error && dashboard && (
        <div className="portal-alert" role="alert">
          <CircleAlert />
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {message && (
        <div className="portal-message" role="status">
          <CheckCircle2 />
          {message}
          <button onClick={() => setMessage("")}>Dismiss</button>
        </div>
      )}
      {!loading && !dashboard && legalAcceptanceRequired && (
        <section className="workspace-unavailable portal-card" aria-labelledby="legal-acceptance-title">
          <div className="workspace-unavailable__icon"><FileText /></div>
          <div className="workspace-unavailable__copy">
            <span className="workspace-unavailable__eyebrow">CURRENT SERVICE TERMS</span>
            <h1 id="legal-acceptance-title">Review the current account terms.</h1>
            <p>Your verified session has no record for the active Terms and Acceptable Use versions. Privacy and KVKK notices are provided separately and are not consent checkboxes.</p>
            <label className="target-authorization"><input type="checkbox" checked={legalGateAccepted} onChange={(event) => setLegalGateAccepted(event.target.checked)} /><span>I agree to the <a href="/terms">Terms of Service</a> and <a href="/acceptable-use">Acceptable Use Policy</a>. <small>Terms {legalConfig?.documents?.terms?.version || "unavailable"} · AUP {legalConfig?.documents?.acceptableUse?.version || "unavailable"}</small></span></label>
            <p>Read the <a href="/privacy">Privacy Notice</a> and <a href="/kvkk">KVKK Aydınlatma Metni</a>.</p>
            {error && <p className="portal-alert" role="alert">{error}</p>}
            <div className="workspace-unavailable__actions"><button className="portal-primary" disabled={actionBusy || !legalGateAccepted || !legalConfig?.ready} onClick={() => void acceptCurrentLegalDocuments()}><CheckCircle2 /> Record acceptance and continue</button></div>
          </div>
        </section>
      )}
      {!loading && !dashboard && error && !legalAcceptanceRequired && (
        <section className="workspace-unavailable portal-card" role="alert">
          <div className="workspace-unavailable__icon">
            <CircleAlert />
          </div>
          <div className="workspace-unavailable__copy">
            <span className="workspace-unavailable__eyebrow">
              {workspaceRateLimited ? "REQUEST BUDGET" : "WORKSPACE CONNECTION"}
            </span>
            <h1>{workspaceRateLimited ? "Request limit reached." : "We couldn’t load your workspace."}</h1>
            {workspaceRateLimited ? (
              <p>
                This connection has temporarily used its API request budget.
                Signing out does not reset it. Try again{retryAfterMinutes ? ` in about ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}` : " in a few minutes"}.
              </p>
            ) : (
              <p>
                The workspace API is unavailable right now. Try again, or return
                to sign in and continue when the connection is ready.
              </p>
            )}
            <div className="workspace-unavailable__actions">
              <button className="portal-primary" onClick={() => void load()}>
                <Activity /> Try again
              </button>
              {!workspaceRateLimited && <button
                className="workspace-unavailable__secondary"
                onClick={() => navigate("/login", true)}
              >
                Return to sign in
              </button>}
            </div>
          </div>
        </section>
      )}

      {!loading && dashboard && active === "overview" && (
        <>
          <section className="reference-overview">
            <header className="reference-overview__heading">
              <h1>Overview</h1>
              <button className="reference-target" onClick={() => goToSurface("targets")}>
                <strong>{safeHostname(dashboard.projects[0]?.origin) || dashboard.workspace.name}</strong>
                {dashboard.projects[0]?.verifiedAt && <CheckCircle2 aria-label="Verified target" />}
              </button>
              <p>{dashboard.projects[0]?.verifiedAt ? "DNS ownership enabled" : "Public-link access"}</p>
            </header>

            <div className="reference-metrics" aria-label="Workspace metrics">
              <button onClick={() => openFindings("active")}><span>ACTIVE</span><AnimatedNumber value={dashboard.metrics.activeFindings} /></button>
              <button onClick={() => openFindings("high_priority")}><span>HIGH PRIORITY</span><AnimatedNumber value={dashboard.metrics.highPriority} /></button>
              <button onClick={() => openFindings("resolved")}><span>RESOLVED</span><AnimatedNumber value={dashboard.metrics.resolved} /></button>
            </div>

            <div className={`reference-well${liveScanProgress ? " is-active" : ""}`} aria-hidden="true" />

            {liveScanProgress ? (
              <ScanProgressPanel snapshot={liveScanProgress} transport={progressTransport} />
            ) : (
              <article className="reference-priority" aria-live="polite">
                <i aria-hidden="true" />
                <strong>{plainFindingText(activeEnginePriority?.title || activeEnginePriority?.description, `${activeProductEngine.label} has no active priority finding`)}</strong>
                <span>{activeEnginePriority?.severity || activeEngineEmptyState}</span>
                <span>{safePathname(activeEnginePriority?.pageUrl) || "No recorded finding"}</span>
                <span className="reference-priority__confidence"><small>Confidence</small>{typeof activeEnginePriority?.confidence === "number" ? `${Math.round(activeEnginePriority.confidence * 100)}%` : "—"}</span>
                <button onClick={() => openEngineFindings(activeEnginePriority)}>{activeEnginePriority ? "View evidence" : "View findings"} <ArrowRight /></button>
              </article>
            )}

            <aside className="reference-engines" aria-label="Analysis engines">
              {productEngines.map((engine) => {
                const available = productEngineAvailable(engine);
                return <button key={engine.id} aria-pressed={activeProductEngine.id === engine.id} aria-label={`${engine.label}${available ? "" : " — plan upgrade required"}`} title={available ? engine.label : `${engine.label} is not included in ${dashboard.plan.name}.`} disabled={!available} className={`cutaway-engine reference-engine${activeProductEngine.id === engine.id ? " is-active" : ""}${available ? "" : " is-locked"}`} onClick={() => setActiveEngine(engine.id)}><span>{engine.label}{!available && <small>Upgrade</small>}</span></button>;
              })}
              <div className="reference-engine-contract"><strong>{productEngines.length} product-owned engine surfaces</strong><small>{capabilities?.version ? `Capability contract ${capabilities.version}` : surfaceErrors.capabilities || "Capability contract not returned."}</small></div>
            </aside>

            <section className="reference-ledger" aria-live="polite">
              <header><span>RECENT FINDINGS</span><small>{activeProductEngine.label}</small></header>
              {activeEngineFindings.slice(0, 3).map((finding, index) => <button key={finding.fingerprint || `${finding.title}-${index}`} onClick={() => openEngineFindings(finding)}>
                <strong>{plainFindingText(finding.title || finding.description, "Website finding")}</strong>
                <span>{finding.severity || "medium"}</span>
                <span>{safePathname(finding.pageUrl) || finding.category || "WPA analysis"}</span>
                <time>{finding.createdAt ? new Date(finding.createdAt).toLocaleDateString() : "recent"}</time>
              </button>)}
              {!activeEngineFindings.length && <button onClick={() => openEngineFindings()}><strong>{activeEngineModuleState && activeEngineModuleState.status !== "completed" ? `No findings returned${activeEngineModuleState.errorCode ? ` — ${activeEngineModuleState.errorCode}` : ""}` : "No recent findings"}</strong><span>{activeEngineEmptyState}</span><span>{activeProductEngine.label}</span><time>—</time></button>}
            </section>
          </section>

        </>
      )}

      {!loading && dashboard && active === "findings" && surfaceErrors.findings && (
        <SurfaceUnavailable label="Findings" message={surfaceErrors.findings} onRetry={() => void load()} />
      )}

      {!loading && dashboard && active === "findings" && !surfaceErrors.findings && (
        <section className="findings-ledger portal-section">
          <header className="findings-ledger__heading">
            <div>
              <span>01 / EVIDENCE LEDGER</span>
              <h1>Findings</h1>
              <p>Measured issues, their source and the evidence required to act.</p>
            </div>
            <dl aria-label="Finding totals">
              <div><dt>Active</dt><dd><AnimatedNumber value={activeFindingsTotal} /></dd></div>
              <div><dt>Priority</dt><dd><AnimatedNumber value={dashboard.metrics.highPriority} /></dd></div>
              <div><dt>Resolved</dt><dd><AnimatedNumber value={resolvedFindingsTotal} /></dd></div>
            </dl>
          </header>

          <div className="findings-ledger__controls">
            <div className="findings-ledger__states" aria-label="Finding state filters">
              {[
                ["active", `Active ${activeFindingsTotal}`],
                ["high_priority", `Priority ${dashboard.metrics.highPriority}`],
                ["critical", `Critical ${severityCounts.critical || 0}`],
                ["high", `High ${severityCounts.high || 0}`],
                ["medium", `Medium ${severityCounts.medium || 0}`],
                ["low", `Low ${severityCounts.low || 0}`],
                ["resolved", `Resolved ${resolvedFindingsTotal}`],
              ].map(([filter, label]) => (
                <button
                  className={findingFilter === filter ? "is-active" : ""}
                  key={filter}
                  aria-pressed={findingFilter === filter}
                  onClick={() => setFindingFilter(filter as FindingFilter)}
                >{label}</button>
              ))}
            </div>
            {contractFilters}
          </div>

          <div className="findings-ledger__table" aria-label={`${filteredFindings.length} findings shown`}>
            <div className="findings-ledger__columns" aria-hidden="true">
              <span>Record</span><span>Finding</span><span>Source</span><span>Path</span><span>Severity</span><span />
            </div>
            {filteredFindings.length ? filteredFindings.map((finding, index) => {
              const source = typeof finding.source === "string"
                ? finding.source
                : finding.source?.name || finding.category || "WPA";
              const aiState = finding.fingerprint ? aiRemediations[finding.fingerprint] : undefined;
              return (
                <details
                  className={`findings-ledger__record${finding.state === "resolved" ? " is-resolved" : ""}`}
                  key={finding.fingerprint || index}
                >
                  <summary>
                    <span className="findings-ledger__number">F.{String(index + 1).padStart(2, "0")}</span>
                    <strong>{plainFindingText(finding.title, "Website finding")}</strong>
                    <span>{source}</span>
                    <span>{safePathname(finding.pageUrl) || finding.category || "—"}</span>
                    <SeverityBadge severity={finding.severity} />
                    <ArrowRight />
                  </summary>
                  <div className="findings-ledger__evidence">
                    <div className="findings-ledger__proof">
                      <span>EVIDENCE / {finding.kind || "MEASURED"}</span>
                      <h2>{plainFindingText(finding.description, "No additional description was recorded.")}</h2>
                      <p>{plainFindingText(finding.remediation, "Review the recorded evidence and repair the affected implementation.")}</p>
                      {finding.evidence?.length ? (
                        <pre>{JSON.stringify(finding.evidence, null, 2)}</pre>
                      ) : <code>NO ADDITIONAL PAYLOAD / SOURCE RECORD PRESERVED</code>}
                      {finding.fingerprint && <section className="finding-ai-guidance" aria-label="AI-generated remediation guidance">
                        <header><div><Sparkles /><span>AI-GENERATED REMEDIATION GUIDANCE</span></div><small>Suggestion only · not a verified fix</small></header>
                        {!aiState?.output && <div className="finding-ai-guidance__empty"><p>Generate a minimized, structured suggestion from this measured finding. Core evidence remains authoritative.</p><button type="button" disabled={aiState?.busy} onClick={() => void generateAiRemediation(finding)}>{aiState?.busy ? "Generating…" : "Generate suggestion"}</button></div>}
                        {aiState?.error && <div className="finding-ai-guidance__error" role="alert"><CircleAlert /><span><b>AI is unavailable; the finding is unchanged.</b>{aiState.error}</span><button type="button" disabled={aiState.busy} onClick={() => void generateAiRemediation(finding)}>Try again</button></div>}
                        {aiState?.output && <article className="finding-ai-guidance__result">
                          <div className="finding-ai-guidance__meta"><span>{aiState.cached ? "cached" : "generated"}</span><span>Confidence label: {aiState.output.confidence}</span>{aiState.quota && <span>{aiState.quota.remaining ?? "—"} of {aiState.quota.limit ?? "—"} monthly generations remain</span>}</div>
                          <h3>{aiState.output.summary}</h3><p><b>Likely cause:</b> {aiState.output.likelyCause}</p>
                          <ol>{aiState.output.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                          {aiState.output.codeExample && <pre><code>{aiState.output.codeExample}</code></pre>}
                          <div className="finding-ai-guidance__caveats"><b>Verify before applying</b><ul>{aiState.output.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul></div>
                          <footer><span>{aiState.generatedAt ? `Generated ${new Date(aiState.generatedAt).toLocaleString()}` : "Generated by the configured AI route"}</span><button type="button" disabled={aiState.busy} onClick={() => void generateAiRemediation(finding, true)}>{aiState.busy ? "Regenerating…" : "Regenerate · uses quota"}</button></footer>
                        </article>}
                      </section>}
                    </div>
                    <dl>
                      <div><dt>Module</dt><dd>{finding.moduleId || "unclassified"}</dd></div>
                      <div><dt>Rule</dt><dd>{finding.ruleId || "—"}</dd></div>
                      <div><dt>Device</dt><dd>{finding.device || "not applicable"}</dd></div>
                      <div><dt>Confidence</dt><dd>{typeof finding.confidence === "number" ? `${Math.round(finding.confidence * 100)}%` : "—"}</dd></div>
                      <div><dt>Coverage</dt><dd>{finding.coverage?.truncated ? "truncated" : finding.coverage ? "complete" : "not recorded"}</dd></div>
                      <div><dt>State</dt><dd>{finding.state || "active"}</dd></div>
                    </dl>
                  </div>
                </details>
              );
            }) : (
              <div className="findings-ledger__empty">
                <Search /><b>No records match this view.</b>
                <p>{findingFilter === "resolved" ? "Resolved records appear after a comparable scan clears their fingerprint." : "Change a filter or run a new scan."}</p>
              </div>
            )}
          </div>
          <footer className="findings-ledger__footer">
            <span>{filteredFindings.length} shown</span><span>{findingsTotal} lifecycle records</span><span>Evidence stays attached to its source</span>
          </footer>
        </section>
      )}

      {!loading && dashboard && active === "reports" && surfaceErrors.reports && (
        <SurfaceUnavailable label="Reports" message={surfaceErrors.reports} onRetry={() => void load()} />
      )}

      {!loading && dashboard && active === "reports" && !surfaceErrors.reports && (
        <section className="reports-seal portal-section">
          <h1 className="sr-only">Reports</h1>

          {selectedReport ? (
            <div className="reports-seal__stage">
              <article className="report-sheet" aria-label={`Report version ${selectedReport.version}`}>
                <i className="report-sheet__corner" aria-hidden="true" />
                <Globe2 className="report-sheet__globe" aria-hidden="true" />
                <div className="report-sheet__title">
                  <span>REPORT</span>
                  <h2>Website Analysis {String(selectedReport.version).padStart(2, "0")}</h2>
                </div>
                <dl className="report-sheet__meta">
                  <div><dt>Target</dt><dd>{safeHostname(dashboard.projects[0]?.origin) || dashboard.workspace.name}<CheckCircle2 /></dd></div>
                  <div><dt>Completed</dt><dd>{new Date(selectedReport.createdAt).toLocaleString()}</dd></div>
                </dl>
                <div className="report-sheet__modules">
                  <span>MODULES</span>
                  {Object.entries(selectedReport.payload?.modules || {}).sort(([, left], [, right]) => Number(left.status === "completed") - Number(right.status === "completed")).slice(0, 5).map(([moduleId, module]) => (
                    <div key={moduleId}><b>{moduleId.replaceAll("_", " ")}</b><small>{module.status}</small>{module.status === "completed" ? <CheckCircle2 /> : <CircleAlert />}</div>
                  ))}
                  {!Object.keys(selectedReport.payload?.modules || {}).length && <div><b>Legacy report</b><small>recorded</small><CheckCircle2 /></div>}
                </div>
                <div className="report-sheet__seal"><FileText /><span>VERSIONED REPORT<br />WEBPAGEANALYZ</span></div>
              </article>

              <aside className="report-inspector">
                <header>
                  <span>REPORT NAME</span>
                  <strong>Website Analysis {String(selectedReport.version).padStart(2, "0")}</strong>
                  <p>v{selectedReport.version}.0</p>
                </header>
                <dl className="report-inspector__summary">
                  <div><dt>Status</dt><dd><i />{selectedReport.payload?.summary?.terminalState || selectedReport.status.replaceAll("_", " ")}</dd></div>
                  <div><dt>Record</dt><dd><FileText /><span><b>Versioned report</b><small>Generated by WebPageAnalyz; not a certification</small></span></dd></div>
                  <div><dt>Coverage</dt><dd>{selectedReport.payload?.summary?.completedPages || 0} / {selectedReport.payload?.summary?.requestedPages || 0} pages</dd></div>
                </dl>
                <div className="report-inspector__modules">
                  <span>MODULE COMPLETENESS</span>
                  {Object.entries(selectedReport.payload?.modules || {}).map(([moduleId, module]) => (
                    <div key={moduleId}><b>{moduleId.replaceAll("_", " ")}</b><em className={`is-${module.status}`}>{module.status}</em>{module.errorCode && <small>{module.errorCode}</small>}</div>
                  ))}
                  {!Object.keys(selectedReport.payload?.modules || {}).length && <p>No module ledger was recorded for this legacy report.</p>}
                </div>
                {reportDetailLoading === selectedReport.id && <p className="report-detail-state" role="status">Loading the selected report detail…</p>}
                {reportDetailError && selectedReportSummary?.id === selectedReport.id && <p className="report-detail-state is-error" role="alert">{reportDetailError}</p>}
                {Object.keys(crawlerSources).length > 0 && <section className="report-crawler-coverage" aria-labelledby="crawler-coverage-title"><span id="crawler-coverage-title">CRAWLER DISCOVERY PROVENANCE</span><dl>{Object.entries(crawlerSources).map(([source, value]) => { const sourceRecord = objectRecord(value); return <div key={source}><dt>{source.replaceAll("_", " ")}</dt><dd>{String(sourceRecord.uniqueUrls ?? sourceRecord.references ?? 0)} URLs</dd></div>; })}</dl>{Boolean(crawlerCoverage.truncated) && <p>Coverage was bounded: {Array.isArray(crawlerCoverage.truncatedReasons) ? crawlerCoverage.truncatedReasons.join(", ") : "limit reached"}.</p>}</section>}
                <div className="report-inspector__actions">
                  <button title={canExportReports ? "Download a verified PDF artifact" : "Signal or higher is required"} disabled={Boolean(exporting) || !canExportReports} onClick={() => void downloadReport(selectedReport, "pdf")}>{exporting === `${selectedReport.id}:pdf` ? "Preparing…" : "Download PDF"}<ArrowRight /></button>
                  <button title={canExportReports ? "Export the versioned JSON report" : "Signal or higher is required"} disabled={Boolean(exporting) || !canExportReports} onClick={() => void downloadReport(selectedReport, "json")}>{exporting === `${selectedReport.id}:json` ? "Preparing…" : "Export JSON"}<ArrowRight /></button>
                  {canRequestExpertReview && selectedReport.status === "automated_draft" && <button disabled={actionBusy || reportDetailLoading === selectedReport.id} onClick={() => void requestExpertReview(selectedReport)}>Request Expert Review<ArrowRight /></button>}
                </div>
                {!canExportReports && <p className="report-share__note">PDF and JSON exports start on Signal. Your in-app evidence remains available on Free.</p>}
                <section className="report-share" aria-labelledby="report-share-title">
                  <header><span>PUBLIC SHARE</span><h3 id="report-share-title">Share published evidence.</h3></header>
                  {!canShareReports ? <p className="report-share__note">Shareable read-only reports start on Studio.</p>
                    : selectedReport.status !== "published" ? <p className="report-share__note">Sharing unlocks after this report is published and reviewed.</p>
                    : selectedReportShare?.status === "revoked" ? <p className="report-share__note">This share link was revoked. Create a new link when you are ready.</p>
                    : selectedReportShare?.status === "active" && selectedReportShareUrl ? <div className="report-share__active">
                      <label><span>Canonical public page</span><input aria-label="Canonical public share link" readOnly value={selectedReportShareUrl} /></label>
                      <small>{selectedReportShare.expiresInDays ? "Server confirmed " + selectedReportShare.expiresInDays + "-day expiry." : selectedReportShare.expiresAt ? "Expires " + new Date(selectedReportShare.expiresAt).toLocaleDateString() : "Expiry is controlled by the server response."}</small>
                      <div><button type="button" onClick={() => void copyReportShare(selectedReport)} disabled={shareBusy}>Copy link</button><button type="button" onClick={() => void revokeReportShare(selectedReport)} disabled={shareBusy}>Revoke</button></div>
                    </div> : <div className="report-share__create">
                      <label><span>Link expiry</span><select aria-label="Share link expiry" value={shareExpiryDays} onChange={(event) => setShareExpiryDays(event.target.value)} disabled={shareBusy}><option value="7">7 days</option><option value="30">30 days (default)</option><option value="90">90 days</option></select></label>
                      <small>The selected window is requested; the server response is the source of truth for the actual expiry.</small>
                      <button type="button" className="portal-primary" onClick={() => void createReportShare(selectedReport)} disabled={shareBusy}>{shareBusy ? "Preparing share…" : "Create share link"}<ArrowRight /></button>
                    </div>}
                  {shareError && <p className="report-share__error" role="alert"><CircleAlert />{shareError}</p>}
                  {shareMessage && <p className="report-share__message" role="status" aria-live="polite">{shareMessage}</p>}
                </section>
              </aside>
            </div>
          ) : <div className="reports-seal__empty"><FileText /><b>No report has been issued yet.</b><p>Complete a scan to create the first versioned output.</p></div>}

          <div className="report-timeline" aria-label="Report versions">
            <span>VERSION HISTORY</span>
            <div>
              {reports.map((report) => <button key={report.id} className={selectedReport?.id === report.id ? "is-active" : ""} aria-current={selectedReport?.id === report.id ? "page" : undefined} onClick={() => setSelectedReportId(report.id)}>
                <i />
                <b>V.{String(report.version).padStart(2, "0")}</b>
                <small>{new Date(report.createdAt).toLocaleDateString()}</small>
              </button>)}
            </div>
          </div>

          <section className="reports-compare" aria-labelledby="reports-compare-title">
            <header>
              <div><span>COMPARE / EVIDENCE DELTA</span><h2 id="reports-compare-title">Compare two report versions.</h2><p>The workspace service checks project and capability compatibility before returning a delta.</p></div>
            </header>
            <div className="reports-compare__controls">
              <label><span>Earlier version</span><select aria-label="Earlier report version" value={compareLeftId} onChange={(event) => setCompareLeftId(event.target.value)} disabled={!canCompareReports || compareLoading || reports.length < 2}><option value="">Choose a report</option>{reports.map((report) => <option value={report.id} key={`left-${report.id}`}>V.{String(report.version).padStart(2, "0")} · {new Date(report.createdAt).toLocaleDateString()}</option>)}</select></label>
              <label><span>Later version</span><select aria-label="Later report version" value={compareRightId} onChange={(event) => setCompareRightId(event.target.value)} disabled={!canCompareReports || compareLoading || reports.length < 2}><option value="">Choose a report</option>{reports.map((report) => <option value={report.id} key={`right-${report.id}`}>V.{String(report.version).padStart(2, "0")} · {new Date(report.createdAt).toLocaleDateString()}</option>)}</select></label>
              <button className="portal-primary" title={canCompareReports ? "Compare compatible report versions" : "Studio or higher is required"} onClick={() => void compareSelectedReports()} disabled={!canCompareReports || compareLoading || reports.length < 2}>{compareLoading ? "Comparing…" : "Compare versions"}<ArrowRight /></button>
            </div>
            {!canCompareReports ? <p className="reports-compare__note">Report comparison starts on Studio. The API enforces the same plan boundary.</p> : reports.length < 2 && <p className="reports-compare__note">Two returned report versions are required before a comparison can run.</p>}
            {compareError && <div className="reports-compare__error" role="alert"><CircleAlert />{compareError}</div>}
            {compareResult && <div className="reports-compare__result" aria-live="polite">
              {[['New findings', compareResult.newFindings], ['Fixed findings', compareResult.fixedFindings], ['Unchanged findings', compareResult.unchangedFindings]].map(([label, values]) => {
                const list = Array.isArray(values) ? values : null;
                return <article key={label as string}><header><span>{label as string}</span><strong>{list ? list.length : "—"}</strong></header>{list ? (list.length ? <ul>{list.map((fingerprint) => <li key={fingerprint}><code>{fingerprint}</code></li>)}</ul> : <p>No fingerprints returned.</p>) : <p>This category was not returned by the comparison service.</p>}</article>;
              })}
            </div>}
          </section>
        </section>
      )}

      {!loading && dashboard && active === "targets" && (
        <section className="targets-runway portal-section">
          <header className="targets-runway__heading">
            <div>
              <h1>Targets</h1>
              <p>Add and manage the websites you want to analyze.</p>
              <button className="portal-primary" onClick={() => { setTargetRegistryOpen(true); setTargetComposerOpen(true); setTargetAccessMode("public_link"); }}>＋ <span>Add target</span></button>
            </div>
          </header>

          <div className="targets-runway__scene">
            <div className="targets-runway__horizon" aria-hidden="true"><i /></div>
            <div className="targets-runway__surface" aria-hidden="true"><i /><i /><i /><i /></div>
            {runwayProjects.length ? runwayProjects.map((project, index) => {
              const existingScan = dashboard.scans.find((scan) => scan.projectId === project.id && ["queued", "running"].includes(scan.status));
              return <article className={`runway-target runway-target--${index === 0 ? "near" : "far"}${project.verifiedAt ? " is-verified" : ""}`} key={project.id}>
                <button className="runway-target__focus" onClick={() => setFocusedTargetId(project.id)} aria-label={`Focus ${project.name}`} aria-pressed={focusedTargetId === project.id || (!focusedTargetId && index === 0)}>
                  <Globe2 /><span><strong>{safeHostname(project.origin) || project.name}</strong><small>{project.verifiedAt && <CheckCircle2 />}{project.verifiedAt ? "DNS enabled" : "Public-link"}</small></span>
                </button>
                <div>
                  {project.previewOnly ? <button disabled>Preview <ArrowRight /></button> : <button onClick={() => void startScan(project)} disabled={actionBusy || !externalAnalyzerAccepted || Boolean(existingScan)}>{existingScan ? `${existingScan.status === "queued" ? "Queued" : "Running"}…` : <>Scan <ArrowRight /></>}</button>}
                </div>
              </article>;
            }) : <div className="runway-target runway-target--empty"><Crosshair /><b>No target on the runway.</b><button onClick={() => { setTargetRegistryOpen(true); setTargetComposerOpen(true); setTargetAccessMode("public_link"); }}>Add the first target</button></div>}
            <footer><span>{visibleTargetProjects.filter((project) => project.verifiedAt).length} DNS enabled</span><span>{visibleTargetProjects.length - visibleTargetProjects.filter((project) => project.verifiedAt).length} public-link</span><button onClick={() => { setTargetRegistryOpen(true); setTargetComposerOpen(false); }}>All targets · {visibleTargetProjects.length}<ArrowRight /></button></footer>
          </div>

          {canUseAdditionalUrls && <details className="targets-additional-urls">
            <summary><Globe2 /><span><b>Additional URLs</b><small>Add known URLs only to a DNS-verified full-site scan.</small></span><ArrowRight /></summary>
            <label><span>One URL per line, or comma-separated</span><textarea value={additionalUrlsText} onChange={(event) => setAdditionalUrlsText(event.target.value)} placeholder={'https://example.com/landing-page\nhttps://docs.example.com/getting-started'} rows={5} /><small>{parseUrlList(additionalUrlsText, 500).length} / 500 unique entries. These URLs are rejected before queueing on a public-link target; the server also enforces verified scope, SSRF controls and deduplication.</small></label>
          </details>}

          <label className="targets-external-consent">
            <input type="checkbox" checked={externalAnalyzerAccepted} onChange={(event) => setExternalAnalyzerAccepted(event.target.checked)} />
            <span><b>External analyzer disclosure</b><small>For this scan, send the public target URL to YellowLab.tools for its performance analysis. No account cookie, authorization header, uploaded source archive or private credential is sent. This confirmation resets after the scan is queued.</small></span>
          </label>

          {canUseSourceAudit && <details className="targets-source">
            <summary><UploadCloud /><span><b>Secure ZIP Source Audit</b><small>Inspect dependency evidence without executing uploaded scripts.</small></span><ArrowRight /></summary>
            <form className="source-audit-form" onSubmit={uploadSource}>
              <label><span>Target project</span><select value={sourceProject} onChange={(event) => setSourceProject(event.target.value)} required><option value="">Choose a project</option>{dashboard.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
              <label className="source-file"><span>Source package (.zip)</span><input id="source-package" type="file" accept=".zip,application/zip" onChange={(event) => setSourceFile(event.target.files?.[0] || null)} required /><span className="source-file__control"><UploadCloud />{sourceFile?.name || "Choose ZIP file"}</span></label>
              <button className="portal-primary" disabled={actionBusy || !sourceFile || !sourceProject}>Run Source Audit</button>
            </form>
            {sourceInputs.length > 0 && <div className="targets-source__results" aria-label="Source Audit results">{sourceInputs.map((sourceInput) => <details key={sourceInput.id}><summary><GitBranch /><span><b>Source Audit · {sourceInput.status}</b><small>{sourceInput.failureCode || `${sourceInput.result?.module?.findingCount || 0} dependency findings`} · {new Date(sourceInput.createdAt).toLocaleString()}</small></span></summary><div><pre>{JSON.stringify(sourceInput.result?.coverage || {}, null, 2)}</pre>{sourceInput.result?.module?.remediation && <p>{sourceInput.result.module.remediation}</p>}</div></details>)}</div>}
          </details>}

          {targetRegistryOpen && <>
            <button className="target-registry__backdrop" aria-label="Close target registry" onClick={() => setTargetRegistryOpen(false)} />
            <aside ref={targetRegistryRef} className="target-registry" role="dialog" aria-modal="true" aria-labelledby="target-registry-title">
              <header><div><span id="target-registry-title">TARGET REGISTRY</span><h2>{visibleTargetProjects.length} surfaces</h2></div><button ref={targetRegistryCloseRef} onClick={() => setTargetRegistryOpen(false)} aria-label="Close target registry">Close</button></header>
              <button className="target-registry__add" onClick={() => { setTargetComposerOpen((current) => !current); setTargetAccessMode("public_link"); }}>{targetComposerOpen ? "Cancel new target" : "+ Add target"}</button>
              {targetComposerOpen && <form className="target-registry__form" onSubmit={createTarget}>
                <label><span>Project name</span><input value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="Company website" minLength={2} maxLength={120} required /></label>
                <label><span>Public website URL</span><input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com" required /></label>
                <label><span>Additional authorized subdomains (optional)</span><textarea value={authorizedSubdomainsText} onChange={(event) => setAuthorizedSubdomainsText(event.target.value)} placeholder={'https://docs.example.com\nhttps://shop.example.com'} rows={3} /><small>Each origin remains independently scoped and must satisfy server authorization and SSRF checks. WPA never enumerates subdomains.</small></label>
                {canUnlockWithDns ? <fieldset className="target-access-choice">
                  <legend>Can you add a DNS TXT record for this website?</legend>
                  <label className={targetAccessMode === "public_link" ? "is-selected" : ""}>
                    <input type="radio" name="target-access" value="public_link" checked={targetAccessMode === "public_link"} onChange={() => setTargetAccessMode("public_link")} />
                    <span><Globe2 /><b>No — continue with the public link</b><small>Start immediately. No DNS access needed.</small></span>
                    <ul>{targetAccessBenefits.publicLink.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul>
                  </label>
                  <label className={targetAccessMode === "dns" ? "is-selected" : ""}>
                    <input type="radio" name="target-access" value="dns" checked={targetAccessMode === "dns"} onChange={() => setTargetAccessMode("dns")} />
                    <span><ShieldCheck /><b>Yes — unlock full target access</b><small>We will show one TXT record after adding the target.</small></span>
                    <ul>{targetAccessBenefits.dns.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul>
                  </label>
                </fieldset> : <div className="target-access-signal"><Globe2 /><span><b>No DNS record needed on {dashboard.plan.name}.</b><small>Your plan's available engines work from the public link.</small></span></div>}
                <label className="target-authorization"><input type="checkbox" checked={targetAuthorizationAccepted} onChange={(event) => setTargetAuthorizationAccepted(event.target.checked)} required /><span>I confirm that I own this target or have explicit permission to analyze it. <small>Authorization version {targetAuthorizationVersion || "unavailable"}; DNS verification is a separate capability check.</small></span></label>
                {!targetAuthorizationVersion && <p className="target-authorization-error" role="alert">Target creation is unavailable until the server publishes the authorization version.</p>}
                <button className="portal-primary" disabled={actionBusy || !targetAuthorizationAccepted || !targetAuthorizationVersion}>{targetAccessMode === "dns" && canUnlockWithDns ? "Add target & show DNS" : "Add target & continue"}</button>
              </form>}
              <div className="target-registry__list">{visibleTargetProjects.map((project, index) => {
                const host = `_wpa-verification.${safeHostname(project.origin)}`;
                return <article className={`${project.verifiedAt ? "is-verified" : ""}${runwayProjects[0]?.id === project.id ? " is-focused" : ""}`} key={project.id}>
                  <button className="target-registry__select" onClick={() => { setFocusedTargetId(project.id); setTargetRegistryOpen(false); }}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{project.name}</b><small>{project.origin}</small></div><em>{project.previewOnly ? "Preview" : project.verifiedAt ? "DNS enabled" : "Public-link"}</em><ArrowRight /></button>
                  <div className="target-registry__actions">{project.previewOnly ? <button disabled><Crosshair /> Preview only</button> : <><button onClick={() => void startScan(project)} disabled={actionBusy || !externalAnalyzerAccepted}><Gauge /> Scan</button>{canUnlockWithDns && !project.verifiedAt && <button onClick={() => setDnsSetupTargetId(project.id)} disabled={actionBusy}><ShieldCheck /> Enable DNS</button>}{dashboard.plan.id === "enterprise" && project.verifiedAt && <button onClick={() => void startJourney(project)} disabled={actionBusy || !externalAnalyzerAccepted}><Activity /> Journey</button>}</>}</div>
                  {!project.previewOnly && canUnlockWithDns && !project.verifiedAt && project.verificationToken && <details className="target-registry__dns" open={dnsSetupTargetId === project.id} onToggle={(event) => { if (event.currentTarget.open) setDnsSetupTargetId(project.id); else setDnsSetupTargetId((current) => current === project.id ? "" : current); }}><summary>DNS record · unlock {targetAccessBenefits.dns.length} capabilities</summary><p>Public-link scans already work. Add this optional record only to unlock ownership-only engines.</p><dl><div><dt>Type</dt><dd>TXT</dd></div><div><dt>Name / Host</dt><dd><code>{host}</code></dd></div><div><dt>Content / Value</dt><dd><code>wpa-verification={project.verificationToken}</code></dd></div><div><dt>TTL</dt><dd>Auto</dd></div></dl><button type="button" onClick={() => void verifyTarget(project)} disabled={actionBusy}><ShieldCheck /> Check DNS record</button></details>}
                </article>;
              })}</div>
            </aside>
          </>}
        </section>
      )}

      {!loading && dashboard && active === "integrations" && surfaceErrors.integrations && (
        <SurfaceUnavailable label="Integrations" message={surfaceErrors.integrations} onRetry={() => void load()} />
      )}

      {!loading && dashboard && active === "integrations" && !surfaceErrors.integrations && (
        <section className="signal-ports portal-section">
          <header className="signal-ports__heading">
            <h1>Integrations</h1>
          </header>

          <div className="signal-ports__layout">
            <div className="signal-board" aria-label="Integration ports">
              <div className="signal-board__ports">
                {integrations.map((integration) => (
                  <button
                    className={`signal-port${selectedIntegration?.provider === integration.provider ? " is-active" : ""}${["connected", "configured"].includes(integration.status) ? " is-connected" : ""}`}
                    key={integration.provider}
                    onClick={() => setActiveIntegration(integration.provider)}
                    aria-pressed={selectedIntegration?.provider === integration.provider}
                  >
                    <span className="signal-port__socket">
                      <i aria-hidden="true" /><i aria-hidden="true" />
                      <b>{integration.label}</b>
                    </span>
                    <span className="signal-port__state"><i aria-hidden="true" />{["connected", "configured"].includes(integration.status) ? "Connected" : "Connect"}</span>
                  </button>
                ))}
              </div>
            </div>

            <aside className="signal-inspector" aria-live="polite">
              {selectedIntegration ? <>
                <header><span>STATUS</span><h2>{selectedIntegration.label}</h2><p>{providerCopy[selectedIntegration.provider]}</p></header>
                <dl>
                  <div><dt>Status</dt><dd>{selectedIntegration.status.replaceAll("_", " ")}</dd></div>
                  <div><dt>Entitlement</dt><dd>{selectedIntegration.available ? "Included" : "Plan upgrade required"}</dd></div>
                  <div><dt>Server keys</dt><dd>{selectedIntegration.provider === "webhook" || selectedIntegration.serverConfigured ? "Ready" : "Required"}</dd></div>
                  {selectedIntegration.displayName && <div><dt>Identity</dt><dd>{selectedIntegration.displayName}</dd></div>}
                </dl>

                {selectedIntegration.provider === "webhook" && dashboard.plan.id === "enterprise" && !["configured", "connected"].includes(selectedIntegration.status) ? (
                  <form id="webhook-setup" className="signal-webhook" onSubmit={configureWebhook} autoComplete="off" data-form-type="other">
                    <label><span>Public HTTPS endpoint</span><input type="url" name="wpa-webhook-endpoint" autoComplete="off" data-1p-ignore value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.example.com/wpa" required /></label>
                    <label><span>Signing secret (optional)</span><input type="password" name="wpa-webhook-signing-secret" autoComplete="new-password" data-1p-ignore value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="Generate when blank" minLength={24} /></label>
                    <button className="portal-primary" disabled={actionBusy}>Configure signed webhook</button>
                    {generatedSecret && <div className="generated-secret"><b>Copy this secret now — it will not be shown again.</b><code>{generatedSecret}</code></div>}
                  </form>
                ) : !selectedIntegration.available ? (
                  <button className="signal-inspector__action" disabled>Not included in this plan</button>
                ) : ["connected", "configured", "error"].includes(selectedIntegration.status) ? (
                  <button className="signal-inspector__action" onClick={() => void disconnectIntegration(selectedIntegration.provider)} disabled={actionBusy}>Disconnect port <ArrowRight /></button>
                ) : selectedIntegration.provider === "webhook" ? (
                  <button className="signal-inspector__action" disabled>Enterprise webhook access required</button>
                ) : (
                  <button className="signal-inspector__action" onClick={() => void connectIntegration(selectedIntegration.provider)} disabled={actionBusy || !selectedIntegration.serverConfigured}>Connect {selectedIntegration.label} <ExternalLink /></button>
                )}
                {selectedIntegration.provider !== "webhook" && !selectedIntegration.serverConfigured && <p className="signal-inspector__warning">Server OAuth keys are required before authorization can open.</p>}
              </> : <div className="signal-inspector__empty"><Plug /><b>No integration ports are available.</b></div>}
            </aside>
          </div>
        </section>
      )}

      {!loading && dashboard && active === "settings" && surfaceErrors.settings && (
        <SurfaceUnavailable label="Settings" message={surfaceErrors.settings} onRetry={() => void load()} />
      )}

      {!loading && dashboard && active === "settings" && !surfaceErrors.settings && (
        <section className="settings-cabinet portal-section">
          <aside className="settings-cabinet__wall" aria-label="Settings sections">
            <div className="settings-cabinet__slot" aria-hidden="true" />
            <nav>
              {settingsSections.map((section, index) => (
                <button key={section.id} className={settingsSection === section.id ? "is-active" : ""} aria-pressed={settingsSection === section.id} onClick={() => setSettingsSection(section.id)}>
                  <span>{section.label}</span><small>{String(index + 1).padStart(2, "0")}</small><i aria-hidden="true" />
                </button>
              ))}
            </nav>
            <span className="settings-cabinet__mark">ACCOUNT CABINET / 05</span>
          </aside>

          <div className="settings-cabinet__content">
            <header className="settings-cabinet__heading">
              <span>05 / {settingsSection.toUpperCase()}</span>
              <h1>Settings</h1>
              <p>{settingsSections.find((section) => section.id === settingsSection)?.note}</p>
            </header>

            {settingsSection === "workspace" && <form className="settings-panel" onSubmit={saveSettings}>
              <header><Globe2 /><div><h2>Workspace identity</h2><p>Defaults used when a new target or report is created.</p></div></header>
              <label><span>Workspace name</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required maxLength={120} /></label>
              <label><span>Default report language</span><select value={defaultLocale} onChange={(event) => setDefaultLocale(event.target.value as "tr" | "en")}><option value="en">English</option><option value="tr">Türkçe</option></select></label>
              <button className="portal-primary" disabled={actionBusy}><Save /> Save workspace</button>
            </form>}

            {settingsSection === "notifications" && <form className="settings-panel settings-panel--notifications" onSubmit={saveSettings}>
              <header><Mail /><div><h2>Notification center</h2><p>Only keep signals that can change a decision.</p></div></header>
              <label className="settings-switch"><span><b>Scan completion</b><small>Completed and failed scans appear in the notification menu.</small></span><input type="checkbox" checked={notifyScanComplete} onChange={(event) => setNotifyScanComplete(event.target.checked)} /></label>
              <label className="settings-switch"><span><b>High-priority findings</b><small>Critical and high findings surface immediately.</small></span><input type="checkbox" checked={notifyHighPriority} onChange={(event) => setNotifyHighPriority(event.target.checked)} /></label>
              <label className="settings-switch"><span><b>Workspace digest</b><small>A compact periodic summary of active evidence.</small></span><input type="checkbox" checked={weeklyDigest} onChange={(event) => setWeeklyDigest(event.target.checked)} /></label>
              <button className="portal-primary" disabled={actionBusy}><Save /> Save notifications</button>
            </form>}

            {settingsSection === "security" && <div className="settings-panel settings-panel--security">
              <header><ShieldCheck /><div><h2>Account security</h2><p>Authentication controls stay attached to this identity.</p></div></header>
              <div className="settings-security-row"><span><b>Two-factor authentication</b><small>Add an authenticator challenge to every new sign-in.</small></span><em className={session?.user?.twoFactorEnabled ? "is-enabled" : ""}>{session?.user?.twoFactorEnabled ? "Enabled" : "Not enabled"}</em></div>
              <SecuritySetup enabled={Boolean(session?.user?.twoFactorEnabled)} />
            </div>}

            {settingsSection === "billing" && <div className="settings-panel settings-panel--billing">
              <header><Boxes /><div><h2>Plan and billing</h2><p>Your current entitlement and subscription path.</p></div></header>
              <div className="settings-plan">
                <div><span>CURRENT PLAN</span><b>{dashboard.plan.name}</b><small>{!paymentsEnabled ? "Free, redeemed or operator-assigned early access" : settingsData?.subscription ? `${legalConfig?.billing?.merchantOfRecordName || legalConfig?.billing?.provider || "Billing provider"} subscription · ${settingsData.subscription.status}` : "Free or operator-assigned entitlement"}</small></div>
                <strong>${dashboard.plan.id === "free" ? 0 : dashboard.plan.id === "signal" ? 29 : dashboard.plan.id === "studio" ? 99 : 349}<small>{dashboard.plan.id === "enterprise" ? "/month · invitation" : "/month"}</small></strong>
              </div>
              <dl><div><dt>Page credits</dt><dd>{dashboard.plan.limits.pageCredits}</dd></div><div><dt>Projects</dt><dd>{dashboard.plan.limits.projects}</dd></div><div><dt>Used this period</dt><dd>{dashboard.usage.consumed + dashboard.usage.reserved}</dd></div></dl>
              {!paymentsEnabled && settingsData?.subscription
                ? <span className="settings-panel__max"><CheckCircle2 /> Provider billing paused during early access</span>
                : settingsData?.subscription
                  ? <button className="settings-panel__action" onClick={() => void manageBilling()} disabled={actionBusy}>Open billing portal <ExternalLink /></button>
                  : upgradeTarget
                    ? <button className="settings-panel__action" onClick={() => void openCheckout(upgradeTarget)} disabled={actionBusy}>{upgradeTarget === "enterprise" ? "Contact sales" : paymentsEnabled ? "Upgrade plan" : "Redeem access"} <ArrowRight /></button>
                    : <span className="settings-panel__max"><CheckCircle2 /> Highest plan active</span>}
              <form className="billing-redeem" onSubmit={redeemEntitlement}>
                <div>
                  <label htmlFor="workspace-redeem-code">Redeem code</label>
                  <p>{paymentsEnabled ? "Apply a code supplied by WebPageAnalyz. A valid code may add a temporary plan or credits without changing a paid subscription." : "Paid checkout is paused. Apply a WebPageAnalyz code for temporary plan access or credits."}</p>
                </div>
                <div className="billing-redeem__controls">
                  <input
                    id="workspace-redeem-code"
                    value={redeemCode}
                    onChange={(event) => { setRedeemCode(event.target.value); setRedeemError(""); setRedeemMessage(""); }}
                    minLength={6}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <button type="submit" disabled={redeemBusy || redeemCode.trim().length < 6}>{redeemBusy ? "Applying…" : "Apply code"}</button>
                </div>
                {redeemError && <p className="billing-redeem__status billing-redeem__status--error" role="alert">{redeemError}</p>}
                {redeemMessage && <p className="billing-redeem__status billing-redeem__status--success" role="status">{redeemMessage}</p>}
              </form>
            </div>}
          </div>
        </section>
      )}

      {!loading && active === "status" && surfaceErrors.status && (
        <SurfaceUnavailable label="System status" message={surfaceErrors.status} onRetry={() => void load()} />
      )}

      {!loading && active === "status" && platformStatus && !surfaceErrors.status && (
        <section className="portal-section">
          <div className="portal-heading">
            <div>
              <span>PLATFORM STATUS</span>
              <h1>System health</h1>
              <p>
                Live application readiness checked at{" "}
                {new Date(platformStatus.checkedAt).toLocaleString()}.
              </p>
            </div>
            <button onClick={() => void load()} className="portal-primary">
              <Activity /> Refresh
            </button>
          </div>
          <div className="status-overview portal-card">
            <ShieldCheck />
            <div>
              <b>
                {platformStatus.overall === "operational"
                  ? "Core systems operational"
                  : "Configuration review required"}
              </b>
              <span>
                This view reports application readiness, not a fabricated uptime
                percentage.
              </span>
            </div>
          </div>
          <div className="status-component-grid">
            {platformStatus.components.map((component) => (
              <article className="portal-card" key={component.id}>
                {component.id === "database" ? (
                  <Database />
                ) : component.id === "workers" ? (
                  <Boxes />
                ) : component.id === "storage" ? (
                  <LockKeyhole />
                ) : (
                  <Gauge />
                )}
                <div>
                  <b>{component.label}</b>
                  <p>{component.detail}</p>
                </div>
                <span
                  className={
                    component.status === "operational"
                      ? "status-ok"
                      : "status-pending"
                  }
                >
                  {component.status.replaceAll("_", " ")}
                </span>
              </article>
            ))}
          </div>
        </section>
      )}

      {paymentsEnabled && checkoutPlan && <div className="checkout-confirmation">
        <button type="button" className="checkout-confirmation__backdrop" aria-label="Close checkout confirmation" onClick={closeCheckout} />
        <section className="checkout-confirmation__dialog" role="dialog" aria-modal="true" aria-labelledby="checkout-confirmation-title">
          <header><div><span>CHECKOUT CONFIRMATION</span><h2 id="checkout-confirmation-title">Review the recurring purchase.</h2></div><button ref={checkoutCloseRef} type="button" onClick={closeCheckout} disabled={checkoutLoading} aria-label="Close checkout confirmation">Close</button></header>
          <form onSubmit={confirmCheckout}>
            <dl className="checkout-confirmation__summary"><div><dt>Plan</dt><dd>{checkoutPlan.name}</dd></div><div><dt>Price</dt><dd>{checkoutPlan.priceUsd} {legalConfig?.billing?.currency || "USD"}</dd></div><div><dt>Billing interval</dt><dd>{legalConfig?.billing?.interval || "Monthly"}</dd></div><div><dt>Renewal</dt><dd>Recurring until cancelled</dd></div></dl>
            <p>{checkoutPlan.description}</p>
            <div className="checkout-confirmation__disclosures"><p><strong>Cancellation:</strong> {legalConfig?.billing?.cancellationSummary || "Cancel through the buyer portal; access normally continues until the end of the current paid period."}</p><p><strong>Merchant of record:</strong> {legalConfig?.billing?.merchantOfRecordName || legalConfig?.billing?.provider || "Unavailable"} handles payment collection, applicable tax, invoices and eligible refund processing.</p><p>Review the <a href="/terms">Terms of Service</a> and <a href="/refund">Cancellation and Refund Policy</a>. Mandatory consumer rights remain unaffected.</p></div>
            <label className="checkout-confirmation__accept"><input type="checkbox" checked={checkoutAccepted} onChange={(event) => setCheckoutAccepted(event.target.checked)} required /><span>I accept the active Terms and Refund Policy and acknowledge that this is a recurring subscription at the price and interval shown above.</span></label>
            {checkoutError && <p className="checkout-confirmation__error" role="alert">{checkoutError}</p>}
            <footer><button type="button" onClick={closeCheckout} disabled={checkoutLoading}>Back and correct</button><button className="portal-primary" disabled={!checkoutAccepted || checkoutLoading || !legalConfig?.ready}>{checkoutLoading ? "Opening secure checkout…" : `Continue to ${legalConfig?.billing?.merchantOfRecordName || "checkout"}`}</button></footer>
          </form>
        </section>
      </div>}
    </PortalShell>
  );
}
