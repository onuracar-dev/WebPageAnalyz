import { Check, CircleX, Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

export type ScanProgressEvent = {
  id: number | string;
  type: string;
  createdAt?: string;
  payload?: {
    pageKey?: string;
    pageIndex?: number;
    executionId?: string;
    engineIds?: string[];
    resourceClass?: string;
    timeoutBudgetMs?: number;
    executionMs?: number;
    status?: string;
    errorCode?: string;
    engines?: Array<{
      executionId?: string;
      engineIds?: string[];
      resourceClass?: string;
      timeoutBudgetMs?: number;
    }>;
  };
};

export type ScanProgressPage = {
  pageKey?: string;
  pageIndex?: number;
  url?: string;
  status: string;
  modules?: Record<string, { status?: string; errorCode?: string }>;
};

export type ScanProgressSnapshot = {
  scan: {
    id: string;
    status: string;
    createdAt: string;
    manifest?: { urls?: string[] };
  };
  counts: Record<string, number>;
  pages: ScanProgressPage[];
  events: ScanProgressEvent[];
  lastEventId?: number | string;
};

type EngineRow = {
  id: string;
  label: string;
  status: string;
  resourceClass?: string;
  executionMs?: number;
  errorCode?: string;
};

const ENGINE_LABELS: Record<string, string> = {
  lighthouse: "Lighthouse",
  yellowLab: "YellowLab",
  axe: "Accessibility / Axe",
  wpaPage: "WPA Page",
  performancePlus: "Performance Plus",
  advancedGeo: "Advanced GEO",
  visualUx: "Visual UX",
  journey: "Journey Test",
  zapBaseline: "Passive Security",
};

const TERMINAL_ENGINE_STATES = new Set([
  "completed",
  "failed",
  "timeout",
  "unavailable",
  "cancelled",
  "incomplete",
]);
const TERMINAL_PAGE_STATES = new Set([
  "completed",
  "incomplete",
  "failed",
  "unavailable",
  "cancelled",
]);

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

function useElapsed(createdAt: string, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const startedAt = Date.parse(createdAt);
  return formatElapsed(Number.isFinite(startedAt) ? now - startedAt : 0);
}

function eventStatus(event: ScanProgressEvent | undefined) {
  if (!event) return "queued";
  return event.payload?.status || event.type.replace(/^engine\./, "") || "queued";
}

function latestPlan(events: ScanProgressEvent[]) {
  return [...events].reverse().find((event) => event.type === "analysis.plan");
}

function rowsFor(snapshot: ScanProgressSnapshot): { rows: EngineRow[]; page?: ScanProgressPage } {
  const planEvent = latestPlan(snapshot.events);
  const pageKey = planEvent?.payload?.pageKey;
  const page = snapshot.pages.find((candidate) => pageKey && candidate.pageKey === pageKey)
    || snapshot.pages.find((candidate) => ["running", "retrying"].includes(candidate.status))
    || snapshot.pages.at(-1);
  const plan = planEvent?.payload?.engines || [];
  const definitions = plan.flatMap((execution) => (execution.engineIds || []).map((engineId) => ({
    id: engineId,
    resourceClass: execution.resourceClass,
  })));
  if (!definitions.length && page?.modules) {
    definitions.push(...Object.keys(page.modules).map((id) => ({ id, resourceClass: undefined })));
  }

  const seen = new Set<string>();
  return {
    page,
    rows: definitions.filter((definition) => {
      if (seen.has(definition.id)) return false;
      seen.add(definition.id);
      return true;
    }).map((definition) => {
      const executionEvent = [...snapshot.events].reverse().find((event) => {
        if (!event.type.startsWith("engine.")) return false;
        if (pageKey && event.payload?.pageKey !== pageKey) return false;
        return event.payload?.engineIds?.includes(definition.id);
      });
      const terminalModule = page?.modules?.[definition.id];
      const status = executionEvent ? eventStatus(executionEvent) : terminalModule?.status || "queued";
      return {
        id: definition.id,
        label: ENGINE_LABELS[definition.id] || definition.id.replace(/([a-z])([A-Z])/g, "$1 $2"),
        status,
        resourceClass: executionEvent?.payload?.resourceClass || definition.resourceClass,
        executionMs: executionEvent?.payload?.executionMs,
        errorCode: executionEvent?.payload?.errorCode || terminalModule?.errorCode,
      };
    }),
  };
}

function statusLabel(status: string) {
  if (status === "completed") return "Completed";
  if (status === "running") return "Running";
  if (status === "queued") return "Waiting";
  if (status === "timeout") return "Timed out";
  if (status === "unavailable") return "Unavailable";
  if (status === "cancelled") return "Cancelled";
  if (status === "incomplete") return "Incomplete";
  return "Failed";
}

function engineNote(row: EngineRow) {
  if (row.status === "completed") return row.executionMs === undefined
    ? "Evidence sealed"
    : `Finished in ${formatElapsed(row.executionMs)}`;
  if (row.status === "running") return row.id === "performancePlus" || row.id === "advancedGeo" || row.id === "visualUx"
    ? "Shared browser collection"
    : row.resourceClass === "external" ? "External analysis" : "Browser analysis";
  if (row.status === "queued") return row.resourceClass === "external" ? "External lane ready" : "Browser lane queued";
  return row.errorCode ? row.errorCode.replaceAll("_", " ") : "Needs attention";
}

function EngineStateIcon({ status }: { status: string }) {
  if (status === "completed") return <Check aria-hidden="true" />;
  if (status === "running") return <LoaderCircle aria-hidden="true" />;
  if (TERMINAL_ENGINE_STATES.has(status)) return <CircleX aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

export default function ScanProgressPanel({
  snapshot,
  transport,
}: {
  snapshot: ScanProgressSnapshot;
  transport: "polling" | "stream";
}) {
  const active = ["queued", "running"].includes(snapshot.scan.status);
  const elapsed = useElapsed(snapshot.scan.createdAt, active);
  const { rows, page } = rowsFor(snapshot);
  const completedRows = rows.filter((row) => row.status === "completed").length;
  const terminalRows = rows.filter((row) => TERMINAL_ENGINE_STATES.has(row.status)).length;
  const runningRows = rows.filter((row) => row.status === "running");
  const engineFraction = rows.length
    ? rows.reduce((total, row) => total + (TERMINAL_ENGINE_STATES.has(row.status) ? 1 : row.status === "running" ? .5 : 0), 0) / rows.length
    : snapshot.scan.status === "running" ? .08 : .03;
  const totalPages = Math.max(1, snapshot.pages.length || Object.values(snapshot.counts).reduce((total, value) => total + Number(value || 0), 0));
  const completedPages = snapshot.pages.filter((candidate) => TERMINAL_PAGE_STATES.has(candidate.status) && candidate.pageKey !== page?.pageKey).length;
  const stageEstimate = active
    ? Math.min(99, Math.max(3, Math.round(((completedPages + engineFraction) / totalPages) * 100)))
    : 100;
  const pageNumber = page?.pageIndex === undefined ? null : Math.min(totalPages, page.pageIndex + 1);
  const currentCopy = runningRows.length
    ? `Running ${runningRows.slice(0, 2).map((row) => row.label).join(" + ")}${runningRows.length > 2 ? ` +${runningRows.length - 2}` : ""}`
    : rows.length && terminalRows === rows.length ? "Finalizing the report"
      : rows.length ? "Preparing the next engine"
        : snapshot.scan.status === "queued" ? "Waiting for an analysis worker" : "Preparing the engine plan";

  return (
    <section className="reference-scan-progress" aria-label="Live scan progress" aria-live="polite">
      <header className="reference-scan-progress__header">
        <div>
          <span className="reference-scan-progress__eyebrow"><i aria-hidden="true" />LIVE SCAN</span>
          <strong>{currentCopy}</strong>
          <small>{transport === "stream" ? "Live event stream" : "Polling fallback"} · elapsed {elapsed}</small>
        </div>
        <div className="reference-scan-progress__measure">
          <strong>{stageEstimate}%</strong>
          <small>stage estimate</small>
        </div>
      </header>

      <div
        className="reference-scan-progress__bar"
        role="progressbar"
        aria-label="Scan stage estimate"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={stageEstimate}
      >
        <i style={{ transform: `scaleX(${stageEstimate / 100})` }} />
      </div>

      <div className="reference-scan-progress__meta">
        <span>{completedRows} / {rows.length || "—"} engines completed</span>
        <span>{pageNumber ? `Page ${pageNumber} / ${totalPages}` : `${totalPages} page${totalPages === 1 ? "" : "s"}`}</span>
      </div>

      {rows.length ? (
        <ul className="reference-scan-progress__engines" aria-label="Engine execution states">
          {rows.map((row) => (
            <li className={`is-${row.status}`} key={row.id}>
              <span className="reference-scan-progress__state"><EngineStateIcon status={row.status} /></span>
              <span><strong>{row.label}</strong><small>{engineNote(row)}</small></span>
              <em>{statusLabel(row.status)}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="reference-scan-progress__preflight">The worker is validating the target and assembling the entitled engine plan.</p>
      )}
    </section>
  );
}
