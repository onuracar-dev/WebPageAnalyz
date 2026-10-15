import { expect, test, type Page, type Route } from '@playwright/test';

const ENGINES = ['lighthouse', 'axe', 'yellowLab', 'wpaPage', 'performancePlus', 'advancedGeo', 'visualUx'];

const engineList = ENGINES.map((id) => ({ id, name: `Engine ${id}`, description: `About ${id}`, external: id === 'yellowLab' }));

function scanBody(status: string, engines: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'scan-1',
    url: 'https://example.com/',
    status,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    engines,
    findings: [],
    summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} },
    ...extra,
  };
}

const findings = [
  { id: 'f1', ruleId: 'seo.meta', title: 'Meta description is missing', severity: 'medium', category: 'seo', engineId: 'wpaPage', description: 'No meta description.', remediation: 'Add one.' },
  { id: 'f2', ruleId: 'sec.csp', title: 'Content-Security-Policy is missing', severity: 'high', category: 'security', engineId: 'wpaPage' },
  { id: 'f3', ruleId: 'a11y.contrast', title: 'Text contrast is too low', severity: 'critical', category: 'accessibility', engineId: 'axe', evidence: [{ type: 'axe-nodes', name: 'color-contrast', value: [{ target: ['p.lede'], html: '<p class="lede">Hello</p>' }] }] },
];

async function mockEngines(page: Page) {
  await page.route('**/api/engines', (route) => route.fulfill({ json: { engines: engineList } }));
}

async function startScan(page: Page) {
  await page.goto('/');
  await page.getByLabel('Website URL').fill('example.com');
  await page.getByLabel(/authorized to test it/).check();
  await page.getByRole('button', { name: 'Scan' }).click();
}

test('scan button stays disabled until consent is given', async ({ page }) => {
  await mockEngines(page);
  await page.goto('/');
  await page.getByLabel('Website URL').fill('https://example.com');
  const button = page.getByRole('button', { name: 'Scan' });
  await expect(button).toBeDisabled();
  await page.getByLabel(/authorized to test it/).check();
  await expect(button).toBeEnabled();
});

test('submit -> live timeline -> results with galaxy and list', async ({ page }) => {
  await mockEngines(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/scans', async (route: Route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { id: 'scan-1', status: 'queued', position: 1 } });
  });

  let polls = 0;
  await page.route('**/api/scans/scan-1', (route) => {
    polls += 1;
    const pending = Object.fromEntries(ENGINES.map((id) => [id, { status: 'pending' }]));
    if (polls === 1) return route.fulfill({ json: scanBody('running', { ...pending, yellowLab: { status: 'running' }, lighthouse: { status: 'completed', durationMs: 15800 } }) });
    return route.fulfill({
      json: scanBody(
        'completed',
        Object.fromEntries(ENGINES.map((id) => [id, { status: 'completed', durationMs: 1200 }])),
        { finishedAt: new Date().toISOString(), findings, summary: { bySeverity: { critical: 1, high: 1, medium: 1, low: 0, info: 0 }, byCategory: {} } },
      ),
    });
  });

  await startScan(page);
  expect(submitted).toMatchObject({ url: 'https://example.com', consent: { accepted: true, version: '2026-10-15' } });

  await expect(page.getByRole('heading', { name: 'example.com', exact: true })).toBeVisible();
  await expect(page.getByText('1 of 7 engines finished')).toBeVisible();
  await expect(page).toHaveURL(/\?scan=scan-1/);

  await expect(page.getByText('Scan complete')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('application', { name: /3 findings shown as one galaxy/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Findings/ })).toBeVisible();

  await page.getByRole('button', { name: /Text contrast is too low/ }).click();
  const evidence = page.locator('.fa__visual');
  await expect(evidence.getByRole('heading', { name: 'Text contrast is too low' })).toBeVisible();
  await expect(evidence).toContainText('Markup captured from the scanned page');
  await expect(evidence.locator('pre')).toContainText('<p class="lede">Hello</p>');
  await page.getByRole('button', { name: 'Next finding' }).click();
  await expect(evidence.getByRole('heading', { name: 'Content-Security-Policy is missing' })).toBeVisible();

  // Nothing (e.g. hidden text inside the scrolling list) may extend the page past the footer.
  const pageEndsAtFooter = await page.evaluate(() => {
    const footer = document.querySelector('.site-footer')!.getBoundingClientRect().bottom + window.scrollY;
    return document.documentElement.scrollHeight <= Math.ceil(footer) + 1;
  });
  expect(pageEndsAtFooter).toBe(true);

  await page.getByRole('tab', { name: 'Category' }).click();
  await expect(page.getByRole('application', { name: /grouped by category/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Severity' }).click();
  await expect(page.getByRole('application', { name: /grouped by severity/ })).toBeVisible();
});

test('host cooldown shows a message and a countdown without leaving the form', async ({ page }) => {
  await mockEngines(page);
  await page.route('**/api/scans', (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'HOST_COOLDOWN', message: 'x', retryAfterSeconds: 125 }, retryAfterSeconds: 125 } }),
  );
  await startScan(page);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('This site was scanned recently.');
  await expect(alert).toContainText(/Try again in 2:0\d/);
  await expect(page.getByLabel('Website URL')).toBeVisible();
});

test('expired scan id in the URL returns to the form with a message', async ({ page }) => {
  await mockEngines(page);
  await page.route('**/api/scans/gone', (route) => route.fulfill({ status: 404, json: { error: { code: 'SCAN_NOT_FOUND', message: 'x' } } }));
  await page.goto('/?scan=gone');
  await expect(page.getByRole('alert')).toContainText('This result expired');
  await expect(page).not.toHaveURL(/scan=/);
});

test('no horizontal scroll at 375px on every scene', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockEngines(page);
  await page.route('**/api/scans/scan-1', (route) =>
    route.fulfill({ json: scanBody('completed', Object.fromEntries(ENGINES.map((id) => [id, { status: 'completed', durationMs: 900 }])), { findings }) }),
  );
  // body hides horizontal overflow, so also check that no element sticks out past the viewport.
  const noOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('main *')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1 || el.closest('pre')));

  await page.goto('/');
  expect(await noOverflow()).toBe(true);
  await page.goto('/?scan=scan-1');
  await expect(page.getByText('Scan complete')).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await page.goto('/terms');
  expect(await noOverflow()).toBe(true);
});

test('entry page fits the viewport without a scrollbar', async ({ page }) => {
  await mockEngines(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByLabel('Website URL')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  }
});
