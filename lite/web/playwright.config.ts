import { defineConfig, devices } from '@playwright/test';

const port = 5179;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  // PW_CHANNEL=chrome uses an installed Chrome instead of Playwright's bundled browser.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    // API calls are mocked per test; point the proxy at a closed port so nothing real is hit.
    env: { VITE_DEV_API_PROXY_TARGET: 'http://127.0.0.1:9' },
  },
});
