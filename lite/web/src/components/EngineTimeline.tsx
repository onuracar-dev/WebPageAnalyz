import { useEffect, useState } from 'react';
import { ENGINE_IDS, displayUrl, type EngineInfo, type EngineState, type EngineStatus, type Scan } from '../api';
import { scanProgress } from '../progress';
import { Progress } from '../vendor/arc/progress/progress';

const STATUS_LABELS: Record<EngineStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  timed_out: 'Timed out',
};

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function useElapsed(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since || !running) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [since, running]);
  return since ? Math.max(0, now - Date.parse(since)) : undefined;
}

/** Shows where the scanned URL came from when the server followed redirects. */
export function RedirectNote({ scan }: { scan?: Scan }) {
  if (!scan?.requestedUrl || scan.requestedUrl === scan.url) return null;
  return <p className="redirect-note">Redirected from <span className="mono">{displayUrl(scan.requestedUrl)}</span></p>;
}

function EngineRow({ info, state }: { info: EngineInfo; state: EngineState }) {
  const elapsed = useElapsed(state.startedAt, state.status === 'running');
  const duration = state.status === 'running' ? elapsed : state.durationMs;
  return (
    <li className="engine" data-status={state.status}>
      <span className="engine__marker" aria-hidden="true" />
      <div className="engine__body">
        <div className="engine__head">
          <span className="engine__name">{info.name}</span>
          {info.external && <span className="badge">external</span>}
        </div>
        <p className="engine__desc">{info.description}</p>
        {state.error && <p className="engine__error">{state.error.message}</p>}
      </div>
      <div className="engine__meta">
        <span className="engine__status">{STATUS_LABELS[state.status] ?? state.status}</span>
        <span className="engine__time mono">{formatDuration(duration)}</span>
      </div>
    </li>
  );
}

interface Props {
  url?: string;
  scan?: Scan;
  engines: EngineInfo[];
  onCancel: () => void;
}

export function EngineTimeline({ url, scan, engines, onCancel }: Props) {
  const running = scan?.status === 'running';
  const elapsed = useElapsed(scan?.startedAt, running);
  const states = scan?.engines ?? {};
  const progress = scanProgress(scan);
  const ordered = ENGINE_IDS.map((id) => engines.find((engine) => engine.id === id) ?? { id, name: id, description: '', external: false });

  return (
    <section className="timeline panel" aria-labelledby="timeline-title">
      <div className="timeline__head">
        <p className="eyebrow">{scan?.status === 'queued' ? 'Queued' : 'Scanning'}</p>
        {elapsed !== undefined && <span className="timeline__elapsed mono">{formatDuration(elapsed)}</span>}
      </div>
      <h2 id="timeline-title" className="timeline__url" title={scan?.url ?? url}>
        {scan?.url ? displayUrl(scan.url) : url ? displayUrl(url) : 'Preparing scan…'}
      </h2>
      <RedirectNote scan={scan} />

      <Progress className="timeline__progress" label={progress.label} value={progress.done} max={progress.total} showValue />
      <p className="visually-hidden" aria-live="polite">
        {progress.done} of {progress.total} engines finished. {progress.label}.
      </p>

      <ol className="engines">
        {ordered.map((info) => (
          <EngineRow key={info.id} info={info} state={states[info.id] ?? { status: 'pending' }} />
        ))}
      </ol>

      <button type="button" className="button button--ghost" onClick={onCancel}>
        Back
      </button>
    </section>
  );
}
