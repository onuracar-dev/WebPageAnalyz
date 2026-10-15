import { TerrainBackdrop } from '../backdrop/TerrainBackdrop';

export function About() {
  return (
    <>
      <TerrainBackdrop scene="results" />
      <main className="page panel">
        <p className="eyebrow">About</p>
        <h1 className="page__title">What this is</h1>
        <p>
          WPA Lite is the open, account-free version of WebPage Analyzer. It runs only the engines that work from a public link:
          Google Lighthouse, axe, Yellow Lab Tools, and WebPage Analyzer’s own page, performance, GEO and visual UX checks.
        </p>
        <h2>What’s left out</h2>
        <p>
          The full product also crawls whole sites, runs passive security scans with OWASP ZAP and replays user journeys. Those
          require proving you own the domain (a DNS record), so they aren’t part of this demo.
        </p>
        <h2>Scan traffic</h2>
        <p>
          Requests to scanned sites come from this server. If you see unexpected traffic from WPA Lite, contact{' '}
          {/* TODO(onur): contact email */}
          <span className="mono">TODO: contact email</span>.
        </p>
        <h2>Source</h2>
        <p>
          The code is on <a href="https://github.com/onuracar-dev/WebPageAnalyz" rel="noreferrer">GitHub</a>. Background: Topography from React Bits.
        </p>
      </main>
    </>
  );
}
