import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';

export type IcebergBeat = {
  depth: string;
  issue: string;
  evidence: string;
  engine: string;
};

const beats: IcebergBeat[] = [
  { depth: '18m', issue: 'Browser errors during page load', evidence: 'Captured console message, URL and source location.', engine: 'WPA Page' },
  { depth: '42m', issue: 'A discovered route cannot be reached', evidence: 'Crawl trail, response status and referring page.', engine: 'WPA Site Crawler' },
  { depth: '67m', issue: 'Long main-thread tasks delay interaction', evidence: 'Long-task timeline and affected browser run.', engine: 'Performance Plus' },
  { depth: '93m', issue: 'Machine-readable entity data is missing or invalid', evidence: 'Structured-data extract and entity validation.', engine: 'Advanced GEO' },
  { depth: '118m', issue: 'Text is clipped or contrast is likely insufficient', evidence: 'Viewport capture and visual coordinates.', engine: 'Visual UX' },
  { depth: '146m', issue: 'A configured read-only user path fails', evidence: 'Step trace, selector and safe browser evidence.', engine: 'Journey Test' },
];

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function isAllowedPreviewUrl(value: string) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  const blockedIpv4 = ipv4 && (ipv4.some((part) => part > 255)
    || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168));
  const blockedName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
  const blockedIpv6 = host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && Boolean(host) && !blockedName && !blockedIpv4 && !blockedIpv6;
}

export default function IcebergExperience() {
  const rootRef = useRef<HTMLElement>(null);
  const frameRef = useRef(0);
  const depthMountedRef = useRef(false);
  const [url, setUrl] = useState('https://example.com');
  const [sampleUrl, setSampleUrl] = useState('https://example.com');
  const [sampleReady, setSampleReady] = useState(false);
  const [error, setError] = useState('');
  const [depthMounted, setDepthMounted] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const update = () => {
      frameRef.current = 0;
      const box = root.getBoundingClientRect();
      const progress = clamp(-box.top / Math.max(1, box.height - window.innerHeight));
      const desktopMotion = window.matchMedia('(min-width: 761px) and (prefers-reduced-motion: no-preference)').matches;
      root.style.setProperty('--ice-progress', String(progress));
      root.style.setProperty('--ice-beat', String(clamp((progress - .28) / .5)));
      root.style.setProperty('--ice-resolve', String(clamp((progress - .78) / .22)));
      if (!desktopMotion && depthMountedRef.current) {
        depthMountedRef.current = false;
        setDepthMounted(false);
      } else if (desktopMotion && progress > .1 && !depthMountedRef.current) {
        depthMountedRef.current = true;
        setDepthMounted(true);
      }
    };
    const schedule = () => { if (!frameRef.current) frameRef.current = window.requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => { window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); window.cancelAnimationFrame(frameRef.current); };
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (!isAllowedPreviewUrl(url)) throw new Error();
      setError(''); setSampleUrl(parsed.toString()); setSampleReady(true);
      document.querySelector('#sample-report')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { setError('Enter a complete public HTTP or HTTPS URL.'); }
  }

  let hostname = 'example.com';
  try { hostname = new URL(sampleUrl).hostname; } catch { /* guarded in submit */ }

  return <section className="ice-experience" id="top" ref={rootRef}>
    <div className="ice-experience__stage">
      <div className="ice-art" aria-hidden="true">
        <div className="ice-art__waterline" />
        <picture className="ice-art__surface">
          <source media="(max-width: 480px)" srcSet="/assets/iceberg/iceberg-surface-480.avif" type="image/avif" />
          <source media="(max-width: 480px)" srcSet="/assets/iceberg/iceberg-surface-480.webp" type="image/webp" />
          <source media="(max-width: 760px)" srcSet="/assets/iceberg/iceberg-surface-768.avif" type="image/avif" />
          <source media="(max-width: 760px)" srcSet="/assets/iceberg/iceberg-surface-768.webp" type="image/webp" />
          <source srcSet="/assets/iceberg/iceberg-surface-1024.avif" type="image/avif" />
          <img src="/assets/iceberg/iceberg-surface-1024.webp" width="1024" height="650" alt="" fetchPriority="high" decoding="async" />
        </picture>
        {depthMounted && <picture className="ice-art__depth">
          <source media="(max-width: 1024px)" srcSet="/assets/iceberg/iceberg-master-768.avif" type="image/avif" />
          <source media="(max-width: 1024px)" srcSet="/assets/iceberg/iceberg-master-768.webp" type="image/webp" />
          <source srcSet="/assets/iceberg/iceberg-master-1024.avif" type="image/avif" />
          <img src="/assets/iceberg/iceberg-master-1024.webp" width="1024" height="1536" alt="" loading="lazy" fetchPriority="low" decoding="async" />
        </picture>}
      </div>
      <svg className="ice-hairlines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M70 25H92M25 52H6M76 70H94M22 86H6" /></svg>

      <div className="ice-intro">
        <p>WEBPAGE ANALYZER</p><h1>The visible page is<br />not the whole site.</h1><span>Below the page are failures that do not announce themselves.</span>
        <form onSubmit={submit} noValidate><label htmlFor="iceberg-url">Public target URL</label><div><input id="iceberg-url" type="url" value={url} onChange={(event) => { setUrl(event.target.value); setError(''); }} autoComplete="url" spellCheck="false" aria-describedby="iceberg-error iceberg-disclosure" aria-invalid={Boolean(error)} /><button type="submit">See the sample <b>-&gt;</b></button></div><small id="iceberg-error" role="alert">{error}</small></form>
        <em id="iceberg-disclosure">Simulated preview. Public-link scans can start immediately; ownership-only engines require DNS verification.</em>
      </div>

      <p className="ice-water-copy">THE SURFACE ENDS HERE</p>
      <div className="ice-beats" aria-label="Examples of hidden website problems">
        {beats.map((beat, index) => <article key={beat.engine} style={{ '--beat-index': index } as CSSProperties}><span>{beat.depth}</span><div><h2>{beat.issue}</h2><p>{beat.evidence}</p><strong>Found by {beat.engine}</strong></div></article>)}
      </div>

      <article className="ice-resolution" id="sample-report">
        <p>{sampleReady ? 'SIMULATED FINDING / READY' : 'EXAMPLE FINDING'}</p><h2>{hostname}: browser error during page load</h2>
        <dl><div><dt>Location</dt><dd>/checkout / checkout.js:148:22</dd></div><div><dt>Evidence</dt><dd>TypeError: session is undefined</dd></div><div><dt>Remediation</dt><dd>Guard the session before checkout initialization.</dd></div></dl>
        <footer><span>Fingerprint <code>707ba7daf874</code></span><b>Re-scan: fingerprint disappears after the fix.</b></footer>
      </article>
    </div>
  </section>;
}
