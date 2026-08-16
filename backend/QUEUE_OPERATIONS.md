# Queue schema operations

The API and worker construct pg-boss with `migrate: false`; runtime startup never creates or alters queue schema/tables. The one-shot `npm run db:bootstrap` release step runs the pg-boss migration and idempotently registers the four canonical queue rows (`wpa-scan`, `wpa-scan-page`, `wpa-source-audit`, and `wpa-pdf-export`) from `platform/execution-boundary.js`. A missing or stale queue schema/row is an operational failure and must not be repaired implicitly by customer traffic. Re-running `npm run db:bootstrap` is safe after the ownership/grant step because queue registration is bounded row/function DML, while schema CREATE/ALTER/DROP remains revoked.

Application-owned isolated work uses the `wpa.worker-job.v1` envelope from
`platform/execution-boundary.js`. `kind` is one of `scan`, `page`, `source`, or
`pdf`; the source handler owns the OSV pass inside the same `wpa-source-audit`
execution, with the source-input ID as its singleton key. There is deliberately
no separate OSV queue or producer, preventing duplicate source scans. API processes enqueue only and workers must validate the envelope before
consuming it. A worker must persist a terminal result or explicit failure code
before acknowledging a job; the API never reports provider or renderer success
merely because enqueue succeeded. The application handler is
`platform/worker-handler.js`, loaded with `WORKER_HANDLER_MODULE=platform/worker-handler.js`
(or the Compose absolute equivalent `/app/platform/worker-handler.js`).
It exports `startWorker({config, logger, workerKind})` and registers
`wpa-scan`, `wpa-scan-page`, `wpa-source-audit`, and `wpa-pdf-export`; scan/page handlers reuse the fenced `PlatformService`
lease, progress, credit, report, retry, and DNS-revalidation lifecycle. Source/OSV consume
encrypted files from the shared `SOURCE_ARTIFACT_DIR` volume (the Compose
contract mounts this at `/app/logs/source-inputs`); PDF results
are written with 0600 permissions below `WORKER_RESULT_DIR/pdf/<executionId>.pdf`.
The dedicated maintenance-worker retention loop is the only automatic
destructive lifecycle: it requires recorded customer confirmation, admin
authorization, and an elapsed grace period before claiming a deletion request.
The analysis worker does not register this loop and has no retention/deletion
table grants. Deletion and retention runs persist running/completed/failed
state; stale running claims are reclaimable, and artifact cleanup is
path-contained and retried on the next sweep.
The API mounts the same worker-results volume read-only at its
`WORKER_RESULT_DIR`; the worker mounts it read-write. The
worker requires `EXECUTION_ROLE=worker` and
`DATABASE_EXPECTED_ROLE=wpa_worker`; the maintenance worker requires
`EXECUTION_ROLE=maintenance` and `DATABASE_EXPECTED_ROLE=wpa_maintenance`,
all four execution-disabled flags, and no queue credentials. The API requires
`EXECUTION_ROLE=api`, `DATABASE_EXPECTED_ROLE=wpa_runtime`, and all four
execution-disabled flags.
