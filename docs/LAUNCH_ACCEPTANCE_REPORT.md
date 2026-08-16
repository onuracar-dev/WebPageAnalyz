# WebPageAnalyzer Production Launch Acceptance Report

Date: 2026-08-15
Branch: codex/webpageanalyz-p0-p3-hardening
Baseline HEAD: 44b5a15e4a178d467b37b136074a6cc8281ea99d
Evidence level: local source, deterministic fixtures, real local Chrome, disposable PostgreSQL 17, Docker image builds and a bounded local Compose smoke.

## Verdict

**NOT LAUNCH READY.**

The launch-hardening implementation has no known P0, P1, or P2 executable code/test gap in the final reviewed tree. The canonical backend suite is 321/321 with zero skips, the website browser suite has zero failures, all six application images build, and the provider-free commercial/security contracts are executable.

This is not a production launch claim. Three Definition of Done items remain live-unproven: a real Paddle purchase, real Resend verification/reset delivery, and stable execution on the target Ubuntu VDS. Operator identity/legal facts, real provider accounts, DNS/TLS/firewall/monitoring, off-site production backups, and a clean reviewed release commit are also absent. Revenue must remain disabled and the product must not be labelled LAUNCH READY / FEATURE FROZEN until those gates close.

## Status vocabulary

| Status | Meaning |
|---|---|
| TESTED_LOCAL | Executable evidence passed locally, with fixtures, real local Chrome, or disposable infrastructure. It is not live-provider proof. |
| IMPLEMENTED | Required document/checklist/configuration authority exists, but is not itself a runtime proof. |
| LIVE_UNPROVEN | Code and local contract exist, but the real provider, host, account, domain, or human review was not exercised. |
| BLOCKED | Completion requires new user authority, credentials, external approval, spending, deployment, or production state. |
| NOT_APPLICABLE | The item does not apply. No item in this report uses this status. |

## Canonical evidence summary

| Harness | Total | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| Backend integrated: disposable PG17, runtime/worker/maintenance roles, pg-boss, real Chrome | 321 | 321 | 0 | 0 |
| Website Playwright, serial across Chromium/mobile/compact/reduced-motion profiles | 172 | 89 | 0 | 83 |
| Legacy development frontend unit tests | 4 | 4 | 0 | 0 |
| Arithmetic across the three independent harnesses | 497 | 414 | 0 | 83 |

The 83 website skips are intentional profile-specific selections; they are not failures and are not provider/production proof. The following are separate, overlapping gates and are not added to the 497 count: backend syntax/lint PASS; database checksum check 31 migrations PASS; synthetic AI evaluation 24/24 PASS with human review still required; website typecheck/build/plan parity PASS; cutaway visual check 4/4 contexts with zero browser faults; legacy frontend lint/build PASS; six Docker image builds PASS; base+local and base+production Compose config PASS.

## Requirement-by-requirement status: sections 0–45

Final classification across the 55 numbered/sub-numbered rows below: 37 TESTED_LOCAL, 15 LIVE_UNPROVEN, 2 IMPLEMENTED, 1 BLOCKED.

| Item | Status | What was done | What was not done |
|---|---|---|---|
| 0. Verify the existing system first | TESTED_LOCAL | Repository, branch, architecture, current plans, security boundaries, test baselines, and dirty working tree were inventoried before hardening. | There is no clean, committed, reviewed release SHA yet. |
| 1. Create a real Free plan | TESTED_LOCAL | Free is the default real plan: $0, 5 pages/month, 1 project, 1 seat, 7-day retention, basic modules, 5 AI generations. A verified production session creates a stable Free workspace. Paid modules fail closed. Terminal billing states return to Free; past_due preserves grace. | No live signup was performed on a public deployment. |
| 2. Preserve paid plans and add AI entitlement | TESTED_LOCAL | Signal $29/100 AI, Studio $99/1000 AI, Enterprise $349/5000 AI remain canonical; API, website, store, and migration 031 agree. AI usage/cache are workspace/model/prompt/evidence scoped. | No live paid entitlement was purchased. |
| 3. Validate Enterprise / Expert promise | TESTED_LOCAL | Enterprise is contact/invite-only. Expert Review is a separately assignable executable module with claim, finding decision, roadmap, finalize, and publish lifecycle; it is not plan-name-bound. | No human reviewer capacity or response-time promise is made or proven. |
| 4. Convert Stripe coupling to BillingProvider | TESTED_LOCAL | Provider-neutral contract and factory select Paddle for launch; legacy Stripe remains an optional adapter with the same port. | Stripe was not used as the launch provider. |
| 5. Paddle production integration | LIVE_UNPROVEN | Checkout, portal, cancel, raw-body HMAC, replay window, product/price mapping, payments/refunds, ordered/idempotent ledger, grace/Free transitions, upgrade/downgrade, and reconciliation pass locally. | No approved Paddle seller/domain/catalog, sandbox end-to-end purchase, or live webhook/portal/refund evidence. |
| 6. Paid checkout confirmation | TESTED_LOCAL | Checkout shows plan, price, USD/month, recurring charge, cancellation, Merchant of Record/tax, Terms and refund links; explicit recurring/Terms/refund acceptance is persisted before provider invocation. | Real Paddle-hosted checkout copy was not inspected. |
| 7. Redeem / Founder Codes | TESTED_LOCAL | Salted hashes, hint-only admin DTO, dates, global/workspace limits, double-use prevention, disable/revoke, temporary plan, feature overrides, credits, audit, expiry, and rate limits are implemented. | No real founder-code campaign was issued. |
| 8. Admin Operations v2 | TESTED_LOCAL | Bounded user/workspace/plan/usage/scan/ticket views; ban/unban and suspend/unsuspend; verified email, role, 2FA, recent reauth, trusted origin, reason, confirm, requestId, rate limit, and secret-safe DTO enforcement. | No production admin account was bootstrapped. |
| 9. Manual credits / entitlement overrides | TESTED_LOCAL | Positive/negative page and AI credits, temporary plan, executable feature grant/revoke, expiry, billing preservation, shared allowlist, and actor/target/before/after/reason/request/time audit. UI keeps credit, temporary plan, and feature override separate. | No live operator grant was made. |
| 10. Admin support capabilities | TESTED_LOCAL | Ticket list/context, reply, internal note, close/reopen, assignment, priority, pagination/timeline, customer filtering of internal notes, notifications, and atomic audit. No impersonation surface exists. | No real support mailbox/provider delivery or production support process exercised. |
| 11. Job / scan operations | TESTED_LOCAL | Admin scan inspection, cancel, safe/idempotent retry, reservation release/reuse, failure context, retry eligibility, reason/confirm/requestId audit. | No stuck production job was recovered. |
| 12. AI provider migration — OpenRouter | TESTED_LOCAL | Provider-neutral AI interface, isolated AI service/client, OpenRouter adapter, no production hard-coded model, and no OpenRouter key in API/worker. Gemini is explicit optional legacy/dev only. | No live OpenRouter call was authorized. |
| 12.1 Attribution headers | TESTED_LOCAL | OPENROUTER_SITE_URL maps to HTTP-Referer and OPENROUTER_APP_NAME maps to X-OpenRouter-Title in the isolated server-side service. | Live OpenRouter attribution display was not inspected. |
| 12.2 Configurable model selection | LIVE_UNPROVEN | Production has no model default; primary/fallback are required configuration and evaluation metadata is recorded. | No live model metadata snapshot, candidate comparison, human approval, or final model/fallback selection. |
| 12.3 OpenRouter free models | TESTED_LOCAL | No invalid :model:free syntax or hard-coded free production dependency; openrouter/free is documented only as deliberately excluded. Specific free models require official metadata and evaluation. | No free model was selected for production. |
| 12.4 Model evaluation harness | LIVE_UNPROVEN | 24 anonymized fixtures run deterministically and capture schema, usefulness, correctness, hallucination, latency, token, cost, actual model/provider fields. Synthetic run is 24/24. | Same fixtures were not run against paid/live candidates; human review is not complete. |
| 12.5 Model fallback | TESTED_LOCAL | One logical request sends an ordered, de-duplicated models chain; it does not call models in parallel; actual model/provider and fallback metadata are stored. | Live fallback routing was not triggered. |
| 12.6 AI cost controls | TESTED_LOCAL | Monthly plan quota, customer/global rate limits, concurrency, byte/token-independent input bound, output bound, timeout, cache, soft/hard daily cost and fail-soft behavior. | Live billing/usage reconciliation against OpenRouter account data was not performed. |
| 13. AI egress security boundary | LIVE_UNPROVEN | OpenRouter credential exists only in the AI service; internal bearer auth, request/response bounds, timeout, rate/concurrency limits, redaction, and Compose network separation are tested. | Compose networks are not hostname-aware firewall proof. VDS egress/DOCKER-USER/provider rules were not applied. |
| 14. Structured AI output | TESTED_LOCAL | Strict JSON Schema, additionalProperties false, require_parameters, validation/normalization, bounded retry, malformed-output rejection, and no invalid output to UI. | Live selected-model structured-output support is unproven. |
| 14.1 AI output semantics | TESTED_LOCAL | Customer output is explicitly an AI-generated suggestion, not a verified fix, certification, guarantee, or compliance determination. | No human production content review. |
| 15. AI data minimization | TESTED_LOCAL | Only minimized finding/evidence is sent; HTML, repository data, auth headers, cookies, secrets, credentials, email and sensitive query values are removed/redacted. | Live provider-side logs were not inspected. |
| 15.1 OpenRouter privacy / subprocessors | LIVE_UNPROVEN | data_collection=deny, ZDR default false/request-only, and variable underlying routing are represented honestly in public processor text. | Actual route/provider/location/retention and account privacy settings are unknown until live configuration. |
| 15.2 Final OpenRouter principle | TESTED_LOCAL | Architecture is application → AIProvider → OpenRouter adapter → configured model/fallback; business logic does not depend on a model name. | Production model decision remains open. |
| 16. Transactional email — Resend | LIVE_UNPROVEN | Isolated Resend service, Better Auth verification/reset transport, support/security/subscription templates, HTTPS host allowlist, timeout, rate/concurrency, internal auth and failure handling pass locally. | No verified domain, SPF/DKIM, real inbox delivery, bounce or complaint evidence. |
| 17. Website discovery / crawler | TESTED_LOCAL | Root, robots sitemap, sitemap.xml, internal links, passive rendered anchors, manual/additional URLs, deterministic bounds, normalization/dedupe and provenance. No random path guessing. | No first authorized production target crawl. |
| 18. Sitemap index support | TESTED_LOCAL | Index recursion, cycles, depth/global URL budgets, gzip and decompression limits, and provenance pass. | No production oversized third-party sitemap observed. |
| 19. Custom scope / additional URLs | TESTED_LOCAL | Additive manual URLs, explicit replacement mode, URL/scheme/origin/SSRF validation, allowed subdomains, UI request contract and coverage snapshot. | No real customer-defined subdomain scope. |
| 20. Subdomain behavior | TESTED_LOCAL | Only exact, user-declared owned origins/subdomains are accepted; no enumeration/brute force; unauthorized off-origin URLs fail closed. | No live DNS ownership exercise. |
| 21. Target Authorization | TESTED_LOCAL | Versioned authorization basis, user/project/workspace/origin/requestId/timestamp records and audit; DNS and SSRF protections remain. | Real operator/customer authorization evidence not collected. |
| 22. Legal document set | LIVE_UNPROVEN | Terms, Privacy, KVKK, AUP, Refund/Cancellation, and Subprocessors routes are public locally; no analytics/advertising consent is invented. | Mandatory real operator/hosting facts and production publication are missing. |
| 23. Terms of Service | LIVE_UNPROVEN | Text follows actual plans, billing, AI semantics, crawler authorization, cancellation and dispute behavior; missing facts fail closed. | Operator identity/address/effective date and professional legal review missing. |
| 24. Privacy Notice | LIVE_UNPROVEN | Real data flow, Paddle/Resend/OpenRouter/YellowLab, retention, export/deletion, rights/contact behavior are described. | Actual host/edge/region/DPA facts and legal review missing. |
| 25. KVKK notice | LIVE_UNPROVEN | Separate KVKK notice; no fake privacy consent. | Real data controller/contact/transfer facts and legal review missing. |
| 26. Signup legal UX | TESTED_LOCAL | Terms+AUP are required checkboxes; Privacy/KVKK are notices; active versions persist and gate production workspace access. | Real public signup flow not run. |
| 27. Acceptable Use Policy | TESTED_LOCAL | Authorization, abuse, crawler/source/AI limits and prohibited testing are represented. | External legal review missing. |
| 28. Refund & Cancellation Policy | LIVE_UNPROVEN | Current-period cancellation, mandatory-rights and Paddle Merchant-of-Record-compatible wording and portal UX exist. | Real Paddle settings and operator/legal approval missing. |
| 29. Subprocessors | LIVE_UNPROVEN | Configured host, Paddle, Resend, OpenRouter routing and YellowLab are derived from actual code; edge provider appears only when configured. | Real VDS/region/DPA and optional edge facts missing. |
| 30. Legal versioning | TESTED_LOCAL | Version 1.0 documents and current-version acceptance gate; migration 029 aligns acceptable_use DB value. | Future version rollout not exercised. |
| 31. Public legal wording status | TESTED_LOCAL | Public UI contains no DRAFT, counsel-reviewed, fake company, or placeholder compliance claim; mandatory facts fail closed. | Final operator/legal approval missing. |
| 32. Product claim consistency | TESTED_LOCAL | API, website, database and tests agree; monitoring/white-label unsupported promises removed; Expert Review remains admin-assignable. | No live sales/marketing review. |
| 33. Admin audit log | TESTED_LOCAL | Central actor/target/action/before/after/reason/request/time, secret sanitation, immutable PG trigger, transactional rollback, publish/finalize idempotency and fail-closed audit. | Engine Lab run state is process-memory while audit is PG, so cross-system ACID is impossible; cancel is audit-first and terminal audit failure is logged. |
| 34. Rate limit / abuse | TESTED_LOCAL | Separate auth/login/reset/general/admin/scan/AI/reauth/support/redeem/admin-mutation budgets, plus plan quota. | Live proxy/IP behavior and traffic tuning not exercised. |
| 35. Production deployment target | LIVE_UNPROVEN | Ubuntu 24.04 single-VDS target, 10 vCPU/12 GB/200 GB baseline, MAX_CONCURRENT_ANALYSES=1, service/network/secret boundaries and exact runbook exist. | No real VDS, firewall, DNS/TLS, deploy, soak or stability evidence. Docker Desktop rejects the worker namespace sandbox fail-closed. |
| 36. PostgreSQL / backup | LIVE_UNPROVEN | TLS/role-separated PG configuration, 31 checksum migrations, encrypted age dump/checksum and disposable restore-check were exercised. | No scheduled encrypted off-VDS production backup, pre-migration real backup, age/disk alert, or production restore drill. |
| 37. Observability | LIVE_UNPROVEN | Safe health/ready/status, structured logs, worker heartbeat/liveness and truthful degraded state pass locally. | No external uptime/TLS/disk/memory/restart/queue/backup-age monitors or incident owner. |
| 38. External accounts checklist | IMPLEMENTED | Exact unchecked account/manual configuration list exists in EXTERNAL_ACCOUNTS_AND_MANUAL_CONFIGURATION.md. | Every real account/configuration item remains operator work. |
| 39. Environment checklist | TESTED_LOCAL | Required/optional/secret/source/rotation/consumer matrix, Compose ownership, production fail-closed behavior, and example env are present. | No real secret values were created or installed. |
| 40. Tests | TESTED_LOCAL | Exact 67 minimum scenarios have direct executable evidence; canonical suites have zero failures. | Live provider/deployment checks are not represented as test PASS. |
| 41. Do not regress security | TESTED_LOCAL | SSRF/DNS rebinding/safe proxy/origin/secret/workspace/admin 2FA/idempotency/source limits/worker isolation regressions pass. | VDS firewall/runtime hardening remains live-unproven. |
| 42. No feature creep | TESTED_LOCAL | Work stayed within launch hardening, product truth, required test gaps and existing-surface audit. No CRM, analytics, impersonation or unrelated product feature was added. | Nothing deferred was implemented as a new feature. |
| 43. Final production gate | IMPLEMENTED | This document contains A–L, exact section matrix, 67-scenario matrix and DoD matrix. | Live blockers in section I remain open. |
| 44. Definition of Done | BLOCKED | 32 of 35 items have local evidence. | Real Paddle purchase, production Resend delivery and real VDS stability are unproven; therefore the global DoD is not met. |
| 45. Final OpenRouter consistency | TESTED_LOCAL | No Groq/GROQ_ or invalid :model:free residue; Gemini is explicit optional legacy/dev; OpenRouter attribution, fallback, schema and config-driven model selection are enforced. | Live OpenRouter account/model/routing proof missing. |

## Section 40: exact minimum-scenario matrix — 67/67 TESTED_LOCAL

These 67 rows are requirement coverage, not 67 additional test cases to add to the canonical totals. Some scenarios share fixtures or test files. `TESTED_LOCAL` never means a live Paddle, Resend, OpenRouter, or VDS pass.

### Plans — 8/8

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| P1 | New signup receives Free | `backend/test/free-entitlement.test.js`: verified production-style session accepts legal terms, receives the stable personal workspace, and both API/store show `free`. | PASS |
| P2 | Free cannot use a paid feature | `backend/test/free-entitlement.test.js`: paid module request returns `MODULE_NOT_ENTITLED` with no side effect. | PASS |
| P3 | Signal payment grants Signal | `backend/test/launch-minimum-contracts.test.js`: signed raw Paddle `pri_signal` event maps to Signal subscription/effective entitlement. | PASS |
| P4 | Studio payment grants Studio | `backend/test/paddle-provider.test.js`: signed Studio price event maps active/trialing state to Studio. | PASS |
| P5 | Enterprise is configured as sales/contact mode | `backend/test/launch-commercial-core.test.js`: canonical Enterprise sales mode is exactly `contact`. | PASS |
| P6 | Cancellation preserves grace and then returns to Free | `backend/test/paddle-provider.test.js` and `backend/test/launch-commercial-core.test.js`: past_due/scheduled cancellation preserves access; terminal cancellation returns to Free. | PASS |
| P7 | Duplicate payment webhook is idempotent | `backend/test/paddle-provider.test.js`: the same signed `transaction.completed` event is replayed through the real Memory store; one ledger entry and one payment reconciliation remain, with no grant duplication. | PASS |
| P8 | Temporary plan override does not mutate billing | `backend/test/redeem-core.test.js`: effective Studio override can coexist with the unchanged paid Signal subscription/base workspace plan. | PASS |

### Redeem — 8/8

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| R1 | Valid code redeems | `backend/test/redeem-core.test.js`. | PASS |
| R2 | Expired code fails without side effects | `backend/test/launch-minimum-contracts.test.js`; `REDEEM_CODE_EXPIRED`, no grant. | PASS |
| R3 | Global maximum is enforced | `backend/test/redeem-core.test.js`. | PASS |
| R4 | Per-workspace maximum is enforced | `backend/test/redeem-core.test.js`. | PASS |
| R5 | Double redemption is blocked | `backend/test/redeem-core.test.js`. | PASS |
| R6 | Disabled or revoked code fails | `backend/test/redeem-core.test.js`. | PASS |
| R7 | Temporary plan expires automatically | `backend/test/redeem-core.test.js`. | PASS |
| R8 | Bonus-credit expiry semantics are deterministic | `backend/test/redeem-core.test.js`: adjustment is effective before expiry and base totals return after expiry. | PASS |

### Admin — 10/10

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| A1 | Ban blocks protected access | `backend/test/admin-operations-core.test.js`. | PASS |
| A2 | Unban restores access and is audited | `backend/test/admin-operations-core.test.js`: active access plus `user.unbanned` reason/requestId. | PASS |
| A3 | Suspend and unsuspend block/restore expected operations | `backend/test/admin-operations-core.test.js`. | PASS |
| A4 | Unauthorized role cannot mutate | `backend/test/security-regression.test.js`: operator plan mutation is 403. | PASS |
| A5 | Step-up authentication is required | `backend/test/security-regression.test.js` and `backend/test/admin-audit-api.test.js`. | PASS |
| A6 | Positive credit grant is logged | `backend/test/admin-operations-core.test.js`: `credits.granted`, actor, reason, requestId and +25 page delta. | PASS |
| A7 | Credit revoke is logged | `backend/test/launch-minimum-contracts.test.js`: `credits.revoked` for page and AI credits. | PASS |
| A8 | Entitlement override expires | `backend/test/admin-operations-core.test.js`. | PASS |
| A9 | Successful support actions are logged | `backend/test/support.test.js`: internal note, admin reply and admin update preserve actor/reason/requestId. | PASS |
| A10 | Secrets are absent from admin API DTOs | `backend/test/launch-minimum-contracts.test.js`: authenticated DTO sentinel and sensitive-key scan. | PASS |

### AI — 12/12

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| AI1 | Plan quota is enforced | `backend/test/launch-ai-quota.test.js`. | PASS |
| AI2 | Per-request/service rate limiting works | `backend/test/ai-service-http.test.js`. | PASS |
| AI3 | Cache hit is deterministic and quota-safe | `backend/test/launch-api-wiring.test.js`. | PASS |
| AI4 | Strict JSON Schema is sent and validated | `backend/test/openrouter-provider.test.js`. | PASS |
| AI5 | Malformed response is rejected after bounded retry | `backend/test/openrouter-provider.test.js`. | PASS |
| AI6 | Provider timeout is handled | `backend/test/openrouter-provider.test.js`: real AbortSignal deadline becomes `AI_PROVIDER_TIMEOUT`/504. | PASS |
| AI7 | Ordered fallback is sent in one logical request | `backend/test/openrouter-provider.test.js`: ordered `models`, actual fallback metadata. | PASS |
| AI8 | Actual model/provider is recorded | `backend/test/openrouter-provider.test.js` and `backend/test/launch-api-wiring.test.js`. | PASS |
| AI9 | Hard daily cost stops AI before provider/reservation | `backend/test/launch-api-wiring.test.js`: 503, zero provider calls, zero reservation. | PASS |
| AI10 | Forbidden application secrets are not forwarded | `backend/test/openrouter-provider.test.js`: minimized/redacted request body. | PASS |
| AI11 | OpenRouter API key is not leaked | `backend/test/openrouter-provider.test.js`: credential appears only in Authorization, not body/result/metadata. | PASS |
| AI12 | AI failure does not fail the core scan | `backend/test/launch-api-wiring.test.js`: seeded completed scan/report remain deep-equal after timeout; failed usage releases quota. | PASS |

### Crawler — 11/11

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| C1 | `robots.txt` sitemap discovery | `backend/test/crawler.test.js`. | PASS |
| C2 | Conventional `/sitemap.xml` discovery | `backend/test/crawler.test.js`. | PASS |
| C3 | Sitemap-index recursion | `backend/test/crawler.test.js`. | PASS |
| C4 | Internal-link discovery | `backend/test/crawler.test.js`. | PASS |
| C5 | Rendered DOM anchor discovery | `backend/test/crawler.test.js` and real-Chrome `backend/test/wpa-page.test.js`. | PASS |
| C6 | Manual/additional URL discovery | `backend/test/platform-service.test.js` and website E2E. | PASS |
| C7 | Duplicate normalization/deduplication | `backend/test/crawler.test.js` and `backend/test/wpa-page.test.js`. | PASS |
| C8 | Unauthorized off-origin URL is rejected | `backend/test/platform-service.test.js`. | PASS |
| C9 | Explicit authorized subdomain is scoped exactly | `backend/test/platform-service.test.js`. | PASS |
| C10 | Crawler trap is bounded | `backend/test/crawler.test.js`. | PASS |
| C11 | Oversized sitemap/decompression is bounded | `backend/test/crawler.test.js`. | PASS |

### Legal — 5/5

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| L1 | Terms and AUP acceptance are required and stored | `backend/test/app.test.js` and `backend/test/launch-data-contract.test.js`. | PASS |
| L2 | Acceptance versions are stored | Same tests plus migration 027. | PASS |
| L3 | Privacy/KVKK do not use fake consent | `backend/test/legal-contract.test.js` and website signup E2E. | PASS |
| L4 | Target authorization is stored | `backend/test/launch-data-contract.test.js` and platform/browser target flow. | PASS |
| L5 | Paid checkout Terms/refund acceptance is persisted before provider call | `backend/test/launch-api-wiring.test.js` and migration 027. | PASS |

### Email — 5/5

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| E1 | Verification email contract | `backend/test/resend-provider.test.js` and `backend/test/resend-email-service.test.js`. | PASS |
| E2 | Password reset email contract | `backend/test/resend-provider.test.js`. | PASS |
| E3 | Support notification contract | `backend/test/resend-provider.test.js` and `backend/test/support.test.js`. | PASS |
| E4 | Provider failure/timeout is handled | `backend/test/support.test.js` and `backend/test/resend-provider.test.js`. | PASS |
| E5 | Disabled/misconfigured production email is detected | `backend/test/email-transport.test.js` and `backend/test/resend-email-service.test.js`. | PASS |

### Paddle — 8/8

| ID | Scenario | Evidence | Result |
|---|---|---|---|
| PD1 | Raw signature, timestamp and replay validation | `backend/test/paddle-signature.test.js`. | PASS |
| PD2 | Product/price maps to plan | `backend/test/launch-minimum-contracts.test.js` and `backend/test/paddle-provider.test.js`. | PASS |
| PD3 | Duplicate event is idempotent | `backend/test/launch-commercial-core.test.js` and exact payment replay above. | PASS |
| PD4 | Out-of-order event is ignored safely | `backend/test/launch-commercial-core.test.js`. | PASS |
| PD5 | Cancellation and portal flows normalize correctly | `backend/test/paddle-provider.test.js`. | PASS |
| PD6 | Upgrade and downgrade work on the same subscription | `backend/test/paddle-provider.test.js`: Signal → Studio → Signal. | PASS |
| PD7 | Provider reconciliation fetches, normalizes and applies entitlement | `backend/test/paddle-provider.test.js`: real Memory-store application. | PASS |
| PD8 | Unknown product/price fails before store mutation | `backend/test/launch-minimum-contracts.test.js`: `BILLING_PRODUCT_UNMAPPED`, zero side effects. | PASS |

Arithmetic: 8 + 8 + 10 + 12 + 11 + 5 + 5 + 8 = **67**; local pass 67, fail 0. Live providers are still unproven.

## Definition of Done — 1–35

| DoD | Status | Evidence / remaining boundary |
|---:|---|---|
| 1 | TESTED_LOCAL | Signup UI/API and verified-session contract pass in browser/API tests. |
| 2 | TESTED_LOCAL | A new stable personal workspace is a real Free workspace. |
| 3 | TESTED_LOCAL | Verification template, Better Auth transport and `/verify-email` browser contract pass; actual inbox delivery is separately unproven at item 30. |
| 4 | TESTED_LOCAL | Terms+AUP acceptance persists and current versions gate workspace access. |
| 5 | TESTED_LOCAL | Project creation requires explicit target authorization. |
| 6 | TESTED_LOCAL | Authorization version, basis, actor, origin, requestId and timestamp persist/audit. |
| 7 | TESTED_LOCAL | Free scan fits the monthly credit contract and consumes one page credit. |
| 8 | TESTED_LOCAL | Customer AI-remediation endpoint works with strict suggestion semantics. |
| 9 | TESTED_LOCAL | AI quota reservation, settlement, failure release and cache behavior pass. |
| 10 | TESTED_LOCAL | AI timeout leaves the completed core scan/report unchanged. |
| 11 | TESTED_LOCAL | Primary model is required environment/config; there is no production model default. |
| 12 | TESTED_LOCAL | Ordered fallback configuration and request metadata pass. |
| 13 | LIVE_UNPROVEN | No real Paddle checkout/purchase was made. Credentials and approved seller/domain/catalog are absent. |
| 14 | TESTED_LOCAL | Signed raw Paddle webhook changes entitlement atomically. |
| 15 | TESTED_LOCAL | Duplicate signed payment/event does not duplicate ledger, audit or entitlement. |
| 16 | TESTED_LOCAL | Bounded admin user/workspace/plan/usage/ticket DTO views pass. |
| 17 | TESTED_LOCAL | Ban/unban blocks/restores protected access and audits both transitions. |
| 18 | TESTED_LOCAL | Positive/negative page and AI credits are separate and audited. |
| 19 | TESTED_LOCAL | Temporary plan/feature entitlements expire/revoke without mutating base billing. |
| 20 | TESTED_LOCAL | Admin mutations use reason/confirmation/requestId and transaction/rollback audit contracts. |
| 21 | TESTED_LOCAL | Valid redeem lifecycle passes. |
| 22 | TESTED_LOCAL | Expiry, global/workspace maximum, double-use and disabled/revoked code limits pass. |
| 23 | TESTED_LOCAL | Support create/reply/note/status/priority/assignment and safe customer view pass. |
| 24 | TESTED_LOCAL | Sitemap, internal, rendered, manual and explicitly authorized additional discovery pass. |
| 25 | TESTED_LOCAL | Discovery is deterministic/bounded; no random unknown-path brute force exists. |
| 26 | TESTED_LOCAL | Scheduled cancellation/grace/terminal-Free behavior passes. |
| 27 | TESTED_LOCAL | Six legal routes are public in local browser tests. |
| 28 | TESTED_LOCAL | Signup requires Terms+AUP and presents Privacy/KVKK as notices, not fake consent. |
| 29 | TESTED_LOCAL | Executable plan catalog, database catalog and marketing promises are aligned. |
| 30 | LIVE_UNPROVEN | No production Resend verification/reset message reached a real inbox; domain/SPF/DKIM are absent. |
| 31 | LIVE_UNPROVEN | No real Ubuntu VDS deploy/load/soak/stability proof. Docker Desktop correctly rejected the worker namespace sandbox rather than weakening it. |
| 32 | TESTED_LOCAL | Encrypted disposable PostgreSQL backup was created and checksummed. This is not a production backup. |
| 33 | TESTED_LOCAL | Disposable restore-check and migrations 001–031 passed; restored ledger/catalog/heartbeat state was checked. |
| 34 | TESTED_LOCAL | `/healthz`, `/readyz`, `/api/v1/status`, heartbeat freshness and liveness checks pass locally and report degraded truthfully. |
| 35 | TESTED_LOCAL | Canonical integrated local suite has zero failures and zero backend skips; website profile skips are explicit. |

DoD count: **32 TESTED_LOCAL, 3 LIVE_UNPROVEN**. The global Definition of Done is **BLOCKED** by items 13, 30 and 31.

## A. Implemented

- Exact Free plus Signal/Studio/Enterprise catalogs, enforceable limits, seats, retention, AI quotas and API/website/database parity.
- Provider-neutral billing with Paddle launch default and a retained optional Stripe adapter; checkout, raw webhook verification, event ledger/order/idempotency, portal, cancellation, payment/refund and reconciliation contracts.
- Redeem codes, temporary grants, positive/negative credits, admin/support/scan operations and immutable, transactional audit behavior.
- Isolated OpenRouter AI service, strict schema/redaction, ordered fallback, quota/cache/cost controls, fail-soft customer flow and a 24-fixture evaluation harness.
- Isolated Resend email service with verification/reset/support/security/subscription templates and bounded provider behavior.
- Bounded root/robots/sitemap/index/internal/rendered/manual/additional discovery with provenance, target attestation, exact-origin allowlists and SSRF/DNS validation.
- Six public legal surfaces, versioned acceptance, fail-closed mandatory facts, role-separated PostgreSQL/worker topology, health/readiness, encrypted backup/restore scripts and deployment runbooks.

## B. Security impact

New trust boundaries are Paddle webhook/API, backend-to-AI internal bearer-to-OpenRouter, backend-to-email internal bearer-to-Resend, authorized public-target fetching/YellowLab, the admin control plane, role-scoped PostgreSQL, and worker/ZAP/source execution networks.

Positive controls include provider secrets only in their owning services; no OpenRouter/Resend key in the API container; Paddle raw-body HMAC with time window; idempotent ordered event ledger; verified email, role, 2FA, recent reauthentication, trusted origin, reason, confirmation and requestId for dangerous operations; secret-sanitized immutable audit; target authorization plus DNS/SSRF validation; and bounded body, token, timeout, rate and concurrency controls.

Residual risks:

- Compose network separation is not a hostname-aware egress firewall. Host/provider/DOCKER-USER controls must be applied on the VDS.
- Actual OpenRouter route, underlying provider, privacy/retention and cost behavior are unknown until the account is configured and observed.
- Paddle and Resend dashboard/domain policy has not been configured or inspected.
- Engine Lab execution state is process memory while audit is PostgreSQL. Cancel is audit-first/fail-closed and terminal audit failure is visible, but cross-system ACID is not possible.
- DNS, TLS, host firewall, monitoring, production backups and operational ownership have not been applied.

## C. Database migrations

| Migration | SHA-256 | Purpose |
|---|---|---|
| 027 `launch_commercial_readiness` | `ab00069dafd067796abe30053ccdf63268fa86a99b0f7e46f9bc3f239a6ff91a` | Free default; workspace/user state; provider-neutral billing; checkout/legal/target/redeem/grant/credit/AI tables; audit context and immutability; rate namespaces. |
| 028 `rendered_scan_discovery` | `a997c29d5f16d006a9ba60f2c263516a04aae4bbbab7ac9879452671eb19f5bc` | Scan-page discovery/provenance and unique URL/index constraints. |
| 029 `legal_acceptance_consistency` | `023f45862f0e9794e281a4ab5bb1d2a8cc54d0b98705db6710e0c985f41e80e4` | Legacy AUP normalization and `acceptable_use` constraint. |
| 030 `worker_heartbeats` | `cbfaf5c496ac35bec237a645bd5c3f332f86068f3500c61c8ad2dc95cbbf2c02` | Durable worker heartbeat and freshness index. |
| 031 `plan_catalog_truth_sync` | `402d86cabc0237d633254c197f282c48a635c931133cc53299d961cc392130dd` | Executable Free/Signal/Studio/Enterprise catalog truth sync. |

Disposable PostgreSQL 17 applied migrations 001–031 with the checksum ledger intact. The encrypted disposable backup SHA-256 was `b93aeef54209261af12ffba0e69e6597b12a3d966b78dbf5ca756810b0f0b183`; its restored migration/catalog/heartbeat checks passed. Temporary restore data and key material were destroyed after validation.

## D. External accounts and manual ownership

Required, still unchecked:

1. Ubuntu 24.04 VDS with 10 vCPU, 12 GB RAM and at least 200 GB NVMe.
2. Production domain, authoritative DNS, TLS issuance and renewal.
3. Paddle seller/KYC/business/domain approval plus monthly Signal and Studio products/prices.
4. Resend account and verified sending domain.
5. OpenRouter server account, key and funded/limited credits.
6. External HTTPS/TLS uptime monitor.
7. Operator-controlled `age` identity and encrypted off-VDS backup destination.
8. Monitored support mailbox and incident owner.
9. Real operator identity, address, effective date, hosting/region/DPA facts and professional legal review.
10. Tax, accounting, invoicing and refund operations.

Cloudflare is optional. If enabled, it becomes an actual processor/trust-proxy/origin-certificate configuration item. YellowLab currently requires no account, but remains a disclosed processor and consent-bound external analyzer. The authority checklist is `docs/EXTERNAL_ACCOUNTS_AND_MANUAL_CONFIGURATION.md`.

## E. Environment variables the operator must supply

This is a deployment checklist, not a secret-value record. Canonical required/optional/secret/source/rotation/consumer detail is in `docs/PRODUCTION_ENVIRONMENT.md`.

- App: `PUBLIC_ORIGIN`; optional `FRONTEND_PORT`; `MAX_CONCURRENT_ANALYSES=1`; `MAX_QUEUED_ANALYSES`; `LEGACY_API_ENABLED=false`; `LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT=false`.
- PostgreSQL: `POSTGRES_TLS_DIR`; distinct `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_WORKER_PASSWORD`, `POSTGRES_MAINTENANCE_PASSWORD`, `POSTGRES_QUEUE_PASSWORD`; `DATABASE_SSLMODE=require`; `MIGRATION_DATABASE_SSLMODE=require`; `MIGRATION_REQUIRE_TLS=true`; `DATABASE_SSL_REJECT_UNAUTHORIZED=true`; optional timeout settings. `POSTGRES_PASSWORD` is only a compatibility alias and should normally be empty.
- Auth/admin: `BETTER_AUTH_SECRET`; `ADMIN_REAUTH_MAX_AGE_MS`; rate-limit values; optional API/admin keys and OAuth IDs/secrets; one-shot `BOOTSTRAP_ADMIN_TOKEN` and `BOOTSTRAP_ADMIN_EMAILS`.
- Billing: initial production uses `PAYMENTS_ENABLED=false`, `BILLING_PROVIDER=paddle`, and `ENTERPRISE_SALES_MODE=contact`; Paddle credentials and price IDs remain empty in Free + redeem-only mode. Future paid mode requires `PAYMENTS_ENABLED=true`, `PADDLE_ENVIRONMENT`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_SIGNAL`, and `PADDLE_PRICE_STUDIO`. Enterprise price remains empty in contact mode. Stripe variables remain empty unless the non-launch legacy adapter is deliberately enabled.
- Email: `EMAIL_PROVIDER=resend`; `EMAIL_DELIVERY_ENABLED=true`; `EMAIL_SERVICE_TOKEN`; `RESEND_API_KEY`; `EMAIL_FROM`; `SUPPORT_EMAIL`; `EMAIL_PROVIDER_HOST_ALLOWLIST=api.resend.com`; optional timeout.
- AI: `AI_PROVIDER=openrouter`; `AI_SERVICE_TOKEN`; `OPENROUTER_API_KEY`; `OPENROUTER_MODEL_PRIMARY`; optional ordered `OPENROUTER_MODEL_FALLBACKS`; `OPENROUTER_SITE_URL`; `OPENROUTER_APP_NAME`; `OPENROUTER_DATA_COLLECTION=deny`; `OPENROUTER_ZDR`; `OPENROUTER_METADATA_ENABLED=true`; request/minute, concurrency, input/output and daily soft/hard cost limits. Gemini variables stay empty for launch.
- Worker/security: `ZAP_API_KEY`; `OSV_SCANNER_PATH`; `ENGINE_LAB_SERVICE_TOKEN` shared only by backend and analysis-worker; `REQUIRE_EXTERNAL_PROVIDER_CONSENT=true`; `ALLOWED_TARGET_PORTS=80,443`; `SOURCE_ENCRYPTION_KEY`; crawler, proxy, analyzer, lease and retention bounds.
- Backup: `BACKUP_AGE_RECIPIENT`; `BACKUP_REQUIRE_ENCRYPTION=true`.
- Legal: `LEGAL_OPERATOR_NAME`; optional real `LEGAL_OPERATOR_TYPE`; `LEGAL_COUNTRY`; `LEGAL_BUSINESS_ADDRESS`; `LEGAL_SUPPORT_EMAIL`; optional phone; `LEGAL_EFFECTIVE_DATE`; `LEGAL_HOSTING_PROVIDER_NAME`; optional confirmed host region/privacy URL and optional edge provider/region/privacy URL only if enabled.

All secrets must be independent, random, outside Git and in a mode-0600 environment file.

## F. Manual configuration

- Paddle: complete seller/domain approval; publish accurate URLs/legal/support; map Signal/Studio monthly prices; keep Enterprise contact-only; register `/api/v1/billing/webhook` for required subscription/transaction/refund events; run sandbox duplicate, old-event, cancel, portal, refund and reconciliation smoke; then perform a controlled live test only with explicit authority.
- Resend: add domain; publish exact SPF/DKIM; create sending-only key; use verified `EMAIL_FROM` and monitored support mailbox; test verification/reset/support delivery and bounce/complaint handling.
- OpenRouter: create server key; set app URL/title; run the same 24 fixtures against approved candidate models with an explicit cost cap; conduct human review; record primary/fallback; keep data collection denied; enable ZDR only when the selected routes support it; set daily spend controls.
- DNS/VDS: A/AAAA, TLS renewal and reverse proxy; inbound only operator SSH and 80/443; no public PostgreSQL/backend/worker/ZAP/AI/email ports; deny metadata/private/link-local egress and apply provider egress rules; configure trusted proxy only when an edge is used.
- Operations/backup: external health/certificate monitor; disk, memory, restart, queue and backup-age alerts; incident contact; offline `age` identity; daily encrypted offsite copy; monthly and post-schema disposable restore drill.

## G. Tests

Canonical non-overlapping harness counts:

- Backend integrated: **321 total / 321 pass / 0 fail / 0 skip**, including disposable PostgreSQL 17, runtime/worker/maintenance role URLs, pg-boss and `RUN_REAL_CHROME=1`.
- Website serial Playwright: **172 total / 89 pass / 0 fail / 83 skip**. Skips are intentional browser-profile selections, not production/provider proofs.
- Legacy frontend unit: **4 total / 4 pass / 0 fail / 0 skip**.
- Arithmetic across those three harnesses: **497 total / 414 pass / 0 fail / 83 skip**.

Separate gates, deliberately not added to 497 because they overlap or use different semantics: backend check/lint PASS; database check 31 migrations PASS; synthetic AI fixture evaluation 24/24 PASS; website typecheck/build/plan contract PASS; cutaway visual 4/4 contexts, zero browser fault; legacy frontend lint/build PASS; Paddle focused 8/8; admin focused 69/69; disposable PG audit 1/1 with zero residue; and six image builds PASS.

The bounded local Compose smoke proved healthy PostgreSQL, bootstrap/migrations/grants, backend, frontend, AI service, email service, ZAP and maintenance worker. It found and fixed a real ZAP healthcheck interpolation defect. The analysis worker correctly failed closed on Docker Desktop because the required Chromium namespace sandbox is unavailable; `infra/seccomp/README.md` documents this host boundary. No sandbox control was weakened.

## H. Known non-blocking issues

- Optional legacy Stripe and Gemini adapter/config references remain, but launch defaults/Compose exclude them and boundary tests prevent provider secrets from entering the wrong container.
- Engine Lab run state is process memory and audit is PostgreSQL; the documented narrow crash window does not affect core customer scan/billing persistence.
- Enterprise is contact/invite-only. Expert Review is an executable but explicitly admin-assigned entitlement, not a self-serve plan promise.
- Website Playwright's 83 profile skips are intentional matrix selection; they are neither failures nor live-provider evidence.

## I. Launch blockers

1. The working tree is dirty/untracked; there is no clean, committed, reviewed detached release SHA.
2. Operator identity/address/support/effective date, real hosting/region/privacy-DPA facts, optional edge facts and professional legal approval are absent. Production config intentionally fails closed.
3. Paddle seller/domain/catalog/credentials plus sandbox-to-live purchase, webhook, portal, cancellation, refund and reconciliation evidence are absent.
4. Resend verified domain/SPF/DKIM/credentials plus real verification/reset inbox delivery are absent.
5. OpenRouter credentials/credits, live metadata snapshot, cost-approved same-fixture evaluation, human model/fallback selection and privacy/routing approval are absent.
6. VDS, DNS, TLS, reverse proxy, firewall/egress, monitoring, deployment, public-target smoke, load and soak evidence are absent.
7. Scheduled encrypted offsite production backup, backup-age/disk alerts and a real production restore drill are absent.
8. Tax, accounting, invoicing and operational refund readiness are absent.

Until all eight close: do not enable revenue and do not write **LAUNCH READY** or **FEATURE FROZEN**.

## J. Exact deployment sequence

The full host/bootstrap/TLS/backup authority is `docs/PRODUCTION_DEPLOYMENT.md`. Placeholder values such as deployment user, domain, repository and release commit must be reviewed before execution, and the release worktree must be clean.

```bash
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml config --quiet
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml pull
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml build --pull
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml up -d postgres
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-bootstrap
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-migrate
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-grants
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml up -d --remove-orphans
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml ps
curl --fail --silent --show-error https://<domain>/healthz
curl --fail --silent --show-error https://<domain>/readyz
curl --fail --silent --show-error https://<domain>/api/v1/status
```

These commands were documented and locally validated at the configuration/image layer. They were **not** executed against a production host.

## K. Rollback plan

Before upgrade, record `PREVIOUS_RELEASE_COMMIT`, the encrypted backup path and its checksum. For an application-only failure: stop frontend/backend/workers/AI/email, check out the previous detached SHA, rebuild, start, and verify readiness using the exact runbook commands.

If migrations ran, never automatically drop or overwrite production data. First restore-check the exact pre-migration backup in a disposable database, inspect migration compatibility, and require explicit operator approval for either forward repair or a maintenance-window restore. Record the release SHA, migration ledger/checksums, smoke results and incident timeline.

## L. First production smoke test

Record user/workspace/project/scan/event/message/run IDs, timestamps and checksums at every step.

0. Preflight: clean detached SHA; environment and Compose config; container state; health/ready/status; TLS/firewall; secret-safe logs.
1. Sign up a designated test user.
2. Receive the real Resend verification email, follow the link and log in; also exercise reset delivery.
3. Accept current Terms+AUP; confirm Privacy/KVKK remain notices.
4. Create an authorized public project with attestation, DNS verification where ownership-only, and one explicitly authorized subdomain.
5. Run a Free scan within five credits; verify sitemap/internal/rendered/manual provenance, report/artifact and no random paths.
6. Generate AI remediation; verify quota, cache replay and actual model/provider/cost metadata; force a provider failure and confirm scan/report remain unchanged.
7. Redeem a valid code; verify duplicate/expired failure; grant and revoke page/AI credits plus temporary feature, expiry and audit.
8. In Paddle sandbox: buy Signal; verify raw webhook and exact entitlement; replay the same event; send an older event; exercise scheduled cancel→grace→Free, portal, recovery and refund; then Studio and Signal↔Studio/reconciliation. Perform a controlled live purchase only after account/domain approval and explicit authority.
9. Exercise support customer→admin reply, internal note, status/priority/assignment and real email notification.
10. Exercise admin inspect, ban→blocked, unban→restored, suspend→blocked, unsuspend→restored, scan cancel/retry and actor/reason/requestId/before/after timeline.
11. Create an encrypted production backup, checksum it, restore-check into a disposable database, verify migration ledger/row sanity, then remove disposable residue.
12. Observe at least ten minutes of logs, queue, worker heartbeats, provider errors and external monitor. Record evidence. Any failure stops revenue and triggers section K; do not relabel an unproven step as pass.

## Official-source alignment

- OpenRouter application attribution, ordered model fallback, structured outputs, provider routing/metadata/usage, privacy controls and ZDR are implemented against the official documentation: [App attribution](https://openrouter.ai/docs/app-attribution), [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection), [models](https://openrouter.ai/docs/guides/overview/models), [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [router metadata](https://openrouter.ai/docs/guides/features/router-metadata), [data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging), and [ZDR](https://openrouter.ai/docs/guides/features/zdr). Live account/routing behavior remains unproven.
- Paddle lifecycle/order/idempotency, signature verification, customer portal and Merchant-of-Record disclosures are aligned with the official [subscription provisioning guide](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/), [signature guide](https://developer.paddle.com/webhooks/about/signature-verification/), [portal guide](https://developer.paddle.com/build/customers/integrate-customer-portal/), [seller handbook](https://www.paddle.com/seller-guides/seller-handbook), and [refund guide](https://www.paddle.com/help/manage/your-customers/how-do-i-issue-refunds). Live account behavior remains unproven.
- Resend integration and domain prerequisites follow the official [Node.js sending guide](https://resend.com/docs/send-with-nodejs) and [domain introduction](https://resend.com/docs/dashboard/domains/introduction). Delivery remains unproven.
- KVKK wording and the distinction between notice and consent are grounded in the Turkish authority's [clarification-obligation guidance](https://www.kvkk.gov.tr/Icerik/4132/aydinlatma-yukumlulugunun-yerine-getirilmesinde-uyulacak-usul-ve-esaslar-hakkinda-teblig). This is not a substitute for operator-specific legal review.
