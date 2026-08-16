import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173';
const outputDir = path.resolve('artifacts', 'cutaway-visual');
await mkdir(outputDir, { recursive: true });

const now = '2026-08-12T10:00:00.000Z';
const workspaceDashboard = {
  workspace: { id: 'ws-001', name: 'Northstar Studio' },
  plan: { id: 'studio', name: 'Studio', limits: { pageCredits: 150, projects: 15 } },
  usage: { consumed: 38, reserved: 2 },
  projects: [{ id: 'project-001', name: 'Northstar', origin: 'https://northstar.example', verifiedAt: now }],
  scans: [{ id: 'scan-001', status: 'completed', createdAt: now, completedAt: now }],
  metrics: { activeFindings: 6, critical: 1, highPriority: 3, resolved: 4, totalPages: 28 },
  recentFindings: [
    { fingerprint: 'finding-1', title: 'Browser console errors occurred', severity: 'high', pageUrl: 'https://northstar.example/checkout', createdAt: now },
    { fingerprint: 'finding-2', title: 'Render-blocking JavaScript', severity: 'medium', pageUrl: 'https://northstar.example/pricing', createdAt: now },
    { fingerprint: 'finding-3', title: 'Image dimensions are missing', severity: 'low', pageUrl: 'https://northstar.example/blog', createdAt: now },
  ],
  trend: Array.from({ length: 6 }, (_, index) => ({ at: `2026-07-${String(7 + index * 4).padStart(2, '0')}T00:00:00.000Z`, count: index + 2 })),
};
const finding = { fingerprint: 'finding-1', title: 'Browser console errors occurred', description: 'A script threw while initializing checkout.', severity: 'high', category: 'runtime', pageUrl: 'https://northstar.example/checkout', createdAt: now, moduleId: 'runtime', engineId: 'wpaPage', device: 'desktop', kind: 'measured', confidence: 1, coverage: { truncated: false }, remediation: 'Guard the checkout session.', state: 'active', source: { name: 'WPA Page', version: '1.0.0' } };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installFixtures(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const routePath = url.pathname;
    let body = {};
    if (routePath === '/api/v1/plans') body = { plans: [] };
    else if (routePath === '/api/auth/get-session') body = { user: { name: 'Avery Example', email: 'avery@example.test', twoFactorEnabled: true } };
    else if (routePath === '/api/v1/dashboard') body = workspaceDashboard;
    else if (routePath === '/api/v1/findings') body = { findings: [finding], total: 1, activeTotal: 1, resolvedTotal: 0 };
    else if (routePath === '/api/v1/reports') body = { reports: [] };
    else if (routePath === '/api/v1/legal/config') body = {
      ready: true,
      operator: { name: 'Fixture Operator', businessAddress: 'Fixture address', country: 'TR', supportEmail: 'support@example.test', effectiveDate: '2026-08-15' },
      documents: { terms: { version: '1.0' }, acceptableUse: { version: '1.0' }, refund: { version: '1.0' }, targetAuthorization: { version: '1.0' } },
      billing: { provider: 'paddle', merchantOfRecord: 'Paddle', currency: 'USD', interval: 'Monthly', recurring: true },
      subprocessors: []
    };
    else if (routePath === '/api/v1/status' || routePath === '/api/v1/status/details') body = { checkedAt: now, overall: 'operational', components: [{ id: 'database', label: 'Database', status: 'operational', detail: 'Read/write checks pass.' }] };
    else if (routePath === '/api/v1/analysis-capabilities') body = { version: 'wpa.analysis-capabilities.v1', findingSchema: 'wpa.finding.v1', reportSchema: 'wpa.report.v1', engines: {} };
    else if (routePath === '/api/v1/integrations') body = { integrations: [] };
    else if (routePath === '/api/v1/source-inputs') body = { sourceInputs: [] };
    else if (routePath === '/api/v1/support/tickets') body = { tickets: [] };
    else if (routePath === '/api/v1/settings') body = { workspace: { name: 'Northstar Studio' }, settings: { defaultLocale: 'en', notifyScanComplete: true, notifyHighPriority: true, weeklyDigest: false }, subscription: null };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${routePath}` }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function inspectPage(browser, name, viewport, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(`pageerror:${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') faults.push(`console:${message.text()} @ ${message.location().url}`); });
  await installFixtures(page);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.locator('.wpa-scene--entry').waitFor({ state: 'visible' });
  await page.waitForTimeout(reducedMotion === 'reduce' ? 100 : 1400);
  assert(await page.locator('.wpa-scene').count() === 3, `${name}: landing must have three scenes`);
  // The public story is now the approved three-image cutaway composition.
  // `.wpa-corridor__line` belonged to the retired CSS-only corridor prototype
  // and is intentionally not part of the rendered contract anymore.
  assert(await page.locator('.wpa-scene-media img').count() === 3, `${name}: landing must render one image per scene`);
  assert(await page.locator('.wpa-scene-media img').evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), `${name}: scene imagery must load`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: landing horizontal overflow`);
  await page.locator('.wpa-scene--entry').screenshot({ path: path.join(outputDir, `${name}-scene-01.png`) });
  await page.locator('.wpa-scene--scan').scrollIntoViewIfNeeded();
  await page.waitForTimeout(reducedMotion === 'reduce' ? 50 : 1100);
  await page.locator('.wpa-scene--scan').screenshot({ path: path.join(outputDir, `${name}-scene-02.png`) });
  await page.locator('.wpa-scene--result').scrollIntoViewIfNeeded();
  await page.waitForTimeout(reducedMotion === 'reduce' ? 50 : 1100);
  await page.locator('.wpa-scene--result').screenshot({ path: path.join(outputDir, `${name}-scene-03.png`) });
  await page.screenshot({ path: path.join(outputDir, `${name}-landing.png`), fullPage: true });

  await page.goto(`${baseURL}/app`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  // The workspace overview uses the current reference composition. The
  // former `.cutaway-overview` shell is retained only as retired CSS residue.
  await page.locator('.reference-overview').waitFor({ state: 'visible' });
  await page.waitForTimeout(reducedMotion === 'reduce' ? 100 : 1100);
  assert(await page.locator('.cutaway-engine').count() === 6, `${name}: dashboard must have six engine layers`);
  const activeEngine = page.getByRole('button', { name: 'Performance Plus', exact: true });
  assert(await activeEngine.getAttribute('aria-pressed') === 'true', `${name}: Performance Plus must be the active engine`);
  assert(await activeEngine.getAttribute('class').then((value) => value?.includes('is-active')), `${name}: active engine state must be visible`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: dashboard horizontal overflow`);
  if (viewport.width >= 900) {
    assert(await page.locator('.portal-desktop-nav > button').count() === 6, `${name}: desktop nav must have six primary items`);
    for (const [buttonName, headingName] of [['Findings', 'Findings'], ['Reports', 'Reports'], ['Targets', 'Targets'], ['Integrations', 'Integrations']]) {
      await page.getByRole('button', { name: buttonName, exact: true }).click();
      await page.getByRole('heading', { name: headingName, exact: true }).waitFor({ state: 'visible' });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: ${buttonName} horizontal overflow`);
    }
    // Support is a dedicated workspace surface with its own shell. Visit it
    // directly, then verify the utility-only Settings and Status routes from
    // the profile menu; neither is part of the six-item primary nav anymore.
    await page.getByRole('button', { name: 'Support', exact: true }).click();
    await page.getByRole('heading', { name: /Support, with a paper trail/i }).waitFor({ state: 'visible' });
    const supportNavLabels = await page.locator('.portal-desktop-nav > button').allTextContents();
    assert(JSON.stringify(supportNavLabels) === JSON.stringify(['Overview', 'Findings', 'Reports', 'Targets', 'Integrations', 'Support']), `${name}: Support nav drifted: ${supportNavLabels.join(', ')}`);
    assert(await page.getByRole('button', { name: 'Findings', exact: true }).isVisible(), `${name}: Findings disappeared on Support`);
    assert(await page.getByRole('button', { name: 'Support', exact: true }).getAttribute('aria-current') === 'page', `${name}: Support must remain active`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: Support horizontal overflow`);
    await page.goto(`${baseURL}/app`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.locator('.reference-overview').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Open profile menu' }).click();
    await page.getByRole('button', { name: /account settings/i }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ state: 'visible' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: Settings horizontal overflow`);
    await page.getByRole('button', { name: 'Open profile menu' }).click();
    await page.getByRole('button', { name: /^system status$/i }).click();
    await page.getByRole('heading', { name: 'System health', exact: true }).waitFor({ state: 'visible' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: System Status horizontal overflow`);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('.reference-overview').waitFor({ state: 'visible' });
    await page.waitForTimeout(reducedMotion === 'reduce' ? 50 : 1000);
  } else {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    assert(await page.getByRole('button', { name: 'Findings', exact: true }).isVisible(), `${name}: mobile drawer did not open`);
    await page.getByRole('button', { name: 'Findings', exact: true }).click();
    await page.getByRole('heading', { name: 'Findings', exact: true }).waitFor({ state: 'visible' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: mobile Findings overflow`);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('.reference-overview').waitFor({ state: 'visible' });
  }
  await page.screenshot({ path: path.join(outputDir, `${name}-dashboard.png`), fullPage: true });

  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByRole('heading', { name: /welcome back/i }).waitFor({ state: 'visible' });
  assert(await page.getByLabel(/email address/i).isVisible(), `${name}: login email missing`);
  assert(await page.getByLabel(/^password$/i).isVisible(), `${name}: login password missing`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: login horizontal overflow`);
  await page.screenshot({ path: path.join(outputDir, `${name}-login.png`), fullPage: true });
  assert(faults.length === 0, `${name}: browser faults: ${faults.join(' | ')}`);
  await context.close();
  return { name, viewport, reducedMotion, faults: faults.length };
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  results.push(await inspectPage(browser, 'desktop-1440', { width: 1440, height: 1000 }));
  results.push(await inspectPage(browser, 'mobile-390', { width: 390, height: 844 }));
  results.push(await inspectPage(browser, 'compact-320', { width: 320, height: 800 }));
  results.push(await inspectPage(browser, 'reduced-motion', { width: 1440, height: 1000 }, 'reduce'));
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify({ status: 'PASS', results }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
} finally {
  await browser.close();
}
