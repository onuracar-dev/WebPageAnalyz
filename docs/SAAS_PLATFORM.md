# WebPage Analyzer SaaS platform

## Runtime shape

The existing React and Express application now runs as a modular monolith with analyzer workers. PostgreSQL owns workspaces, the published plan catalog, projects, credit ledger, immutable scan manifests, reports, operator tasks, source inputs, subscriptions and audit-ready lifecycle data. pg-boss uses the same PostgreSQL deployment as a durable queue; the queue adapter can be replaced without changing scan contracts.

Run locally:

1. Copy `production.environment.template` to `.env` and set the required secrets.
2. Start PostgreSQL and set `backend/DATABASE_URL`.
3. Run `npm run db:migrate` in `backend`.
4. Run the backend and frontend development servers.

The disposable local overlay can apply numbered migrations before starting the API. Production uses the base and production TLS overlay together and follows [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md). Development can run without PostgreSQL using the in-memory adapter; production requires PostgreSQL and Better Auth sessions for workspace endpoints.

## Implemented product contracts

- Free is the default unpaid entitlement state (5 pages, 1 project, 1 seat, 7-day retention and 5 AI generations). Signal, Studio and contact/invite-only Enterprise / Expert remain the three public paid packages.
- A scan stores its plan, limits, entitlements, locale, URLs, devices and engine versions in a `ScanManifest` snapshot.
- Fragment/tracking normalization, project origin boundaries and desktop+mobile as one credit are enforced. Every requested automated engine must complete; unavailable or failed engines keep the scan/report explicitly partial and release the page credit. Settlement is idempotent.
- WPA runtime, SEO/GEO, design and backend-surface findings use the common measured/heuristic evidence contract and stable fingerprints.
- Full-site discovery uses robots, sitemap and sitemap-index documents, internal/rendered links and explicitly supplied additional URLs through the SSRF-safe boundary. It preserves route status, referrer/source, coverage and truncation, enforces exact authorized origins and never brute-forces unknown paths. Source ZIPs fail closed on traversal, symlink and bomb patterns; OSV results use a versioned customer-visible lifecycle.
- Reports support TR/EN manifests, JSON, printable HTML, server PDF, comparison, version state, reviewed publishing and hashed share links. AI output never advances a human-review state.
- Billing core is provider-neutral. Production Paddle events require the unmodified raw body, a valid `Paddle-Signature`, event-id idempotency and occurrence ordering before entitlements change. Stripe remains a disabled optional legacy adapter.
- AI remediation uses an isolated OpenRouter service with configurable primary/fallback models, strict schema validation, redaction, durable quota/cost records and finding/evidence/model cache keys. Resend delivery uses a separate isolated email service.

## Advanced analyzer boundaries

Performance Plus, advanced GEO, Visual UX, passive ZAP Baseline, OSV Source Audit and read-only Journey Test run automatically when their entitlement, dependency and required input are present. Advanced GEO is heuristic, Visual UX exposes bounded viewport/rectangle evidence, and neither is represented as human review or a visibility guarantee. ZAP is constrained to verified same-origin GET/HEAD/OPTIONS traffic and never runs an active scan. Source ZIPs are encrypted, revalidated, extracted into a temporary private directory, scanned without executing package scripts, then deleted. Expert Review remains a genuine human workflow: it is requested separately, every scoped finding receives an accept/reject/edit decision, and publication remains a distinct privileged action.

## Production gates still external to this repository

- Create and verify the Paddle, Resend, OpenRouter, DNS/TLS, VDS and external-monitor accounts/configuration listed in [`EXTERNAL_ACCOUNTS_AND_MANUAL_CONFIGURATION.md`](EXTERNAL_ACCOUNTS_AND_MANUAL_CONFIGURATION.md).
- Run the controlled public-target Lighthouse/Playwright/ZAP smoke suite and a PostgreSQL concurrency/load test on the target VDS.
- Run and retain evidence for the encrypted backup plus disposable restore rehearsal; configure host disk/memory/container alerts and the public `/healthz` monitor.
