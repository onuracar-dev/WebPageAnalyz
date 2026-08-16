# Analysis capability contract

Customer analysis uses the executable `wpa.analysis-capabilities.v1` contract in
`backend/domain/analysis-contract.js`. Findings use `wpa.finding.v1`; scan
reports use `wpa.report.v2`.

| Engine | Required input | Entitlement | Devices | Evidence kind | Dependency/preflight | Coverage contract |
| --- | --- | --- | --- | --- | --- | --- |
| Lighthouse | verified public URL | Core Audit | desktop, mobile | measured | Chromium + Lighthouse/runtime | devices, categories, audits, truncation |
| Axe | verified public URL | Core Audit | desktop | measured | Chromium + Axe/runtime | violations, passes, incomplete, nodes, truncation |
| YellowLab | verified public URL | Core Audit | provider default | measured | YellowLab upstream/request | rules, score profile, truncation |
| WPA Page | verified public URL | Runtime, SEO, GEO, Design, Backend Surface | desktop, mobile | measured + heuristic | Chromium + Playwright/runtime | devices, snapshots, truncation |
| WPA Crawler | verified origin | Full Site Crawl | crawler | measured | SSRF-safe proxy/runtime | robots, sitemap, internal links, pages, referrers, truncation |
| Performance Plus | verified public URL | Performance Plus | desktop, mobile | measured | Chromium + Playwright/runtime | per-device metrics and truncation |
| Advanced GEO | verified public URL | advanced GEO | desktop | heuristic | Chromium + Playwright/runtime | entity and structured-data inference coverage |
| Visual UX | verified public URL | advanced Design | desktop, mobile | heuristic | Chromium + Playwright/runtime | viewport, sampled elements, safe selectors/rectangles, truncation |
| Journey Test | validated read-only journey | Journey Test | desktop | measured | Chromium + Playwright/runtime | declared/executed steps, failure location, blocked requests |
| ZAP Baseline | verified public origin | Passive Security | passive proxy | measured | configured ZAP/configuration | passive-only URLs, alerts, pagination, truncation |
| OSV Scanner | validated source ZIP | Source Audit | source | measured | OSV executable/configuration | manifests, files, database source, truncation |

Every requested automated engine must end as `completed`, `failed`,
`unavailable`, or `cancelled`. A requested engine that does not complete makes
the page, module, report, and scan incomplete. Useful partial findings remain in
the report, but a partial report is stored as `automated_incomplete` and the
scan is `partial`; it is never promoted to complete. Credits are consumed only
for a page whose complete requested engine set completed, and settlement is
idempotent.

Full-site discovery records status, discovery source, referrer, robots/sitemap
coverage, unreachable routes, and explicit truncation. These records and
crawler findings are part of the same versioned report lifecycle.

Visual evidence contains viewport and bounded element/rectangle diagnostics.
Temporary screenshots and filesystem paths are not customer report references.
When analyzer artifacts are deleted, the report remains self-contained.

Journey Test accepts only same-origin GET/HEAD/OPTIONS traffic and requires a
real path/action plus an assertion. A body-visible smoke alone is rejected and
is not represented as a user journey. Advanced GEO remains heuristic and makes
no ranking or AI-visibility guarantee. ZAP is passive baseline only.

Scan execution uses page records with bounded attempts, expiring leases,
idempotent credit settlement, and single report publication. Progress is
available through cursor-safe polling and bounded SSE replay; the latest 200
events are retained per scan.

Source Audit returns a versioned customer result for completed, failed, or
unavailable execution. Raw ZIP plaintext and extracted files are cleaned after
the bounded run. Missing OSV execution is `unavailable` with a failure code and
remediation, never a successful empty result.
