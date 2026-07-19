# Security Policy

## Supported versions

Security fixes are applied to the latest revision on the default branch. No older release line is currently maintained.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Email `onuracar.work@gmail.com` with:

- the affected commit or version;
- a concise impact description;
- reproducible steps or a minimal proof of concept;
- suggested mitigations, if known.

Do not access data you do not own, perform denial-of-service testing, run automated scans against public deployments without permission, or disclose a report before a fix can be prepared. You can expect an initial acknowledgment within seven days.

## High-value areas

Reports involving SSRF/DNS rebinding, Chromium sandbox escape, proxy bypass, authentication or rate-limit bypass, secret disclosure, prompt-data leakage, or unsafe report rendering are especially valuable.

## Deployment responsibility

The repository includes application-level safeguards, not a complete hosting security boundary. Operators must use TLS, isolate the analyzer worker, restrict outbound network access, keep Chromium sandboxing enabled, rotate API keys, monitor quotas, and apply dependency/security updates. Automated audit results are not a security or compliance certification.
