import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { animate, createTimeline, stagger } from 'animejs';
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileJson,
  Gauge,
  Globe2,
  Menu,
  Network,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import BloomScene from './BloomScene';

type Category = 'performance' | 'accessibility' | 'seo' | 'bestPractices';
type ScanStage = 'ready' | 'running' | 'complete';

const categories: Array<{ id: Category; label: string; short: string }> = [
  { id: 'performance', label: 'Performance', short: 'PERF' },
  { id: 'accessibility', label: 'Accessibility', short: 'A11Y' },
  { id: 'seo', label: 'Search', short: 'SEO' },
  { id: 'bestPractices', label: 'Best practices', short: 'B/P' },
];

const evidence: Record<Category, Array<{ title: string; detail: string; impact: 'critical' | 'high' | 'medium'; owner: string }>> = {
  performance: [
    { title: 'The LCP image arrives late', detail: 'The browser discovers the main image after layout CSS. Give it the first network window.', impact: 'critical', owner: 'Frontend' },
    { title: '84 KB of JavaScript can wait', detail: 'This code does not change the first view or the first interaction.', impact: 'high', owner: 'Platform' },
    { title: 'Two assets expire too early', detail: 'Versioned files return a short cache policy and cost repeat visitors another request.', impact: 'medium', owner: 'Infra' },
  ],
  accessibility: [
    { title: 'Checkout has lost its label', detail: 'The email field looks named, but assistive technology receives no programmatic label.', impact: 'critical', owner: 'Frontend' },
    { title: 'Muted copy misses AA contrast', detail: 'Secondary control text falls below the required contrast ratio on the dark panel.', impact: 'high', owner: 'Design' },
    { title: 'The heading order jumps', detail: 'The footer moves from an H2 to an H4 and breaks the document outline.', impact: 'medium', owner: 'Content' },
  ],
  seo: [
    { title: 'The canonical route is missing', detail: 'The page never declares which public URL should own its search signals.', impact: 'high', owner: 'Growth' },
    { title: 'The search description will clip', detail: 'The current description is longer than the useful result preview.', impact: 'medium', owner: 'Content' },
    { title: 'Two links have no destination clue', detail: 'Repeated “learn more” labels do not describe where the link goes.', impact: 'medium', owner: 'Content' },
  ],
  bestPractices: [
    { title: 'A widget fails on every load', detail: 'A third-party script throws before the page becomes interactive.', impact: 'critical', owner: 'Platform' },
    { title: 'One image is visibly stretched', detail: 'The rendered dimensions do not match the source aspect ratio.', impact: 'high', owner: 'Frontend' },
    { title: 'A browser API is near removal', detail: 'One dependency still calls an interface browsers have marked as deprecated.', impact: 'medium', owner: 'Platform' },
  ],
};

const witnesses = [
  { name: 'Lighthouse', line: 'Speed, search and browser quality.' },
  { name: 'Axe', line: 'Accessibility failures tied to the markup.' },
  { name: 'YellowLab', line: 'Page weight and frontend complexity.' },
];

function makeScores(value: string) {
  const seed = [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return {
    performance: 58 + seed % 31,
    accessibility: 70 + (seed * 3) % 25,
    seo: 76 + (seed * 5) % 21,
    bestPractices: 66 + (seed * 7) % 29,
  };
}

function AnalyzerMark() {
  return <span className="wpa-mark" aria-hidden="true"><ScanLine /><i /></span>;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function ProductSite() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [url, setUrl] = useState('https://example.com');
  const [analyzedUrl, setAnalyzedUrl] = useState('https://example.com');
  const [activeCategory, setActiveCategory] = useState<Category>('performance');
  const [scanStage, setScanStage] = useState<ScanStage>('ready');
  const [error, setError] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const scanTimers = useRef<number[]>([]);
  const reducedMotion = useReducedMotion();

  const scores = useMemo(() => makeScores(analyzedUrl), [analyzedUrl]);
  const hostname = useMemo(() => {
    try { return new URL(analyzedUrl).hostname; } catch { return 'example.com'; }
  }, [analyzedUrl]);
  const overallScore = Math.round(Object.values(scores).reduce((sum, score) => sum + score, 0) / 4);

  useEffect(() => {
    if (reducedMotion) return undefined;
    const intro = createTimeline({ defaults: { ease: 'outExpo' } })
      .add('.site-nav', { opacity: [0, 1], y: [-24, 0], duration: 900 }, 0)
      .add('.hero-line > span', { y: ['115%', '0%'], rotate: [3, 0], duration: 1200, delay: stagger(110) }, 90)
      .add('.hero-summary', { opacity: [0, 1], y: [24, 0], duration: 900 }, 380)
      .add('.bloom-scene', { opacity: [0, 1], scale: [1.035, 1], duration: 1500 }, 180)
      .add('.command-bar', { opacity: [0, 1], y: [36, 0], duration: 1000 }, 620);

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || entry.target.classList.contains('is-visible')) return;
        entry.target.classList.add('is-visible');
        const children = entry.target.querySelectorAll(':scope > [data-reveal-item]');
        animate(children.length ? children : entry.target, {
          opacity: [0, 1],
          y: [46, 0],
          duration: 1050,
          delay: children.length ? stagger(95) : 0,
          ease: 'outExpo',
        });
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.14 });

    document.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
    return () => {
      intro.revert();
      observer.disconnect();
    };
  }, [reducedMotion]);

  useEffect(() => {
    const updateScroll = () => {
      const available = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      document.documentElement.style.setProperty('--page-progress', `${window.scrollY / available}`);
    };
    updateScroll();
    window.addEventListener('scroll', updateScroll, { passive: true });
    return () => window.removeEventListener('scroll', updateScroll);
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || reducedMotion) return undefined;

    const current = { x: 0.22, y: 0.15, pressure: 0 };
    const target = { ...current };
    let frame = 0;

    const render = () => {
      current.x += (target.x - current.x) * 0.09;
      current.y += (target.y - current.y) * 0.09;
      current.pressure += (target.pressure - current.pressure) * 0.08;
      nav.style.setProperty('--liquid-x', `${current.x * 100}%`);
      nav.style.setProperty('--liquid-y', `${current.y * 100}%`);
      nav.style.setProperty('--liquid-tilt-x', `${(0.5 - current.y) * current.pressure * 1.15}deg`);
      nav.style.setProperty('--liquid-tilt-y', `${(current.x - 0.5) * current.pressure * 1.5}deg`);
      nav.style.setProperty('--liquid-pressure', current.pressure.toFixed(3));
      nav.style.setProperty('--liquid-shadow-alpha', (0.2 + current.pressure * 0.08).toFixed(3));
      nav.style.setProperty('--liquid-highlight-alpha', (0.58 + current.pressure * 0.34).toFixed(3));
      nav.style.setProperty('--liquid-dark-alpha', (0.02 + current.pressure * 0.07).toFixed(3));
      nav.style.setProperty('--liquid-flow-opacity', (0.34 + current.pressure * 0.24).toFixed(3));
      nav.style.setProperty('--liquid-shift', `${(current.pressure - 0.5) * 5}px`);
      frame = window.requestAnimationFrame(render);
    };

    const move = (event: PointerEvent) => {
      const bounds = nav.getBoundingClientRect();
      target.x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      target.y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      target.pressure = 1;
    };

    const leave = () => {
      target.x = 0.5;
      target.y = 0.3;
      target.pressure = 0;
    };

    nav.addEventListener('pointermove', move, { passive: true });
    nav.addEventListener('pointerleave', leave);
    frame = window.requestAnimationFrame(render);
    return () => {
      nav.removeEventListener('pointermove', move);
      nav.removeEventListener('pointerleave', leave);
      window.cancelAnimationFrame(frame);
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);

  useEffect(() => () => scanTimers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const runSample = (event: FormEvent) => {
    event.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url);
      const parsedHostname = parsed.hostname.toLowerCase();
      if (
        !['http:', 'https:'].includes(parsed.protocol)
        || !parsedHostname
        || parsed.username
        || parsed.password
        || parsedHostname === 'localhost'
        || parsedHostname.endsWith('.localhost')
      ) throw new Error();
    } catch {
      setError('Use a complete public HTTP or HTTPS URL.');
      return;
    }

    scanTimers.current.forEach((timer) => window.clearTimeout(timer));
    setError('');
    setScanStage('running');
    const stepDelay = reducedMotion ? 180 : 1200;
    scanTimers.current.push(window.setTimeout(() => {
      setAnalyzedUrl(parsed.toString());
      setScanStage('complete');
      window.dispatchEvent(new CustomEvent('wpa:scroll-to', { detail: '#report' }));
    }, stepDelay));
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="wpa-site" data-scan-stage={scanStage}>
      <a className="skip-link" href="#main">Skip to content</a>

      <header className="site-nav" ref={navRef}>
        <span className="nav-liquid" aria-hidden="true"><span className="nav-liquid__flow"><i /><i /><i /></span></span>
        <a className="site-brand" href="#top" aria-label="WebPage Analyzer home"><AnalyzerMark /><span>WPA<sup>®</sup></span></a>
        <nav id="primary-navigation" className={menuOpen ? 'nav-links nav-links--open' : 'nav-links'} aria-label="Primary navigation">
          <a href="#method" onClick={closeMenu}>Product</a>
          <a href="#anatomy" onClick={closeMenu}>Findings</a>
          <a href="#report" onClick={closeMenu}>Sample report</a>
          <a href="#deployment" onClick={closeMenu}>Deployment</a>
        </nav>
        <a className="nav-cta" href="mailto:onuracar.work@gmail.com?subject=WebPage%20Analyzer%20private%20demo">Book demo <ArrowUpRight /></a>
        <button className="menu-button" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X /> : <Menu />}</button>
        <i className="nav-progress" aria-hidden="true" />
      </header>

      <main id="main">
        <section className="hero" id="top">
          <BloomScene reducedMotion={reducedMotion} />

          <div className="hero-content">
            <h1 aria-label="Your website left clues">
              <span className="hero-line"><span>YOUR WEBSITE</span></span>
              <span className="hero-line hero-line--signal"><span>LEFT CLUES.</span></span>
            </h1>
            <div className="hero-bottom">
              <p className="hero-summary">Lighthouse, Axe and YellowLab findings, ranked in one report.</p>
            </div>
            <form className="command-bar" onSubmit={runSample} noValidate>
              <Globe2 aria-hidden="true" />
              <label htmlFor="sample-url" className="sr-only">Website URL for the sample report</label>
              <input id="sample-url" type="url" inputMode="url" autoComplete="url" spellCheck={false} required value={url} onChange={(event) => { setUrl(event.target.value); if (error) setError(''); }} aria-describedby={error ? 'url-error' : undefined} aria-invalid={Boolean(error)} />
              <button type="submit" disabled={scanStage === 'running'}>{scanStage === 'running' ? 'Preparing report' : scanStage === 'complete' ? 'Run again' : 'View sample'} <ArrowRight /></button>
              {error && <p id="url-error" className="command-error" role="alert"><CircleAlert /> {error}</p>}
            </form>
          </div>
        </section>

        <section className="witness-section" id="method">
          <div className="section-shell witness-intro" data-reveal>
            <h2 data-reveal-item>Three audits.<br /><em>One fix list.</em></h2>
            <p data-reveal-item>Each finding keeps its source and the affected element.</p>
          </div>
          <div className="witness-list section-shell" data-reveal>
            {witnesses.map((engine) => (
              <article key={engine.name} data-reveal-item>
                <h3>{engine.name}</h3>
                <p>{engine.line}</p>
                <ArrowUpRight />
              </article>
            ))}
          </div>
        </section>

        <section className="anatomy-section" id="anatomy">
          <div className="section-shell anatomy-layout">
            <div className="anatomy-copy" data-reveal>
              <h2 data-reveal-item>The problem,<br /><em>pinned to the page.</em></h2>
              <p data-reveal-item>Open a finding and see the element, impact and owner.</p>
            </div>

            <div className="inspection-stage" aria-label="A selected button inspected with three attached findings">
              <svg className="inspection-paths" viewBox="0 0 760 720" aria-hidden="true">
                <path d="M92 174 C194 174 184 258 302 282" />
                <path d="M671 126 C576 174 612 257 500 302" />
                <path d="M676 596 C573 568 591 482 491 444" />
              </svg>
              <div className="inspection-lens">
                <span>SELECTED ELEMENT</span>
                <strong>&lt;button&gt;</strong>
                <div className="inspection-element">START NOW</div>
                <p>Accessible name <b>missing</b></p>
              </div>
              <span className="inspection-pin inspection-pin--one"><i>01</i><b>Axe</b><small>Label missing</small></span>
              <span className="inspection-pin inspection-pin--two"><i>02</i><b>Lighthouse</b><small>Late dependency</small></span>
              <span className="inspection-pin inspection-pin--three"><i>03</i><b>Owner</b><small>Frontend</small></span>
            </div>
          </div>
        </section>

        <section className="report-section" id="report">
          <div className="section-shell report-intro" data-reveal>
            <h2 data-reveal-item>A ranked list.<br /><em>Evidence attached.</em></h2>
          </div>

          <div className="report-shell section-shell" data-reveal>
            <div className="report-chrome" data-reveal-item>
              <span><AnalyzerMark /> WPA / CASE 001</span><b>{hostname}</b><span>EVIDENCE LOCKED</span>
            </div>
            <div className="report-overview" data-reveal-item>
              <div className="score-orbit" style={{ '--score': `${overallScore * 3.6}deg` } as CSSProperties}>
                <div><strong>{overallScore}</strong><span>OVERALL<br />SIGNAL</span></div>
              </div>
              <div className="report-title"><span>AUDIT SUBJECT</span><h3>{hostname}</h3><p>12 findings collected across three independent engines.</p></div>
              <div className="report-sparkline" aria-hidden="true"><span>REQUEST LOAD</span><svg viewBox="0 0 280 64"><path d="M0 52 L24 49 L40 51 L58 30 L78 34 L98 18 L119 28 L140 25 L160 38 L180 9 L199 19 L219 13 L242 27 L260 18 L280 21" /></svg><b>2.4 MB</b></div>
            </div>

            <div className="report-score-nav" data-reveal-item>
              {categories.map((category) => (
                <button key={category.id} type="button" className={activeCategory === category.id ? 'active' : ''} onClick={() => setActiveCategory(category.id)} aria-pressed={activeCategory === category.id}>
                  <span>{category.short}</span><strong>{scores[category.id]}</strong><i style={{ '--value': `${scores[category.id]}%` } as CSSProperties} />
                </button>
              ))}
            </div>

            <div className="report-evidence" data-reveal-item>
              <div className="finding-column" role="region" aria-live="polite" aria-label={`${categories.find((category) => category.id === activeCategory)?.label} sample findings`}>
                <div className="finding-head"><span>PRIORITY</span><span>FINDING / EVIDENCE</span><span>OWNER</span></div>
                {evidence[activeCategory].map((issue, index) => (
                  <article key={issue.title}>
                    <span className={`priority priority--${issue.impact}`}>{String(index + 1).padStart(2, '0')}<i />{issue.impact}</span>
                    <div><h4>{issue.title}</h4><p>{issue.detail}</p></div>
                    <span className="owner">{issue.owner}<ChevronRight /></span>
                  </article>
                ))}
              </div>
              <aside className="next-move">
                <span>NEXT MOVE / 01</span>
                <Gauge />
                <h3>{evidence[activeCategory][0].title}</h3>
                <p>{evidence[activeCategory][0].detail}</p>
                <div><Bot /><span>AI guidance stays off until a person asks for it.</span></div>
              </aside>
            </div>

            <div className="report-actions" data-reveal-item><span><Check /> SOURCE VISIBLE</span><span><Check /> ELEMENT ATTACHED</span><span><Check /> OWNER ASSIGNED</span><button type="button"><FileJson /> EXPORT CASE FILE</button></div>
          </div>
        </section>

        <section className="boundary-section">
          <div className="section-shell boundary-intro" data-reveal>
            <h2 data-reveal-item>Public targets only.</h2>
            <p data-reveal-item>Private IPs, unsafe redirects and mixed DNS answers are blocked before a browser opens.</p>
          </div>
          <div className="boundary-rail section-shell" data-reveal>
            <div data-reveal-item><span>01</span><Globe2 /><b>Submitted URL</b><small>Credentials rejected</small></div><ArrowRight data-reveal-item />
            <div data-reveal-item><span>02</span><Network /><b>DNS + IP policy</b><small>Public targets only</small></div><ArrowRight data-reveal-item />
            <div className="boundary-focus" data-reveal-item><span>03</span><ShieldCheck /><b>Safe proxy</b><small>Redirects checked again</small></div><ArrowRight data-reveal-item />
            <div data-reveal-item><span>04</span><Gauge /><b>Bounded browser</b><small>Time, bytes, concurrency</small></div>
          </div>
        </section>

        <section className="deployment-section" id="deployment">
          <div className="section-shell deployment-layout">
            <div className="deployment-content" data-reveal>
              <h2 data-reveal-item><span>Run it where</span><span>your data lives.</span></h2>
              <p data-reveal-item>Deploy the analyzer inside your environment. URLs and report history stay there.</p>
              <div className="deployment-actions" data-reveal-item>
                <a href="mailto:onuracar.work@gmail.com?subject=WebPage%20Analyzer%20private%20demo">Book a demo <ArrowUpRight /></a>
                <a href="#report">View sample report</a>
              </div>
            </div>
            <div className="report-lockup" aria-label="Twelve findings ranked from three audit sources">
              <span>ONE ORDERED REPORT</span>
              <div><strong>12</strong><p>findings ranked<br />by impact</p></div>
              <ul>{witnesses.map((engine) => <li key={engine.name}>{engine.name}</li>)}</ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer section-shell">
        <a className="site-brand" href="#top"><AnalyzerMark /><span>WPA<sup>®</sup></span></a>
        <div><a href="https://onuracar.dev" target="_blank" rel="noreferrer">Onur Acar <ArrowUpRight /></a><span>© 2026</span></div>
      </footer>
    </div>
  );
}

export default ProductSite;
