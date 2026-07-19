import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  Accessibility,
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  Container,
  Download,
  ExternalLink,
  FileJson,
  Github,
  Globe2,
  Gauge,
  History,
  Menu,
  Network,
  Printer,
  ScanLine,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

type Category = 'performance' | 'accessibility' | 'seo' | 'bestPractices';

const preloadSnippet = '<link rel="preload"\n  as="image"\n  href="/hero.webp">';

const categories: Array<{ id: Category; label: string; icon: typeof Gauge }> = [
  { id: 'performance', label: 'Performance', icon: Zap },
  { id: 'accessibility', label: 'Accessibility', icon: Accessibility },
  { id: 'seo', label: 'SEO', icon: Search },
  { id: 'bestPractices', label: 'Best practices', icon: Activity },
];

const issueMap: Record<Category, Array<{ title: string; detail: string; impact: 'high' | 'medium' | 'low' }>> = {
  performance: [
    { title: 'Largest Contentful Paint', detail: 'Hero image is discovered late and blocks the primary paint.', impact: 'high' },
    { title: 'Unused JavaScript', detail: 'Defer 84 KB from the initial route.', impact: 'medium' },
    { title: 'Cache policy', detail: 'Two static assets use short cache lifetimes.', impact: 'low' },
  ],
  accessibility: [
    { title: 'Form label', detail: 'Newsletter input has no programmatic label.', impact: 'high' },
    { title: 'Color contrast', detail: 'Muted button text does not reach 4.5:1.', impact: 'medium' },
    { title: 'Heading order', detail: 'A heading level is skipped in the footer.', impact: 'low' },
  ],
  seo: [
    { title: 'Canonical URL', detail: 'No canonical link is declared for this route.', impact: 'medium' },
    { title: 'Meta description', detail: 'Description exceeds the useful snippet range.', impact: 'low' },
    { title: 'Link text', detail: 'Two links use ambiguous “learn more” labels.', impact: 'low' },
  ],
  bestPractices: [
    { title: 'Console errors', detail: 'A third-party widget logs an uncaught error.', impact: 'high' },
    { title: 'Image dimensions', detail: 'One image renders at an incorrect aspect ratio.', impact: 'medium' },
    { title: 'Deprecated API', detail: 'A browser API in one dependency is deprecated.', impact: 'low' },
  ],
};

function AnalyzerMark() {
  return <span className="analyzer-mark" aria-hidden="true"><ScanLine /><i /></span>;
}

function makeScores(value: string) {
  const seed = [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return {
    performance: 62 + seed % 25,
    accessibility: 73 + (seed * 3) % 22,
    seo: 78 + (seed * 5) % 19,
    bestPractices: 69 + (seed * 7) % 25,
  };
}

function Score({ label, score, icon: Icon }: { label: string; score: number; icon: typeof Gauge }) {
  return (
    <article className="score-card">
      <div className="score-card__top"><Icon /><span>{label}</span></div>
      <div className="score-ring" style={{ '--score': score } as CSSProperties}><strong>{score}</strong><span>/100</span></div>
    </article>
  );
}

function ProductSite() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [url, setUrl] = useState('https://example.com');
  const [analyzedUrl, setAnalyzedUrl] = useState('https://example.com');
  const [activeCategory, setActiveCategory] = useState<Category>('performance');
  const [error, setError] = useState('');

  const scores = useMemo(() => makeScores(analyzedUrl), [analyzedUrl]);

  const runSample = (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (
        !['http:', 'https:'].includes(parsed.protocol)
        || !hostname
        || parsed.username
        || parsed.password
        || hostname === 'localhost'
        || hostname.endsWith('.localhost')
      ) throw new Error();
      setAnalyzedUrl(parsed.toString());
      setError('');
      document.getElementById('sample-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      setError('Enter a complete public HTTP or HTTPS URL.');
    }
  };

  return (
    <div className="analyzer-site">
      <a className="skip" href="#main">Skip to content</a>
      <header>
        <a className="brand" href="#top" aria-label="WebPage Analyzer home"><AnalyzerMark /><span>WebPage<br /><strong>Analyzer</strong></span></a>
        <nav id="primary-navigation" className={menuOpen ? 'nav nav--open' : 'nav'} aria-label="Primary navigation">
          <a href="#workflow" onClick={() => setMenuOpen(false)}>Workflow</a>
          <a href="#sample-report" onClick={() => setMenuOpen(false)}>Sample report</a>
          <a href="#security" onClick={() => setMenuOpen(false)}>Security</a>
          <a href="#deploy" onClick={() => setMenuOpen(false)}>Self-host</a>
          <a className="github" href="https://github.com/onuracar-dev/WebPageAnalyz" target="_blank" rel="noreferrer"><Github /> GitHub</a>
        </nav>
        <button className="menu" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X /> : <Menu />}</button>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero-copy">
            <div className="eyebrow"><span>OPEN SOURCE</span><i /> Lighthouse + Axe + YellowLab + optional AI</div>
            <h1>One URL.<br />A <em>prioritized</em><br />way forward.</h1>
            <p>Audit performance, accessibility, SEO, best practices, and frontend quality in one security-aware workflow—then turn findings into work your team can act on.</p>
            <form className="url-form" onSubmit={runSample} noValidate>
              <label htmlFor="hero-url">Website URL</label>
              <div><Globe2 /><input id="hero-url" type="url" inputMode="url" autoComplete="url" spellCheck={false} required value={url} onChange={(event) => { setUrl(event.target.value); if (error) setError(''); }} placeholder="https://your-site.com" aria-describedby={error ? 'url-error' : 'sample-note'} aria-invalid={Boolean(error)} /><button type="submit">Explore sample audit <ArrowRight /></button></div>
              {error && <p id="url-error" className="form-error" role="alert"><CircleAlert /> {error}</p>}
            </form>
            <p id="sample-note" className="sample-note"><Sparkles /> Interactive sample only—no request is sent and no live scan runs on this marketing page.</p>
          </div>

          <div className="hero-report" aria-label="Illustrative audit report">
            <div className="report-sheet report-sheet--back"><span>ACCESSIBILITY</span><strong>91</strong></div>
            <div className="report-sheet report-sheet--middle"><span>SEO</span><strong>94</strong></div>
            <div className="report-sheet report-sheet--front">
              <div className="sheet-top"><div><ScanLine /><span>audit / overview</span></div><span className="live-dot">sample</span></div>
              <p>example.com</p>
              <strong className="hero-score">78<span>/100</span></strong>
              <div className="hero-bars"><span style={{ width: '78%' }} /><span style={{ width: '91%' }} /><span style={{ width: '94%' }} /><span style={{ width: '84%' }} /></div>
              <div className="sheet-finding"><i>01</i><CircleAlert /><div><strong>Prioritize LCP image</strong><span>potential 0.8s improvement</span></div><ChevronRight /></div>
              <div className="sheet-finding"><i>02</i><Accessibility /><div><strong>Restore input label</strong><span>critical user path</span></div><ChevronRight /></div>
              <div className="sheet-stamp">illustrative dataset · local interaction</div>
            </div>
          </div>
        </section>

        <section className="engine-strip" aria-label="Audit engines"><span>Powered by proven engines</span><strong>LIGHTHOUSE</strong><strong>axe</strong><strong>YELLOWLAB</strong><strong>GEMINI <i>optional</i></strong></section>

        <section className="workflow" id="workflow">
          <div className="section-heading"><span className="section-number">01</span><div><p className="kicker">FROM URL TO ACTION</p><h2>One bounded workflow.<br />Four useful layers.</h2></div><p>The dashboard preserves raw evidence while moving the highest-impact work to the top.</p></div>
          <div className="workflow-grid">
            <article><span>01</span><Globe2 /><h3>Validate the target</h3><p>Credential-free public HTTP(S), explicit ports, DNS/IP checks, and redirect/subresource enforcement.</p></article>
            <article><span>02</span><Gauge /><h3>Run bounded audits</h3><p>Lighthouse, Axe, and YellowLab execute behind concurrency, duration, connection, and byte limits.</p></article>
            <article><span>03</span><ScanLine /><h3>Prioritize evidence</h3><p>Scores, engine status, and category findings live together instead of across disconnected reports.</p></article>
            <article><span>04</span><Bot /><h3>Ask for remediation</h3><p>Gemini suggestions are opt-in, visibly separated, and keep the source finding in view.</p></article>
          </div>
        </section>

        <section className="sample-report" id="sample-report">
          <div className="section-heading"><span className="section-number">02</span><div><p className="kicker">INTERACTIVE SAMPLE</p><h2>Make the report<br />answerable.</h2></div><p>Scores are deterministically modeled from the URL on this page. The production app runs real audit engines on the backend.</p></div>
          <div className="dashboard">
            <div className="dashboard-top"><div><AnalyzerMark /><div><span>Sample report</span><strong>{analyzedUrl}</strong></div></div><div><button type="button"><History /> History</button><button type="button"><FileJson /> JSON</button><button type="button"><Printer /> Print</button></div></div>
            <div className="score-grid">{categories.map(({ id, label, icon }) => <Score key={id} label={label} score={scores[id]} icon={icon} />)}</div>
            <div className="finding-workspace">
              <div className="finding-tabs" role="tablist" aria-label="Audit categories">
                {categories.map(({ id, label, icon: Icon }, index) => <button
                  id={`category-tab-${id}`}
                  key={id}
                  type="button"
                  role="tab"
                  aria-controls="category-panel"
                  aria-selected={activeCategory === id}
                  tabIndex={activeCategory === id ? 0 : -1}
                  onClick={() => setActiveCategory(id)}
                  onKeyDown={(event) => {
                    const lastIndex = categories.length - 1;
                    let nextIndex = index;
                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1;
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1;
                    else if (event.key === 'Home') nextIndex = 0;
                    else if (event.key === 'End') nextIndex = lastIndex;
                    else return;
                    event.preventDefault();
                    const nextCategory = categories[nextIndex].id;
                    setActiveCategory(nextCategory);
                    requestAnimationFrame(() => document.getElementById(`category-tab-${nextCategory}`)?.focus());
                  }}
                ><Icon /><span>{label}</span><i>{issueMap[id].length}</i></button>)}
              </div>
              <div id="category-panel" className="finding-list" role="tabpanel" aria-labelledby={`category-tab-${activeCategory}`}>
                <div className="finding-list__head"><span>Prioritized findings</span><strong>{categories.find((category) => category.id === activeCategory)?.label}</strong></div>
                {issueMap[activeCategory].map((issue, index) => <article key={issue.title}><span>{String(index + 1).padStart(2, '0')}</span><i className={`impact impact--${issue.impact}`}>{issue.impact}</i><div><h3>{issue.title}</h3><p>{issue.detail}</p></div><button type="button" aria-label={`Open ${issue.title}`}><ArrowUpRight /></button></article>)}
              </div>
              <aside className="ai-panel"><div className="ai-panel__label"><Sparkles /> OPTIONAL AI LAYER</div><h3>Prioritize the LCP image.</h3><p>Preload the hero image, use a responsive source set, and remove lazy loading from the above-the-fold candidate.</p><pre><code>{preloadSnippet}</code></pre><div><CheckCircle2 /> Suggestion stays attached to source evidence</div></aside>
            </div>
          </div>
        </section>

        <section className="exports"><div><p className="kicker">REPORTS THAT LEAVE THE DASHBOARD</p><h2>Keep ten locally.<br />Export what matters.</h2></div><div className="export-cards"><article><History /><strong>Local history</strong><span>10 reports · 30 days</span></article><article><Download /><strong>Structured JSON</strong><span>Evidence for your workflow</span></article><article><Printer /><strong>Print / PDF</strong><span>Shareable review artifact</span></article></div><p>History stays in that browser’s local storage. There is no hidden account database in the open-source app.</p></section>

        <section className="security" id="security">
          <div className="security-copy"><span className="section-number">03</span><p className="kicker">ANALYZING URLS IS HIGH-RISK</p><h2>SSRF defense is<br />a system, not a regex.</h2><p>Every Chromium connection passes through a loopback-only policy proxy that resolves destinations again and rejects private, reserved, mixed-answer, credentialed, and disallowed targets.</p><a href="https://github.com/onuracar-dev/WebPageAnalyz#security-model" target="_blank" rel="noreferrer">Read the complete threat boundary <ArrowUpRight /></a></div>
          <div className="boundary-diagram">
            <div className="boundary-step"><span>01</span><Globe2 /><div><strong>submitted URL</strong><small>schema + protocol + port</small></div></div><i><ArrowRight /></i>
            <div className="boundary-step boundary-step--shield"><span>02</span><ShieldCheck /><div><strong>policy proxy</strong><small>DNS + IP + byte limits</small></div></div><i><ArrowRight /></i>
            <div className="boundary-step"><span>03</span><Network /><div><strong>public target</strong><small>rechecked on every hop</small></div></div>
            <p><CircleAlert /> Infrastructure egress rules and runtime isolation are still required in production.</p>
          </div>
        </section>

        <section className="deploy" id="deploy">
          <div className="section-heading"><span className="section-number">04</span><div><p className="kicker">OPEN-SOURCE FIRST</p><h2>Deploy the whole<br />audit boundary.</h2></div><p>The repository includes a non-root backend container, Nginx same-origin proxy, health checks, environment examples, and CI.</p></div>
          <div className="deploy-grid">
            <div className="terminal"><div><span /><span /><span /><code>terminal</code></div><pre><code><b>$</b> cp .env.example .env{`\n`}<b>$</b> docker compose up --build -d{`\n\n`}<i>✓</i> frontend / nginx{`\n`}<i>✓</i> analyzer api / non-root{`\n`}<i>✓</i> same-origin /api proxy</code></pre></div>
            <div className="deploy-notes"><article><Container /><div><h3>Docker baseline</h3><p>Chrome, audit engines, and the app are packaged for repeatable operation.</p></div></article><article><ServerCog /><div><h3>Operator controls</h3><p>Queue, timeout, rate, auth, artifact, proxy, and target-port policies are configurable.</p></div></article><article><ShieldCheck /><div><h3>Conservative defaults</h3><p>AI is optional; admin cleanup is closed unless separately authorized.</p></div></article><a className="primary-button" href="https://github.com/onuracar-dev/WebPageAnalyz" target="_blank" rel="noreferrer"><Github /> Clone and self-host <ArrowRight /></a></div>
          </div>
        </section>

        <section className="closing"><div><span>OPEN SOURCE · MIT</span><h2>Turn a noisy audit<br />into the next right fix.</h2></div><div><a className="primary-button" href="https://github.com/onuracar-dev/WebPageAnalyz" target="_blank" rel="noreferrer"><Code2 /> Explore the code <ExternalLink /></a><p>Hosted plans may follow only after the open-source workflow is validated in real use.</p></div></section>
      </main>

      <footer><a className="brand" href="#top"><AnalyzerMark /><span>WebPage<br /><strong>Analyzer</strong></span></a><p>Open-source website auditing by <a href="https://github.com/onuracar-dev">Onur Acar</a>.</p><div><a href="https://github.com/onuracar-dev/WebPageAnalyz">GitHub</a><a href="https://github.com/onuracar-dev/WebPageAnalyz/blob/master/SECURITY.md">Security</a><a href="https://github.com/onuracar-dev/WebPageAnalyz/blob/master/LICENSE">MIT</a></div></footer>
    </div>
  );
}

export default ProductSite;
