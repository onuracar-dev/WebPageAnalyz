# WPA Lite — web

Single-page frontend for the WPA Lite backend (`../backend`). Vite + React + TypeScript with `motion` for animation. The findings map is a hand-written Canvas 2D component (`src/components/FindingsGalaxy.tsx`, layout maths in `src/galaxy/layout.ts`). The background is a WebGL2 Topography whose settings are tweened per scene (`src/backdrop/`); without WebGL2 a CSS gradient shows instead.

## Run

```bash
npm ci
npm run dev          # proxies /api to http://localhost:8080 (VITE_DEV_API_PROXY_TARGET to change)
npm run build
npm test             # Vitest: polling state machine, error messages, galaxy layout
PW_CHANNEL=chrome npm run test:e2e   # Playwright with mocked API; drop PW_CHANNEL to use Playwright's bundled browser
```

## Notes

- Scan state is tracked only with `GET /api/scans/:id`; the client never re-POSTs (the per-IP limit also counts cached replies). The scan id lives in `?scan=` so a reload resumes.
- In production nginx serves `dist/` and proxies `/api` on the same origin, so no CORS setup is needed. Unknown paths should fall back to `index.html` (`try_files $uri /index.html`) for `/terms` and `/about`.
- `src/pages/About.tsx` has a `TODO(onur)` placeholder for the abuse contact address.
- The evidence panel shows markup the engines captured from the page (axe `html`, Lighthouse `snippet`) when there is any, otherwise the engine evidence as JSON. It never generates code.
- Third-party components and their licenses: see `CREDITS.md`.
