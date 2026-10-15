import { useEffect, useState } from 'react';
import { api, type EngineInfo } from './api';
import { EngineTimeline } from './components/EngineTimeline';
import { ResultsView } from './components/ResultsView';
import { ScanForm } from './components/ScanForm';
import { TerrainBackdrop } from './backdrop/TerrainBackdrop';
import type { SceneId } from './backdrop/presets';
import { About } from './pages/About';
import { Terms } from './pages/Terms';
import { useScanFlow } from './useScanFlow';

const FALLBACK_ENGINES: EngineInfo[] = [
  { id: 'lighthouse', name: 'Google Lighthouse', description: 'Performance, accessibility, best practices and SEO audit.', external: false },
  { id: 'axe', name: 'Axe Accessibility', description: 'Automated WCAG rule checks.', external: false },
  { id: 'yellowLab', name: 'Yellow Lab Tools', description: 'Front-end quality and DOM pattern audit.', external: true },
  { id: 'wpaPage', name: 'WPA Page Intelligence', description: 'Rendered SEO, metadata, layout and runtime diagnostics.', external: false },
  { id: 'performancePlus', name: 'Performance Plus', description: 'Core Web Vitals on desktop and mobile viewports.', external: false },
  { id: 'advancedGeo', name: 'Advanced GEO & Entity Signals', description: 'Structured data and crawler access.', external: false },
  { id: 'visualUx', name: 'Visual UX', description: 'Layout stability and viewport sizing.', external: false },
];

function Scanner() {
  const { state, submit, reset } = useScanFlow();
  const [engines, setEngines] = useState<EngineInfo[]>(FALLBACK_ENGINES);

  useEffect(() => {
    api.engines().then(setEngines).catch(() => {});
  }, []);

  const scene: SceneId = state.phase === 'scanning' ? 'scan' : state.phase === 'results' ? 'results' : 'entry';

  return (
    <>
      <TerrainBackdrop scene={scene} />
      <main className={`scene scene--${scene}`} key={scene}>
        {scene === 'entry' && <ScanForm error={state.error} onSubmit={submit} />}
        {scene === 'scan' && <EngineTimeline scan={state.scan} engines={engines} onCancel={reset} />}
        {scene === 'results' && <ResultsView scan={state.scan} cached={state.cached} engines={engines} onReset={reset} />}
      </main>
    </>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="/">Scan</a>
      <a href="/about">About</a>
      <a href="/terms">Terms</a>
      <a href="https://github.com/onuracar-dev/WebPageAnalyz" rel="noreferrer">
        Source
      </a>
    </footer>
  );
}

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const page = path === '/terms' ? <Terms /> : path === '/about' ? <About /> : <Scanner />;
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div id="content">{page}</div>
      <SiteFooter />
    </>
  );
}
