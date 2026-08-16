# Third-party components

This ledger covers runtime components added or retained by WebPage Analyzer. npm integrity hashes are locked in each package lock. Production container images must additionally be pinned to an approved digest in the deployment environment before release.

| Component | Version | License | Upstream | Use and update policy |
|---|---:|---|---|---|
| Lighthouse | 12.6.1 | Apache-2.0 | https://github.com/GoogleChrome/lighthouse | Core evidence provider; update after report-schema regression tests. |
| Axe Core Puppeteer | 4.12.1 | MPL-2.0 | https://github.com/dequelabs/axe-core-npm | Accessibility evidence; legal review required before redistribution changes. |
| Yellow Lab Tools API | external API | GPL-3.0 upstream | https://github.com/YellowLabTools/YellowLabTools | Evidence integration only; no bundled fork. Pin upstream endpoint behavior in smoke tests. |
| Playwright Core | 1.62.1 | Apache-2.0 | https://github.com/microsoft/playwright | Browser evidence and journey foundation; exact npm version. |
| Better Auth | 1.6.26 | MIT | https://github.com/better-auth/better-auth | Authentication, organization and admin TOTP; exact npm version and generated schema review. |
| pg | 8.22.0 | MIT | https://github.com/brianc/node-postgres | PostgreSQL adapter; exact npm version. |
| pg-boss | 12.27.0 | MIT | https://github.com/timgit/pg-boss | Durable PostgreSQL queue; exact npm version. |
| Stripe Node | 22.4.0 | MIT | https://github.com/stripe/stripe-node | Checkout and signed webhooks; exact npm version. |
| multer | 2.2.0 | MIT | https://github.com/expressjs/multer | Bounded source ZIP upload; exact npm version. |
| yauzl | 3.4.0 | MIT | https://github.com/thejoshwolfe/yauzl | Lazy ZIP inspection and bomb/path controls; exact npm version. |
| OWASP ZAP Baseline | 2.17.0 (`sha256:35ea1052...e7e0b66`) | Apache-2.0 | https://github.com/zaproxy/zaproxy | Digest-pinned container; passive spider and passive alerts only; verified-origin egress proxy, API key and isolated network. |
| OSV-Scanner | 2.3.8 (`bc98e153...9ab92dc`) | Apache-2.0 | https://github.com/google/osv-scanner | SHA-256 verified Linux binary; dependency evidence only, package scripts are never run. |
| Three.js | 0.185.1 | MIT | https://github.com/mrdoob/three.js | Auth-screen WebGL particle artwork; exact npm version, lazy-loaded and reduced-motion aware. |
| qrcode.react | 4.2.0 | ISC | https://github.com/zpao/qrcode.react | Local rendering of Better Auth TOTP enrollment URIs; exact npm version. |

Update rule: exact versions are changed only with license review, upstream changelog review, focused adapter tests and a controlled real-target smoke test. Active ZAP scans are outside product scope.
