import { useState } from 'react';
import { ENGINE_IDS, SEVERITIES, displayUrl, type EngineInfo, type Scan } from '../api';
import { SEVERITY_LABELS, type GroupMode } from '../galaxy/layout';
import { RedirectNote, formatDuration } from './EngineTimeline';
import { FindingsAccordion } from './FindingsAccordion';
import { FindingsGalaxy } from './FindingsGalaxy';

const MODES: { id: GroupMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'category', label: 'Category' },
  { id: 'engine', label: 'Engine' },
  { id: 'severity', label: 'Severity' },
];

interface Props {
  scan?: Scan;
  cached: boolean;
  engines: EngineInfo[];
  onReset: () => void;
}

export function ResultsView({ scan, cached, engines, onReset }: Props) {
  const [mode, setMode] = useState<GroupMode>('all');
  const [selectedId, setSelectedId] = useState<string>();

  if (!scan) {
    return (
      <section className="panel results-loading" aria-live="polite">
        Loading result…
      </section>
    );
  }

  const findings = scan.findings;
  const unhealthy = ENGINE_IDS.filter((id) => {
    const status = scan.engines[id]?.status;
    return status === 'failed' || status === 'timed_out';
  });
  const nameOf = (id: string) => engines.find((engine) => engine.id === id)?.name ?? id;
  const tookMs = scan.startedAt && scan.finishedAt ? Date.parse(scan.finishedAt) - Date.parse(scan.startedAt) : undefined;

  return (
    <div className="results">
      <aside className="summary panel" aria-labelledby="summary-title">
        <p className="eyebrow">
          {scan.status === 'failed' ? 'Scan failed' : 'Scan complete'}
          {cached && <span className="badge">Recent result</span>}
        </p>
        <h2 id="summary-title" className="summary__url" title={scan.url}>
          {displayUrl(scan.url)}
        </h2>
        <RedirectNote scan={scan} />
        {tookMs !== undefined && (
          <p className="muted">
            Took <span className="mono">{formatDuration(tookMs)}</span>
          </p>
        )}

        {scan.status === 'failed' ? (
          <p className="summary__error" role="alert">
            {scan.error?.message ?? 'The scan did not complete.'} This host can be scanned again in about 10 minutes.
          </p>
        ) : (
          <ul className="severity-counts" aria-label="Findings by severity">
            {SEVERITIES.map((severity) => (
              <li key={severity} className={`severity-counts__item severity-counts__item--${severity}`}>
                <span className="severity-counts__value mono">{scan.summary.bySeverity[severity] ?? 0}</span>
                <span className="severity-counts__label">{SEVERITY_LABELS[severity]}</span>
              </li>
            ))}
          </ul>
        )}

        {unhealthy.length > 0 && (
          <div className="summary__engines">
            <p className="muted">Some engines didn’t finish, so their checks are missing from this report:</p>
            <ul>
              {unhealthy.map((id) => (
                <li key={id}>
                  {nameOf(id)}: {scan.engines[id]?.error?.message ?? scan.engines[id]?.status}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button type="button" className="button button--primary" onClick={onReset}>
          Scan another URL
        </button>
      </aside>

      <section className="stage" aria-label="Findings map">
        {findings.length > 0 ? (
          <>
            <div className="tabs" role="tablist" aria-label="Group findings by">
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === item.id}
                  className="tabs__tab"
                  onClick={() => setMode(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <FindingsGalaxy findings={findings} mode={mode} selectedId={selectedId} onSelect={setSelectedId} />
          </>
        ) : (
          scan.status !== 'failed' && (
            <p className="stage__empty">No findings from the engines that finished. That’s rare, so check the engine list on the left.</p>
          )
        )}
      </section>

      {findings.length > 0 && <FindingsAccordion findings={findings} activeId={selectedId} onActivate={setSelectedId} />}
    </div>
  );
}
