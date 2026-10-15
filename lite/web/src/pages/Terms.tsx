import { TerrainBackdrop } from '../backdrop/TerrainBackdrop';

export function Terms() {
  return (
    <>
      <TerrainBackdrop scene="results" />
      <main className="page panel">
        <p className="eyebrow">Terms</p>
        <h1 className="page__title">Using WPA Lite</h1>
        <p>
          WPA Lite is a free, public demo of WebPage Analyzer. It loads a page you submit in a headless browser and runs automated
          audits against it. There are no accounts, no payments and no cookies.
        </p>
        <h2>Your responsibility</h2>
        <p>
          Only scan sites you own or are authorized to test. By ticking the consent box you confirm this and accept responsibility
          for the scan. The checks are passive (they load the page the way a visitor’s browser would), but repeated scans still
          create traffic on the target site.
        </p>
        <h2>What is sent where</h2>
        <ul>
          <li>The URL you submit is loaded by this server’s browser engines.</li>
          <li>
            The URL is also sent to <a href="https://yellowlab.tools" rel="noreferrer">Yellow Lab Tools</a>, a third-party
            service, which loads the page from its own servers.
          </li>
        </ul>
        <h2>What is stored</h2>
        <ul>
          <li>Scan results are kept in memory for 30 minutes, then deleted. They are lost if the server restarts.</li>
          <li>
            When you start a scan, the server logs the time, the consent version and a salted hash of your IP address. The raw IP
            address is not logged.
          </li>
        </ul>
        <h2>Limits</h2>
        <p>
          Scans are limited per IP address, per target site and per day so the service stays usable for everyone. Results are
          automated and can be incomplete or wrong. Treat them as a starting point, not an audit.
        </p>
        <p className="muted">Consent version 2026-10-15.</p>
      </main>
    </>
  );
}
