# Advanced Engine Reliability Report — HQA-016

**Verdict:** `HQA-016: FIXED` for the supported local worker environment tested on 2026-08-16.

**Target:** `https://www.onuracar.dev/`
**Execution boundary:** persistent Chrome → customer portal → API/queue → isolated analysis worker
**Worker limits:** 2 CPU, 2 GiB memory, 512 PIDs, read-only root filesystem, non-root user, reviewed Chromium seccomp profile
**Remediation rounds used:** 1 of 2 allowed

This report is intentionally limited to the paid advanced-engine blocker. It does not repeat the full product acceptance exercise and does not claim production-VDS, real Paddle, live AI provider, DNS-ownership, Source ZIP, or external webhook acceptance.

## A. Original reproduction

### Studio failing browser run

The current pre-fix stack was reproduced from persistent Chrome using the Studio test persona and the existing authorized public-link project.

| Field | Evidence |
| --- | --- |
| Scan | `scan_a270de74-fc4d-4a9f-be7f-0b3baeb77141` |
| Queued | `2026-08-16T02:48:30.374583Z` |
| Scan running | `2026-08-16T02:48:32.385972Z` |
| Page running | `2026-08-16T02:48:34.384321Z` |
| Page terminal | `2026-08-16T02:50:01.150013Z` |
| Scan terminal | `partial` at `2026-08-16T02:50:01.176862Z` |
| Active page duration | approximately 86.77 seconds |
| Completed | Lighthouse, YellowLab, Axe, WPA Page |
| Failed | Performance Plus, Advanced GEO, Visual UX |
| Failure | shared `advancedBrowser` `TimeoutError` |
| Credit | `credit_6313d12e-261e-4f31-afdc-85bf711d592a`, released once, amount 1 |

The paid advanced modules shared one `advancedBrowser` promise, so one timeout mapped to all three module failures. The UI/report correctly retained the partial result; it did not mark missing coverage Clear.

The pre-fix customer report did not persist analyzer-level queued/start/finish timestamps or worker correlation. Therefore the exact pre-fix per-engine start sequence cannot be reconstructed honestly beyond the page events, shared failure, container samples and engine terminal states above. That observability gap was part of the remediation; no missing timestamp was inferred or fabricated.

### Enterprise pre-fix comparison

A new Enterprise run was also queued from persistent Chrome before the patch:

| Field | Evidence |
| --- | --- |
| Scan | `scan_ee93e1c8-5ada-4ca5-b0a6-76a1154c8d42` |
| Page running | `2026-08-16T02:58:37.564511Z` |
| Page completed | `2026-08-16T02:59:55.934576Z` |
| Result | completed, 7 / 7 requested public-link modules, 49 findings |
| Credit | `credit_8fa41258-79cf-4c68-b2fa-0b4f5f56fb53`, consumed once |

This run happened to finish, but it reproduced the same unsafe resource shape: 204% CPU, at least 1.337 GiB and 477 PIDs were observed very early. The follow-up process-count probe could no longer start while the container was under pressure. This explains the historical intermittent Enterprise partial rather than disproving it.

### Pre-fix Studio resource timeline

The worker started near 272–284 MiB and 13–17 PIDs. During the failing Studio bundle it climbed through approximately:

```text
852.5 MiB / 428 PIDs
1.226 GiB / 456 PIDs
1.664 GiB / 494 PIDs
1.927 GiB / 503 PIDs
1.999 GiB / 504–512 PIDs
```

CPU stayed near 192–206%, which is effectively full use of both assigned cores. API, PostgreSQL and ZAP did not show comparable pressure; ZAP remained near idle and was not part of this public-link manifest.

## B. Root cause

The failure was internal orchestration/resource contention, not an external provider limitation and not a slow first-party engine.

Before the patch, one page analysis started all of the following through one `Promise.allSettled` fan-out:

```text
Lighthouse Chromium
YellowLab external polling
Axe Chromium
WPA Page Playwright Chromium
Advanced Browser Playwright Chromium
  ├─ Performance Plus
  ├─ Advanced GEO
  └─ Visual UX
optional ZAP
```

`MAX_CONCURRENT_ANALYSES=1` bounded page analyses, but it did not bound the Chromium/process fan-out inside that one analysis. Four browser-heavy workloads therefore competed for the same 2 CPU, 2 GiB and 512-PID worker.

The decisive comparison was:

```text
isolated advanced engines: PASS in about 21–23 seconds
bundled Studio execution: worker limit pressure + shared advanced timeout
```

Queue scheduling, proxy startup, target behavior and external AI were excluded as primary causes:

- the isolated engines used the same target, worker, SafeBrowserProxy and sandbox;
- all isolated first-party runs completed;
- YellowLab also completed in the corrected bundles;
- the worker stayed healthy and no stale lease or heartbeat failure occurred;
- the failing bundle, not the target in isolation, approached the memory/PID ceilings.

## C. Resource profile

### Before remediation

| Metric | Observed |
| --- | --- |
| Worker CPU | approximately 192–206% |
| Worker memory | up to 1.999 GiB / 2 GiB |
| Container PIDs | up to the 512 limit |
| Browser process count | exact count unavailable at the limit; process probing itself stopped making progress |
| OOM/restart | no OOM or restart, but almost no execution headroom |
| ZAP/API/PostgreSQL | no matching resource spike |

### After remediation

Across the three isolated Performance Plus runs and four full paid browser runs:

| Metric | Observed maximum / terminal state |
| --- | --- |
| Worker CPU | up to 208.27%; one browser engine can still use both assigned cores |
| Worker memory | maximum observed 1.179 GiB / 2 GiB |
| Container PIDs | maximum observed 157 / 512 |
| Chromium processes | maximum observed 14; terminal 0 |
| Terminal worker state | healthy, `OOMKilled=false`, restart count 0 |
| Post-soak worker memory | 299.1 MiB by `docker stats`; cgroup current 338,362,368 bytes |
| `/tmp` | 2,555,139 bytes before; 2,556,096 bytes after |
| Customer artifact residue | no growth in managed customer artifact paths; Engine Lab artifacts intentionally remained under its history/TTL contract |

The post-run memory fell from the active/early-idle 0.46 GiB range to about 0.30 GiB, so the samples do not show monotonic process growth. Chromium returned to zero after every observed terminal run.

## D. Concurrency model before

```text
PgBoss scan job
  → page job
    → TaskPool(maxConcurrentAnalyses=1)
      → analysisService.analyze()
        → all browser analyzers start concurrently
```

Timeouts started when each analyzer promise was created. With a future semaphore added around those already-created promises, queue wait would incorrectly consume the active execution budget. The fix therefore had to defer promise creation until a resource lane actually started the analyzer.

## E. Changes

Primary implementation: `backend/services/analysis-service.js`.

1. Analyzer work is classified into two small, explicit resource classes:
   - `browser`: Lighthouse, Axe, WPA Page, Advanced Browser;
   - `external`: YellowLab and ZAP.
2. Browser-heavy analyzers execute one at a time inside a bounded lane.
3. External work remains concurrent with the browser lane; the system was not globally serialized.
4. The analyzer timeout begins only after the lane starts the actual operation.
5. A timed-out/aborted browser operation is given a bounded 10-second cleanup drain before the lane can start the next browser. Exceeding the drain creates an explicit worker warning.
6. Customer reports now retain per-analyzer execution evidence:
   - `queuedAt`;
   - `startedAt`;
   - `finishedAt`;
   - `queueWaitMs`;
   - `executionMs`;
   - `timeoutBudgetMs`;
   - resource class;
   - terminal status/error code.
7. Module runs reference the corresponding execution evidence. Performance Plus, Advanced GEO and Visual UX correctly reference the shared Advanced Browser execution.
8. Structured worker logs add the analyzer name, safe hostname, resource class, queue wait, active duration, timeout budget, terminal state and worker PID. They do not log target query strings or credentials.

Regression coverage was added for maximum browser-heavy concurrency of one, queue/execution timing evidence, external-lane preservation and cleanup-before-next-browser behavior.

## F. Timeout changes

No execution timeout was increased.

| Analyzer | Before | After | Healthy active duration observed |
| --- | ---: | ---: | ---: |
| Lighthouse | 180,000 ms | 180,000 ms | 24,220–27,057 ms in corrected full runs |
| Axe | 90,000 ms | 90,000 ms | 3,731–4,844 ms |
| WPA Page | 120,000 ms | 120,000 ms | 21,979–22,945 ms |
| Advanced Browser | 150,000 ms | 150,000 ms | 23,716–24,122 ms |
| YellowLab | 150,000 ms | 150,000 ms | 16,653–22,908 ms |

The only new bound is the 10,000-ms post-abort cleanup grace. It does not extend successful analyzer execution; it prevents a timed-out browser from overlapping the next browser silently.

### Persisted corrected-run engine timeline

The following evidence was read back from the durable report payloads. All rows ran in the same healthy analysis-worker process (`workerPid=8`), exited `completed` with no error code, and retained normalized report evidence. Managed analyzer temp artifacts were cleaned after consumption. CPU/RAM/PID sampling was container-level rather than attributed speculatively to an individual child process.

`Advanced Browser` is one intentional shared collection for Performance Plus, Advanced GEO and Visual UX; its one execution row is referenced by all three module runs.

| Persona/run | Engine | Queued at (UTC) | Started at (UTC) | Finished at (UTC) | Queue wait | Execution | Budget | Class |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Enterprise 1 | YellowLab | 03:08:21.661 | 03:08:21.662 | 03:08:44.570 | 1 ms | 22,908 ms | 150,000 ms | external |
| Enterprise 1 | Lighthouse | 03:08:21.661 | 03:08:21.662 | 03:08:48.719 | 1 ms | 27,057 ms | 180,000 ms | browser |
| Enterprise 1 | Axe | 03:08:21.661 | 03:08:48.719 | 03:08:52.450 | 27,058 ms | 3,731 ms | 90,000 ms | browser |
| Enterprise 1 | WPA Page | 03:08:21.661 | 03:08:52.450 | 03:09:14.504 | 30,789 ms | 22,054 ms | 120,000 ms | browser |
| Enterprise 1 | Advanced Browser | 03:08:21.661 | 03:09:14.504 | 03:09:38.304 | 52,843 ms | 23,800 ms | 150,000 ms | browser |
| Enterprise 2 | YellowLab | 03:10:32.502 | 03:10:32.502 | 03:10:49.155 | 0 ms | 16,653 ms | 150,000 ms | external |
| Enterprise 2 | Lighthouse | 03:10:32.502 | 03:10:32.502 | 03:10:56.722 | 0 ms | 24,220 ms | 180,000 ms | browser |
| Enterprise 2 | Axe | 03:10:32.502 | 03:10:56.723 | 03:11:00.557 | 24,221 ms | 3,834 ms | 90,000 ms | browser |
| Enterprise 2 | WPA Page | 03:10:32.502 | 03:11:00.558 | 03:11:23.503 | 28,056 ms | 22,945 ms | 120,000 ms | browser |
| Enterprise 2 | Advanced Browser | 03:10:32.502 | 03:11:23.503 | 03:11:47.625 | 51,001 ms | 24,122 ms | 150,000 ms | browser |
| Studio 1 | YellowLab | 03:13:11.794 | 03:13:11.794 | 03:13:28.456 | 0 ms | 16,662 ms | 150,000 ms | external |
| Studio 1 | Lighthouse | 03:13:11.793 | 03:13:11.794 | 03:13:37.693 | 1 ms | 25,899 ms | 180,000 ms | browser |
| Studio 1 | Axe | 03:13:11.794 | 03:13:37.694 | 03:13:42.538 | 25,900 ms | 4,844 ms | 90,000 ms | browser |
| Studio 1 | WPA Page | 03:13:11.794 | 03:13:42.538 | 03:14:04.517 | 30,744 ms | 21,979 ms | 120,000 ms | browser |
| Studio 1 | Advanced Browser | 03:13:11.794 | 03:14:04.518 | 03:14:28.290 | 52,724 ms | 23,772 ms | 150,000 ms | browser |
| Studio 2 | YellowLab | 03:15:46.523 | 03:15:46.523 | 03:16:03.235 | 0 ms | 16,712 ms | 150,000 ms | external |
| Studio 2 | Lighthouse | 03:15:46.523 | 03:15:46.523 | 03:16:11.511 | 0 ms | 24,988 ms | 180,000 ms | browser |
| Studio 2 | Axe | 03:15:46.523 | 03:16:11.512 | 03:16:15.400 | 24,989 ms | 3,888 ms | 90,000 ms | browser |
| Studio 2 | WPA Page | 03:15:46.523 | 03:16:15.400 | 03:16:37.866 | 28,877 ms | 22,466 ms | 120,000 ms | browser |
| Studio 2 | Advanced Browser | 03:15:46.523 | 03:16:37.866 | 03:17:01.582 | 51,343 ms | 23,716 ms | 150,000 ms | browser |

## G. Security impact

No security boundary was weakened.

- The API image still has no Chromium/Chrome executable.
- Browser execution remains in the analysis worker.
- The API and worker remain non-root, read-only and non-privileged with all Linux capabilities dropped.
- The worker retains `no-new-privileges` and the reviewed Chromium seccomp profile.
- Chromium sandbox enforcement was not disabled and no `--no-sandbox` production path was added.
- SafeBrowserProxy and SSRF/origin controls were unchanged.
- No DNS ownership, target authorization or plan-entitlement gate was bypassed.
- No worker database privilege, public port or API internet-egress expansion was added.
- Worker limits remain 2 CPU, 2 GiB and 512 PIDs.

## H. Isolated engine results

### Pre-fix isolation

| Engine | Run | Duration | Result | Findings | Resource observation |
| --- | --- | ---: | --- | ---: | --- |
| Performance Plus | `lab_38b1515c-433f-4f38-9cb4-ca342b9f0da1` | 22.96 s | completed | 4 | about 1.011 GiB / 142 PIDs |
| WPA Page | `lab_3743c507-1c58-4421-beb3-0b741d18c714` | 21.33 s | completed | 13 | about 1.019 GiB / 148 PIDs |
| Advanced GEO | `lab_2aa5f0be-2af2-46b4-b81e-f925725e4e54` | 22.83 s | completed | 2 | about 1.027 GiB / 147 PIDs |
| Visual UX | `lab_997396c2-d326-48fd-85fb-143095b3434c` | 23.06 s | completed | 8 | about 0.95–1.05 GiB / 153 PIDs |

### Post-fix Performance Plus repetition

| Iteration | Run | Active duration | Result | Findings |
| ---: | --- | ---: | --- | ---: |
| 1 | `lab_9b594921-922c-44f5-9b78-97ce042ad1fe` | 23.08 s | completed | 4 |
| 2 | `lab_b8e129cf-3a4d-46e3-a417-be247dff97b7` | 23.31 s | completed | 4 |
| 3 | `lab_2f63d7e9-b453-4d37-ba77-2ac5ce0f0b9f` | 22.04 s | completed | 4 |

Across the three post-fix isolated iterations the observed maximum was 934.1 MiB, 154 PIDs and 11 Chromium processes. The worker returned to 165.5 MiB, 13 PIDs and zero Chromium processes immediately after that sequence.

## I. Studio browser acceptance

Both corrected Studio runs were started from the real persistent Chrome target screen with explicit YellowLab disclosure consent.

| Field | Run 1 | Run 2 |
| --- | --- | --- |
| Scan | `scan_3256ed55-8917-4c0a-84ea-2d5246a732e9` | `scan_bee6495b-8b4e-4e13-a3f1-fbdc5c8e5bb9` |
| Page active window | 03:13:11.780–03:14:28.442Z | 03:15:46.512–03:17:01.724Z |
| Page duration | 76.66 s | 75.21 s |
| Terminal state | completed | completed |
| Module result | 7 / 7 completed | 7 / 7 completed |
| Findings | 65 | 64 |
| Credit | consumed once | consumed once |

Requested and completed modules were Lighthouse, YellowLab, Axe, WPA Page, Performance Plus, Advanced GEO and Visual UX.

Persistent Chrome then proved:

- Overview says `Latest scan completed` and shows Performance Plus findings;
- the latest report is `completed`, has 1 / 1 page coverage and completed module labels;
- refresh/history navigation preserved the completed result;
- Report history retained four versions, including the original partial evidence and the two corrected reports;
- PDF and JSON controls plus Compare/Share entry points remained visible for the entitled plan;
- Studio remaining page balance was 148 / 150, exactly matching the two new successful consumptions; the original failing reservation remained released.

## J. Enterprise browser acceptance

Both corrected Enterprise runs were also started from persistent Chrome.

| Field | Run 1 | Run 2 |
| --- | --- | --- |
| Scan | `scan_43d0af6c-97ce-4299-af3c-ef9821328a6f` | `scan_96cec97b-c0d6-42b5-b294-93424135c92e` |
| Page active window | 03:08:21.652–03:09:38.389Z | 03:10:32.494–03:11:47.696Z |
| Page duration | 76.74 s | 75.20 s |
| Terminal state | completed | completed |
| Module result | 7 / 7 completed | 7 / 7 completed |
| Findings | 63 | 64 |
| Credit | consumed once | consumed once |

Persistent Chrome then proved:

- Overview says `Latest scan completed` and shows Performance Plus findings;
- the latest report remained completed with 1 / 1 coverage after refresh/history navigation;
- report history retained four versions;
- PDF/JSON, comparison and sharing entry points remained available;
- Enterprise remaining page balance was 497 / 500, matching one successful pre-fix comparison run plus the two corrected runs.

The browser JSON export of the corrected second Enterprise report succeeded through HTTP 200:

```text
file: C:\Users\onura\Downloads\wpa-report-v1 (2).json
bytes: 237,423
sha256: 8A741267AD1A95D0E3228593A900D561D85CFDA41B7652A3CF378BAE53FA50AD
report: rpt_bb6b2599-8468-4703-88e4-20e7c1ea0474
scan: scan_96cec97b-c0d6-42b5-b294-93424135c92e
```

The downloaded payload contains one completed page, 64 findings, all seven requested module states as `completed`, and the new per-engine timing evidence.

## K. Repeated-run results

The requested bounded fallback was used because every full paid run takes about 75–77 seconds and consumes a test-account page credit:

```text
3 isolated Performance Plus runs
2 full Studio runs
2 full Enterprise runs
```

Result: **7 / 7 consecutive post-fix advanced executions completed**.

Additional terminal checks:

```text
customer analyzer-finished logs: 20
customer analyzer failures: 0
cleanup-grace warnings: 0
OPERATION_TIMEOUT logs: 0
worker OOM: false
worker restarts: 0
terminal Chromium processes: 0
```

There was no unexplained intermittent timeout in the bounded repetition.

## L. Remaining risk

- This is supported-local-environment proof, not production-VDS or multi-day soak proof.
- Engine Lab and customer scans use separate scheduling surfaces. Intentional simultaneous admin Lab stress plus customer scan was not part of the required fallback and remains a capacity-test follow-up; normal paid customer repetition passed.
- The worker working set temporarily remained around 0.46 GiB after the final run and later fell to about 0.30 GiB. A multi-hour heap/FD soak is not proven, but the bounded sequence did not show orphan Chromium, temp growth, OOM or terminal PID growth.
- Advanced GEO still shares the Advanced Browser collection and therefore captures desktop/mobile evidence even though its declared consumer contract is desktop-oriented. That is an efficiency opportunity, not the observed blocker.
- A browser PDF was not regenerated from the corrected report in this focused pass. The corrected report exposed the entitled PDF action; the prior human-acceptance run already proved the durable PDF worker path and valid PDF magic. JSON export was re-executed on the corrected report.
- HQA-011, HQA-012 and HQA-014 remain non-blocking. In particular, same-day report rows are still hard to distinguish and GSAP stale-target warnings remain console-only.

## Final gate answers

| Question | Answer |
| --- | --- |
| Does Performance Plus complete independently? | **Yes**, 3 / 3 post-fix and the pre-fix isolated run completed. |
| Does Performance Plus complete inside Studio? | **Yes**, 2 / 2 full Studio runs. |
| Does Performance Plus complete inside Enterprise? | **Yes**, 2 / 2 corrected full Enterprise runs. |
| Does WPA Page complete reliably? | **Yes** in the bounded evidence: isolated plus 4 / 4 corrected full runs. |
| Do Advanced GEO and Visual UX complete reliably? | **Yes** in isolation and 4 / 4 corrected full runs. |
| Did resource competition cause the original timeouts? | **Yes**; the pre-fix bundle reached the worker ceilings while isolated engines completed normally. |
| Are queue wait and execution timeout separated? | **Yes**; promise creation/timeout begins only after the browser lane starts the analyzer, and both durations are persisted. |
| Are browser resources cleaned after every run? | **Yes** for the observed sequence: zero terminal Chromium processes and stable temp usage. |
| Do repeated runs remain stable? | **Yes**, 7 / 7 post-fix executions completed in the bounded fallback. |
| Do credits settle correctly? | **Yes**; four corrected full scans produced four single consumptions and no duplicate release/consumption. |
| Do reports honestly represent coverage? | **Yes**; original partial history remains and corrected reports show 7 / 7 completed coverage. |
| Were security controls weakened? | **No**. |

**HQA-016 final state: FIXED.**
