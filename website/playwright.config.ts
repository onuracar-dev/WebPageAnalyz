import { defineConfig, devices } from '@playwright/test';

/**
 * The suite owns its API state through route fixtures; it never needs a
 * running backend or an administrator account. BASE_URL makes Docker smoke
 * runs possible without starting a second Vite server.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  expect: { timeout: 15_000 },
  timeout: 45_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173',
    // Developers with Chrome installed avoid a separate browser download;
    // CI still uses the pinned Playwright Chromium revision by default.
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI ? undefined : 'chrome'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
    { name: 'compact', use: { ...devices['Pixel 5'], viewport: { width: 320, height: 800 } } },
    { name: 'reduced-motion', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
