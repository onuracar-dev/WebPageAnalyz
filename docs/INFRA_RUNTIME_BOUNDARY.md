# Runtime and execution boundary

This document describes the local Compose boundary. It is an implementation
contract, not proof of a deployed network policy or a full browser-sandbox
certification.

## Topology

```text
browser -> frontend -- app-internal --> backend(API)
                                      |
                                      +-- data-internal --> postgres
                                      +-- app-internal --> ai-service -- ai-egress --> OpenRouter
                                      +-- app-internal --> email-service -- email-egress --> Resend
                                      \-- billing-egress --> Paddle

analysis-worker -- data-internal --> postgres
                \- analysis-egress --> public target / ZAP

maintenance-worker -- data-internal --> postgres
                  \- source-staging + worker-results (lifecycle cleanup only)

db-bootstrap -> postgres (administrator, one-shot)
db-migrate   -> postgres (wpa_migrator + wpa_queue, one-shot)
db-grants    -> postgres (administrator, one-shot)
```

The API image intentionally does not install Chromium, `chromium-sandbox`, or
OSV Scanner. Its Compose role is `api`, `WORKER_ENABLED=false`, and it is not
attached to the analysis, AI, or email egress networks. The API has only the
credentials needed for its role (database runtime role, Better Auth, Paddle,
internal AI/email service tokens, optional OAuth, and source-at-rest
encryption). The OpenRouter and Resend API keys exist only in their isolated
services and none of these credentials may be copied into a worker environment.

The worker image is the only application image with Chromium, the Chromium
setuid helper, and OSV Scanner. It runs as `node` with a read-only root
filesystem, bounded tmpfs/artifact volumes, all Linux capabilities dropped,
`no-new-privileges`, explicit CPU/memory/PID limits, and no auth/Paddle/Stripe/
OAuth/OpenRouter/Resend/API-key secrets. It receives only the worker database role, the source
encryption key when a source job requires it, and the ZAP API key when passive
security is enabled. `analysis-egress` is the only network with external
egress; production still needs a host/cloud firewall rule denying metadata,
private, loopback, link-local, and other non-public target ranges.
Worker startup checks `current_user` against `DATABASE_EXPECTED_ROLE` and exits
on a mismatch; production worker startup rejects any expected role other than
`wpa_worker` (and the API application rejects any role other than
`wpa_runtime`).
The API and worker share only the encrypted `source-staging` volume for the
source lifecycle; the worker has `rw` permission because it must unlink the
ciphertext after processing. That volume contains no API/auth/provider
credentials and is not mounted into ZAP.

The `maintenance-worker` is a separate no-browser image and process. It runs
as `node` with `EXECUTION_ROLE=maintenance`, `DATABASE_EXPECTED_ROLE=wpa_maintenance`,
all hostile execution flags disabled, no queue or analysis-egress network, and
no auth, provider, source-encryption, ZAP, Chromium, or OSV secrets. Its role
has only the lifecycle tables plus the narrowly-scoped `DELETE` privileges
needed for retention and a confirmed, authorized workspace deletion. The
analysis worker receives no retention/deletion-table grants and does not start
the retention executor; it can never perform account deletion by queue or
configuration alone.

## Job contract required from the application runtime

The API must enqueue a bounded, authenticated job envelope rather than invoke
browser/source/PDF/OSV code in the API process:

```json
{
  "jobId": "opaque-id",
  "kind": "scan | page | source | pdf",
  "workspaceId": "opaque-id",
  "targetUrl": "https://verified.example/",
  "encryptedReference": "encrypted-artifact-reference",
  "reportId": "opaque-id",
  "capabilityContractVersion": "wpa.worker-job.v1",
  "deadlineAt": "2026-08-14T12:00:00.000Z",
  "attempt": 1
}
```

Only the fields required by a job kind may be populated. The worker must
validate ownership, target origin, deadline, capability contract, and attempt
before execution; write an immutable result/error with worker image/version
metadata; and settle the job idempotently. PDF output is a worker result file
with a bounded, allowlisted path below `WORKER_RESULT_DIR`. Compose mounts the
dedicated `worker-results` volume read-write in the worker and read-only in the
API; it is separate from the worker's private analyzer-artifact volume. The
API result adapter may read only the bounded file after the durable result
reaches `completed`.
No auth session, OAuth refresh token, Paddle/Stripe secret, OpenRouter/Resend key, or API key is
part of the envelope.

The application currently reserves these queue names: `wpa-scan`,
`wpa-scan-page`, `wpa-source-audit`, and `wpa-pdf-export`. There is deliberately
no independent OSV queue: OSV is the source-audit engine and runs inside the
same fenced `wpa-source-audit` lifecycle after the encrypted ZIP has passed
inspection and extraction. This keeps ownership, result settlement, artifact
cleanup, and retries in one source-audit contract. The result envelope must
carry the same `jobId`, `kind`, `workspaceId`, status, bounded artifact
reference, and worker image/version metadata, with idempotent settlement and
no auth/provider secrets. `WORKER_HANDLER_MODULE` is the explicit hand-off
point for the application owner's durable scan/page/source/PDF lifecycle.
Compose sets it to `/app/platform/worker-handler.js`; the handler is
application-owned and must remain covered by its queue/result tests.
Deployment proof still needs an end-to-end disposable queue run for each
lifecycle path.

## Chromium boundary

The worker entrypoint fails closed when `CHROME_NO_SANDBOX` is any common
truthy spelling (`1`, `true`, `yes`, or `on`), when the
Chromium binary is absent, or when `/usr/lib/chromium/chrome-sandbox` is not
root-owned and setuid. No blanket `CHROME_NO_SANDBOX=true` is present in
Compose. It then runs a bounded `about:blank` launch without a
`--no-sandbox` escape; a non-zero exit or timeout stops the worker before it
consumes jobs. Docker Desktop, rootless engines, custom seccomp profiles, or a
host kernel may still prevent Chromium's user/setuid namespace sandbox. The
metadata and launch checks are fail-closed prerequisites, not a claim of full
sandbox proof; deployment-specific kernel, seccomp, and escape testing remains
required. The worker selects `infra/seccomp/playwright-worker.json`, the
official Microsoft Playwright profile pinned in `infra/seccomp/README.md` at
commit `ae935a43d9e376e4759548f6b3c6905c7b282333` (normalized SHA-256
`17e2d449ab7c2c6fefc5b9f978224a49929864eb1d5a42f4f9002266c9300de2`). It
retains Docker's deny-by-default policy and adds only the documented
user-namespace `clone`, `setns`, and `unshare` entries. The profile is selected
only by `analysis-worker`; API, database, maintenance, and ZAP services retain
their own default boundary.
On the current Docker Desktop engine the constrained probe exits
`WORKER_SANDBOX_UNAVAILABLE` because the Chromium PID namespace operation is
denied (`Operation not permitted`) under the default seccomp/no-new-privileges
boundary. The host kernel still rejects the exact Chromium zygote
probe (`sys_chroot("/proc/self/fdinfo/") == 0`, `No such file or directory`)
under the profile plus NNP/cap-drop/read-only boundary. Do not loosen this to `seccomp=unconfined`,
`SYS_ADMIN`, or `--no-sandbox`; deploy only on an engine with
Chromium-compatible user/PID namespace support. The worker therefore remains
fail-closed until a compatible host/kernel combination passes this probe; no
bypass is claimed and no scan job is consumed on the failing Docker Desktop
host.

## Database authority

`db-bootstrap` creates `wpa_owner` (NOLOGIN), `wpa_migrator`, `wpa_runtime`,
`wpa_worker`, `wpa_maintenance`, and `wpa_queue` roles. The `postgres` administrator credential is
used only by the one-shot bootstrap/grant containers. `db-migrate` takes a
PostgreSQL advisory lock, verifies the expected role and TLS policy, applies
numbered migrations in transactions with statement/lock timeouts, and records
SHA-256 checksums in `wpa_schema_migrations`. Missing or changed checksums,
ledger residue, and old unverified ledger rows fail closed.

Production Compose defaults all role-scoped URLs to `sslmode=require`, sets
certificate verification on, and defaults `MIGRATION_REQUIRE_TLS=true`. The
checked-in `production.environment.template` uses those production-safe values. Plaintext is
available only through the explicit `docker-compose.local.yml` development
overlay, which sets `NODE_ENV=development`, `MIGRATION_REQUIRE_TLS=false`, and
`sslmode=disable` for the bundled local Postgres. Production operators should
use `require` or preferably `verify-full` with a trusted CA; the migrator
rejects a production connection that does not meet that policy.

The pg-boss schema is created by the explicit `db:bootstrap` step using the
queue role. Runtime queue startup uses `migrate:false`; it must not create or
alter pg-boss schema tables. `db-grants` grants the API broad application-table
DML and grants the worker only SELECT/INSERT/UPDATE on the scan/source/report
execution tables and queue-row DML; the worker has no DELETE on event history,
reports, source inputs, or execution results. Event trimming is best-effort
only for roles that own that table, so a worker privilege failure cannot fail a
scan or cross a workspace boundary.
`wpa_maintenance` receives the retention/deletion lifecycle DELETE authority and
no queue access. Existing shared databases are not changed by this code until an
operator explicitly runs the bootstrap/migration/grant sequence.

Compose passes `DATABASE_EXPECTED_ROLE=wpa_runtime` to the API; the API
application owner must enforce that value during its own startup before this is
runtime acceptance evidence.

## Drift evidence

`npm run runtime:drift -- --source-root <backend> --runtime-root <container-app>`
is read-only. It compares normalized source/runtime file hashes and verifies
the migration ledger checksums/version when `DATABASE_URL` is supplied. The
source manifest explicitly classifies Docker-intentional exclusions (tests,
test output, local `.env*` files, dependency trees, and mounted runtime
directories) in `sourceIntentionalExclusions`; an omitted deployable file or
runtime-only file still produces `FAIL`. The image-root fixture in
`backend/test/runtime-drift-infra.test.js` proves both the accepted exclusions
and a real missing-runtime-file failure. Without `--runtime-root`, the command
exits non-zero with `UNPROVEN`; CI's explicit `--source-only --skip-database`
mode is the only exception and still reports `UNPROVEN` rather than `PASS`. A
deployed database check must provide `connect_timeout`, statement/lock/idle
timeouts, and `sslmode=require` (or stronger) in its role-scoped URL.

## AI, billing, and email provider boundaries

The API reaches Paddle only through `billing-egress`; it owns the Paddle API
and webhook secrets but has no OpenRouter or Resend key. It reaches
`ai-service` and `email-service` over `app-internal` with separate internal
bearer tokens. `ai-service` is the only container with `OPENROUTER_API_KEY` and
`email-service` is the only container with `RESEND_API_KEY`; neither service
has database, Better Auth, Paddle, browser, ZAP, source archive, or customer
session secrets. Compose networks are not hostname-aware firewalls, so the
Ubuntu host/cloud firewall must enforce provider egress policy.

Production requires `EMAIL_PROVIDER=resend` and
`EMAIL_DELIVERY_ENABLED=true`. The internal email contract allowlists
verification, reset, support, security, and subscription templates; validates
recipient/callback/idempotency data; and uses bounded timeout, concurrency and
response size. Tests use injected providers and make no real send. A live
sender-domain/SPF/DKIM and delivery test remains deployment evidence, not a
repository claim.
