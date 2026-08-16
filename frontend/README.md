# WebPage Analyzer legacy frontend

React/Vite compatibility dashboard retained for development and migration
work. The canonical customer UI is the `website/` application; this directory
is not part of the production Compose route and its Docker image is not
published by the release workflow. Development, environment, deployment,
security, and verification instructions live in the [repository README](../README.md).

```bash
npm ci
npm run dev
```

The development server proxies `/api` to `http://localhost:5000`. Leave `VITE_API_BASE_URL` empty for same-origin deployments. Never put OpenRouter, Resend, Paddle, legacy AI, or application API secrets in a `VITE_*` variable.
