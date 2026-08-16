import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, FileSearch, RefreshCw, ShieldAlert, X, XCircle } from 'lucide-react';
import { apiFetch } from './api';

type Evidence = { kind?: string; label?: string; samples?: Array<Record<string, unknown>>; [key: string]: unknown };
type EngineResult = {
  engineId: string; label: string; version: string; status: string; progress: number; phase: string;
  findingsCount: number; evidence: Evidence[]; error?: { code: string; message: string } | null;
};
type LabRun = {
  id: string; targetUrl: string; targetOrigin: string; status: string; createdAt: string; completedAt?: string;
  summary: Record<string, number>; engines: EngineResult[];
};
type FindingRow = {
  key: string; engine: string; ruleId: string; title: string; severity: string; fingerprint?: string;
  id?: string; description?: string; category?: string; confidence?: number; kind?: string; pageUrl?: string;
  source?: { name?: string; version?: string } | string; remediation?: string; evidence?: Array<Record<string, unknown>>;
  artifactUrl?: string; device?: string;
};

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);

function severity(value: unknown) {
  const normalized = String(value || 'info').toLowerCase();
  if (['critical', 'high', 'serious'].includes(normalized)) return 'high';
  if (['medium', 'moderate', 'warning'].includes(normalized)) return 'medium';
  if (['low', 'minor'].includes(normalized)) return 'low';
  return 'info';
}

function collectFindings(run: LabRun | null): FindingRow[] {
  if (!run) return [];
  return run.engines.flatMap((engine) => engine.evidence.flatMap((item, evidenceIndex) =>
    Array.isArray(item.samples) ? item.samples.map((sample, sampleIndex) => ({
      key: `${engine.engineId}-${evidenceIndex}-${sampleIndex}`,
      engine: engine.label,
      ruleId: String(sample.ruleId || sample.id || 'unknown'),
      title: String(sample.title || sample.description || 'Finding'),
      severity: severity(sample.severity || sample.impact),
      fingerprint: sample.fingerprint ? String(sample.fingerprint) : undefined,
      id: sample.id ? String(sample.id) : undefined,
      description: sample.description ? String(sample.description) : undefined,
      category: sample.category ? String(sample.category) : undefined,
      confidence: typeof sample.confidence === 'number' ? sample.confidence : undefined,
      kind: sample.kind ? String(sample.kind) : undefined,
      pageUrl: sample.pageUrl ? String(sample.pageUrl) : undefined,
      source: typeof sample.source === 'string' ? sample.source : sample.source as FindingRow['source'],
      remediation: sample.remediation ? String(sample.remediation) : undefined,
      evidence: Array.isArray(sample.evidence) ? sample.evidence as Array<Record<string, unknown>> : undefined,
      artifactUrl: sample.artifactUrl ? String(sample.artifactUrl) : undefined,
      device: sample.device ? String(sample.device) : undefined,
    })) : []
  ));
}

function humanize(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function safeHostname(value?: string) {
  if (!value) return 'Page not reported';
  try { return new URL(value).hostname || value; }
  catch { return value.replace(/^https?:\/\//i, '').split('/')[0] || 'Page not reported'; }
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="evidence-empty">Not reported</span>;
  if (typeof value === 'boolean') return <span className={`evidence-boolean is-${value}`}>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <strong className="evidence-number">{value.toLocaleString()}</strong>;
  if (typeof value === 'string') return <span>{value}</span>;
  if (Array.isArray(value)) return <div className="evidence-tags">{value.length ? value.map((entry, index) => <span key={index}>{typeof entry === 'object' ? <EvidenceValue value={entry} /> : String(entry)}</span>) : <span className="evidence-empty">None</span>}</div>;
  return <dl className="evidence-object">{Object.entries(value as Record<string, unknown>).map(([key, entry]) => <div key={key}><dt>{humanize(key)}</dt><dd><EvidenceValue value={entry} /></dd></div>)}</dl>;
}

function EvidenceCard({ item }: { item: Evidence }) {
  const fields = Object.entries(item).filter(([key]) => !['kind', 'label', 'samples'].includes(key));
  return <article className={`evidence-card is-${String(item.kind || 'evidence')}`}>
    <header><span>{humanize(String(item.kind || 'evidence'))}</span><h5>{String(item.label || 'Analyzer evidence')}</h5></header>
    {fields.length > 0 && <dl className="evidence-fields">{fields.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd><EvidenceValue value={value} /></dd></div>)}</dl>}
    {Array.isArray(item.samples) && item.samples.length > 0 && <div className="evidence-samples">{item.samples.map((sample, index) => <div key={index}><em className={`severity-badge is-${severity(sample.severity || sample.impact)}`}>{severity(sample.severity || sample.impact)}</em><span><b>{String(sample.title || sample.description || 'Finding')}</b><small>{String(sample.ruleId || sample.id || 'unknown')}</small></span></div>)}</div>}
  </article>;
}

function sourceLabel(source: FindingRow['source']) {
  if (!source) return 'Not reported';
  if (typeof source === 'string') return source;
  return [source.name, source.version ? `v${source.version}` : ''].filter(Boolean).join(' ') || 'Not reported';
}

function screenshotUrl(finding: FindingRow) {
  if (finding.artifactUrl) return finding.artifactUrl;
  const screenshot = finding.evidence?.find((item) => item.type === 'screenshot');
  const value = screenshot?.value;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).artifactUrl === 'string') return String((value as Record<string, unknown>).artifactUrl);
  return undefined;
}

function FindingDetail({ finding, onClose }: { finding: FindingRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const screenshot = screenshotUrl(finding);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const copy = async (value: string) => { await navigator.clipboard?.writeText(value).catch(() => {}); };

  return <aside className="lab-finding-inspector" aria-labelledby="lab-finding-inspector-title">
      <header className="lab-finding-inspector__header"><div><span>SELECTED IMPRESSION</span><h3 id="lab-finding-inspector-title">{finding.title}</h3></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close finding detail"><X /></button></header>
      <div className="lab-finding-inspector__badges"><em className={`severity-badge is-${finding.severity}`}>{finding.severity}</em><span>{finding.engine}</span>{finding.category && <span>{humanize(finding.category)}</span>}{finding.kind && <span>{humanize(finding.kind)}</span>}</div>

      <section data-proof-step="01"><h4>Where</h4><dl className="lab-finding-inspector__fields">
        <div><dt>Page</dt><dd>{finding.pageUrl || 'Not reported'}</dd></div>
        <div><dt>Device</dt><dd>{finding.device || (finding.ruleId.match(/\.(desktop|mobile)$/)?.[1] || 'Not reported')}</dd></div>
        <div><dt>Rule ID</dt><dd><code>{finding.ruleId}</code></dd></div>
        <div><dt>Source</dt><dd>{sourceLabel(finding.source)}</dd></div>
        <div><dt>Confidence</dt><dd>{typeof finding.confidence === 'number' ? `${Math.round(finding.confidence * 100)}%` : 'Not reported'}</dd></div>
        {finding.fingerprint && <div><dt>Fingerprint</dt><dd><code>{finding.fingerprint}</code></dd></div>}
      </dl></section>

      <section data-proof-step="02"><h4>What happened</h4><p className="lab-finding-inspector__description">{finding.description || 'The analyzer did not provide a description for this finding.'}</p></section>
      <section data-proof-step="03"><h4>Evidence</h4>{finding.evidence?.length ? <div className="lab-finding-inspector__evidence">{finding.evidence.map((item, index) => <article key={index}><header><b>{humanize(String(item.type || 'evidence'))}</b>{typeof item.name === 'string' && <small>{item.name}</small>}</header><EvidenceValue value={item.value ?? item} /></article>)}</div> : <p className="lab-finding-inspector__empty">No structured evidence was retained for this finding.</p>}</section>
      {screenshot && <section data-proof-step="04"><h4>Screenshot</h4><a className="lab-finding-inspector__screenshot" href={screenshot} target="_blank" rel="noreferrer"><img src={screenshot} alt={`${finding.device || 'Analyzer'} screenshot for ${finding.title}`} /></a></section>}
      <section data-proof-step={screenshot ? '05' : '04'}><h4>How to fix</h4><p className="lab-finding-inspector__remediation">{finding.remediation || 'The analyzer did not provide remediation guidance.'}</p></section>
      {finding.pageUrl && <button className="lab-finding-inspector__copy" type="button" onClick={() => void copy(finding.pageUrl!)}><Copy /> Copy page URL</button>}
    </aside>;
}

export default function AdminEngineLabResults() {
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [active, setActive] = useState<LabRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedFinding, setSelectedFinding] = useState<FindingRow | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  async function load(preferredId?: string) {
    setLoading(true);
    try {
      const response = await apiFetch<{ runs: LabRun[] }>('/api/v1/admin/engine-lab/runs');
      setRuns(response.runs);
      const selected = response.runs.find((run) => run.id === (preferredId || active?.id)) || response.runs[0] || null;
      if (selected) {
        const detail = await apiFetch<{ run: LabRun }>(`/api/v1/admin/engine-lab/runs/${selected.id}`);
        setActive(detail.run);
      } else setActive(null);
      setError('');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Lab results could not be loaded.'); }
    finally { setLoading(false); }
  }

  async function selectRun(runId: string) {
    try {
      const response = await apiFetch<{ run: LabRun }>(`/api/v1/admin/engine-lab/runs/${runId}`);
      setActive(response.run);
      setError('');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Lab result could not be loaded.'); }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active || terminal.has(active.status)) return;
    const timer = window.setInterval(() => void load(active.id), 1_500);
    return () => window.clearInterval(timer);
  }, [active?.id, active?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const findings = useMemo(() => collectFindings(active), [active]);
  const orderedFindings = useMemo(() => [...findings].sort((left, right) => ['high', 'medium', 'low', 'info'].indexOf(left.severity) - ['high', 'medium', 'low', 'info'].indexOf(right.severity)), [findings]);

  return <section className="lab-results portal-panel">
    <header className="lab-results__header"><div><span>ADMIN EVIDENCE ARCHIVE</span><h2>Engine Lab results</h2><p>Lab runs stay separate from customer scans, findings, credits and reports.</p></div><button onClick={() => void load(active?.id)} disabled={loading}><RefreshCw /> {loading ? 'Refreshing...' : 'Refresh'}</button></header>
    {error && <div className="portal-alert" role="alert"><ShieldAlert /> {error}</div>}
    {!loading && !runs.length ? <div className="lab-results__empty"><FileSearch /><h3>No Engine Lab results yet</h3><p>Run one or more engines from Engine Test Lab. Results will appear here.</p></div> : <div className="lab-results__layout">
      <nav className="lab-run-list" aria-label="Engine Lab run history">{runs.map((run, index) => <button className={active?.id === run.id ? 'is-active' : ''} key={run.id} onClick={() => void selectRun(run.id)}><small>{String(index + 1).padStart(2, '0')}</small><span><b>{run.targetOrigin}</b><small>{new Date(run.createdAt).toLocaleString()} / {run.engines.length} engines</small></span><em className={`run-state is-${run.status}`}>{run.status}</em></button>)}</nav>
      {active && <div className="lab-result-detail">
        <header><div><span>SELECTED RUN</span><h3>{active.targetOrigin}</h3><small>{active.id}</small></div><b className={`run-state is-${active.status}`}>{active.status}</b></header>
        <div className="lab-result-summary"><div><span>Completed</span><strong>{active.engines.filter((engine) => engine.status === 'completed').length}</strong></div><div><span>Total findings</span><strong>{active.engines.reduce((total, engine) => total + engine.findingsCount, 0)}</strong></div><div><span>Evidence samples</span><strong>{findings.length}</strong></div><div><span>Failed</span><strong>{active.summary.failed || 0}</strong></div></div>
        <section className="lab-finding-board"><div className="lab-section-heading"><div><span>EVIDENCE LEDGER</span><h4>Finding impressions</h4></div><em>{findings.length} measured samples</em></div>{findings.length ? <div className="lab-evidence-workbench"><div className="lab-finding-ledger" role="list">{orderedFindings.map((finding, index) => <button className={`lab-ledger-row is-${finding.severity}${selectedFinding?.key === finding.key ? ' is-selected' : ''}`} type="button" key={finding.key} ref={selectedFinding?.key === finding.key ? openerRef : undefined} onClick={(event) => { openerRef.current = event.currentTarget; setSelectedFinding(finding); }}><small>{String(index + 1).padStart(2, '0')}</small><em>{finding.severity}</em><span><b>{finding.title}</b><small>{finding.engine} / {finding.ruleId}</small></span><span>{safeHostname(finding.pageUrl)}</span>{finding.fingerprint ? <code>{finding.fingerprint.slice(0, 12)}</code> : <code>NO PRINT</code>}</button>)}</div>{selectedFinding ? <FindingDetail finding={selectedFinding} onClose={() => { setSelectedFinding(null); window.setTimeout(() => openerRef.current?.focus(), 0); }} /> : <aside className="lab-finding-inspector lab-finding-inspector--empty"><FileSearch /><span>SELECT AN IMPRESSION</span><h3>Evidence stays in context.</h3><p>Choose a row to inspect its source, location, retained evidence and remediation without leaving the ledger.</p></aside>}</div> : <p className="empty-state">No normalized finding samples were produced. Coverage and measured evidence remain available per engine below.</p>}</section>
        <section className="lab-result-engines"><div className="lab-section-heading"><div><span>ENGINE EVIDENCE</span><h4>Coverage and measurements</h4></div><em>Open an engine to inspect</em></div>{active.engines.map((engine) => <details key={engine.engineId}><summary>{engine.status === 'completed' ? <CheckCircle2 /> : engine.status === 'failed' || engine.status === 'unavailable' ? <XCircle /> : <AlertTriangle />}<span><b>{engine.label}</b><small>{engine.engineId} / v{engine.version} / {engine.phase}</small></span><strong>{engine.findingsCount} findings</strong><em>{engine.status}</em></summary>{engine.error && <div className="engine-result__error"><AlertTriangle /><span><b>{engine.error.code}</b><small>{engine.error.message}</small></span></div>}{engine.evidence.length ? <div className="evidence-grid">{engine.evidence.map((item, index) => <EvidenceCard item={item} key={`${engine.engineId}-${index}`} />)}</div> : <p className="empty-state">This engine did not return structured evidence.</p>}</details>)}</section>
      </div>}
    </div>}
  </section>;
}
