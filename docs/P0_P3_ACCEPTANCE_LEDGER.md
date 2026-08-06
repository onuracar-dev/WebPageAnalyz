# WebPageAnalyz P0-P3 Acceptance Ledger

This file is the authoritative implementation and verification ledger for the
full product-hardening goal. A row may move to `PASS` only when the named code,
test, and runtime evidence has been inspected on the integrated checkout.

Status values:

- `PENDING`: implementation has not been accepted.
- `IN_PROGRESS`: an isolated task is implementing the item.
- `REVIEW`: implementation exists but has not passed independent integration review.
- `PASS`: integrated code and fresh evidence prove the acceptance criteria.
- `EXTERNAL_GATE`: repository work is complete but a named owner/account action remains.

Human/external boundaries: production deploy, live billing activation, provider
credentials, DNS ownership, approved legal text, and destructive data operations
are never inferred or executed without the owner's explicit action.

## Work packages

| Package | Scope | Status |
| --- | --- | --- |
| AUTHZ | Admin bootstrap, workspace RBAC, privileged admin operations, legacy API auth | IN_PROGRESS |
| BILLING | Free/trial model, Stripe lifecycle, catalog consistency | IN_PROGRESS |
| DEPLOY | Cloudflare SPA/API routing, live headers, container topology | IN_PROGRESS |
| LEGAL | Consent ledger, legal/feature release gates, customer data controls | PENDING |
| BROWSER-SEC | Browser/ZAP origin, method, egress, and isolation contracts | IN_PROGRESS |
| RESOURCE-SEC | Source/PDF workloads, quotas, queues, and worker isolation | PENDING |
| DURABILITY | pg-boss recovery, fan-out, PostgreSQL, readiness, backup/retention | IN_PROGRESS |
| REPORTS | Finding normalization, entitlements, reports, evidence, i18n | IN_PROGRESS |
| WEB-QUALITY | Type safety, portal reliability, accessibility, canonical UI | IN_PROGRESS |
| PLATFORM | CI, supply chain, observability, API contracts, release operations | IN_PROGRESS |
| FINAL-AUDIT | Integrated full-suite and requirement-by-requirement acceptance | PENDING |

## P0 release blockers

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P0-01 | Live SPA routes, API routing, and security headers work on the actual deployment path | Cloudflare config tests; route/header smoke; live verification after owner-approved deploy | PENDING |
| P0-02 | Public signup cannot claim the first super-admin | Negative auth tests; one-time bootstrap test; verified-email and re-auth invariants | IN_PROGRESS |
| P0-03 | A paid Signal plan is never granted without a valid paid/trial state | Plan-state unit/integration tests; new-account and cancellation tests | PENDING |
| P0-04 | Stripe lifecycle is fail-closed and duplicate checkout-safe | Test-mode lifecycle suite; idempotency/customer/subscription reuse tests | PENDING |
| P0-05 | Workspace RBAC protects every customer mutation | Route-policy matrix and owner/admin/analyst/viewer positive/negative tests | IN_PROGRESS |
| P0-06 | Only super-admin can mutate plans and global entitlements, with audit evidence | Route/service tests and immutable before/after audit assertions | IN_PROGRESS |
| P0-07 | Legacy analysis/AI routes are production-disabled or tenant-authenticated | Production config and endpoint denial tests; scoped-key tests when enabled | IN_PROGRESS |
| P0-08 | Untrusted browser execution is separated from API secrets and sandboxed | Container topology tests, capability/secret/egress assertions, hostile-page smoke | PENDING |
| P0-09 | Registration/checkout cannot accept placeholder policies | Consent version/hash storage tests and legal-release gate tests | PENDING |
| P0-10 | No paid plan advertises unavailable capabilities as production-ready | Entitlement-to-code/UI acceptance matrix and marketing snapshot checks | PENDING |

## P1 secure paid-beta requirements

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P1-01 | HTTPS ZAP scanning enforces the documented read-only method policy | Real HTTPS POST-denial regression and ZAP configuration assertion | PENDING |
| P1-02 | Core browser cannot follow unverified origins or send state-changing requests | Redirect, subresource, form, fetch, and WebSocket egress tests | PENDING |
| P1-03 | Source ZIP upload cannot exhaust API memory/disk/CPU | Streaming upload, queue, quota, archive-limit, and load tests | PENDING |
| P1-04 | OSV/source scanning runs in a secrets-free constrained worker | Container/env/network/resource assertions and malicious fixture tests | PENDING |
| P1-05 | PDF generation is queued, bounded, cancellable, and reusable | Concurrency, disconnect, timeout, and cache tests | PENDING |
| P1-06 | Rate limiting is shared and identity/cost aware | Multi-instance store tests; auth/user/workspace/API-key quota tests | PENDING |
| P1-07 | Webhook delivery uses an outbox with absolute timeout, retry, DLQ, and replay | Failure/retry/idempotency/delivery-history integration tests | PENDING |
| P1-08 | Public report links expire, revoke, audit access, and expose a safe DTO | Token lifecycle and data-minimization tests | PENDING |
| P1-09 | Target ownership expires and is revalidated | TTL, domain-transfer, and revocation tests | PENDING |
| P1-10 | External analyzers receive only consented and redacted data | Provider policy, query-redaction, opt-in, and audit tests | PENDING |
| P1-11 | Production dependencies have no unaccepted critical/high findings | Fresh registry audit and documented reachability/exception gate | PENDING |
| P1-12 | Structured logs recursively redact URLs, tokens, and sensitive context | Nested-object, URL-query, and error-context tests | PENDING |
| P1-13 | Worker crashes cannot strand scans or credits | Lease, heartbeat, reclaim, retry, and settlement tests | PENDING |
| P1-14 | Large scans fan out into resumable bounded page jobs | Page-job retry, cancellation, aggregate-progress, and deploy-restart tests | PENDING |
| P1-15 | Crawling is queued, abortable, origin-scoped, and standards-aware | Redirect/sitemap/robots/deadline/disconnect tests | PENDING |
| P1-16 | Concurrent ZAP scans cannot share mutable daemon session state | Parallel scan isolation and partial-coverage tests | PENDING |
| P1-17 | Production configuration fails closed | Schema tests for environment, origins, secrets, DB, auth, billing, and capabilities | PENDING |
| P1-18 | PostgreSQL, migrations, and pg-boss have real integration coverage | CI Postgres contract, migration-up, concurrency, and queue tests | PENDING |
| P1-19 | Health/readiness reports live DB, queue, storage, and worker state | Probe failure-mode tests and container health smoke | PENDING |
| P1-20 | Backup, restore, retention, export, and deletion are implemented | Restore drill; RPO/RTO evidence; lifecycle and deletion tests | PENDING |
| P1-21 | All analyzer findings enter one versioned lifecycle contract | Cross-analyzer normalization and dashboard/trend tests | PENDING |
| P1-22 | Entitlements control execution, cost, output, and UI | Module matrix tests from plan snapshot through rendered result | PENDING |
| P1-23 | Source Audit has a real queued lifecycle and visible results | Upload/status/progress/result/error/retry E2E | PENDING |
| P1-24 | Report lists and evidence are bounded, pageable, and retrievable | Cursor/detail/object-store/artifact-expiry tests | PENDING |
| P1-25 | Review/version/quota state transitions are atomic and idempotent | Concurrent claim/finalize/version/quota tests | PENDING |
| P1-26 | Unified website passes typecheck, lint, unit, component, and E2E gates | CI scripts with zero TypeScript diagnostics and critical-flow tests | PENDING |
| P1-27 | Only one canonical customer UI is built and published | Workflow/image assertions and legacy removal/archive evidence | PENDING |
| P1-28 | Scan progress is genuinely live and reconnect-safe | SSE/polling reconnect, stale-state, partial/failure E2E | PENDING |
| P1-29 | Reports are customer-grade, inspectable, shareable, comparable, and exportable | Visual snapshots, accessibility, data completeness, and export tests | PENDING |
| P1-30 | Report language and AI behavior are explicit, localized, and auditable | TR/EN snapshots; model/version/token/cost/provenance tests | PENDING |
| P1-31 | Every sold capability has backend enforcement and discoverable UI | Plan-by-plan acceptance suite | PENDING |
| P1-32 | Portal sections fail independently and large data sets stay responsive | Partial API failure, timeout/cancel, pagination, and virtualization tests | PENDING |
| P1-33 | Pricing, signup, checkout, and catalog use one fail-closed source of truth | Catalog/version/amount/currency/checkout copy tests | PENDING |
| P1-34 | Email verification, reset, and 2FA recovery are production flows | Token expiry/replay, verification, recovery-code, and provider-stub tests | PENDING |
| P1-35 | Keyboard, focus, target-size, and screen-reader blockers are zero | Automated Axe plus manual keyboard/AT acceptance matrix | PENDING |

## P2/P3 production maturity and product polish

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P2-01 | Database runtime and migration roles are least-privileged with timeouts/TLS | Role/permission/TLS/timeout integration checks | PENDING |
| P2-02 | Migrations are locked, checksummed, and rollout-safe | Concurrent migration, checksum drift, and compatibility tests | PENDING |
| P2-03 | Report/finding payloads are versioned and boundary-validated | Schema fixture and backward-compatibility tests | PENDING |
| P2-04 | Finding history persists beyond the latest two reports | Multi-version lifecycle event tests | PENDING |
| P2-05 | Stripe event ordering is event-ID safe and reconciliation-capable | Same-second/out-of-order/re-fetch tests | PENDING |
| P2-06 | OAuth/API keys support scope, expiry, rotation, revoke, and safe redirects | Credential lifecycle and host-allowlist tests | PENDING |
| P2-07 | Artifact cleanup is manifest-based and crash-safe | Startup janitor, TTL, orphan, and preservation tests | PENDING |
| P2-08 | Axe/Lighthouse/YellowLab expose device/rule/coverage metadata | Analyzer contract and partial-result tests | PENDING |
| P2-09 | Robots and sitemap processing follows explicit standards and coverage limits | Parser fixtures for groups, Allow, wildcards, indexes, and gzip | PENDING |
| P2-10 | Heuristic findings separate measurements, inferences, and confidence | Golden fixtures and false-positive feedback tests | PENDING |
| P2-11 | OSV severity/truncation and Windows ZIP canonicalization are correct | CVSS fixtures; limit flags; reserved-name/ADS/Unicode tests | PENDING |
| P2-12 | ZAP alert pagination and incomplete passive scans are explicit | Pagination, truncation, and incomplete-status tests | PENDING |
| P2-13 | Metrics/traces/SLOs reflect real platform state | OTel export tests and dashboard/query evidence | PENDING |
| P2-14 | Image publication depends on tested CI and security gates | Workflow dependency, smoke, SAST, secret, and image scan evidence | PENDING |
| P2-15 | Images are digest-pinned and releases include SBOM/provenance/signatures | Lock/pin policy and release artifact verification | PENDING |
| P2-16 | Website runtime is non-root with correct immutable cache policy | Container-user and cache-header smoke tests | PENDING |
| P2-17 | OpenAPI and generated clients define versioning, errors, and idempotency | Spec validation, generated-client compile, contract tests | PENDING |
| P2-18 | Quickstart, env, migration, and release versions are canonical | Clean-machine documentation smoke and version consistency check | PENDING |
| P2-19 | Portal state has real routes, deep links, history, and semantic 404 | Router E2E and direct-navigation tests | PENDING |
| P2-20 | Landmarks, popovers, tabs, charts, and 2FA meet interaction semantics | Keyboard/AT/component tests | PENDING |
| P2-21 | Journey/review/admin actions use validated forms, preview, and reason evidence | Form, diff, confirmation, autosave, and audit E2E | PENDING |
| P2-22 | CSS/JS/WebGL/font/sourcemap budgets are enforced | Build budgets, reduced-motion/save-data, and source-map checks | PENDING |
| P2-23 | Marketing sample is unmistakably synthetic and never calls live analysis | Network assertion, adjacent disclosure, and snapshot tests | PENDING |
| P2-24 | Pricing/support/legal footer communicates limits and trust paths | Content contract and responsive/accessibility snapshots | PENDING |
| P2-25 | SEO metadata, schema, robots, sitemap, and route indexing are correct | Built-asset and crawler smoke tests | PENDING |
| P2-26 | Trademark symbols are legally confirmed or removed | Owner/legal confirmation or repository removal evidence | PENDING |
| P2-27 | Funnel telemetry is privacy-aware and the product dogfoods its audits | Consent/no-tracking contract and CI self-audit budget | PENDING |
| P2-28 | Release matrix covers AT, zoom, mobile, reduced motion, exports, and load | Signed acceptance report with fresh runtime evidence | PENDING |

## Integrated completion gate

The goal is not complete until all of the following are true:

- Every row above is `PASS` or a narrowly defined `EXTERNAL_GATE` whose repository
  implementation and verification are already complete.
- Integrated backend, website, and retained legacy checks have zero failures.
- Production dependency audit has zero unaccepted critical/high findings.
- Real PostgreSQL/queue/provider-stub/browser/container/load/restore suites pass.
- Live verification is performed only after explicit owner authorization.
- The final handoff contains only account credentials, provider activation, DNS,
  approved legal copy, and production deployment steps that cannot be completed
  safely from the repository alone.
