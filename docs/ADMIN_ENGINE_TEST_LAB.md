# Admin Engine Test Lab

Engine Test Lab is an admin-only diagnostic surface for running the product's
runnable analyzers independently of customer workspaces, plans, entitlements,
and page credits. It does not add a bypass flag to the customer scan API.

## Access and workflow

Open `/admin`, complete the existing admin session, verified-email, 2FA, and
recent reauthentication checks, then choose **Engine Test Lab**.

1. Enter a public HTTP(S) target URL.
2. Select one engine, a custom set, or all engines.
3. Supply Journey JSON when Journey Test is selected.
4. Supply a source ZIP when OSV Scanner is selected.
5. Start the run and follow each engine independently.

The URL is checked by the existing SSRF-safe validator when the request is
accepted and again immediately before each engine starts. Journey steps remain
same-origin and read-only. ZAP runs only its passive baseline and is serialized
because the connected ZAP service has process-global session state.

## Runnable catalog

The catalog contains 12 runnable entries: Lighthouse, Axe, Yellow Lab,
Playwright Safe Browser, WPA Page, WPA Site Crawler, Performance Plus, Advanced
GEO, Visual UX, Journey Test, OWASP ZAP Passive Baseline, and OSV Scanner.

Expert Review and API/Webhook delivery are product workflows, not analyzers,
and therefore are not presented as runnable engines. Monitoring and White Label
rendering are not launch capabilities or public base-plan entitlements.

## Status and progress semantics

Each selected engine has its own `queued`, `preflight`, `running`, `completed`,
`failed`, `unavailable`, or `cancelled` state. Progress is explicitly marked
`stage_estimate`: the engine wrapper reports lifecycle stages and an elapsed-time
estimate capped at 90%; only a terminal result reaches 100%. It is not presented
as native analyzer telemetry.

Completed engines expose a sanitized finding count and detailed evidence. Up to
200 findings are retained per engine; the response reports `totalFindings` and
`truncated` explicitly when that bound is exceeded. Canonical findings retain
description, severity, category, confidence, page, source/version, structured
evidence, remediation and fingerprint instead of the former four-field sample.
Failed/unavailable engines expose a safe error code and redacted message while
other selected engines continue. A mixed outcome produces a `partial` parent run.

## Diagnostic evidence inventory

- Lighthouse converts failing desktop/mobile audits into detailed findings with
  score, display value, numeric value, explanation and bounded audit items.
- Axe retains help text, impact and bounded affected-node selectors, HTML and
  failure summaries. Yellow Lab retains its rule, message, score and penalty.
- WPA Page now retains bounded console messages and page errors, including safe
  source URL, line and column when Playwright reports them. Total error counts
  remain accurate even when the detailed list is capped at 20 entries.
- WPA Page, Performance Plus, Advanced GEO and Visual UX retain their normalized
  descriptions, evidence and remediation. Their desktop/mobile screenshots are
  linked to matching findings when an image remains within the 8 MB limit.
- Crawler, Journey, ZAP and OSV retain their existing normalized finding detail;
  engine coverage and journey step output remain available below the finding
  board. Playwright smoke continues to report browser coverage rather than
  inventing findings.

Finding detail is displayed in an accessible dialog with Where, What happened,
Evidence, Screenshot and How to fix sections. Screenshots are served only from
an authenticated admin route, must be declared by the engine result, use an
image extension allowlist and cannot resolve outside their run directory.
Queries, URL credentials, authorization/cookie/token/password/secret values and
local filesystem paths are removed from retained diagnostics.

## Runtime dependencies

- Lighthouse, Axe, WPA, Playwright, crawler, and advanced browser engines need a
  working Chromium installation.
- Yellow Lab needs its configured API/runtime.
- ZAP needs a configured ZAP URL and API key.
- OSV needs both the configured scanner executable, a constrained no-network
  isolation runner, and a ZIP input. The checked-in Compose topology does not
  claim OSV availability until that runner is supplied and proven.

The catalog shows whether ZAP and OSV are configured. A missing dependency is
reported as `unavailable`, never as a successful run.

## Execution and persistence boundary

The public API never executes Engine Lab analyzers. It forwards the existing
admin-only contract over a token-authenticated, container-internal control
channel to the isolated analysis worker, which owns Chromium, OSV and ZAP
access. The worker does not receive Better Auth, billing, email or AI-provider
secrets.

Engine Lab run state and its latest 50 snapshots currently live in analysis
worker memory. Restarting that worker clears this history and aborts active
runs; restarting only the API does not. This is suitable for a controlled
admin/demo lab, but durable production execution across worker restarts remains
unproven until the lab has PostgreSQL-backed jobs, leases, event replay, and
worker recovery. Customer scan persistence and billing behavior are unchanged.

The worker admits one Engine Lab run at a time and queues at most eight more;
per-run engine concurrency is a separate bound. Repeated start requests with
the same `Idempotency-Key` and payload coalesce inside the current worker
process, while reuse for a different payload fails closed. This idempotency is
not durable across worker restarts. Shutdown aborts queued work, waits a bounded
15 seconds for active work, and never treats a timeout as completed evidence.

The run-history endpoint returns bounded engine-state summaries. Full evidence
is fetched only from the selected run's detail endpoint, preventing a history
list from multiplying large evidence payloads.

Lab screenshots follow the same in-memory lifecycle. Non-image analyzer logs
are removed when normal artifact retention is disabled; screenshots are private
admin diagnostics and are not customer report artifacts. Terminal history
eviction removes its managed run directory, and a TTL janitor removes only old
generated `engine-lab/lab_<uuid>` directories; unrelated artifact paths are not
eligible for that cleanup.
