# WebPage Analyzer

Production-oriented, open-source website audit dashboard with AI-assisted remediation.

<img src="./docs/assets/preview.svg" alt="WebPage Analyzer dashboard preview">

[Live website](https://webpage-analyzer.onuracar-work.workers.dev/) · [GitHub repository](https://github.com/onuracar-dev/WebPageAnalyz)

WebPage Analyzer combines Lighthouse, Axe, YellowLabTools, and Gemini in one workflow. A user submits a public URL, the backend runs bounded audits through an SSRF-aware network boundary, and the React dashboard presents prioritized findings.

## What is included

- Lighthouse desktop/mobile audits for performance, SEO, accessibility, and best practices
- Axe accessibility findings and YellowLab frontend-quality signals
- Optional Gemini remediation suggestions and executive summaries
- Ten-report, 30-day browser-local history
- JSON export and print/PDF flow
- Lazy-loaded report visualization to keep the initial frontend bundle smaller
- Docker deployment with an Nginx same-origin API proxy
- Automated syntax, lint, test, build, and dependency-audit checks

## Security model

Analyzing arbitrary URLs is inherently high-risk. This implementation applies several layers:

1. Only credential-free `http:` and `https:` URLs on configured ports are accepted.
2. Local names and private, loopback, link-local, multicast, documentation, and reserved IPv4/IPv6 ranges are rejected.
3. Every Chromium connection passes through a loopback-only proxy that resolves the destination again, rejects mixed public/private DNS answers, and connects to the vetted IP. Redirects and subresources therefore receive the same check.
4. Analysis concurrency, queue length, duration, proxy connections, and transferred bytes are bounded.
5. CORS uses an explicit origin list; request bodies are small and schema validated.
6. General, analysis, and AI routes have separate rate limits.
7. `API_KEYS` can protect expensive routes. Log deletion is disabled unless a separate `ADMIN_API_KEYS` value is configured.
8. Raw analyzer files use randomized names and are deleted after parsing by default.

The application-level proxy materially reduces SSRF risk, but production deployments should also enforce outbound firewall rules and run the backend in an isolated network. Allow only DNS, the YellowLab/Gemini endpoints you use, and public HTTP(S); block cloud metadata and all private address ranges at the infrastructure layer. Do not set `CHROME_NO_SANDBOX=true` unless the runtime makes it unavoidable.

## Data flow and privacy

- The target URL is submitted to YellowLabTools when that analyzer is enabled.
- Issue context or aggregate scores are sent to Google Gemini only when a user explicitly requests an AI response.
- Report history is stored in that browser's `localStorage`, not in a server database.
- Analyzer artifacts are temporary unless `KEEP_ANALYZER_ARTIFACTS=true` is explicitly configured.

Do not submit URLs containing sensitive query parameters or one-time tokens: the complete target URL must be sent to the audit providers and is retained in the submitting browser's local history.

Review the third-party terms and privacy requirements before operating a public service.

## Architecture

| Area | Implementation |
| --- | --- |
| Frontend | React 19, Vite, Recharts, React Markdown |
| API | Express 5, Zod, Helmet, express-rate-limit |
| Audit engines | Lighthouse, Axe, YellowLabTools |
| Browser boundary | DNS/IP policy plus a per-analysis safe HTTP CONNECT proxy |
| AI | Gemini (optional) |
| Deployment | Docker Compose, Nginx, non-root backend process |

## Local development

Requirements: Node.js 20.19+ (Node 24 is used in CI), npm, and Chrome/Chromium.

```bash
cp backend/.env.example backend/.env
cd backend
npm ci
npm start
```

In another terminal:

```bash
cp frontend/.env.example frontend/.env
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to `http://localhost:5000`, so `VITE_API_BASE_URL` can stay empty. Open `http://localhost:5173`.

To enable AI features, set `GEMINI_API_KEY` only in `backend/.env`. Never put provider secrets in a `VITE_*` variable: Vite embeds those values in public browser assets.

## Configuration

All options and conservative defaults are documented in [`backend/.env.example`](./backend/.env.example). The most important settings are:

| Variable | Purpose |
| --- | --- |
| `CORS_ORIGINS` | Comma-separated exact frontend origins |
| `API_KEYS` | Optional comma-separated keys for analyze/AI endpoints |
| `ADMIN_API_KEYS` | Keys that enable and protect artifact deletion |
| `GEMINI_API_KEY` | Enables AI routes |
| `MAX_CONCURRENT_ANALYSES` / `MAX_QUEUED_ANALYSES` | Bounded local work queue |
| `*_TIMEOUT_MS` | Overall and per-provider deadlines |
| `ALLOWED_TARGET_PORTS` | Public destination ports; keep `80,443` in production |
| `KEEP_ANALYZER_ARTIFACTS` | Retain raw audit JSON; defaults to `false` |
| `TRUST_PROXY` | Enable only behind a trusted reverse proxy |

The built-in rate-limit store is process-local and suitable for one initial instance. Multiple replicas need a shared rate-limit/quota store at the gateway or application layer.

`API_KEYS` is intended for private/API-only deployments or a trusted gateway that injects authentication. The public browser UI does not embed a shared API key; leave `API_KEYS` empty when the UI is publicly accessible and enforce user quotas at the gateway until account authentication is added.

## API

Analyze a URL:

```bash
curl -X POST http://localhost:5000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

If `API_KEYS` is set, add `-H "X-API-Key: your-key"`. Administrative cleanup uses a key from `ADMIN_API_KEYS`:

```bash
curl -X DELETE http://localhost:5000/api/logs \
  -H "X-API-Key: your-admin-key"
```

Health endpoints are `GET /healthz` and `GET /readyz`. Error responses contain a stable `code` and `requestId` without stack traces or upstream error details.

## Docker deployment

Copy the root `.env.example` to `.env`, add deployment secrets (the resulting file is gitignored), then run:

```bash
docker compose up --build -d
```

The dashboard is served at `http://localhost:8080`; Nginx proxies `/api` to the private backend service. Set `PUBLIC_ORIGIN` to the exact HTTPS origin in production. Terminate TLS at a trusted load balancer or ingress and keep the backend port private.

## Verification

```bash
cd backend
npm ci
npm run check
npm run lint
npm test
npm audit --audit-level=moderate

cd ../frontend
npm ci
npm run lint
npm test
npm run build
npm audit --audit-level=moderate
```

Backend tests inject analyzer, DNS, and AI doubles and do not contact external services.

## Operational limitations

- Lighthouse and Chromium are resource-intensive. Start with one backend instance and low concurrency, then measure memory/CPU before increasing limits.
- The in-memory queue is not a durable job system. Long-running public workloads should move to a persistent queue with worker isolation.
- Browser-local history is intentionally not account synchronization.
- A successful automated scan is not a security, accessibility, legal, or compliance certification.

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities and [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance.

## License

MIT © 2026 Onur Acar
