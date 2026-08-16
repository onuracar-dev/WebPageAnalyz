# Local Security Demo Flow

This demo proves a bounded local lifecycle:

`URL -> safe browser -> WPA finding/evidence -> remediation -> fix -> re-scan -> finding verified/resolved`

It is intentionally separate from the product UI and platform API. The demo does not modify `backend/**`, `website/**`, `frontend/**`, root configuration, or existing documentation.

## What is real and what is intentionally bounded

- The target is a Node HTTP server bound to `127.0.0.1` only.
- The safe browser uses the locally installed Chrome through the repository's installed `playwright-core` dependency.
- The browser request route permits only the target origin and `GET`, `HEAD`, or `OPTIONS`. Service workers are blocked, the context has no cookies, and external requests are aborted before they leave the browser.
- The scan calls the real WPA `analyzeSnapshot` function from `backend/analyzers/wpa-page.js`. The demo adapter collects the same header, HTML, DOM, and runtime fields that the WPA page analyzer evaluates.
- In `insecure` mode the target omits `Content-Security-Policy` and `/demo.js` emits one deterministic `console.error`. All other baseline fields are satisfied so the expected findings are exactly four device-specific rules: two `backend.csp.missing.*` and two `runtime.console-errors.*` findings.
- In `fixed` mode the target sends a restrictive CSP and `/demo.js` is silent. The re-scan is performed against the same URL, so the original finding fingerprints can be checked for absence.
- No internet, provider, paid API, secret, deployment, or source/media generation is used.

## Run on Windows PowerShell

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\demo\security-flow\Test-SecurityDemo.ps1
powershell -ExecutionPolicy Bypass -File .\demo\security-flow\Run-SecurityDemo.ps1 -Port 0
```

`-Port 0` asks Windows for a free loopback port. Use a specific free port when a stable URL is useful, for example `-Port 43891`. The run creates a new directory under `%TEMP%` and prints a JSON report plus its `runDirectory`. The report contains `initial`, `remediation`, `rescan`, `verification`, and `integrationBoundary` sections.

Expected successful result:

- `status`: `PASS`
- initial findings: `4`
- fixed re-scan findings: `0`
- verified/resolved findings: `4`
- `integrationBoundary.status`: `BLOCKED_AS_EXPECTED`
- `integrationBoundary.errorCode`: `PRIVATE_TARGET_BLOCKED`

The last two values are required, not a false-green scan result. The production `backend/security/url-safety.js` rejects loopback addresses, and `backend/security/safe-proxy.js` uses that validator. Therefore the demo does not claim that `/api/v1/scans` or the authenticated platform queue can currently consume this local target.

## Cleanup

The harness closes its in-process target in a `finally` block. To remove the saved evidence directory after reviewing it, pass the exact printed path to the guarded cleanup script:

```powershell
powershell -ExecutionPolicy Bypass -File .\demo\security-flow\Cleanup-SecurityDemo.ps1 -RunDirectory 'C:\Users\onura\AppData\Local\Temp\wpa-security-demo-...'
```

The cleanup script refuses paths outside the Windows temporary directory, unexpected directory names, reparse points, or directories without the demo marker. It removes only that exact generated run directory.

## Integration need

The local engine proof is complete, but a full product-level URL-to-platform proof needs an approved test-only integration seam: either a loopback allowlist injected into `validatePublicUrl`/`SafeBrowserProxy` or a disposable local test origin that satisfies the existing public-target contract. It would also need the platform's project verification, auth, entitlement, queue, and report persistence setup. Those changes are intentionally outside this task's ownership boundary and are not simulated here.
