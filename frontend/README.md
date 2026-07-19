# WebPage Analyzer frontend

React/Vite dashboard for WebPage Analyzer. Development, environment, deployment, security, and verification instructions live in the [repository README](../README.md).

```bash
npm ci
npm run dev
```

The development server proxies `/api` to `http://localhost:5000`. Leave `VITE_API_BASE_URL` empty for same-origin deployments. Never put Gemini or application API secrets in a `VITE_*` variable.
