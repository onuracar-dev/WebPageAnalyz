import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, CircleStop, FileArchive, FlaskConical, Play, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { apiFetch, jsonRequest, privilegedApiFetch } from './api';
import { DEFAULT_JOURNEY_JSON, validateJourneyJson } from './journeyContract';

type EngineDefinition = {
  id: string;
  label: string;
  version: string;
  owner: 'internal' | 'external' | 'infrastructure';
  input: 'url' | 'journey' | 'source_zip';
  expectedSeconds: number;
  configured: boolean;
  progressMode: 'stage_estimate';
};

type EngineState = {
  engineId: string;
  label: string;
  version: string;
  status: 'queued' | 'preflight' | 'running' | 'completed' | 'failed' | 'unavailable' | 'cancelled';
  progress: number;
  progressMode: string;
  phase: string;
  findingsCount: number;
  evidence: Array<Record<string, unknown>>;
  error?: { code: string; message: string } | null;
  startedAt?: string;
  completedAt?: string;
};

type EngineLabRun = {
  id: string;
  targetUrl: string;
  targetOrigin: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  createdAt: string;
  completedAt?: string;
  summary: Record<string, number>;
  engines: EngineState[];
};

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);

function StateIcon({ status }: { status: EngineState['status'] }) {
  if (status === 'completed') return <CheckCircle2 />;
  if (status === 'failed' || status === 'unavailable') return <XCircle />;
  if (status === 'cancelled') return <CircleStop />;
  return <Activity />;
}

export default function AdminEngineLab() {
  const [catalog, setCatalog] = useState<EngineDefinition[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [journey, setJourney] = useState(DEFAULT_JOURNEY_JSON);
  const [source, setSource] = useState<File | null>(null);
  const [crawlerLimit, setCrawlerLimit] = useState(25);
  const [run, setRun] = useState<EngineLabRun | null>(null);
  const [history, setHistory] = useState<EngineLabRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const startInFlight = useRef(false);
  const startIdempotencyKey = useRef<string | null>(null);

  const needsJourney = selected.has('journey');
  const needsSource = selected.has('osvScanner');
  const allSelected = catalog.length > 0 && selected.size === catalog.length;
  const completedCount = run?.engines.filter((engine) => engine.status === 'completed').length || 0;

  async function loadInitial() {
    try {
      const [catalogData, runData] = await Promise.all([
        apiFetch<{ engines: EngineDefinition[] }>('/api/v1/admin/engine-lab/catalog'),
        apiFetch<{ runs: EngineLabRun[] }>('/api/v1/admin/engine-lab/runs'),
      ]);
      setCatalog(catalogData.engines);
      setHistory(runData.runs);
      if (!selected.size) setSelected(new Set(catalogData.engines.filter((engine) => engine.configured && engine.input === 'url').map((engine) => engine.id)));
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Engine catalog could not be loaded.'); }
  }

  useEffect(() => { void loadInitial(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!startInFlight.current) startIdempotencyKey.current = null; }, [crawlerLimit, journey, needsJourney, needsSource, selected, source, targetUrl]);
  useEffect(() => {
    if (!run || terminal.has(run.status)) return;
    const timer = window.setInterval(() => {
      apiFetch<{ run: EngineLabRun }>(`/api/v1/admin/engine-lab/runs/${run.id}`)
        .then((result) => { setRun(result.run); if (terminal.has(result.run.status)) void loadInitial(); })
        .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Run status could not be refreshed.'));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const validation = useMemo(() => {
    if (!selected.size) return 'Select at least one engine.';
    try { const parsed = new URL(targetUrl); if (!['http:', 'https:'].includes(parsed.protocol)) return 'Enter a public HTTP or HTTPS target.'; }
    catch { return 'Enter a valid target URL.'; }
    if (needsJourney) {
      const journeyError = validateJourneyJson(journey, targetUrl);
      if (journeyError) return journeyError;
    }
    if (needsSource && !source) return 'OSV Scanner requires a ZIP source package.';
    return '';
  }, [journey, needsJourney, needsSource, selected.size, source, targetUrl]);

  function toggle(engineId: string) {
    setError('');
    setSelected((current) => { const next = new Set(current); if (next.has(engineId)) next.delete(engineId); else next.add(engineId); return next; });
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (validation) { setError(validation); return; }
    if (startInFlight.current) return;
    startInFlight.current = true;
    startIdempotencyKey.current ||= crypto.randomUUID();
    setBusy(true); setError('');
    try {
      const body = new FormData();
      body.set('targetUrl', targetUrl);
      body.set('engineIds', JSON.stringify([...selected]));
      body.set('crawlerLimit', String(crawlerLimit));
      if (needsJourney) body.set('journey', journey);
      if (needsSource && source) body.set('source', source);
      const result = await privilegedApiFetch<{ run: EngineLabRun }>('/api/v1/admin/engine-lab/runs', { method: 'POST', body, headers: { 'Idempotency-Key': startIdempotencyKey.current } });
      setRun(result.run);
      startIdempotencyKey.current = null;
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Engine Lab run could not start.'); }
    finally { startInFlight.current = false; setBusy(false); }
  }

  async function cancel() {
    if (!run) return;
    const reason = window.prompt('Reason for cancelling this Engine Lab run')?.trim();
    if (!reason || !window.confirm(`Confirm cancellation of Engine Lab run ${run.id}?`)) return;
    setBusy(true);
    try { const result = await privilegedApiFetch<{ run: EngineLabRun }>(`/api/v1/admin/engine-lab/runs/${run.id}/cancel`, jsonRequest('POST', { reason, confirm: true })); setRun(result.run); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Run could not be cancelled.'); }
    finally { setBusy(false); }
  }

  async function openHistoryRun(runId: string) {
    setBusy(true); setError('');
    try {
      const result = await apiFetch<{ run: EngineLabRun }>(`/api/v1/admin/engine-lab/runs/${runId}`);
      setRun(result.run);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Run detail could not be loaded.'); }
    finally { setBusy(false); }
  }

  return <div className="engine-lab">
    <section className="engine-lab__intro portal-panel">
      <div><FlaskConical /><span><b>Bounded proof press</b><small>Admin runs leave customer credits, plan entitlements and verified-project limits untouched. URL safety and read-only browser policies remain engaged.</small></span></div>
      <div className="engine-lab__legend"><span><i className="is-internal" /> Internal</span><span><i className="is-external" /> External</span><span><i className="is-infrastructure" /> Infrastructure</span></div>
    </section>

    <form className="engine-lab__form portal-panel" onSubmit={start}>
      <header><div><span>01 / INTAKE REGISTER</span><h2>Set the test impression</h2></div><button type="button" onClick={() => setSelected(allSelected ? new Set() : new Set(catalog.map((engine) => engine.id)))}>{allSelected ? 'Clear the rack' : 'Load every engine'}</button></header>
      <div className="engine-lab__fields">
        <label><span>Public target URL</span><input type="url" required value={targetUrl} onChange={(event) => { setTargetUrl(event.target.value); setError(''); }} placeholder="https://example.com" /></label>
        <label><span>Crawler page ceiling</span><input type="number" min="1" max="200" value={crawlerLimit} onChange={(event) => { setCrawlerLimit(Number(event.target.value)); setError(''); }} /></label>
        {needsSource && <label className="engine-lab__file"><span>OSV source package (.zip)</span><input type="file" accept=".zip,application/zip" onChange={(event) => { setSource(event.target.files?.[0] || null); setError(''); }} /><b><FileArchive /> {source?.name || 'Choose ZIP package'}</b></label>}
      </div>
      {needsJourney && <label className="engine-lab__journey"><span>Read-only Journey JSON</span><textarea value={journey} onChange={(event) => { setJourney(event.target.value); setError(''); }} spellCheck={false} /></label>}
      <div className="engine-lab__catalog">
        <div className="engine-lab__catalog-head" aria-hidden="true"><span>Lane / engine</span><span>Input</span><span>Expected</span><span>Load</span></div>
        {catalog.map((engine, index) => <label className={`engine-choice is-${engine.owner}${selected.has(engine.id) ? ' is-selected' : ''}`} key={engine.id}>
          <input type="checkbox" checked={selected.has(engine.id)} onChange={() => toggle(engine.id)} />
          <small className="engine-choice__index">{String(index + 1).padStart(2, '0')}</small><i className="engine-choice__trace" aria-hidden="true" />
          <span><b>{engine.label}</b><small>{engine.id} / v{engine.version} / {engine.owner}</small></span>
          <em>{engine.configured ? engine.input.replace('_', ' ') : 'configuration required'}</em><strong>{engine.expectedSeconds}s</strong><span className="engine-choice__toggle" aria-hidden="true">{selected.has(engine.id) ? 'LOADED' : 'OFF'}</span>
        </label>)}
      </div>
      <footer><span>{selected.size}/{catalog.length} engine lanes loaded{validation ? ` · ${validation}` : ''}</span><button className="portal-primary" disabled={busy || Boolean(validation)}><Play /> {busy ? 'Starting…' : 'Start bounded run'}</button></footer>
    </form>

    {error && <div className="portal-alert" role="alert"><ShieldAlert /> {error}</div>}

    {run && <section className="engine-lab__run portal-panel" aria-live="polite">
      <header><div><span>02 / LIVE PRESS TRACE</span><h2>{run.targetOrigin}</h2><small>{run.id}</small></div><div className="engine-lab__run-actions"><b className={`run-state is-${run.status}`}>{run.status}</b>{!terminal.has(run.status) && <button disabled={busy} onClick={() => void cancel()}><CircleStop /> Cancel</button>}<button onClick={() => apiFetch<{ run: EngineLabRun }>(`/api/v1/admin/engine-lab/runs/${run.id}`).then((result) => setRun(result.run))}><RefreshCw /> Refresh</button></div></header>
      <div className="engine-lab__summary"><div><span>Completed</span><strong>{completedCount}</strong></div><div><span>Failed</span><strong>{run.summary.failed || 0}</strong></div><div><span>Unavailable</span><strong>{run.summary.unavailable || 0}</strong></div><div><span>Loaded</span><strong>{run.engines.length}</strong></div></div>
      <div className="engine-matrix">
        <div className="engine-matrix__axis" aria-hidden="true"><span>Engine / current phase</span><span>0</span><i /><span>50</span><i /><span>100</span><span>Evidence / state</span></div>
        {run.engines.map((engine, index) => <article className={`engine-result is-${engine.status}`} key={engine.engineId}>
          <div className="engine-result__head"><small>{String(index + 1).padStart(2, '0')}</small><StateIcon status={engine.status} /><span><b>{engine.label}</b><small>{engine.engineId} / {engine.phase}</small></span></div>
          <div className="engine-result__progress" role="progressbar" aria-label={`${engine.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={engine.progress}><i style={{ width: `${engine.progress}%` }}><span /></i><b>{engine.progress}%</b></div>
          <div className="engine-result__state"><strong>{engine.findingsCount}</strong><small>findings</small><em>{engine.status}</em></div>
          <div className="engine-result__meta"><span>{engine.findingsCount} findings</span><span>{engine.progressMode === 'stage_estimate' ? 'Stage-based progress' : engine.progressMode}</span>{engine.startedAt && <span>{Math.max(0, Math.round(((engine.completedAt ? Date.parse(engine.completedAt) : Date.now()) - Date.parse(engine.startedAt)) / 1_000))}s</span>}</div>
          {engine.error && <div className="engine-result__error"><AlertTriangle /><span><b>{engine.error.code}</b><small>{engine.error.message}</small></span></div>}
          {engine.evidence.length > 0 && <details><summary>Evidence and coverage ({engine.evidence.length})</summary><pre>{JSON.stringify(engine.evidence, null, 2)}</pre></details>}
        </article>)}
      </div>
    </section>}

    {history.length > 0 && <section className="engine-lab__history portal-panel"><header><div><span>RECENT LAB RUNS</span><h2>Execution history</h2></div></header>{history.map((item) => <button key={item.id} disabled={busy} onClick={() => void openHistoryRun(item.id)}><span><b>{item.targetOrigin}</b><small>{new Date(item.createdAt).toLocaleString()} · {item.engines.length} engines</small></span><em className={`run-state is-${item.status}`}>{item.status}</em></button>)}</section>}
  </div>;
}
