# WebPageAnalyzer — Final Human User Acceptance & UX QA

**Run date:** 2026-08-15–16
**Environment:** local Docker Compose, real persistent Chrome, http://localhost:8080
**Authorized analysis target:** https://www.onuracar.dev
**Final local product-code verdict:** **PASS WITH KNOWN LIMITATIONS**
**Production launch claim:** not made; provider/deployment acceptance listed below remains external to this local pass.

The customer-facing core is usable on all four plans and the administrator can perform the important operating actions. Studio and Enterprise originally failed because paid advanced-engine runs ended partial. HQA-016 was subsequently reproduced, measured and fixed in the worker: isolated engines passed, the bundled scan was proven to exhaust the 2 GiB / 512-PID worker, browser-heavy analyzers were placed in one bounded resource lane without changing execution timeouts, and two new Studio plus two new Enterprise browser scans completed 7 / 7 requested modules. The original failure evidence remains in this report.

This was a browser-first acceptance run. API/unit/Playwright checks below are regression evidence, not substitutes for the manual Chrome journeys.

## A. Accounts Tested

| Persona | Local credential | Durable commercial owner | DB plan / role | Verified limits | Final result |
| --- | --- | --- | --- | --- | --- |
| Free | local QA identity / credential excluded from release | the registered user, not the workspace | free / customer owner | 5 pages, 5 AI, 1 project, 1 seat, 0 source audits | **PASS WITH KNOWN LIMITATION** |
| Signal | local QA identity / credential excluded from release | the registered user, not the workspace | signal / customer owner | 25 pages, 100 AI, 3 projects, 1 seat, 0 source audits | **PASS WITH KNOWN LIMITATION** |
| Studio | local QA identity / credential excluded from release | the registered user, not the workspace | studio / customer owner | 150 pages, 1,000 AI, 15 projects, 5 seats, 1 source audit | **PASS WITH KNOWN LIMITATION** |
| Enterprise | local QA identity / credential excluded from release | the registered user, not the workspace | enterprise / customer owner | 500 pages, 5,000 AI, 50 projects, 15 seats, 4 source audits | **PASS WITH KNOWN LIMITATION** |
| Admin | existing local admin identity / credential excluded from release | the registered user | signal customer plan plus active super_admin authority | Signal customer quota; verified email; 2FA enabled | **PASS WITH KNOWN LIMITATION** |

Four customer personas were created only for local QA. The existing local super-administrator was reused to avoid leaving a second permanent administrator. Its temporary QA password replacement was rolled back to the original hash after the browser pass.

Final DB residue check:

- all five accounts are active and verified;
- Free, Signal, Studio and Enterprise resolve to their expected user-owned entitlement profile;
- Enterprise is a strict Studio analysis-depth superset;
- Admin remains active super_admin with 2FA and its Signal customer profile;
- active temporary grants across all five test personas: **0**;
- no real Paddle charge or production subscription was created.

## B. User Journeys Tested

### Method

The application was operated in persistent Chrome with normal clicks and form entry. Critical actions also received combinations of rapid double-click, refresh, Back/Forward, two tabs, wrong and empty input, long input, navigation while pending, and repeat-after-apparent-delay behavior. The browser remained connected to the real local frontend/backend/worker/PostgreSQL stack.

### Free

- Login, invalid login, logout/login persistence, profile menu, email/account state and deep links.
- Dashboard allowance panel, account-menu allowance summary, project creation, authorization attestation and public target creation.
- Invalid URL, 300-character project name, duplicate/rapid project submission and the one-project cap.
- Public-link scan for the authorized target, double-click start, navigation while running, progress, completion, refresh and history.
- Findings totals, category/state/source/device filters, severity, evidence, confidence and coverage.
- AI remediation double-click and safe provider-unavailable error handling.
- Free page/AI/project limits, paid report controls, Source Audit visibility, integration visibility and upgrade explanation.
- Reports, JSON/PDF/compare/share locks, settings, Billing CTA, notifications, public System status, Help and Support.
- Support case creation, idempotent double-click, customer reply visibility and admin reply visibility.

Result: the normal public-link scan completed and one page credit was consumed exactly once. Failed AI provider work did not consume a completed-use quota. Paid report/source features now fail closed and explain the required plan. A successful external AI answer remains unproven.

### Signal

- Login, balance and plan visibility; project/target creation; invalid and duplicate submissions.
- Public-link scan for the authorized target with double-click start and live progress.
- Findings/evidence/filter navigation and a failed AI-provider path.
- JSON export and the complete PDF queue/download lifecycle.
- Reports/history, Integrations, Billing, Studio upgrade confirmation and Support identity.
- Checkout stopped before Paddle, after confirming Studio / USD 99 / month and the recurring-purchase confirmation state.

Result: the scan completed with 55 active / 27 high-priority findings and the balance changed from 25 to 24. The final browser download was a real 242,501-byte PDF beginning with %PDF-1.4. Successful Paddle and AI provider results were not invoked.

### Studio

- Login and allowance visibility: 150 pages, 1,000 AI, 15 projects and 1 source audit.
- Target creation, invalid additional origin, two same-origin manual URLs and the DNS TXT instruction/retry UX.
- Source ZIP entry point inspection without choosing or uploading a file.
- Public-link scan double-click, progress, partial completion, report coverage and history persistence.
- Studio-only report/export/comparison/share entry points, VCS integration availability, workspace and billing settings.
- Two-tab session behavior and logout/deep-link behavior.

Original result: entitlement/UI parity was correct, but the captured paid run remained partial: WPA Page, Performance Plus, Advanced GEO and Visual UX timed out. Its reservation was released, leaving 150 / 150.

HQA-016 resolution: `scan_3256ed55-8917-4c0a-84ea-2d5246a732e9` and `scan_bee6495b-8b4e-4e13-a3f1-fbdc5c8e5bb9` were started from persistent Chrome after the worker fix. Both completed 7 / 7 requested public-link modules in approximately 75–77 seconds, persisted 65/64 findings, consumed exactly one credit each, survived refresh/report-history navigation and left 148 / 150 page credits. Studio is now PASS WITH KNOWN LIMITATION; DNS-gated discovery/Journey, Source ZIP and live providers remain outside this focused proof.

### Enterprise

- Login, allowance visibility: 500 pages, 5,000 AI, 50 projects and 4 source audits.
- Public pricing versus DB catalog versus effective scan manifest comparison.
- Public-link scan double-click, progress, partial report and failed-module presentation.
- Enterprise-only Journey and webhook entry points, invalid/private endpoint input, blank optional secret, browser password-manager autofill behavior and double-click submission.
- Public Contact sales, FAQ, Enterprise naming and Expert Review wording.
- VCS/source integration visibility and Billing/account copy.

Original result: catalog/UI/backend agreed that Enterprise included Studio depth plus Journey/webhooks and higher limits, but the earlier safe-target run ended partial because Performance Plus failed; its credit was released.

HQA-016 resolution: `scan_43d0af6c-97ce-4299-af3c-ef9821328a6f` and `scan_96cec97b-c0d6-42b5-b294-93424135c92e` were started from persistent Chrome after the worker fix. Both completed 7 / 7 requested public-link modules in approximately 75–77 seconds, persisted 63/64 findings, consumed exactly one credit each and survived refresh/report-history navigation. The final browser balance was 497 / 500, matching one successful pre-fix comparison run plus the two corrected runs. Enterprise is now PASS WITH KNOWN LIMITATION; successful webhook delivery and DNS-gated Journey remain untested.

### Admin

- Login, dashboard, all navigation groups, Back/Forward, compact menu and reload.
- User list/detail, client-side search/filter and plan/usage/AI/project/scan inspection.
- Workspace detail and suspend/unsuspend.
- Page-credit and AI-credit grant/revoke; permanent plan change and restore.
- Temporary Signal plan grant and revoke, confirmed from the Free customer profile.
- Temporary Expert Review entitlement grant and revoke, confirmed without changing the Free plan.
- Ban/unban, with the customer protected operation blocked rather than trusting the admin toast.
- Redeem create, redeem, disable and revoke; the Free baseline was restored.
- Support reply, internal note, close, reopen, identity display and zero-result filtering.
- Audit log verification after every mutation family.
- Scan manifest inspection plus retry/cancel for eligible work.
- Engine Test Lab invalid Journey input, private-target rejection and safe authorized-target execution.
- System/health and billing-state inspection.

Result: core production operations work and mutations were verified from the customer side. Engine Lab cancellation remains unproven because the run reached a terminal state before the cancel control could win the race.

### Final clean sequence

The post-fix customer/admin sequence was rerun in this order:

1. Free — **PASS WITH KNOWN LIMITATION**
2. Signal — **PASS WITH KNOWN LIMITATION**
3. Studio — **PASS WITH KNOWN LIMITATION** after the focused HQA-016 rerun
4. Enterprise — **PASS WITH KNOWN LIMITATION** after the focused HQA-016 rerun
5. Admin — **PASS WITH KNOWN LIMITATION**

## C. Issues Found

| ID | Severity | Persona / surface | Browser reproduction and observed result | Final state |
| --- | --- | --- | --- | --- |
| HQA-001 | HIGH | Customer System status | Profile → System status called an admin endpoint, rendered “not an administrator” and generated 403 noise. | **FIXED** — customers use the public status contract. |
| HQA-002 | HIGH | Free/Signal PDF | Download saved a 142-byte JSON queue ticket with a .pdf name. | **FIXED** — 202 is polled to a terminal execution; download occurs only after PDF magic validation. |
| HQA-003 | BLOCKER | Free reports | Free could export JSON and compare reports promised to paid plans. | **FIXED** — UI locks plus backend export/compare/share enforcement. |
| HQA-004 | HIGH | Free AI | Safe AI_PROVIDER_ERROR copy was replaced by “An unexpected server error occurred.” | **FIXED** — allowlisted operational message is shown; provider success is still unproven. |
| HQA-005 | HIGH | Free Support | Support replaced Free Tester/email with generic Account/Workspace member and removed usage visibility. | **FIXED** — canonical identity/profile/usage is reused. |
| HQA-006 | HIGH | Free Billing | Upgrade CTA foreground and background were both near-black. | **FIXED** — readable contrast restored. |
| HQA-007 | MEDIUM | Findings | YellowLab finding titles showed literal paragraph HTML. | **FIXED** — provider markup is normalized to text. |
| HQA-008 | MEDIUM | Portal Back/Forward | URL/content changed but the active navbar item stayed stale. | **FIXED** — route state follows history/popstate synchronously. |
| HQA-009 | MEDIUM | Free Targets | Full Source ZIP form was exposed without an entitlement explanation. | **FIXED** — hidden/locked from ineligible plans with upgrade context. |
| HQA-010 | MEDIUM | Scan banner | “Public-link scan queued” persisted after completion and across unrelated pages. | **FIXED** — transient state is cleared/bound to navigation and scan state. |
| HQA-011 | MEDIUM | Report history/compare | Repeated V.01/date rows are difficult to distinguish; comparison still exposes technical fingerprints. | **OPEN, NON-BLOCKING**. |
| HQA-012 | LOW | Finding AI action | Small action text is less readable than the rest of the controls. | **OPEN, NON-BLOCKING**. |
| HQA-013 | MEDIUM | Project validation | Oversized name produced only “Invalid request fields: name.” | **FIXED** — client states the maximum before submission. |
| HQA-014 | LOW | Portal console | Route changes still emit GSAP “target not found” warnings. | **OPEN, NON-BLOCKING** — reproduced on final bundle. |
| HQA-015 | HIGH | Signal/Studio engine picker | Plans could select engines they did not own and “not included” appeared Clear. | **FIXED** — effective-entitlement visibility/lock states. |
| HQA-016 | BLOCKER | Studio/Enterprise scan | Paid advanced runs on the authorized target ended partial after engine timeouts/failure. | **FIXED** — root cause was unbounded browser-heavy fan-out inside one analysis. Three isolated Performance Plus runs plus two full Studio and two full Enterprise browser runs completed after the bounded worker-lane fix; timeouts were unchanged. |
| HQA-017 | HIGH | Studio manual URLs | UI accepted additional URLs that public-link manifest silently discarded. | **FIXED** — UI states DNS ownership is required before queue and does not imply inclusion. |
| HQA-018 | HIGH | Multi-tab auth | A second tab initially retained stale protected UI after logout/state change. | **MITIGATED** — protected operations fail closed and reload revalidates. Automatic focus transition could not be proven with the connector. |
| HQA-019 | BLOCKER | Enterprise catalog | “Everything in Studio” downgraded advanced GEO/design/backend limits to null. | **FIXED** — canonical domain, frontend catalog and migration 037 make Enterprise a strict superset. |
| HQA-020 | HIGH | Enterprise naming | Portal said “Enterprise / Expert,” implying Expert Review came with the plan. | **FIXED** — plan is Enterprise; Expert Review remains separately assigned. |
| HQA-021 | BLOCKER | Enterprise webhook | Chrome inserted saved login email/password into endpoint/secret fields. | **FIXED** — explicit non-login names/autocomplete attributes; final Chrome fields stayed blank. |
| HQA-022 | HIGH | Enterprise webhook | Blank optional secret failed validation instead of allowing server generation. | **FIXED** — blank optional secret is omitted. |
| HQA-023 | HIGH | Studio/Enterprise seats | Catalog exposed 5/15 seats without a customer member-management surface. | **FIXED FOR LAUNCH COPY** — unshipped seat wording removed; enforcement stays internal. Full team UX moved to backlog. |
| HQA-024 | BLOCKER | Public Enterprise sales | Contact sales opened a generic support page with no prospect path. | **FIXED** — enterprise-aware contact page and explicit sales mail link; no charge/activation claim. |
| HQA-025 | HIGH | Partial report | Failed Performance Plus was omitted while completed modules made the report look successful. | **FIXED** — failed modules/coverage/warning are prominent, the historical partial report remains honest, and corrected HQA-016 runs now show 7 / 7 completed coverage. |
| HQA-026 | MEDIUM | Admin navigation | Rapid route/search changes could render records from the prior admin surface. | **FIXED** — synchronous route state, request-generation guard and stale-data clearing. |
| HQA-027 | MEDIUM | Admin Support | A zero-result filter left the prior selected case visible. | **FIXED** — selection is cleared; final browser showed 0 cases / Select a case. |
| HQA-028 | MEDIUM | Admin users/scans | No useful local user filter and no persisted scan manifest/progress inspector. | **FIXED** — user filter and bounded scan inspector added. |
| HQA-029 | MEDIUM | Engine Lab defaults | ZIP/Journey lanes appeared selected by default and stale errors survived new runs. | **FIXED** — ten URL-capable lanes load; Journey/OSV require explicit selection/input. |
| HQA-030 | BLOCKER | PDF worker release step | First repaired PDF enqueue failed with permission denied for wpa_queue after a manual deploy omitted runtime grants. | **FIXED OPERATIONALLY** — canonical db-migrate → db-grants sequence rerun; real PDF proved end-to-end. No privilege broadening. |
| HQA-031 | LOW | Failed-engine wording | Summary rendered “failed failed.” | **FIXED**. |
| HQA-032 | HIGH | Customer scan progress | A long-running scan exposed only a generic Running state; the customer could not see stage progress, the active engine or completed/failed engine states. | **FIXED** — the worker persists a bounded engine plan and lifecycle stream; Overview renders an explicitly labelled stage estimate, elapsed time, page position and per-engine Waiting/Running/Completed/failure states. |
| HQA-033 | MEDIUM | Local customer workspace | Repeated browser acceptance and sign-in reloads exhausted the broad 120-request loopback budget; the UI incorrectly described HTTP 429 as an unavailable API and suggested signing in again, which cannot reset an IP budget. | **FIXED** — the global UI presents Retry-After guidance and removes the ineffective sign-in action; only `docker-compose.local.yml` raises the broad QA budget to 2,000. Production and endpoint-specific security limits are unchanged. |

## D. Issues Fixed

### Commercial truth and user ownership

- Plan, credits, AI limits and temporary feature/plan grants resolve through the registered commercial user.
- Scan snapshots preserve both requester and entitlement owner.
- Admin customer mutations operate on users; workspace suspend/ownership remains workspace-scoped.
- Enterprise catalog is a strict Studio superset.
- The customer-facing commercial name is Enterprise; Expert Review is independent.
- Free export/compare/share is denied by both UI and backend.

Primary code: backend/domain/plans.js, backend/platform/service.js, backend/app.js, backend/platform/store.js, backend/billing/provider.js, backend/billing/stripe.js, backend/billing/paddle.js, migrations 036–039.

### Customer UX

- Usage remains visible in the profile menu and customer surfaces.
- Public status no longer calls admin diagnostics.
- Source, report, integration and engine controls render correct plan locks and upgrade explanations.
- AI provider availability errors retain safe operational wording.
- Report history navigation, success/error residue, long-name validation and Billing CTA contrast were corrected.
- Failed or unavailable analyzers cannot be presented as Clear.
- Manual URL discovery explains the DNS requirement before queue.
- YellowLab HTML and duplicate failure wording are normalized.
- Long-running scans now expose real durable engine lifecycle states. The displayed percentage is explicitly a stage estimate, not a fabricated time-to-completion prediction.
- HTTP 429 workspace failures explain the temporary request budget and Retry-After duration instead of claiming an API outage or suggesting an ineffective logout/login loop.

Primary code: website/src/portal/ScanProgressPanel.tsx, website/src/portal/UserDashboard.tsx, website/src/portal/PortalShell.tsx, website/src/portal/SupportCenter.tsx, website/src/portal/router.ts, website/src/portal.css, backend/services/analysis-service.js and backend/platform/service.js.

### Reports and integrations

- PDF generation is treated as durable work, then downloaded only after a terminal execution produces a verified artifact.
- Partial reports include failed module state and usable-coverage warning.
- Webhook fields resist login autofill and blank optional secrets are omitted.
- Enterprise sales has a real, plan-aware contact path.

Primary code: website/src/portal/UserDashboard.tsx, website/src/AuxiliaryPages.tsx, backend report/export gates and worker queue contract.

### Admin operations

- Local user filtering, bounded scan inspection and stale-request suppression were added.
- Support zero-result selection and post-mutation reload were repaired.
- Engine Lab defaults now match the actual input contract.
- Admin navigation state and compact navbar behavior were corrected.

Primary code: website/src/portal/AdminOperationsConsole.tsx, AdminSupportInbox.tsx, AdminEngineLab.tsx and admin-operations.css.

### Regression contract

- The launch migration test now verifies the actual 036–039 tail instead of incorrectly freezing the repository at migration 036.

### Paid advanced-engine reliability

- The original Studio bundle reached approximately 1.999 GiB and the 512-PID worker ceiling while Lighthouse, Axe, WPA Page and Advanced Browser launched together.
- WPA Page, Performance Plus, Advanced GEO and Visual UX each completed independently in about 21–23 seconds, proving the target/engine was not the primary failure.
- `backend/services/analysis-service.js` now classifies browser-heavy versus external work. Lighthouse, Axe, WPA Page and Advanced Browser use one bounded lane; YellowLab/ZAP can continue alongside that lane.
- Analyzer timeout clocks start only when actual execution starts, so `queueWaitMs` is separate from `executionMs`.
- Timeout/abort cleanup is drained for a bounded 10 seconds before the next browser can start; exceeding that bound emits an explicit warning.
- Report/module metadata now preserves queued/start/finish timestamps, queue wait, active duration, timeout budget, resource class and terminal state.
- No analyzer execution timeout was increased.
- Post-fix peak dropped to 1.179 GiB / 157 PIDs / 14 Chromium processes; terminal state returned to zero Chromium, 13 container PIDs and about 299 MiB after settling.

Primary code and evidence: `backend/services/analysis-service.js`, `backend/test/analysis-service.test.js`, and `docs/ADVANCED_ENGINE_RELIABILITY_REPORT.md`.

## E. UX Improvements

- Compact usage summary exposes remaining page, AI and project allowance without creating a new usage-dashboard system.
- Locked features state which plan unlocks them rather than disappearing ambiguously.
- Partial and failed engine states use failure/warning language, not empty-success language.
- Project-name validation is actionable before network submission.
- Public Enterprise contact retains the selected plan context.
- Support consistently shows the registered requester's name and email.
- Admin search and scan inspection reduce operator guesswork.
- Webhook fields no longer resemble credentials to password managers.
- Removed customer-facing seat claims until a real member workflow exists.
- Live scan progress remains compact in the existing Overview reference well, switches to one column at 390/320 px and freezes decorative motion under reduced-motion preference.

## F. Architecture Stale Assumptions

| Area | Finding | Result |
| --- | --- | --- |
| Customer System status | Customer UI assumed access to an admin diagnostic route. | Fixed with the public health contract. |
| PDF export | Browser assumed API 202 queue metadata was already a PDF. | Fixed; API enqueues, worker renders, UI polls, artifact is validated. |
| Failed engines | UI assumed “no findings” meant “clear,” ignoring incomplete worker state. | Fixed in UI/report presentation. |
| Manual discovery | UI assumed accepted URLs would enter a public-link manifest despite the DNS trust boundary. | Fixed without weakening target authorization. |
| Engine Test Lab | Checked for API-process browser execution. The live path uses the authenticated isolated analysis-worker endpoint. | PASS for run/private-target rejection; cancel race unproven. |
| Retry/job operations | Admin retry/cancel operates on durable scan/page state and queue ownership. | PASS for eligible scan operation. |
| Source processing | UI/backend remain isolated and entitlement-gated. | Architecture inspected; execution not tested because no ZIP was supplied. |
| Browser/PDF capability | No browser capability, sandbox bypass or extra internet egress was added to the API container. | PASS. |
| Paid browser fan-out | `MAX_CONCURRENT_ANALYSES=1` bounded pages but not the Chromium fan-out inside a page. | **FIXED** — one explicit browser-heavy lane, external lane preserved, active timeout excludes queue wait. |
| Customer scan progress | UI previously inferred only queued/running from the scan record and had no engine execution authority. | **FIXED** — the analysis worker emits bounded plan/running/terminal events through the existing durable progress store; the API remains browser-free. |

The advanced-engine failure was fixed in the worker execution path. Chromium was not moved into the API process, and the proxy, sandbox, target-authorization, entitlement, network and database boundaries were not weakened.

## G. Browser Evidence

| Evidence | Real-browser result |
| --- | --- |
| B-FREE-01 | Rapid scan click created one scan and one credit reservation; completion consumed it once. |
| B-FREE-02 | Overview moved through queued/running/completed and exposed findings, evidence, severity, confidence and coverage. |
| B-FREE-03 | AI rapid-click produced one failed provider usage record and retained 5 / 5 completed-use allowance. |
| B-FREE-04 | Invalid URL, oversized name, project cap, invalid password and invalid redeem all failed closed with useful copy after fixes. |
| B-FREE-05 | Support case F57F76FA retained the local Free Tester identity and did not duplicate on rapid click. |
| B-SIGNAL-01 | Signal scan completed with 55 active / 27 high-priority findings and 24 / 25 page credits remaining. |
| B-SIGNAL-02 | JSON export produced a 133,057-byte report. |
| B-SIGNAL-03 | The locally downloaded report is 242,501 bytes and starts %PDF-1.4. Backend enqueue returned 202 and the execution artifact later returned 200. |
| B-SIGNAL-04 | Upgrade confirmation selected Studio / USD 99 / month and required recurring terms; no Paddle continuation occurred. |
| B-STUDIO-01 | Invalid additional origin failed closed; DNS check gave an exact TXT instruction and safe retry message. |
| B-STUDIO-02 | Two manual URLs were no longer implied to be part of a public-link scan; the UI now requires ownership verification for discovery. |
| B-STUDIO-03 | scan_7ae5ae4e-1532-4be7-a342-cb9513f8f14b ended partial; its reserved credit was released to 150 / 150. |
| B-STUDIO-04 | Partial Overview/report shows failed engines rather than Clear. |
| B-STUDIO-05 | Corrected scans `scan_3256ed55-8917-4c0a-84ea-2d5246a732e9` and `scan_bee6495b-8b4e-4e13-a3f1-fbdc5c8e5bb9` completed 7 / 7 requested modules; Chrome report/history persisted and balance became 148 / 150. |
| B-STUDIO-06 | Real localhost Chromium started `scan_723a741f-4b1d-445b-b0a7-d6575957f1aa`; Overview showed the live SSE transport, elapsed time, stage estimate advancing from 3% to 79% while active, and simultaneous Completed/Running/Waiting engine rows. The scan then reached completed and the Studio allowance moved from 148 / 150 to 147 / 150; five terminal execution events represented seven customer rows because one bounded Advanced Browser execution supplies Performance Plus, Advanced GEO and Visual UX. Screenshot: `website/test-results/live-scan-progress.png`. |
| B-ENT-01 | Enterprise manifest retained Studio advanced limits after migration 037. |
| B-ENT-02 | Enterprise safe-target scan ended partial with failed Performance Plus and released credit to 500 / 500. |
| B-ENT-05 | Corrected scans `scan_43d0af6c-97ce-4299-af3c-ef9821328a6f` and `scan_96cec97b-c0d6-42b5-b294-93424135c92e` completed 7 / 7 requested modules; report/history persisted and balance was 497 / 500. |
| B-ENT-06 | Corrected report `rpt_bb6b2599-8468-4703-88e4-20e7c1ea0474` exported from Chrome as a 237,423-byte JSON with SHA-256 `8A741267AD1A95D0E3228593A900D561D85CFDA41B7652A3CF378BAE53FA50AD`; all seven module states were completed. |
| B-ENT-07 | After the shared local QA IP reached the broad request budget, session checks stayed 200 while all workspace surfaces returned 429. The local-only budget override was deployed without changing endpoint-specific limits; a fresh real Chromium Enterprise login then received dashboard HTTP 200, rendered Overview and showed no connection/rate-limit panel. |
| B-ENT-03 | Webhook endpoint/secret stayed blank under Chrome password-manager state; localhost/private input failed closed. |
| B-ENT-04 | Contact sales opened /contact?plan=enterprise, showed “Start the Enterprise conversation,” and exposed the explicit sales mail link without claiming activation/payment. |
| B-ADMIN-01 | Free temporary Signal grant appeared as Signal / 23 of 25 in the customer profile, then revoke returned it to Free; active grant count returned to 0. |
| B-ADMIN-02 | Expert Review override appeared without changing the Free plan and was then revoked; active grant count returned to 0. |
| B-ADMIN-03 | Ban blocked customer login/protected work; unban restored it. Suspend/unsuspend likewise affected the workspace operation. |
| B-ADMIN-04 | Support reply/internal note/close/reopen survived refresh and appeared on the correct customer/admin side. |
| B-ADMIN-05 | Query qa-no-ticket-zzzz rendered 0 cases / Select a case and did not leak the prior selected case. |
| B-ADMIN-06 | Engine Lab rejected a private target, rejected invalid Journey input and completed the safe authorized target run for 2 of 2 selected engines. |
| B-ADMIN-07 | Audit log showed grant/revoke, credit, plan, ban, support, redeem and scan operations. |
| B-ADMIN-08 | Final admin reload remained authenticated at /admin; dashboard rendered 6 users, 18 scans and 953 findings. |
| B-PUBLIC-01 | Public plan DOM contains Enterprise and Contact sales and no longer contains customer seat copy. |

Supplementary verification:

- backend full package after HQA-032: **418 total / 392 PASS / 0 FAIL / 26 UNPROVEN-skip**;
- HQA-016 engine/worker focused package: **29 PASS / 0 FAIL / 0 skip**;
- HQA-033 rate-limit/infra focused package: **17 PASS / 0 FAIL / 0 skip**; customer 429 browser contract plus scan-progress adjacency: **2 PASS / 0 FAIL**;
- focused acceptance/backend package: **19 PASS / 0 FAIL / 0 skip**;
- route/support browser regression at 1440, 390, 320 and reduced motion: **36 PASS / 0 FAIL**;
- website TypeScript check: PASS;
- website production build: PASS, 1,624 modules transformed;
- website plan-contract parity: PASS for Free, Signal, Studio and Enterprise;
- migration inventory/checksums: PASS, 39 contiguous migrations;
- public health: HTTP 200, API/analysis/persistence all operational;
- only the eight WebPageAnalyz containers were in scope; all eight were healthy.

The 26 backend skips are not counted as PASS. They require explicit disposable PostgreSQL/role databases or RUN_REAL_CHROME test environment flags. Real Chrome manual evidence and the live local PostgreSQL/PDF paths are recorded separately above.

## H. Plan Matrix

| Feature | Expected entitlement | UI visibility | Backend enforcement | Actual result |
| --- | --- | --- | --- | --- |
| Public-link core scan | All plans | Visible to all | Target validation, authorization attestation, user page quota and one durable scan | PASS; corrected Studio/Enterprise runs completed with the core and paid modules together. |
| Allowance display | Free 5/5/1; Signal 25/100/3; Studio 150/1000/15; Enterprise 500/5000/50 | Profile/customer surfaces show remaining page, AI and project use | Aggregated by entitlement user across sponsored workspaces | PASS. |
| AI remediation | All plans, plan-specific monthly limit | Visible with remaining quota | Reservation/settlement and user quota; failed calls release use | Error UX PASS; successful external provider output **UNPROVEN**. |
| JSON/PDF export | Signal, Studio, Enterprise | Locked on Free; visible on paid plans | Commercial gate before lookup/enqueue | PASS; Signal real JSON and PDF proven. |
| Compare/share | Studio, Enterprise | Locked below Studio | Commercial gate plus report/workspace/capability checks | UI/backend parity PASS; full external share delivery not required. |
| Advanced GEO / Visual UX / Performance Plus | Studio and Enterprise | Locked below Studio; Enterprise inherits Studio | Manifest snapshots effective entitlements | **PASS** in isolation and in 2 / 2 Studio plus 2 / 2 Enterprise full browser runs after HQA-016 remediation. |
| Full-site crawl / sitemap / rendered discovery / manual URLs | Studio and Enterprise after ownership verification | DNS requirement shown before discovery | DNS/authorized-origin gates; durable page queue | **NOT TESTED — DNS TXT NOT APPLIED.** |
| Source Audit | Studio 1, Enterprise 4 | Hidden/locked below Studio | User source quota, encrypted artifact and isolated OSV path | **NOT TESTED — SOURCE ZIP NOT PROVIDED.** |
| Journey Test | Enterprise only and ownership-verified | Locked below Enterprise; explicit input required | DNS gate and read-only same-origin assertions | **NOT TESTED — DNS TXT NOT APPLIED.** Invalid input failed closed. |
| Signed report webhooks | Enterprise only | Visible only to Enterprise; autofill-safe form | Entitlement, public URL validation, encrypted secret and durable outbox | Invalid/blank input UX PASS; successful delivery **NOT TESTED**. |
| Expert Review | No automatic plan grant | Shown as separately assigned human service | Admin grant/request/review state, not plan name | PASS for temporary grant/revoke and wording. |
| Seats | Internal limits 1/1/5/15 | Not advertised until customer member UX exists | Existing organization seat enforcement | Copy parity PASS; customer team workflow intentionally deferred. |
| Upgrade/billing | Three paid public plans; Enterprise sales-assisted | Correct next-plan CTA; Enterprise contact path | Versioned acceptance and provider gates | Local confirmation PASS; real Paddle charge **NOT TESTED BY INSTRUCTION**. |

## I. Admin Matrix

| Admin operation | Result | Customer-side or durable proof |
| --- | --- | --- |
| Login / dashboard / navigation | **PASS** | Final real Chrome reload remained on /admin. |
| User list, search, detail | **PASS** | Free email filter returned one matching record; detail/usage loaded. |
| Workspace detail | **PASS** | Owner, projects, scans, plan sponsor and status inspected. |
| Suspend / unsuspend | **PASS** | Protected customer operation blocked/restored. |
| Ban / unban | **PASS** | Customer login/protected action blocked/restored. |
| Grant / revoke page credits | **PASS** | Normal-user balance changed, then baseline restored. |
| Grant / revoke AI credits | **PASS** | Normal-user allowance changed, then baseline restored. |
| Permanent plan change / restore | **PASS** | Customer effective profile changed; original plan restored. |
| Temporary plan grant / revoke | **PASS** | Free became Signal temporarily, then returned Free; zero active grants. |
| Temporary entitlement / revoke | **PASS** | Expert Review appeared independently, then disappeared; plan stayed Free. |
| Redeem create / redeem / disable / revoke | **PASS** | Redemption affected the customer and was fully reversed. |
| Billing state | **PASS WITH LIMITATION** | Current local state visible; real provider reconciliation not invoked. |
| Quota / AI usage | **PASS** | Customer allowance and failed-use non-consumption matched DB. |
| Project / scan history | **PASS** | User detail and scan list loaded persisted records. |
| Scan inspect | **PASS** | Bounded manifest, progress, requester and entitlement owner visible. |
| Retry eligible scan | **PASS** | Reused durable scan/credit contract. |
| Cancel eligible scan | **PASS** | Terminal/release behavior verified where eligible. |
| Support identity/search | **PASS** | Registered name/email plus usage; zero filter cleared detail. |
| Support reply | **PASS** | Visible to customer after refresh. |
| Internal note | **PASS** | Admin-only; absent from customer thread. |
| Close / reopen ticket | **PASS** | State persisted and customer flow reflected it. |
| Audit log | **PASS** | Mutation families recorded actor/reason/target. |
| Engine Lab valid run | **PASS** | Authorized target completed 2 / 2 selected URL engines. |
| Engine Lab invalid/private target | **PASS** | Failed closed with safe validation. |
| Engine Lab cancel | **NOT PROVEN** | Run reached terminal state before the browser cancel race could win. |
| Engine Lab retry/history | **PASS WITH LIMITATION** | History/detail and repeat run worked; cancel-specific retry not proven. |
| System / health | **PASS** | Public health HTTP 200; admin detail and worker heartbeat visible. |
| Compact navbar / Back/Forward | **PASS** | Routes and active navigation remained synchronized. |

## J. Not Tested

- **NOT TESTED — SOURCE ZIP NOT PROVIDED.**
- Full-site crawl, sitemap discovery, rendered discovery and passive-security ownership-only execution: **NOT TESTED — DNS TXT NOT APPLIED.**
- Enterprise Journey Test execution: **NOT TESTED — DNS TXT NOT APPLIED.**
- Real Paddle charge, live billing portal, live cancellation and live provider reconciliation: not invoked, as explicitly allowed by the task.
- Successful external AI remediation: configured local provider path returned a safe unavailable/provider error.
- Successful signed webhook delivery: no external endpoint was configured.
- A new PDF was not generated from an HQA-016-corrected report. The corrected report's PDF control was present and the prior acceptance pass proved the durable PDF worker/download path with a valid 242,501-byte `%PDF-1.4` artifact; corrected-report JSON export was repeated successfully.
- GitHub/GitLab/Bitbucket OAuth completion: local OAuth keys are not configured.
- Transactional email delivery to a real inbox: not invoked.
- Engine Lab cancel winning a live run race: run completed before cancellation.
- Automatic focus-only redirect in the stale second tab: protected operation/reload enforcement passed, but the connector did not emit a reliable OS focus event.
- A full manual phone-hardware pass: compact/mobile layouts were covered by 390px/320px browser regression, not physical-device touch hardware.
- Active exploit, brute force and destructive security actions were intentionally not performed.
- Production VDS, real DNS, provider dashboards, backup/restore and live-domain deployment are outside this local browser acceptance evidence.

## K. Remaining Blockers

### Local product-code blockers

None was observed in this focused HQA-016 rerun. The historical Studio/Enterprise partial scans were reproduced as browser-heavy in-analysis fan-out exhausting the worker's 2 GiB / 512-PID boundary. After the bounded browser-resource lane fix, three isolated Performance Plus runs, two Studio runs and two Enterprise runs completed without analyzer failure, cleanup overrun, OOM or restart. Full evidence is in `docs/ADVANCED_ENGINE_RELIABILITY_REPORT.md`.

### External production gates

This local result is not a production-deployment claim. Successful production AI/provider configuration, live Paddle lifecycle/reconciliation, production DNS/deployment, backup/restore and the explicitly untested ownership-gated/source flows still require their own acceptance evidence before an unrestricted production-readiness claim.

### HQA-016 resolution

The required release proof listed in the original finding now exists locally: the worker-side cause was measured and fixed without moving Chromium into the API or weakening security controls; the authorized target was rerun twice under each paid advanced plan; every requested public-link module completed; report/history/credit settlement was rechecked in persistent Chrome. **HQA-016 is FIXED for the supported local worker environment.**

## L. Non-Blocking Issues

- HQA-011: report-history rows need stronger human-readable differentiation; comparison still favors technical fingerprints.
- HQA-012: finding AI action typography is smaller than neighboring controls.
- HQA-014: GSAP target-not-found console warnings remain on route changes; no user-visible failure was observed.
- Cross-tab focus transition is not fully proven, although protected operations and reload fail closed.
- Engine Lab cancellation race remains unproven.
- Intentional simultaneous Engine Lab plus customer-scan stress was not part of the required HQA-016 fallback and remains a capacity-test follow-up; ordinary repeated customer scans passed.
- The customer team/member workflow is intentionally deferred in BACKLOG_AFTER_LAUNCH.md; seat claims were removed rather than inventing a large feature.

## Final Acceptance Questions

> If I were a first-time customer, could I understand and reliably use the basic flows and promised plan features?

**Yes for Free, Signal, Studio and Enterprise in the tested local customer flows, with the recorded limitations.** Plan/entitlement/UI behavior agrees, and two corrected Studio plus two corrected Enterprise runs completed all seven requested public-link modules in Chrome. DNS-gated discovery/Journey, Source ZIP, successful external AI/webhook delivery and real billing-provider lifecycle remain explicitly unproven rather than being counted as PASS.

> If I operated the system in production, could I intervene in user, scan, support, entitlement and failure states through Admin?

**Yes for the tested core operations, with two limitations:** Engine Lab cancellation did not win a live race, and real external billing-provider reconciliation was not exercised. User/credit/plan/grant/ban/suspend/redeem/support/audit/scan inspection and eligible retry/cancel operations were verified with customer-side or durable evidence.
