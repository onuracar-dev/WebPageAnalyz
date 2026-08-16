# WebPageAnalyz — Adversarial Business-Logic, Concurrency, Idempotency and Failure-Mode Audit

**Audit date:** 2026-08-15 (Europe/Istanbul)
**Scope:** repository at `codex/webpageanalyz-p0-p3-hardening`, baseline `44b5a15e4a178d467b37b136074a6cc8281ea99d`
**Input contract:** user-supplied audit contract attachment; local attachment path excluded from release
**Status:** `DO NOT MARK LAUNCH READY`. The integrated local/disposable suite is green, but the OPEN/UNPROVEN P1 boundaries below are not closed.

This is an adversarial correctness audit, not a feature specification. It treats every HTTP mutation, webhook, queue delivery, worker, scheduled process and external side effect as at-least-once and potentially concurrent. UI disabled states are counted only as UX protection; they are not correctness guarantees.

## 1. Executive verdict

The audit branch contains bounded hardening for checkout acceptance and setup leasing, operation fingerprints, project/scan/source/support mutations, billing-provider binding, Better Auth reset/session boundaries, seat enforcement, scan-page settlement and lease renewal, source queue recovery and cross-process retention exclusion. The branch also contains deterministic adversarial tests for the changed paths.

The evidence is not sufficient for a launch claim yet:

- No confirmed P0 was reproduced in the bounded test set. This is not a production/provider/security certification.
- P1 remains `OPEN` or `UNPROVEN` for the global AI hard-cost check/charge TOCTOU, complete deletion/suspension fencing across every worker, non-retention scheduled-job overlap, and explicitly enabled legacy/provider/deployment paths. Page-lease renewal, source queue unknown outcomes and retention overlap were fixed and passed the bounded tests described below.
- Real Paddle/Stripe credentials, live provider webhook delivery, production deployment, multi-process production workers and production data compatibility were not exercised.
- The final integrated local/disposable run completed with `367/367 PASS`, `0 FAIL`, `0 SKIP`. This closes the local test gate only; it does not convert provider or deployment evidence into PASS.

**Prohibited conclusion:** this document does not claim that the application is race-condition-free.

## 2. Evidence boundary and status vocabulary

`PASS` means the named deterministic check completed successfully in the stated environment. `FAIL` means a reproducible invariant violation or failing check. `OPEN` means the risk is known and has not been fixed or has no accepted deterministic proof. `UNPROVEN` means the code/test shape may be reasonable but the required environment, provider, process topology or end-to-end evidence was not exercised. `N/A` means the operation does not have that particular failure mode, not that the whole operation is safe.

The worktree was already heavily dirty before this audit. Existing WIP, generated assets, legacy frontend work and unrelated changes were preserved. The inventory therefore describes the repository snapshot and explicitly separates audit changes from unrelated work; it is not a clean-branch diff claim.

## 3. Baseline and verification ledger

| Evidence | Result | Boundary |
|---|---|---|
| Node/npm | Node `v24.12.0`, npm `11.6.2`; backend requires Node >=22.19 | Local Windows runtime only |
| Fresh baseline `npm run check` | PASS | Before the current hardening changes |
| Fresh baseline `npm test` | `321 total / 306 pass / 0 fail / 15 skip` | The 15 skips included PostgreSQL/role/pg-boss and two real-Chrome checks because their environment was absent |
| Disposable PostgreSQL | Container `wpa-business-logic-pg-e0ff20a0d4`, local port `15285`; migration ledger `35`, latest `035_checkout_setup_lease.sql`; 12 pg-boss schema tables | Anonymous disposable volume only; not production evidence |
| Guarded PostgreSQL/pg-boss checks | `13/13 PASS` when the disposable database was configured | Disposable database only |
| Seat trigger race | `PASS` in live disposable PostgreSQL; one final Studio seat produced one winner | Does not prove every membership path or deployment topology |
| Password reset race | `PASS` in live disposable PostgreSQL; one token winner and existing sessions revoked | Does not prove every Better Auth/provider deployment configuration |
| Focused adversarial suite | `42/42 PASS`, `0 FAIL`, `0 SKIP` with Memory + disposable PostgreSQL | Fake/injected providers only |
| Backend syntax | `npm run check` PASS | Local Node runtime |
| Website typecheck/build | PASS; Vite production build completed | Local build, not deployment |
| Website plan contract + targeted browser suite | Plan parity PASS; Playwright `36/36 PASS` across Chromium/mobile/compact/reduced-motion projects | Mocked/local API contracts; no live provider |
| PostgreSQL role boundary supplement | `4/4 PASS` for worker/maintenance permissions and deletion lifecycle | Disposable roles/database only |
| Real Chrome supplement | `2/2 PASS` for desktop/mobile visual evidence and rendered-link capture | Local Chrome only |
| Final integrated backend suite | `367/367 PASS`, `0 FAIL`, `0 SKIP`, duration `57.583 s` | Memory, disposable PostgreSQL/pg-boss/roles and local Chrome; no real provider or deployed topology |

The disposable database was stopped after verification. Docker confirmed that the exact container and its exact anonymous PostgreSQL volume were absent; no broad cleanup command was used.

## 4. Mutation inventory

The following table is the required mutation/action inventory. Rows group aliases only when they share one service/store path; every route family is listed explicitly. “Current protection” describes the branch snapshot, not a claim that every protection has final green evidence.

| ACTION | RESOURCE | PRECONDITION | INVARIANT | DUPLICATE RISK | CONCURRENT RISK | RETRY RISK | FAILURE WINDOW | CURRENT PROTECTION | DB PROTECTION | TEST COVERAGE | SEVERITY |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST /api/v1/billing/webhook` | Billing event, subscription, entitlement | Valid provider signature; provider/environment/catalog identity | One provider event has one logical effect; older event cannot regress newer state | Replay can grant/apply twice | Reordered events or two workers | Provider retry | Ledger insert vs subscription apply | Provider parser, event ledger, `applyBillingProviderEvent`, occurred-at comparison | Unique event ID; subscription/provider identity and last-event fields in migrations 027/031 | Billing-provider, Paddle/Stripe and integrated suites PASS; real provider UNPROVEN | P0/P1 if bypassed; bounded contract PASS |
| `POST /api/v1/billing/checkout` | Checkout acceptance and provider checkout | Authenticated billing permission, valid plan/terms, operation key | One logical checkout acceptance; no second open intent; paid entitlement comes from webhook | Double Buy or lost response | Two tabs/different keys | Client/proxy retry | Acceptance persisted before provider call; provider call succeeds but response is lost | Stable idempotency key, request fingerprint, active-subscription guard, terminal state machine, persisted acceptance identity and owner/token setup lease | Unique `(workspace_id,idempotency_key)`, one-open-intent partial unique index, setup lease columns in 027/032/033/035 | Checkout API/provider tests and Memory/live-PG commercial contract PASS | P1; real provider/deployment idempotency remains UNPROVEN |
| `POST /api/v1/billing/portal` | Provider customer portal session | Authenticated active provider customer | Portal creation must not mutate internal entitlement | Duplicate portal session | Two tabs | Retry can create two external sessions | External session created before response | Provider API boundary only | Provider-owned; no internal entitlement mutation | Existing billing provider tests; real provider UNPROVEN | P2/UNPROVEN |
| `POST /api/v1/billing/cancel` | Provider subscription cancellation | Current provider subscription | Repeated cancel is harmless and state is reconciled by webhook | Multiple cancel requests | Cancel vs renewal/webhook | Lost response | Provider cancel succeeds, internal state waits for webhook | Provider lookup and provider call; no browser-as-source-of-truth grant | Provider/external subscription uniqueness; internal event ledger | Provider unit tests only; live provider UNPROVEN | P1/UNPROVEN |
| `POST /api/v1/redeem` | Code redemption, bonus credits, temporary entitlement | Authenticated billing permission; active, in-window code | Max global/per-workspace redemption and one logical grant | Double click/replay | Last redemption by two workspaces | Lost response | Redemption/grant/audit must be one transaction | Operation key/fingerprint; code locking in store path | Code constraints, FK and partial operation uniqueness in 027/032 | Commercial idempotency and redeem suites PASS in Memory/live PG | P1; bounded path PASS |
| `POST /api/v1/legal/acceptances` | Legal acceptance record | Authenticated user/workspace, current document version | Same version/purpose is not duplicated and audit is truthful | Repeated consent | User deletion/workspace deletion | Retry | Insert vs audit | Service validation and request ID | Unique user/workspace/document/version/purpose in 027 | Existing legal contract tests; concurrent proof UNPROVEN | P2 |
| `POST /api/v1/workspace/deletion` | Deletion request/run | Settings permission, confirmed request | One logical deletion request; child work is fenced or safely removed | Double delete | Delete vs scan/upload/webhook | Lost response | Request row vs asynchronous deletion | Request ID and deletion-run ledger | Unique deletion request ID in 026; FK `ON DELETE` policy | Legal/deletion contracts; multi-worker proof UNPROVEN | P1/UNPROVEN |
| `PUT /api/v1/settings` | Workspace settings | Settings permission and validated body | Last accepted settings write is intentional; audit follows commit | Repeated form submit | Two admins overwrite fields | Retry | Settings update vs audit | Validation and audit call | Workspace row constraints; no operation-key uniqueness | Existing app/service tests; concurrent last-write semantics UNPROVEN | P2 |
| `POST /api/v1/support/tickets` | Ticket and initial message | Support permission and valid ticket body | One submitted operation creates one ticket/message | Double-click ticket | Two admins/customer transitions | Retry can duplicate email | Ticket/message/audit/notification are separate steps | Operation key/fingerprint in service/store; notification key derived from the committed message | Support message operation index in 032 and ticket request fingerprint in 034 | Support service/store/UI tests PASS in Memory/live PG/browser contract | P2; real email/provider transition race UNPROVEN |
| `POST /api/v1/support/tickets/:id/replies` / `messages` | Support message and ticket state | Ticket belongs to workspace; valid transition | One reply per logical operation; closed/reopened state is deterministic | Double reply | Customer/admin reply or close race | Email retry | Message commit vs notification | Operation context and derived email idempotency key | Support message key index in 032 | Support idempotency test; provider email delivery UNPROVEN | P2 |
| `POST /api/v1/support/tickets/:id/close` / `reopen`; `PATCH .../:id` | Ticket state | Ticket ownership/permission | State transition is valid and repeat-safe | Repeated close/reopen | Two actors choose opposite state | Lost response | State write vs audit/notification | Service transition validation | Row update; no universal operation ledger | Existing support tests; concurrent admin proof UNPROVEN | P2 |
| `POST /api/v1/integrations/:provider/connect` / callback | OAuth state and provider credentials | Integration entitlement, state, callback code | State is one-use and credentials are scoped to workspace/user | Callback replay | User deletion/suspension during callback | Browser retry | Provider exchange vs encrypted upsert | One-use OAuth state, entitlement recheck before finish/upsert | OAuth state consumed atomically by store | `integrations.test.js` includes one-use/entitlement tests | P1 if cross-workspace; current provider proof UNPROVEN |
| `PUT /api/v1/integrations/webhook` | Encrypted webhook integration | Webhook entitlement and validated HTTPS/secret | Secret stored encrypted; configured provider is workspace-scoped | Repeated setup rotates secret | Downgrade while setup/delivery | Retry | Encrypt/upsert vs response | Entitlement checks and encrypted credentials | Workspace/provider identity; no full operation ledger | Integration tests; multi-process proof UNPROVEN | P1/UNPROVEN |
| `DELETE /api/v1/integrations/:provider` | Integration record | Integration permission | Repeated delete is harmless; queued sends do not bypass current entitlement | Repeated delete | Delete vs delivery | Retry | Delete vs outbox claim | Workspace-scoped delete; delivery entitlement recheck | FK/row scope | Existing integration tests; concurrent delivery proof UNPROVEN | P2 |
| `POST /api/v1/projects` | Project and target authorization | Project permission, URL validation, production attestation | Project quota and logical create are atomic; origin scope is explicit | Double create | Max-project boundary | Lost response | URL/DNS validation before insert | Operation key/fingerprint and service-level quota | Partial unique project operation index in 032; FK | Scan-memory/PG business-logic tests | P1 |
| `POST /api/v1/projects/:id/verify-target` | Project verification | Project ownership, target method | Verification is current, bounded and cannot authorize another project | Repeat verification | Verify vs revoke/expiry | Retry | DNS/provider check vs write | Revalidation at queued execution for ownership-only modules | Project FK/state fields; no version column | Existing project/verification tests; concurrent DNS proof UNPROVEN | P1/UNPROVEN |
| `DELETE /api/v1/projects/:id/verification` | Verification state | Project permission | Repeated revoke is harmless; queued work rechecks | Duplicate revoke | Revoke vs page execution | Retry | Revoke while analyzer is running | Worker checks current verification before provider work and before commit | Project row/FK | Scan-memory test covers suspended/verification boundaries; PG final pending | P1 |
| `POST /api/v1/scans` | Scan, pages, reserved credits, queue job | Scan permission, project exists, entitlement/quota | Same logical scan creates one scan and does not consume twice | Double-click/lost response | One credit and two requests; suspension after create | API retry | DB create vs queue send; queue result unknown | Stable operation key/fingerprint, atomic project/scan limits, stable singleton queue key, recovery sweep | Partial unique scan operation index in 032; row/advisory locks for page/credit | `business-logic-scan-memory`, `business-logic-scan-postgres` | P1 |
| `POST /api/v1/findings/:fingerprint/remediation` and `/ai-remediation` | AI usage reservation/result/cache | Scan permission, finding exists, AI entitlement owned by the workspace sponsor user | Same request cannot invoke provider/consume quota twice; failure leaves finding intact | Repeated Generate | One AI credit, cache race, finding/project deletion | Lost provider/HTTP response | Reservation→provider→settlement/cache | Stable key, durable result in usage metadata, terminal settlement CAS, cache replay | User-scoped AI usage/idempotency index in 036; cache index only | `launch-api-wiring`, AI quota tests and cross-workspace user-quota test; global provider cost proof absent | P1; global hard-cost TOCTOU OPEN |
| `POST /api/v1/reports/:id/expert-review-requests` | Expert review request/task | Review entitlement and report ownership | One requested review per intended action; assignment not plan-name-bound | Double request | Admin claim vs request | Retry | Request vs queue/task | Service/status checks | Review/report FKs and task uniqueness where present | Existing review/admin tests; duplicate-request proof UNPROVEN | P2/P1 depending billing impact |
| `POST /api/v1/reports/:id/share`; `DELETE .../share` | Report share token | Share permission, report ownership | Current token lifecycle is deterministic; repeated revoke harmless | Repeated share/revoke | Download vs revoke/expiry | Lost response | Token update vs client response | Hashed token, expiry/revoke checks | Report FK/state fields; no operation uniqueness | Share lifecycle tests; concurrent revoke/download UNPROVEN | P2 |
| `POST /api/v1/source-inputs` | Encrypted source artifact, source input, execution result, queue job | Source entitlement, archive inspection/security limits, project scope | One upload operation and one worker side effect; quota counted once | Same archive twice/lost response | Quota/cleanup/worker read | Queue send unknown | Encrypt→DB insert→queue send; unknown acknowledgement must retain the durable reference | File fingerprint, operation key, stable execution job/singleton key, preserved queued row/ciphertext and same-key redelivery | Partial unique source operation index in 032; execution job key uniqueness; atomic monthly quota in store | Source idempotency suite PASS in Memory/live PG, including unknown outcome recovery | P1; in-flight suspension/deletion fencing remains part of BL-018/021 |
| `POST /api/v1/admin/reauth` | Admin reauth marker | Admin authentication and valid challenge | Marker is bounded to session/user and expires | Repeat reauth | Session revocation/ban | Retry | Auth provider vs marker | Short-lived marker store | Session/user scope | Admin security tests | P1/security boundary if bypassed |
| `POST /api/v1/admin/engine-lab/runs`; `.../cancel` | Admin lab execution/artifact | Admin role, upload validation | One run/job and terminal cancel state | Double submit/retry | Cancel vs worker completion | Lost response | Upload/DB/queue | Admin limiter and execution result lease | Execution job key uniqueness; terminal CAS | Engine-lab/worker tests; concurrent proof UNPROVEN | P1/UNPROVEN |
| `POST /api/v1/admin/users/:id/ban` / `unban` | User account state/sessions | Admin role/reason | Banned state is server-authoritative; sensitive flows fail closed | Repeated ban/unban | Ban vs reset/checkout/worker | Retry | Account update vs session/token revocation | Better Auth hooks, banned reset/verification guards | Better Auth account/session rows; no global operation ledger | Auth boundary tests; live reset race PASS | P1 |
| `POST /api/v1/admin/workspaces/:id/suspend` / `unsuspend` | Workspace execution state | Admin role/reason | Suspended workspace cannot begin/commit protected queued work | Repeated suspend | Suspend vs scan/source/webhook/checkout | Lost response | State write vs already running worker | Rechecks at scan phases, integration delivery and source paths | Workspace state/FK; no universal worker fence | Scan boundary/integration tests; all workers UNPROVEN | P1 |
| `POST /api/v1/admin/users/:id/credits` | User credit adjustment ledger | Admin role, registered user, signed amount, operation key | One intentional grant/revoke per user operation; every sponsored workspace consumes the same user balance | +100 double click | Consume vs grant/reset/expiry | Retry | Adjustment vs audit | Stable operation key/fingerprint | User-scoped credit-adjustment operation index and owner FK in 036; amount CHECK in 027 | User commercial ownership and idempotency suites PASS | P1; bounded keyed path PASS |
| `POST /api/v1/admin/users/:id/entitlements`; `POST /admin/entitlements/:id/revoke` | User temporary entitlement grant | Admin role, registered user, plan/expiry validation | Grant/revoke is explicit and does not mutate paid billing base plan | Duplicate grant | Grant expiry vs billing webhook | Retry | Grant/audit vs response | Stable grant operation key; deterministic effective-plan ordering | User-scoped grant operation index and owner FK in 036; expiry checks in 027 | User commercial ownership/effective-plan suites PASS | P1; unkeyed revoke retry remains P2 residual |
| `POST /api/v1/admin/redeem-codes`; `.../:id/disable|enable` | Code definition/state | Admin role, bounded code fields | Code creation replay-safe; disable/enable does not rewrite redemptions | Double create/disable | Redeem during disable | Retry | Code insert vs audit | Create operation context; code hash not returned | Partial unique creator/key index in 032; redemption FK/checks | Commercial idempotency; final create-code proof pending | P1 |
| `POST /api/v1/admin/workspaces/:workspaceId/scans/:scanId/cancel|retry` | Scan state/pages/credits/queue | Admin/operator role, scan workspace scope | Valid state transitions only; retry cannot run beside original; cancel wins or completion wins atomically | Double retry/cancel | Worker completion vs admin action | Lost response | State update vs queue send | CAS/expected state, terminal page/credit settlement, stable queue keys and page lease renewal | Scan/page/credit row locks and terminal status conditions | Scan Memory/PG + lease tests PASS | P1 bounded PASS; stale external spend remains possible before CAS |
| `POST /api/v1/admin/workspaces/:id/billing/reconcile` | Internal billing reconciliation | Admin role/reason | Reconcile does not grant from an untrusted browser redirect | Repeated reconcile | Reconcile vs webhook | Retry | Provider read vs local apply | Provider-event ledger and provider identity checks | Event/subscription constraints | Provider unit tests; live provider UNPROVEN | P1/UNPROVEN |
| `POST /api/v1/admin/webhook-outbox/:id/replay` | Outbox delivery | Admin role and existing outbox | Replay is bounded and does not duplicate logical external event | Double replay | Worker delivery vs admin replay | Lost response | Claim/replay/complete | Lease owner/token and delivery state | Outbox idempotency key/index | Integration outbox tests; provider receiver dedupe UNPROVEN | P2/P1 |
| `PATCH /api/v1/admin/support/tickets/:id`; `POST .../notes|replies|messages` | Admin ticket state/message | Operator/admin role | One logical admin action and no cross-workspace leakage | Double reply/note | Admin A/B state race | Email retry | Store/audit/email separate | Operation context in support service; notification key | Support message operation index in 032 | Support idempotency test; admin race UNPROVEN | P2 |
| `POST /api/v1/admin/expert-reviews/:id/claim`; `PUT .../findings/:fingerprint`; `PUT .../roadmap`; `POST .../finalize|publish` | Review decisions/roadmap/report | Role and review state | Review state machine and publish gates cannot regress | Double finalize/publish | Two admins edit/claim | Retry | Decision/audit/report version | Service state checks, report versioning | Review/report/task FK; version update in store | Existing admin/review tests; deterministic concurrent proof UNPROVEN | P1/P2 |
| `POST /api/v1/admin/operator-tasks/:id/complete`; `POST /api/v1/admin/reports/:id/publish` | Operator task/report version | Role, task/report status | One completion and one corresponding report transition | Double completion | Two operators | Retry | Task update vs report insert | Store transaction and report version | Task/report constraints and FK | Existing task/report tests; concurrency UNPROVEN | P1/P2 |
| `POST /api/v1/admin/users/:id/plan` | User base plan assignment | Super-admin role, registered user, catalog plan | Billing base plan, temporary grant and bonus credits compose deterministically for all sponsored workspaces | Duplicate plan write | Plan change vs reset/redeem/webhook | Retry | Plan write vs entitlement read | Catalog validation, append-only user plan history and deterministic effective-plan composition | User profile/plan-history FK and idempotency constraints in 036 | User commercial ownership/plan tests PASS; deployed provider/admin interleaving UNPROVEN | P1 |
| `POST /api/v1/admin/workspaces/:id/deletion/authorize|execute` | Deletion authorization/run | Super-admin role and prior authorization | Execute once, authorization scoped and auditable | Double execute | Execute vs worker/webhook | Lost response | Authorization vs destructive execution | Deletion run request ledger | Unique request ID in 026; FK cascade policy | Legal/deletion tests; full worker race UNPROVEN | P1 |
| `PUT /api/v1/admin/plans/:planId/entitlements/:moduleId` | Catalog entitlement | Super-admin role and valid module | Catalog change cannot silently change already accepted checkout identity | Repeated update | Update vs checkout/scan | Retry | Catalog write vs active request | Catalog validation; accepted checkout stores version/amount | Catalog constraints in plan tables | Plan contract tests; concurrent catalog proof UNPROVEN | P1 |
| `POST /api/analyze` | Legacy analysis job/result | Legacy API auth and bounded input | Legacy endpoint must not bypass modern quota/authorization or duplicate expensive work | Retry/double submit | Same target concurrently | Lost response | Legacy service vs response | Production-disabled by default; explicit enablement requires API keys | Legacy tables/constraints are not equivalent to the modern operation ledger | Disabled-default security tests PASS; enabled idempotency UNPROVEN | P1; excluded from default launch scope |
| `POST /api/solve`; `POST /api/executive-summary` | Legacy AI generation | Legacy auth and input | Retry must not create duplicate paid/provider work | Double Generate | AI quota/provider race | Lost response | Provider vs result/quota | Production-disabled by default; explicit enablement requires API keys | No modern AI operation proof for enabled legacy path | Disabled-default tests PASS; enabled adversarial retry UNPROVEN | P1; excluded from default launch scope |
| `DELETE /api/logs` | Log records | Admin API key | Repeat deletion is bounded and authorized; no audit loss needed for security evidence | Repeated delete | Logging while delete runs | Retry | Delete vs concurrent write | Admin key guard | Log table policy; no operation ledger | Existing logger/security tests; concurrency UNPROVEN | P2 |

### 4.1 Queue, worker, scheduled and external mutations

| ACTION | RESOURCE / SIDE EFFECT | INVARIANT AND FAILURE WINDOW | CURRENT PROTECTION | TEST / STATUS | SEVERITY |
|---|---|---|---|---|---|
| Scan queue (`scan`/`page`) | Claims pages, runs analyzers, writes reports/credits | Queue send may succeed while API response/DB transition is lost; duplicate job must not double-charge or overwrite terminal state | Canonical queue definitions, singleton keys, page/execution lease renewal, CAS completion, periodic recoverable-scan sweep | Memory/PG scan tests and disposable pg-boss singleton test PASS; production topology UNPROVEN | P1 bounded PASS |
| Page lease (`claimScanPage`) | External analyzer work | A lease expiry can allow a second worker while the first analyzer call is still executing; completion fencing must reject a stale worker | Owner/token CAS, periodic fenced renewal during analysis and final CAS | Memory/PG lease-renewal tests plus stale-completion and integrated worker suites PASS | P1 fixed in bounded path; process-freeze/network-partition topology remains UNPROVEN |
| Source queue | OSV/source analysis and encrypted artifact reads/deletes | Enqueue accepted/unknown must remain recoverable; DB must not claim failed and delete the only durable artifact if the message may exist | Stable `source:<id>` execution result/singleton, queued row and ciphertext preservation, same-key redelivery, execution lease renewal | Source unknown-outcome/replay and Memory/PG quota tests PASS | P1 fixed for acknowledgement ambiguity; in-flight resource deletion remains BL-021 |
| PDF queue | PDF artifact generation and result record | Duplicate job or ACK retry must not create two artifacts or overwrite another execution | Execution result job key, owner/token lease and terminal CAS, artifact path validation | Worker-handler/PDF tests; multi-process/ACK-loss proof UNPROVEN | P1/P2 |
| AI provider | OpenRouter/legacy provider generation and cost metadata | Provider success with lost HTTP response must be replayable; no fallback after known success; provider cost hard cap must not be bypassed by concurrent reservations | Stable usage idempotency, durable result metadata, settlement CAS, cache path; daily cost pre-check | `launch-api-wiring` retry/cache tests; global cost reservation is not atomic | P1 OPEN |
| Billing webhook receiver | External provider webhook and entitlement | At-least-once, delayed and reordered delivery must be safe; browser redirect cannot grant paid state | Signature, catalog/account/environment checks, event ledger, occurred-at ordering, acceptance completion | Unit/contract tests; real provider replay/out-of-order UNPROVEN | P0/P1 boundary |
| Webhook outbox | Report delivery to customer webhook | At-least-once delivery and retry must not claim success before external response; entitlement can disappear after queueing | Durable outbox, owner/token lease, retry/dead-letter, delivery entitlement recheck | `integrations.test.js` includes queue/entitlement suppression; receiver dedupe UNPROVEN | P2/P1 |
| OAuth callback | External provider token exchange | One-use state; workspace/user and entitlement must still be valid after provider round trip | State consume and post-exchange entitlement check | Integration tests; real provider/error replay UNPROVEN | P1 |
| Support email | External email notification | Email is at-least-once and must not be treated as the ticket transaction; duplicate email lower severity than duplicate grant | Derived event idempotency key passed to transport; notification audit is best effort | Support idempotency test; real email provider dedupe UNPROVEN | P2 |
| Auth email/reset/verification | Sensitive token delivery and consumption | Reset token single-use; session revocation on password reset; delivery retry cannot widen authority | Better Auth hooks, verification consume guard, reset session revocation | Live PostgreSQL reset race PASS; email provider delivery UNPROVEN | P1 |
| Retention executor | Source/worker artifacts and retention rows | Two maintenance processes must not execute the same workspace sweep concurrently | Path containment, process-local coalescing and PostgreSQL session advisory lock per workspace | Live PostgreSQL two-store overlap test PASS; role/retention lifecycle suites PASS | P2/P1 bounded PASS; artifact-reader overlap outside this lock remains UNPROVEN |
| Workspace deletion worker | Workspace children, artifacts and sessions | Deletion must be idempotent and must fence late worker writes | Deletion-run ledger/FK policies and role boundary | Deletion contracts; full concurrent worker proof UNPROVEN | P1 OPEN |
| Monthly reset/cleanup/reconciliation | Quotas, grants, stuck jobs, billing state | Duplicate schedule execution must be safe; exactly-once cron cannot be assumed | Some unique ledgers and idempotent updates; no one global scheduler lock proven | Maintenance tests are bounded; duplicate process run UNPROVEN | P1/P2 |

## 5. Database and state-machine audit

### 5.1 Constraints and transactional protections added/verified

The hardening migrations are deliberately narrow and compatible checks are intended to fail rather than silently reconcile ambiguous existing rows.

| Migration / evidence | Protection |
|---|---|
| `backend/db/migrations/027_launch_commercial_readiness.sql:82-112` | Provider/subscription identity, checkout acceptance identity, billing event ordering fields and acceptance uniqueness. |
| `backend/db/migrations/027_launch_commercial_readiness.sql:142-235` | Redeem code bounds, entitlement/redeem/credit foreign keys and checks, AI usage idempotency uniqueness, audit immutability. |
| `backend/db/migrations/032_business_logic_invariants.sql:4-60` | Operation key and request fingerprint columns/partial unique indexes for projects, scans, credit adjustments, grants, redemptions, redeem-code creation, source inputs and support messages. |
| `backend/db/migrations/032_business_logic_invariants.sql:64-112` | Unique Better Auth membership and advisory-lock-backed seat trigger. The final-seat race has live disposable PostgreSQL evidence. |
| `backend/db/migrations/033_checkout_intent_serialization.sql:1-25` | Bounded historical open intents and partial unique one-open-checkout intent per workspace. Existing duplicate open intents fail migration for manual reconciliation. |
| `backend/db/migrations/034_support_ticket_request_fingerprint.sql` | Durable request fingerprint on support tickets so the same operation key cannot be replayed with a different body. |
| `backend/db/migrations/035_checkout_setup_lease.sql` | Owner/token/expiry fence for provider checkout setup, allowing one caller and bounded recovery after an ambiguous failure. |
| `backend/platform/store.js:2423-2474` | Billing event insertion, row lock, event replay detection and occurred-at/state comparison in the PostgreSQL store. |
| `backend/platform/store.js:3317-3378` | PostgreSQL scan-page completion and credit settlement in one transaction with scan/page row locks and lease-owner/token checks. |
| `backend/platform/store.js:3230-3272` | PostgreSQL page/credit insertion under a workspace advisory transaction lock, deduped page keys and atomic limit accounting. |

These constraints do not prove that every legacy route, worker or external provider path supplies the correct operation key. Missing operation context is called out as an audit finding rather than assumed safe.

### 5.2 State transitions

Checkout acceptance is intended to move only as follows:

```text
accepted -> checkout_created -> completed
accepted -> expired | cancelled
checkout_created -> expired | cancelled | completed
completed / expired / cancelled -> terminal (same-state replay only)
```

Scan and page state transitions are guarded by expected status, owner/token and terminal-state checks. A cancellation or completion that loses the compare-and-set returns no successful mutation; page credit settlement is tied to the terminal commit. Page and source/PDF execution leases are periodically renewed by the fenced owner. A process freeze or network partition can still spend external work before the final CAS rejects a stale result, so this is not an exactly-once external-side-effect claim.

Billing event state is ledger-first and uses provider event IDs plus occurred-at ordering. The browser acceptance/redirect is not itself a paid entitlement source. Temporary grants remain separate from the provider subscription and are composed by deterministic effective-plan ordering; Memory/PostgreSQL commercial and plan suites passed. Real provider/admin interleaving in a deployed topology remains UNPROVEN.

## 6. Adversarial findings ledger

| ID | Domain | Invariant | Attack / failure scenario | Current protection | Test | Result | Severity | Fix | Residual risk |
|---|---|---|---|---|---|---|---|---|---|
| BL-001 | Checkout | One logical checkout has one acceptance/provider intent | Buy twice, two tabs or retry after lost response | Operation key/fingerprint, one-open partial unique index, 30-minute expiry, active subscription guard and setup lease | Checkout API + commercial Memory/PG tests | PASS bounded; real provider UNPROVEN | P1 | Implemented in app/store/migrations 032/033/035 | Real provider idempotency and deployment concurrency UNPROVEN |
| BL-002 | Checkout | Same key cannot change plan/body | Reuse key with a different plan or terms | Persisted request fingerprint and provider acceptance identity | Checkout API/provider tests | PASS | P1 | Implemented | Historical deployment data must pass migration preconditions |
| BL-003 | Billing lifecycle | Browser success cannot grant paid entitlement | Redirect before/during webhook; duplicate webhook | Provider event ledger and acceptance completion after applied paid event | Provider/billing/integrated tests | PASS bounded; real provider UNPROVEN | P0/P1 boundary | Implemented provider binding and event ordering | Real provider payload/account/catalog proof absent |
| BL-004 | Billing ordering | Older event cannot regress newer state | `subscription.updated`/created arrives out of order | occurred-at and event-ID comparison in store | Provider unit/integrated tests | PASS bounded | P1 | Implemented | Provider clock/version semantics and deployment topology UNPROVEN |
| BL-005 | Project quota | Concurrent creates cannot exceed project limit | Two requests at final project slot | Operation lock/transaction and unique logical key | Scan Memory/PG tests | PASS | P1 | Implemented | Legacy API does not create SaaS projects |
| BL-006 | Scan creation | Retry cannot create/bill a second scan | Same key, two tabs, response lost after enqueue | Scan operation fingerprint, unique key, stable queue singleton, recovery sweep | Scan Memory/PG tests | PASS | P1 | Implemented | Different keys intentionally remain separate actions |
| BL-007 | Scan queue | Unknown enqueue result is recoverable | Queue accepts job but API sees timeout/exception | Stable scan row/singleton and recovery sweep | Scan Memory + pg-boss/integrated tests | PASS bounded | P1 | Implemented | Production broker/process topology UNPROVEN |
| BL-008 | Scan terminal settlement | Cancel/complete cannot double-consume or leave reserved credit | Worker completes while admin cancels | Terminal CAS and page+credit transaction | Scan Memory/PG tests | PASS | P1 | Implemented | A stale worker may spend external work before losing CAS |
| BL-009 | Page lease | Expired lease cannot duplicate a committed result or silently let a stale owner win | First worker is slow/stalled; second worker claims after lease expiry | Owner/token completion fence plus periodic renewal while analysis runs | Lease Memory/PG, stale completion and integrated worker tests | PASS bounded | P1 | Implemented heartbeat/fenced renewal | Process freeze/network partition can still duplicate external spend before one commit loses |
| BL-010 | AI global cost | Concurrent requests cannot bypass hard daily provider-cost cap | Two requests both pass `dailyAiCost()` before either settles | Per-workspace AI quota lock; pre-check at app boundary | `launch-api-wiring` hard-limit test covers sequential pre-check | OPEN/UNPROVEN | P1 | Requires atomic/reserved cost authority or explicit accepted cap semantics | Provider-reported cost arrives after generation; cross-process race remains |
| BL-011 | AI retry/lost response | A completed provider result is replayable without a second provider call | Provider succeeds; HTTP response is dropped; client retries | Stable usage key; durable result in usage metadata; settlement idempotency | Launch API cache-write failure/retry test | PASS | P1 | Implemented durable result fallback | Provider success with an ambiguous upstream network failure remains provider-dependent |
| BL-012 | Redeem | Max global/per-workspace redemption and grant are atomic | Two workspaces redeem last code; same workspace replays | Code locking/transaction, operation fingerprint and unique indexes | Commercial idempotency + redeem core tests | PASS Memory/live PG | P1 | Implemented in store/migration | Historical duplicate data must pass migration preconditions |
| BL-013 | Source upload | Unknown queue outcome is recoverable, not falsely failed/deleted | `queue.send` may have accepted job then throws | Stable execution job/singleton; queued row, ciphertext and execution identity are retained and redelivered | Source unknown-outcome/replay + Memory/PG quota tests | PASS | P1 | Implemented recovery-safe policy | In-flight suspension/deletion is still covered by BL-018/021 |
| BL-014 | Support | One operation creates one message and notification attempt | Double reply or email retry | Operation key/fingerprint, transition intent and derived notification key | Support service/store/UI tests | PASS Memory/live PG/browser contract | P2 | Implemented service/store/UI plumbing + migration 034 | Real email provider dedupe and opposing admin transitions UNPROVEN |
| BL-015 | Admin credit/grant | One logical admin click has one ledger/grant row | +100 form submit duplicated | Stable operation key/fingerprint and unique indexes | Commercial idempotency test | PASS Memory/live PG | P1 | Implemented | Ban/suspend/revoke are convergent but lack the same universal operation ledger |
| BL-016 | Membership | Final seat cannot be claimed twice | Two accepts at one remaining seat | Advisory lock + trigger + unique membership | `postgres-business-logic-invariants.test.js` | PASS live disposable PG | P1 | Implemented migration 032 | Other membership/invitation routes and production role permissions UNPROVEN |
| BL-017 | Auth reset | One reset token has one winner and password reset revokes sessions | Same token concurrently; old session remains usable | Better Auth consume guard, reset session revocation, banned-user fail-closed hook | `postgres-business-logic-invariants.test.js`, auth boundary tests | PASS live disposable PG / focused | P1 | Implemented | Email delivery/retry and production Better Auth deployment UNPROVEN |
| BL-018 | Suspension/ban | Queued protected work cannot start/commit after state changes | Suspend/ban while scan/source/webhook is in flight | Server-side rechecks in scan phases and integration delivery; auth hooks | Scan/integration/auth tests | Partial PASS; complete worker matrix UNPROVEN | P1 | Partially implemented | Source/PDF and destructive lifecycle races are not all proven across long external calls |
| BL-019 | Retention | Duplicate maintenance cannot run the same workspace sweep concurrently | Two maintenance processes overlap | Process coalescing, path containment and session advisory lock per workspace | Retention overlap + role/lifecycle tests | PASS live PG | P2/P1 | Implemented distributed exclusion | Artifact-reader coordination outside the sweep lock remains UNPROVEN |
| BL-020 | Reports | Same completed scan does not create duplicate report artifacts | Generate/finalize retry or two workers | `saveReportOnce`, execution-result job key, owner/token lease and versioned report writes | Report/PDF/worker/integrated tests | PASS bounded | P2/P1 | Existing dedupe and lease renewal verified | Report delivery/retention with deployed object storage remains UNPROVEN |
| BL-021 | Deletion | Destructive delete is repeat-safe and fences late writes | Workspace/project deleted while worker references it | FK/cascade policies and some state checks | Legal/deletion contracts | OPEN/UNPROVEN | P1 | Needs bounded worker/deletion race test and accepted fence behavior | Late artifact cleanup or worker write can still be topology-dependent |
| BL-022 | Crawler | One logical URL consumes one page credit | Sitemap/link discovery duplicates, spelling variants, cycles | URL normalization, page key dedupe, page/credit transaction | Crawler and scan tests | PASS for bounded normalization cases; full adversarial matrix UNPROVEN | P1/P2 | Existing bounded dedupe | Canonical/redirect semantics and huge generated calendars require broader proof |
| BL-023 | Legacy mutation paths | Legacy analyze/solve/summary do not bypass modern correctness | Retry or two tabs call `/api/analyze` or `/api/solve` | Production legacy routes are disabled by default; explicit enablement requires API keys | Security/runtime tests PASS for the disabled launch default | Out of default launch scope; enabled mode UNPROVEN | P1 | Explicitly excluded unless separately accepted | If enabled, provider/analysis effects may duplicate |
| BL-024 | Scheduled jobs | Duplicate reset/reconciliation/stuck-job runs are harmless | Two maintenance containers execute the same scheduled action | Retention now has a per-workspace lock; other jobs use mixed ledgers/claims | Retention PASS; full scheduled-job matrix absent | OPEN/UNPROVEN | P1/P2 | Retention portion fixed | Exactly-once cron is not assumed for every reconciliation/reset |

### 6.1 P0/P1/P2/P3 disposition counts

Each finding is assigned one primary severity and one primary final disposition for the counts below. A bounded PASS may still carry an explicitly stated provider/deployment residual; those residuals are not silently promoted to PASS.

| Severity | Confirmed FAIL | Fixed/PASS | OPEN | UNPROVEN | Final count owner |
|---|---:|---:|---:|---:|---|
| P0 | 0 | 0 | 0 | 1: BL-003 real-provider boundary | Root finalized |
| P1 | 0 remaining confirmed failures | 14: BL-001/002/004-009/011-013/015-017 | 3: BL-010, BL-021, BL-023 if enabled | 2: BL-018, BL-024 | Root finalized |
| P2 | 0 | 4: BL-014, BL-019, BL-020, BL-022 | 0 | External email/object-storage/opposing-transition residuals remain bounded UNPROVEN notes | Root finalized |
| P3 | 0 | 0 | 0 | 0 | Root finalized |

## 7. Implemented hardening recorded in this branch

The following are source/test changes observed within this audit scope. They are listed as implementation evidence, not as a claim that all residual risks are closed.

- `backend/domain/idempotency.js`: canonical request fingerprinting and safe key normalization; mismatched replay returns a deterministic conflict.
- `backend/app.js`: operation context for checkout, redeem, project, scan, AI, source and admin credit/grant/redeem operations; checkout acceptance-before-provider flow; active subscription and terminal-state checks; durable AI result fallback; server file fingerprinting.
- `backend/platform/store.js` and `backend/platform/service.js`: operation replay paths, checkout setup claim/release, project/scan/source limits, terminal scan/page/credit CAS, page/execution lease renewal, workspace execution checks, stable queue singleton/recovery paths, support operation binding, retention advisory locking and billing event state handling.
- `backend/billing/provider.js`, `backend/billing/paddle.js`, `backend/billing/stripe.js`: persisted checkout acceptance identity, provider/account/environment/catalog checks, bounded retry identity and acceptance completion after paid webhook application.
- `backend/db/migrations/032_business_logic_invariants.sql`, `033_checkout_intent_serialization.sql`, `034_support_ticket_request_fingerprint.sql` and `035_checkout_setup_lease.sql`: operation fingerprints/unique indexes, seat trigger/advisory lock, one-open-checkout intent, support request binding and checkout setup fencing.
- `backend/auth/better-auth.js`: password-reset session revocation and fail-closed banned/verification/suspension hooks.
- `backend/integrations/service.js`: entitlement checks before OAuth finish/provider upsert and before webhook queue/delivery.
- `backend/source/service.js` and `backend/support/service.js`: source quota/file fingerprinting, unknown-queue-outcome preservation/redelivery, support operation fingerprints, transition intent and notification suppression.
- `backend/platform/worker-handler.js`: owner/token execution-lease renewal for source/PDF work and cross-process retention coordination through the store.
- `website/src/portal/UserDashboard.tsx`, `website/src/portal/AdminOperationsConsole.tsx` and `website/src/portal/supportApi.ts`: stable operation keys retained across network failures and sent as `Idempotency-Key`; UI is supplementary only.

No new analyzer, plan, external provider, infrastructure platform or product concept was added by this audit. Real provider calls, uploads, publishing, deployment and secrets were not authorized or performed.

## 8. Idempotency, state and failure-window map

### 8.1 Checkout

```text
client key/body
  -> validate plan + active subscription
  -> persist acceptance + fingerprint + expiry
  -> call provider with persisted identity
  -> provider webhook ledger (at-least-once)
  -> apply subscription/entitlement exactly once by event identity/order
  -> mark acceptance completed
```

The important remaining failure window is real provider behavior and the deployment/account/catalog authority. A browser redirect is intentionally not part of the entitlement source of truth.

### 8.2 Scan creation and execution

```text
operation key/body
  -> validate workspace/project/entitlement
  -> persist one scan + pages/credits
  -> enqueue stable scan/page singleton
  -> claim page lease owner/token
  -> analyze
  -> re-check workspace/verification
  -> terminal page + credit settlement in one DB boundary
  -> finalize one report / terminal scan CAS
```

Queue-send uncertainty is recoverable for the scan path through a durable queued row and recovery sweep. The source path still uses a destructive failure compensation after an enqueue exception (BL-013). A lease-expiry heartbeat/fencing proof is not present (BL-009).

### 8.3 AI

```text
stable operation key
  -> cache lookup (when not refresh)
  -> monthly quota reservation under store lock/transaction
  -> provider call
  -> terminal usage settlement with result metadata
  -> cache write (best effort, durable usage replay remains)
```

The provider retry/lost-response path is covered for one request key. The global daily cost check is a read-before-provider operation and is not an atomic cross-process cost reservation (BL-010).

### 8.4 Redeem/admin credits/grants

```text
operation key/body
  -> lock code/workspace operation
  -> validate time/active/max counters
  -> insert redemption + grant/credit ledger + audit in one boundary
  -> replay returns original row
```

The disposable PostgreSQL replay contract passed. This remains disposable-database evidence and is not production proof.

## 9. Deterministic adversarial tests

The branch includes or updates the following reproducible tests. The final integrated command completed with every environment guard enabled: `367/367 PASS`, `0 FAIL`, `0 SKIP`.

| Test file | Adversarial coverage | Required evidence |
|---|---|---|
| `backend/test/business-logic-checkout-api.test.js` | Missing key; same key/different body; concurrent same key; concurrent different keys/one open intent; active subscription; duplicate paid webhook after acceptance completion | Provider invocation count, status/error code, one acceptance/event/grant |
| `backend/test/business-logic-billing-provider.test.js` | Active/grace/paid checkout guard; provider-scoped key; persisted acceptance identity; account/environment/catalog checks | No provider call on invalid state; deterministic conflict |
| `backend/test/business-logic-commercial-idempotency.test.js` | Memory/PG checkout setup claim, credit adjustment, entitlement grant and redeem replay/body mismatch | One provider setup owner and one ledger/grant/redemption; changed body conflict |
| `backend/test/business-logic-scan-memory.test.js` | Project limit/replay; scan replay; cancelled terminal; page-credit atomic settlement; unknown queue outcome; recovery; suspension | One scan/queue/audit/credit side effect and safe terminal state |
| `backend/test/business-logic-scan-postgres.test.js` | PostgreSQL project/scan replay and terminal page credit settlement | Live disposable PG result; no skipped test when `TEST_DATABASE_URL` is set |
| `backend/test/business-logic-source-idempotency.test.js` | Source fingerprint/options, atomic monthly quota, duplicate queue side effect and unknown acknowledgement recovery | One source/execution/singleton, retained ciphertext and safe redelivery |
| `backend/test/business-logic-support-idempotency.test.js`; `business-logic-support-store.test.js`; `business-logic-support-ui-contract.test.js` | Operation binding, changed-body rejection, transition intent, notification replay suppression and retry-stable browser key | One ticket/message/notification intent |
| `backend/test/business-logic-lease-heartbeat.test.js` | Memory/PG page and source/PDF execution lease renewal | Only the owner/token can extend a lease |
| `backend/test/business-logic-retention-lock.test.js` | Two PostgreSQL stores race the same retention sweep | Exactly one cross-process winner for the workspace |
| `backend/test/postgres-business-logic-invariants.test.js` | Final seat race; reset token race/session revocation | One membership winner; one reset winner; all sessions revoked |
| `backend/test/business-logic-auth-boundary.test.js` | Banned/missing account fail-closed hooks, reset/verification matcher and workspace route matcher | No sensitive transition under stale/banned state |
| `backend/test/launch-api-wiring.test.js` | AI provider failure settlement; lost/cache-write response replay; hard daily pre-check | One provider call for same key; failed reservation not counted |
| `backend/test/integrations.test.js` | Outbox delivery lease, entitlement loss before delivery, OAuth one-use state | No false delivered result; no delivery after entitlement loss |
| `backend/test/postgres-maintenance-boundary.test.js` | Worker/maintenance least privilege and due-deletion lifecycle | `4/4 PASS` against disposable role-specific URLs |
| `backend/test/real-chrome-visual.test.js` | Desktop/mobile coordinate evidence and rendered-link collection | `2/2 PASS` in local Chrome |
| Website targeted Playwright | Admin operation and support flows under Chromium/mobile/compact/reduced-motion | `36/36 PASS`; local mocked/API-contract boundary |
| Existing crawler/platform/report/retention suites | URL normalization, leases, report versioning, artifact/maintenance boundaries | Integrated suite green; provider/deployment scenarios remain separate |

## 10. Final gate — explicit answers

The required 18 questions are answered conservatively. `UNKNOWN` or `YES` for any P0/P1 question keeps the verdict `DO NOT MARK LAUNCH READY`.

| # | Question | Final answer | Evidence / blocker |
|---:|---|---|---|
| 1 | Can a double click charge twice? | `UNKNOWN` for real provider; `NO` for bounded acceptance/provider contract | App/migration/provider tests; live provider replay not run |
| 2 | Can a retry consume two scan credits? | `NO` in the audited SaaS scan paths | Same-key Memory/PG replay and atomic page-credit settlement PASS |
| 3 | Can two simultaneous scans bypass a one-credit limit? | `NO` in the audited Memory/PostgreSQL paths | Workspace/page-credit locks and concurrent tests PASS |
| 4 | Can a Paddle webhook replay grant twice? | `NO` in the signed event-ledger contract; real delivery remains `UNPROVEN` | Duplicate event and acceptance-completion tests PASS; no live Paddle account |
| 5 | Can out-of-order Paddle events regress subscription state? | `NO` in the occurred-at/event-ID store contract; deployed semantics remain `UNPROVEN` | Provider/store ordering suites PASS; no live replay |
| 6 | Can a redeem code exceed its maximum under concurrency? | `NO` in the audited live-PostgreSQL path | Code row locking, limits and replay contract PASS |
| 7 | Can two admin credit grants occur from one logical action? | `NO` for the required keyed adjustment path | Operation fingerprint/unique index and Memory/PG commercial tests PASS |
| 8 | Can one password-reset token succeed twice? | `NO` in live disposable PG reset race | `postgres-business-logic-invariants.test.js` PASS |
| 9 | Can the same AI request incur duplicate quota/cost from retry? | `NO` for same-key quota/result replay; actual upstream cost remains `UNKNOWN` after an ambiguous provider failure and under the global concurrent cap | Durable result/settlement tests PASS; BL-010 OPEN |
| 10 | Can one failed queue acknowledgement execute an analysis twice? | `NO` for the bounded scan/source singleton and DB-commit contract; production external execution remains `UNKNOWN` under crash/partition | Unknown-outcome, pg-boss singleton, lease renewal and CAS tests PASS |
| 11 | Can cancel and complete corrupt scan state? | `NO` in the audited state machine | Terminal scan/page CAS and atomic credit settlement PASS |
| 12 | Can a free user race two requests to bypass quota? | `NO` for audited project/scan/source/AI-monthly/seat limits; complete optional/legacy surface remains `UNKNOWN` | Memory/live-PG quota tests PASS; no universal endpoint proof |
| 13 | Can a seat/project quota be bypassed concurrently? | `NO` in the audited PostgreSQL path | Live final-seat trigger and concurrent project tests PASS |
| 14 | Can scheduled maintenance executing twice corrupt state? | `NO` for retention; `UNKNOWN` for every other reset/reconciliation schedule | Live retention overlap test PASS; BL-024 remains open |
| 15 | Can stale browser state override server truth? | `NO` for audited scan/billing/source/integration gates; universal legacy/admin coverage remains `UNKNOWN` | Server rechecks and targeted browser tests PASS |
| 16 | Can retry after lost HTTP response repeat a non-idempotent action? | `NO` for audited keyed core mutations; `YES/UNKNOWN` for explicitly enabled legacy and unkeyed residual mutations | Stable UI keys + durable store replay do not cover every mutation |
| 17 | Can deleted/suspended resources still be mutated by running workers? | `UNKNOWN` | Some scan/integration fences exist; deletion and every worker path not proven |
| 18 | Can billing state and temporary entitlements produce impossible combinations? | `NO` in deterministic local composition; real provider/admin interleaving remains `UNKNOWN` | Separate base/grant records and ordering suites PASS; no deployed concurrent provider proof |

Because questions 1, 9–10, 12, and 14–18 retain `UNKNOWN`/open P1 boundaries, this audit must not be labeled launch-ready.

## 11. Required final report A–L

The root agent's final response should reproduce these sections with final numbers and no stronger claim than the evidence supports:

**A. All invariants audited** — checkout, billing/webhook, credits/quotas, scan creation/execution, report generation, AI, redeem, admin operations, ban/suspension, auth/email, membership, scheduled jobs, integrations, crawler, source upload, support, delete, plan composition, DB constraints, TOCTOU, failure windows, UI/multi-tab/lost-response boundaries.

**B. P0 findings** — confirmed bounded count and explicit provider/security UNPROVEN boundaries.

**C. P1 findings** — fixed vs OPEN/UNPROVEN. BL-009 and BL-013 are bounded PASS; BL-010, BL-018, BL-021, BL-023-if-enabled and BL-024 remain the conservative boundaries.

**D. P2/P3 findings** — support/notification/report/retention/UI residuals and accepted P3 noise.

**E. Fixes implemented** — exact files and tests; do not count a delegated report as acceptance without inspecting the code and test output.

**F. Database constraints added** — migrations 032/033/034/035 plus existing 026/027/030/031 constraints and live disposable migration evidence.

**G. Idempotency mechanisms** — operation key, request fingerprint, store replay, unique indexes, event ledger, singleton queue key, execution lease and UI retry key; note uncovered routes.

**H. State-machine changes** — checkout terminal states, scan/page CAS/lease, billing event ordering, reset token/session boundary, support transitions.

**I. New concurrency tests** — list each test file/name, environment, exact pass/fail/skip and whether it is Memory, disposable PostgreSQL, pg-boss, browser or real provider.

**J. Test totals** — `npm run check` PASS; focused adversarial `42/42`; website Playwright `36/36`; final integrated backend `367/367`, `0 FAIL`, `0 SKIP`.

**K. Remaining launch blockers** — any P0/P1 YES/UNKNOWN, real provider/deployment proof, deletion/worker/scheduled-job/explicit-legacy/global-cost gaps. Page lease, source queue acknowledgement and retention overlap are no longer listed as open bounded defects.

**L. Known acceptable residual risks** — only bounded P2/P3 or explicitly non-production/manual boundaries after P0/P1 are closed; never relabel an open P1 as acceptable.

## 12. Final principle

The application is only ready for a stronger claim when the final evidence demonstrates the intended behavior under double-click, retry, lost response, worker crash, repeated/out-of-order webhook, two-tab stale state and simultaneous requests. Until then, the accurate result is **DO NOT MARK LAUNCH READY**.
