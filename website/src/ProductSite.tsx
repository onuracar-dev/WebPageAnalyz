import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, Menu, X } from 'lucide-react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { navigate } from './portal/router';
import { PUBLIC_PLANS } from './planCatalog';

gsap.registerPlugin(ScrollTrigger);

const SAFE_PLAN_FEATURES: Record<string, readonly string[]> = {
  free: ['5 page credits / month', 'Core browser, SEO/GEO, design and backend-surface evidence', '5 AI suggested-remediation generations / month', '7-day report history'],
  signal: ['25 page credits / month', 'Lighthouse, Axe, YellowLab + WPA core inspection', 'Runtime, SEO/GEO, responsive UX and backend-surface checks', 'TR/EN JSON + PDF/print reports', '30-day report history'],
  studio: ['150 page credits / month', 'Everything in Signal + bounded full-site crawl', 'Advanced SEO/GEO, Visual UX and Performance Plus evidence', 'Passive security + 1 source audit / month', '90-day report history'],
  enterprise: ['500 page credits / month', 'Everything in Studio + 4 source audits / month', 'Read-only Journey Test access', 'Expert Review when assigned to the workspace', '365-day report history'],
};

export default function ProductSite() {
  const rootRef = useRef<HTMLDivElement>(null);
  const plansCloseRef = useRef<HTMLButtonElement>(null);
  const plansTriggerRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const plansReturnRef = useRef<HTMLElement | null>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const menuOverflowRef = useRef<string | null>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const [target, setTarget] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const media = gsap.matchMedia();

    media.add('(min-width: 761px) and (prefers-reduced-motion: no-preference)', () => {
      const context = gsap.context(() => {
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .from('.wpa-nav', { y: -24, autoAlpha: 0, duration: .7 })
          .from('.wpa-scene--entry .wpa-scene-media', { scale: 1.035, autoAlpha: 0, duration: 1.15 }, '-=.42')
          .from('.wpa-hero-copy > *', { y: 24, autoAlpha: 0, duration: .72, stagger: .08 }, '-=.76');

        gsap.to('.wpa-scene--entry .wpa-scene-media img', {
          yPercent: 2.8,
          scale: 1.045,
          transformOrigin: 'center center',
          ease: 'none',
          scrollTrigger: { trigger: '.wpa-scene--entry', start: 'top top', end: 'bottom top', scrub: .8 },
        });

        gsap.timeline({
          defaults: { ease: 'power3.out' },
          scrollTrigger: { trigger: '.wpa-scene--scan', start: 'top 72%', toggleActions: 'play none none reverse' },
        })
          .from('.wpa-scene--scan .wpa-scene-media', { scale: 1.04, duration: 1.05 })
          .from('.wpa-scan-copy > *', { x: -26, duration: .64, stagger: .07 }, '-=.68');

        gsap.to('.wpa-scene--scan .wpa-scene-media img', {
          scale: 1.055,
          ease: 'none',
          scrollTrigger: { trigger: '.wpa-scene--scan', start: 'top bottom', end: 'bottom top', scrub: 1 },
        });

        gsap.timeline({
          defaults: { ease: 'power3.out' },
          scrollTrigger: { trigger: '.wpa-scene--result', start: 'top 68%', toggleActions: 'play none none reverse' },
        })
          .from('.wpa-result-copy > *', { y: 22, duration: .65, stagger: .07 })
          .from('.wpa-result-panel', { y: 34, duration: .9 }, '-=.58')
          .from('.wpa-result-panel__rail > *', { x: -18, duration: .55, stagger: .07 }, '-=.52');

        ScrollTrigger.create({
          trigger: '.wpa-scene--scan',
          start: 'top 12%',
          end: 'bottom 12%',
          toggleClass: { targets: '.wpa-nav', className: 'is-dark' },
        });
      }, root);
      return () => context.revert();
    });

    media.add('(max-width: 760px), (prefers-reduced-motion: reduce)', () => {
      gsap.set(root.querySelectorAll('[class*="wpa-"]'), { clearProps: 'transform,opacity,visibility' });
    });

    return () => media.revert();
  }, []);

  useEffect(() => {
    const shouldStayNative = window.matchMedia('(max-width: 760px), (prefers-reduced-motion: reduce)').matches;
    if (shouldStayNative) return undefined;

    const lenis = new Lenis({
      autoRaf: false,
      smoothWheel: true,
      wheelMultiplier: .58,
      lerp: .095,
      anchors: { duration: 1.05 },
      overscroll: false,
    });
    const updateScroll = () => ScrollTrigger.update();
    const tick = (time: number) => lenis.raf(time * 1000);

    lenisRef.current = lenis;
    lenis.on('scroll', updateScroll);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.off('scroll', updateScroll);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!plansOpen) return undefined;
    plansReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : plansTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPlansOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = document.querySelector<HTMLElement>('.wpa-plans__panel');
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
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
    lenisRef.current?.stop();
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    requestAnimationFrame(() => plansCloseRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
      lenisRef.current?.start();
      requestAnimationFrame(() => {
        if (plansReturnRef.current?.isConnected) plansReturnRef.current.focus();
        plansReturnRef.current = null;
      });
    };
  }, [plansOpen]);

  useEffect(() => {
    if (!menuOpen || !window.matchMedia('(max-width: 760px)').matches) return undefined;
    menuReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current;
    menuOverflowRef.current = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const menu = menuRef.current;
      if (!menu) return;
      const focusable = Array.from(menu.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
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
    lenisRef.current?.stop();
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('button,a[href]')?.focus());
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = menuOverflowRef.current || '';
      menuOverflowRef.current = null;
      lenisRef.current?.start();
      requestAnimationFrame(() => {
        if (menuReturnRef.current?.isConnected) menuReturnRef.current.focus();
        menuReturnRef.current = null;
      });
    };
  }, [menuOpen]);

  function submitTarget(event: FormEvent) {
    event.preventDefault();
    const query = target.trim() ? `?target=${encodeURIComponent(target.trim())}` : '';
    navigate(`/register${query}`);
  }

  return <div className="wpa-site" ref={rootRef}>
    <a className="wpa-skip" href="#main">Skip to content</a>
    <header className="wpa-nav">
      <a className="wpa-wordmark" href="#entry" aria-label="WebPageAnalyz home">WebPageAnalyz</a>
      <nav ref={menuRef} id="primary-navigation" className={menuOpen ? 'is-open' : ''} aria-label="Primary navigation">
        <button ref={plansTriggerRef} type="button" onClick={() => { setPlansOpen(true); setMenuOpen(false); }}>Plans</button>
        <a href="/login" onClick={() => setMenuOpen(false)}>Log in</a>
        <a className="wpa-nav__start" href="/register" onClick={() => setMenuOpen(false)}>Start</a>
      </nav>
      <button ref={menuButtonRef} className="wpa-menu" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X /> : <Menu />}</button>
    </header>

    <main id="main">
      <section className="wpa-scene wpa-scene--entry" id="entry" aria-labelledby="entry-title">
        <div className="wpa-scene-media" aria-hidden="true">
          <img src="/assets/scenes/entry-portal.webp" alt="" width="1672" height="941" fetchPriority="high" />
        </div>
        <div className="wpa-hero-copy">
          <span className="wpa-index">01 / ENTER</span>
          <h1 id="entry-title">Find what&apos;s missing.</h1>
          <form className="wpa-target-form" onSubmit={submitTarget}>
            <label className="sr-only" htmlFor="target-url">Website URL</label>
            <input id="target-url" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="yourwebsite.com" inputMode="url" autoComplete="url" />
            <button type="submit">Analyze <ArrowRight /></button>
          </form>
          <small>Analyze only sites you own or have permission to test. DNS verification unlocks ownership-only engines.</small>
        </div>
        <a className="wpa-scroll-cue" href="#scan"><span>Follow the signal</span><ArrowDown /></a>
      </section>

      <section className="wpa-scene wpa-scene--scan" id="scan" aria-labelledby="scan-title">
        <div className="wpa-scene-media" aria-hidden="true">
          <img src="/assets/scenes/options/black-option-02-white-well-2k.webp" alt="" width="2560" height="1440" decoding="async" />
        </div>
        <div className="wpa-scan-copy">
          <span className="wpa-index">02 / EXAMINE</span>
          <h2 id="scan-title">Every layer,<br />examined.</h2>
          <p>Automated and heuristic evidence, with incomplete and unavailable coverage kept visible.</p>
        </div>
        <a className="wpa-scroll-cue" href="#result"><span>See the priority</span><ArrowDown /></a>
      </section>

      <section className="wpa-scene wpa-scene--result" id="result" aria-labelledby="result-title">
        <div className="wpa-scene-media wpa-scene-media--result" aria-hidden="true">
          <img src="/assets/scenes/result-panel.webp" alt="" width="1672" height="941" decoding="async" />
        </div>
        <div className="wpa-result-copy">
          <span className="wpa-index">03 / DECIDE</span>
          <h2 id="result-title">Know what<br />to fix next.</h2>
          <a href="/register">Open your workspace <ArrowRight /></a>
        </div>
        <article className="wpa-result-panel" aria-label="Sample prioritized finding">
          <div className="wpa-result-panel__rail"><strong>Priority 01</strong><span>Highest-impact issue</span><a href="/register">View suggested remediation <ArrowRight /></a></div>
          <div className="wpa-result-panel__finding"><small>Performance Plus / measured</small><h3>Render-blocking JavaScript</h3><p>A measured finding with an automated suggestion to review before making changes.</p></div>
          <footer><span>/pricing</span><b>High</b><em>96% confidence</em></footer>
        </article>
      </section>
    </main>

    <footer className="wpa-footer"><a href="#entry">WebPageAnalyz</a><span>Evidence-led website analysis.</span><nav><a href="/privacy">Privacy</a><a href="/kvkk">KVKK</a><a href="/terms">Terms</a><a href="/acceptable-use">Acceptable use</a><a href="/refund">Refunds</a><a href="/subprocessors">Subprocessors</a></nav></footer>

    {plansOpen && <div className="wpa-plans" role="dialog" aria-modal="true" aria-labelledby="plans-title">
      <button className="wpa-plans__backdrop" aria-label="Close plans" onClick={() => setPlansOpen(false)} />
      <section className="wpa-plans__panel" data-lenis-prevent>
        <header className="wpa-plans__header">
          <div><span>WebPageAnalyz</span><h2 id="plans-title">Choose the depth.</h2></div>
          <button ref={plansCloseRef} aria-label="Close plans" onClick={() => setPlansOpen(false)}><X /></button>
        </header>
        <div className="wpa-plans__stage">
          {PUBLIC_PLANS.map((plan, index) => <article key={plan.id} className={`wpa-plan-aperture wpa-plan-aperture--${plan.id}`}>
            <div className="wpa-plan-aperture__frame" aria-hidden="true">{plan.id === 'studio' && <i />}</div>
            <div className="wpa-plan-aperture__content">
              <small>0{index + 1} / {plan.name}</small>
              <strong>{plan.id === 'free' ? '$0' : plan.id === 'enterprise' ? `From $${plan.priceUsd}` : `$${plan.priceUsd}`}<span>{plan.id === 'free' ? ' bounded access' : plan.id === 'enterprise' ? ' / month · invitation' : '/ month'}</span></strong>
              <p>{plan.description}</p>
              <ul>{(SAFE_PLAN_FEATURES[plan.id] || plan.features).map((feature) => <li key={feature}>{feature}</li>)}</ul>
              <a href={plan.id === 'enterprise' ? '/contact?plan=enterprise' : plan.id === 'free' ? '/register' : `/register?plan=${plan.id}`}>{plan.id === 'enterprise' ? 'Contact sales' : plan.id === 'free' ? 'Start Free' : `Choose ${plan.name}`}<ArrowRight /></a>
            </div>
          </article>)}
        </div>
      </section>
    </div>}
  </div>;
}
