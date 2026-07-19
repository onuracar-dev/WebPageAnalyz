# Changelog

## 1.0.0-beta.1 - 2026-07-19

### Added

- SSRF-aware URL/DNS policy and a loopback-only browser connection proxy that revalidates redirects and subresources.
- Connection, response-byte, total-byte, queue, concurrency, and analyzer deadlines.
- Explicit CORS, Helmet/CSP, request IDs, Zod request validation, route-specific rate limits, and optional API keys.
- Separate admin authorization with cleanup closed by default.
- Partial analyzer reports and redacted structured errors/logs.
- Browser-local report history, JSON export, print/PDF, analyzer status, and best-practices reporting.
- Docker, non-root backend, Nginx same-origin proxy, Compose, health endpoints, CI, security policy, and deployment documentation.
- Separate public product website with a clearly labeled client-only sample audit.

### Changed

- Raw analyzer artifacts are deleted after parsing unless explicitly retained.
- AI requests are opt-in and server-side only.
- The report dashboard is lazy-loaded to reduce the initial browser bundle.

### Security notes

- Production operators must still enforce outbound firewall rules and isolate the Chromium worker runtime.
- A successful automated audit is not a security, accessibility, legal, or compliance certification.
