import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installApiFixtures, legalConfig, workspaceDashboard } from './iceberg-fixtures';

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForTimeout(750);
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body, contentType: 'image/png' });
  if (process.env.WPA_CAPTURE_DIR) {
    const output = path.resolve(process.env.WPA_CAPTURE_DIR);
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, `${name}.png`), body);
  }
}

function captureBrowserFaults(page: Page) {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') faults.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || 'unknown';
    // Browser cancellation is expected when React Strict Mode replays an
    // effect or a picture source loses its media match during navigation.
    if (reason.includes('ERR_ABORTED')) return;
    faults.push(`requestfailed: ${request.url()} (${reason})`);
  });
  return faults;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function expectNativeViewportScrollbarHidden(page: Page) {
  const state = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).getPropertyValue('scrollbar-width'),
    body: getComputedStyle(document.body).getPropertyValue('scrollbar-width'),
    reservedWidth: window.innerWidth - document.documentElement.clientWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      .filter((element) => getComputedStyle(element).getPropertyValue('scrollbar-width') !== 'none')
      .map((element) => element.className || element.tagName)
      .slice(0, 10),
  }));
  expect(state).toEqual({ html: 'none', body: 'none', reservedWidth: 0, offenders: [] });
}

test.describe('Cutaway public narrative', () => {
  test('desktop carries the selected three-scene story', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop-only narrative capture');
    const faults = captureBrowserFaults(page);
    await installApiFixtures(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Find what.s missing/i })).toBeVisible();
    await expect(page.getByLabel('Website URL')).toBeVisible();
    for (const heading of [/Every layer,\s*examined/i, /Know what\s*to fix next/i]) {
      await page.getByRole('heading', { name: heading }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(page.locator('.wpa-scene-media')).toHaveCount(3);
    await expect(page.locator('.wpa-scene-media img')).toHaveCount(3);
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.locator('.wpa-result-panel')).toHaveCount(1);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'cutaway-journey-desktop');
    expect(faults).toEqual([]);
  });

  test('keeps authorization truth, Free plus three paid packages, and contact-only Enterprise', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop plan topology');
    await installApiFixtures(page);
    await page.goto('/');
    await expect(page.getByText(/sites you own or have permission to test/i)).toBeVisible();
    await page.getByRole('button', { name: 'Plans' }).click();
    await expect(page.getByRole('dialog', { name: /choose the depth/i })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.getByRole('link', { name: 'Start Free' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Redeem access' })).toHaveCount(2);
    for (const link of await page.getByRole('link', { name: 'Redeem access' }).all()) await expect(link).toHaveAttribute('href', '/register');
    await expect(page.getByRole('link', { name: 'Contact sales' })).toHaveAttribute('href', '/contact?plan=enterprise');
    await expect(page.getByText(/no credit card|required instantly|trusted by/i)).toHaveCount(0);
  });

  test('mobile preserves all three scenes without horizontal overflow', async ({ page }, testInfo) => {
    test.skip(!['mobile', 'compact'].includes(testInfo.project.name), 'mobile-only assertion');
    await installApiFixtures(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Find what.s missing/i })).toBeVisible();
    await page.getByRole('heading', { name: /Know what\s*to fix next/i }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: /Know what\s*to fix next/i })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'cutaway-journey-mobile');
  });

  test('mobile navigation locks page scroll and composes with Plans', async ({ page }, testInfo) => {
    test.skip(!['mobile', 'compact'].includes(testInfo.project.name), 'mobile navigation fixture');
    await installApiFixtures(page);
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 420));
    const beforeMenu = await page.evaluate(() => window.scrollY);
    await page.getByRole('button', { name: /open navigation/i }).click();
    await expect(page.getByRole('button', { name: /close navigation/i })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    const menuButton = await page.getByRole('button', { name: /close navigation/i }).boundingBox();
    expect(menuButton?.width || 0).toBeGreaterThanOrEqual(44);
    expect(menuButton?.height || 0).toBeGreaterThanOrEqual(44);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(beforeMenu);

    await page.getByRole('button', { name: 'Plans', exact: true }).click();
    await expect(page.getByRole('dialog', { name: /choose the depth/i })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /choose the depth/i })).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('reduced motion preserves static HTML for the entire story', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'reduced-motion', 'reduced-motion-only assertion');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApiFixtures(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Find what.s missing/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Know what\s*to fix next/i })).toBeAttached();
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'cutaway-journey-reduced-motion');
  });
});

test.describe('account and protected product routes', () => {
  test('login renders without a visual runtime dependency', async ({ page }) => {
    const faults = captureBrowserFaults(page);
    await installApiFixtures(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expectNativeViewportScrollbarHidden(page);
    await expectNoHorizontalOverflow(page);
    expect(faults).toEqual([]);
  });

  test('registration separates Terms+AUP acceptance from Privacy/KVKK notice', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop account fixture');
    await installApiFixtures(page);
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
    await expect(page.getByLabel(/full name/i)).toBeVisible();
    await expect(page.getByLabel(/work email/i)).toBeVisible();
    const password = page.getByLabel(/^password$/i);
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: /show password/i }).click();
    await expect(password).toHaveAttribute('type', 'text');
    const acceptance = page.getByRole('checkbox', { name: /terms of service.*acceptable use policy/i });
    await expect(acceptance).not.toBeChecked();
    await expect(page.getByText(/not consent checkboxes/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', '/privacy');
    await expect(page.getByRole('link', { name: 'KVKK Aydınlatma Metni' })).toHaveAttribute('href', '/kvkk');
  });

  test('registration queues active versions until the verified session can record them', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop account contract fixture');
    await installApiFixtures(page);
    let acceptanceBody: unknown;
    await page.route('**/api/auth/sign-up/email', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: null, user: { id: 'user-new', emailVerified: false } }) }));
    await page.route('**/api/v1/legal/acceptances', (route) => {
      acceptanceBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ acceptance: { id: 'acceptance-new' } }) });
    });
    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Avery Example');
    await page.getByLabel(/work email/i).fill('avery@example.test');
    await page.getByLabel(/^password$/i).fill('correct-horse-battery-staple');
    await page.getByRole('checkbox', { name: /terms of service.*acceptable use policy/i }).check();
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible();
    expect(acceptanceBody).toBeUndefined();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('wpa.pending-legal-acceptance.v1'))).toContain('"termsVersion":"1.0"');
    await page.goto('/app');
    await expect.poll(() => acceptanceBody).toEqual({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' });
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('wpa.pending-legal-acceptance.v1'))).toBeNull();
  });

  test('a verified session without browser pending state can record current legal versions', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop legal recovery contract fixture');
    await installApiFixtures(page);
    let accepted = false;
    let acceptanceBody: unknown;
    await page.route('**/api/v1/dashboard', (route) => accepted
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspaceDashboard) })
      : route.fulfill({ status: 428, contentType: 'application/json', body: JSON.stringify({ error: 'Accept current documents.', code: 'LEGAL_ACCEPTANCE_REQUIRED' }) }));
    await page.route('**/api/v1/legal/acceptances', (route) => {
      acceptanceBody = route.request().postDataJSON();
      accepted = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
    });
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: /review the current account terms/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', '/privacy');
    await page.getByRole('checkbox', { name: /terms of service.*acceptable use policy/i }).check();
    await page.getByRole('button', { name: /record acceptance and continue/i }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    expect(acceptanceBody).toEqual({ accepted: true, termsVersion: '1.0', acceptableUseVersion: '1.0' });
  });

  test('workspace rate limiting explains the wait and does not suggest signing in again', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop workspace error contract fixture');
    await installApiFixtures(page);
    await page.route('**/api/v1/dashboard', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '600' },
      body: JSON.stringify({ error: 'Too many API requests. Try again later.', code: 'RATE_LIMIT_EXCEEDED' }),
    }));

    await page.goto('/app');

    await expect(page.getByRole('heading', { name: 'Request limit reached.' })).toBeVisible();
    await expect(page.getByText(/signing out does not reset it/i)).toBeVisible();
    await expect(page.getByText(/in about 10 minutes/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to sign in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('login can transition into the authenticator challenge', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop account fixture');
    await installApiFixtures(page);
    await page.route('**/api/auth/sign-in/email', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ twoFactorRedirect: true }) }));
    await page.goto('/login');
    await page.getByLabel(/email address/i).fill('admin@example.test');
    await page.getByLabel(/^password$/i).fill('correct-horse-battery-staple');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByRole('heading', { name: /verify your identity/i })).toBeVisible();
    await expect(page.getByLabel(/authenticator code/i)).toBeVisible();
  });

  test('workspace fixture renders the five authored product views and System Status', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop workspace fixture');
    const faults = captureBrowserFaults(page);
    await installApiFixtures(page, 'workspace');
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.locator('.cutaway-engine')).toHaveCount(6);
    await expect(page.getByText('6 product-owned engine surfaces', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Performance Plus', exact: true })).toHaveClass(/is-active/);
    await expect(page.locator('.reference-priority')).toBeVisible();

    await page.getByRole('button', { name: 'Findings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Findings', exact: true })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.getByLabel('Filter by module')).toBeVisible();
    await page.locator('.findings-ledger__record summary').first().click();
    await expect(page.locator('.findings-ledger__record').first()).toContainText(/Coverage\s*complete/);
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'workspace-findings-ledger');

    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.getByLabel('Report version 3')).toContainText(/Website Analysis 03/i);
    await expect(page.getByRole('heading', { name: /Compare two report versions/i })).toBeVisible();
    await page.getByRole('button', { name: /compare versions/i }).click();
    await expect(page.getByText('fixture-new-fingerprint')).toBeVisible();
    await expect(page.getByText('fixture-fixed-fingerprint')).toBeVisible();
    await expect(page.locator('.report-sheet__modules')).toContainText(/core audit/i);
    await expect(page.locator('.report-crawler-coverage')).toContainText(/root/i);
    await expect(page.locator('.report-crawler-coverage')).toContainText(/sitemap/i);
    await expect(page.getByText(/signed by webpageanalyz|verified report/i)).toHaveCount(0);
    await page.locator('.report-timeline button').nth(2).click();
    await expect(page.getByRole('button', { name: /request expert review/i })).toHaveCount(0);
    await page.locator('.report-timeline button').nth(1).click();
    await expect(page.locator('.report-inspector')).toContainText('Website Analysis 02');
    await expect(page.getByRole('heading', { name: 'Share published evidence.' })).toBeVisible();
    await page.getByLabel('Share link expiry').selectOption('7');
    await page.getByRole('button', { name: 'Create share link' }).click();
    await expect(page.getByLabel('Canonical public share link')).toHaveValue(/\/shared-reports\/fixture-share-token-1234567890$/);
    await expect(page.getByText(/server (will expire it on|confirmed a \d+-day expiry)/i)).toBeVisible();
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText(/share link (copied|ready)/i)).toBeVisible();
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText(/share link was revoked/i)).toBeVisible();
    await page.locator('.report-timeline button').first().click();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'workspace-reports-seal');

    await page.getByRole('button', { name: 'Targets', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Targets', exact: true })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.locator('.runway-target')).toHaveCount(2);
    const allTargets = page.getByRole('button', { name: /All targets · (3|6)/i });
    const targetCount = Number((await allTargets.textContent())?.match(/\d+/)?.[0] || 0);
    await allTargets.click();
    await expect(page.getByRole('dialog', { name: /target registry/i })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /target registry/i })).toContainText('Northstar Docs');
    if (targetCount === 6) {
      await expect(page.getByRole('dialog', { name: /target registry/i })).toContainText('Northstar Commerce');
      await expect(page.getByRole('dialog', { name: /target registry/i })).toContainText('Northstar Careers');
      await expect(page.getByRole('dialog', { name: /target registry/i })).toContainText('Northstar Journal');
    }
    const targetRegistry = page.getByRole('dialog', { name: /target registry/i });
    await targetRegistry.getByRole('button', { name: /add target/i }).click();
    await expect(page.getByText(/Can you add a DNS TXT record/i)).toBeVisible();
    await expect(page.getByRole('radio', { name: /continue with the public link/i })).toBeChecked();
    await expect(page.getByText('WPA Site Crawler across the verified origin')).toBeVisible();
    await page.getByRole('radio', { name: /unlock full target access/i }).check();
    await expect(page.getByRole('button', { name: /add target & show dns/i })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await capture(page, testInfo, 'workspace-targets-registry-six');
    await page.getByRole('button', { name: /close target registry/i }).last().click();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'workspace-targets-runway');
    await page.locator('.targets-source>summary').click();
    await expect(page.getByText('OSV_UNAVAILABLE')).toBeVisible();

    await page.getByRole('button', { name: 'Integrations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.locator('.signal-port')).toHaveCount(4);
    await expect(page.locator('.signal-port').first()).toHaveClass(/is-connected/);
    await page.locator('.signal-port').nth(1).click();
    await expect(page.locator('.signal-inspector').getByRole('heading', { name: 'GitLab' })).toBeVisible();
    await page.locator('.signal-port').first().click();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'workspace-signal-ports');

    await page.getByRole('button', { name: /open profile menu/i }).click();
    await page.getByRole('button', { name: /account settings/i }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expectNativeViewportScrollbarHidden(page);
    await expect(page.locator('.settings-cabinet__wall')).toBeVisible();
    await expect(page.getByRole('button', { name: /Security 03/i })).toHaveClass(/is-active/);
    await page.locator('.settings-cabinet__wall nav button').first().click();
    await expect(page.getByLabel('Workspace name')).toBeVisible();
    await page.locator('.settings-cabinet__wall nav button').nth(1).click();
    await expect(page.getByText('High-priority findings', { exact: true })).toBeVisible();
    await page.locator('.settings-cabinet__wall nav button').nth(3).click();
    await expect(page.getByText('CURRENT PLAN')).toBeVisible();
    await page.locator('.settings-cabinet__wall nav button').nth(2).click();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'workspace-settings-cabinet');

    await page.getByRole('button', { name: /open profile menu/i }).click();
    await page.getByRole('button', { name: /system status/i }).click();
    await expect(page.getByText('Core systems operational')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto('/app/settings/billing');
    await expect(page.getByRole('heading', { name: 'Plan and billing' })).toBeVisible();
    await expect(page.getByText('CURRENT PLAN')).toBeVisible();
    expect(faults).toEqual([]);
  });

  test('profile menu shows the remaining user-owned plan allowances', async ({ page }, testInfo) => {
    await installApiFixtures(page, 'workspace');
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    if (['mobile', 'compact'].includes(testInfo.project.name)) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.locator('.portal-identity').click();
    } else {
      await page.getByRole('button', { name: 'Open profile menu' }).click();
    }
    const usage = page.getByLabel('Remaining plan usage');
    await expect(usage).toBeVisible();
    await expect(usage).toContainText('Studio');
    await expect(usage).toContainText(/Page credits\s*110\s*\/\s*150/);
    await expect(usage).toContainText(/AI guidance\s*988\s*\/\s*1000/);
    await expect(usage).toContainText(/Project slots\s*12\s*\/\s*15\s*left/);
    await expect(usage).toContainText(/Source audits\s*1\s*\/\s*1\s*left/);
    await expectNoHorizontalOverflow(page);
    if (testInfo.project.name === 'chromium') await capture(page, testInfo, 'workspace-profile-allowances');
  });

  test('workspace typography matches the public sans hierarchy without losing technical mono labels', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop typography contract fixture');
    await installApiFixtures(page, 'workspace');
    await page.goto('/app');
    await page.evaluate(() => document.fonts.ready);

    const publicFamily = /IBM Plex Sans/;
    const technicalFamily = /IBM Plex Mono/;
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toHaveCSS('font-family', publicFamily);
    const workspaceWordmark = page.locator('.portal-topbar .brand-mark__word');
    await expect(workspaceWordmark).toBeVisible();
    await expect(workspaceWordmark).toHaveCSS('font-family', publicFamily);
    await capture(page, testInfo, 'workspace-typography-overview');

    await page.getByRole('button', { name: 'Open profile menu' }).click();
    await page.getByRole('button', { name: 'Account settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCSS('font-family', publicFamily);
    await expect(page.locator('.settings-security-row small')).toHaveCSS('font-family', publicFamily);
    await expect(page.locator('.settings-cabinet__heading > span')).toHaveCSS('font-family', technicalFamily);
    await capture(page, testInfo, 'workspace-typography-settings');

    await page.locator('.settings-cabinet__wall nav button').first().click();
    await expect(page.getByRole('button', { name: 'Save workspace' })).toHaveCSS('font-family', publicFamily);
  });

  test('target handoff survives auth links and opens a review-first composer', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop target handoff fixture');
    const target = 'https://northstar.example/landing';
    await installApiFixtures(page, 'workspace');
    await page.goto(`/register?target=${encodeURIComponent(target)}`);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/login\\?target=${encodeURIComponent(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await page.goto(`/app?target=${encodeURIComponent(target)}`);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
    await expect(page.getByRole('link', { name: 'Need support?' })).toHaveAttribute('href', /mailto:/);
    await page.goto('/app?target=https%3A%2F%2Fnorthstar.example%2Flanding');
    await expect(page.getByRole('heading', { name: 'Targets', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /target registry/i })).toBeVisible();
    await expect(page.getByLabel('Public website URL')).toHaveValue(target);
    await expect(page.getByText(/review the access mode and confirm add target/i)).toBeVisible();
    await expect(page).toHaveURL(/\/app\/targets$/);
  });

  test('target creation records authorization and scans add manual URLs without replacing discovery', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop target contract fixture');
    await installApiFixtures(page, 'workspace');
    let projectBody: unknown;
    let scanBody: unknown;
    await page.route('**/api/v1/projects', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      projectBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ project: { id: 'project-created', name: 'Created target', origin: 'https://created.example', verifiedAt: null, verificationToken: 'proof-created' } }) });
    });
    await page.route('**/api/v1/scans', (route) => {
      scanBody = route.request().postDataJSON();
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ scan: { id: 'scan-created', status: 'queued' } }) });
    });
    await page.goto('/app/targets');
    await page.getByRole('button', { name: /add target/i }).first().click();
    const registry = page.getByRole('dialog', { name: /target registry/i });
    await registry.getByLabel('Project name').fill('Created target');
    await registry.getByLabel('Public website URL').fill('https://created.example');
    await registry.getByLabel(/additional authorized subdomains/i).fill('https://docs.created.example\nhttps://shop.created.example');
    await registry.getByRole('checkbox', { name: /own this target or have explicit permission/i }).check();
    await registry.getByRole('button', { name: /add target & continue/i }).click();
    await expect(page.getByText(/target added in public-link mode/i)).toBeVisible();
    expect(projectBody).toEqual({ name: 'Created target', url: 'https://created.example', locale: 'en', authorizationAttested: true, authorizationVersion: '1.0', additionalSubdomains: ['https://docs.created.example', 'https://shop.created.example'] });
    await page.getByRole('button', { name: /close target registry/i }).last().click();
    await page.locator('.targets-additional-urls>summary').click();
    await page.getByLabel(/one url per line/i).fill('https://northstar.example/known\nhttps://northstar.example/known\nhttps://northstar.example/not-linked');
    await page.getByRole('checkbox', { name: /external analyzer disclosure/i }).check();
    await page.locator('.runway-target').first().getByRole('button', { name: /scan/i }).click();
    expect(scanBody).toEqual({ projectId: 'project-001', locale: 'en', additionalUrls: ['https://northstar.example/known', 'https://northstar.example/not-linked'], externalProviderConsent: true });
  });

  test('AI remediation stays an explicit quota-aware suggestion beside measured evidence', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop AI remediation contract fixture');
    await installApiFixtures(page, 'workspace');
    let requestBody: unknown;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/findings/707ba7daf874/remediation') requestBody = request.postDataJSON();
    });
    await page.goto('/app/findings');
    await page.locator('.findings-ledger__record summary').first().click();
    const guidance = page.getByLabel('AI-generated remediation guidance');
    await expect(guidance.getByText('Suggestion only · not a verified fix')).toBeVisible();
    await guidance.getByRole('button', { name: 'Generate suggestion' }).click();
    await expect(guidance.getByRole('heading', { name: /guard checkout initialization/i })).toBeVisible();
    await expect(guidance.getByText(/999 of 1000 monthly generations remain/i)).toBeVisible();
    const regenerate = guidance.getByRole('button', { name: /regenerate · uses quota/i });
    await expect(regenerate).toBeVisible();
    await page.getByRole('button', { name: 'Open profile menu' }).click();
    const usage = page.getByLabel('Remaining plan usage');
    await expect(usage).toContainText(/AI guidance\s*999\s*\/\s*1000/);
    await page.getByRole('button', { name: 'Close popover' }).first().click();
    await expect(guidance.getByRole('heading', { name: /guard checkout initialization/i })).toBeVisible();
    const contrast = await guidance.evaluate((root) => {
      const ratio = (foreground: string, background: string) => {
        const luminance = (value: string) => {
          const channels = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const first = luminance(foreground);
        const second = luminance(background);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const result = root.querySelector<HTMLElement>('.finding-ai-guidance__result')!;
      const button = result.querySelector<HTMLButtonElement>('button')!;
      const resultStyle = getComputedStyle(result);
      const buttonStyle = getComputedStyle(button);
      return {
        result: ratio(resultStyle.color, resultStyle.backgroundColor),
        button: ratio(buttonStyle.color, buttonStyle.backgroundColor),
      };
    });
    expect(contrast.result).toBeGreaterThanOrEqual(4.5);
    expect(contrast.button).toBeGreaterThanOrEqual(4.5);
    expect(requestBody).toEqual({ refresh: false });
    await capture(page, testInfo, 'ai-remediation-contrast');
  });

  test('AI provider failure leaves the measured finding readable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop AI fail-soft fixture');
    await installApiFixtures(page, 'workspace');
    await page.route('**/api/v1/findings/707ba7daf874/remediation', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'AI remediation is temporarily unavailable.', code: 'AI_SERVICE_UNAVAILABLE' }) }));
    await page.goto('/app/findings');
    await page.locator('.findings-ledger__record summary').first().click();
    const guidance = page.getByLabel('AI-generated remediation guidance');
    await guidance.getByRole('button', { name: 'Generate suggestion' }).click();
    await expect(guidance.getByText(/AI is unavailable; the finding is unchanged/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /a script threw while initializing checkout/i })).toBeVisible();
  });

  test('workspace owner can apply a redeem code without exposing entitlement internals', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop redeem contract fixture');
    await installApiFixtures(page, 'workspace');
    let requestBody: unknown;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/redeem') requestBody = request.postDataJSON();
    });
    await page.goto('/app/settings/billing');
    const input = page.getByLabel('Redeem code');
    await input.fill('WPAFOUNDERS');
    await page.getByRole('button', { name: 'Apply code' }).click();
    await expect(page.getByRole('status')).toContainText('Effective plan: Studio');
    await expect(page.getByRole('status')).toContainText('200 page credits');
    await expect(input).toHaveValue('');
    expect(requestBody).toEqual({ code: 'WPAFOUNDERS' });
    await expect(page.getByText(/codeHash|codeSalt|grantId/i)).toHaveCount(0);
  });

  test('redeem-only early access removes checkout UI and never sends an upgrade request', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop early-access contract fixture');
    await installApiFixtures(page, 'workspace');
    let checkoutRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/billing/checkout') checkoutRequests += 1;
    });
    await page.goto('/app?checkout=studio');
    await expect(page).toHaveURL(/\/app\/settings\/billing$/);
    await expect(page.getByRole('heading', { name: 'Plan and billing' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/paid checkout is paused/i);
    await expect(page.getByLabel('Redeem code')).toBeVisible();
    await expect(page.getByRole('dialog', { name: /review the recurring purchase/i })).toHaveCount(0);
    expect(checkoutRequests).toBe(0);
  });

  test('report comparison keeps partial evidence and surfaces service errors', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop comparison contract fixture');
    await installApiFixtures(page, 'workspace');
    await page.route('**/api/v1/reports/compare/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ left: 'report-002', right: 'report-001', newFindings: ['partial-new-fingerprint'] }),
    }));
    await page.goto('/app/reports');
    await expect(page.getByRole('heading', { name: /Compare two report versions/i })).toBeVisible();
    await page.getByRole('button', { name: /compare versions/i }).click();
    await expect(page.getByText('partial-new-fingerprint')).toBeVisible();
    await expect(page.getByText(/this category was not returned by the comparison service/i)).toHaveCount(2);
    await page.unroute('**/api/v1/reports/compare/**');
    await page.route('**/api/v1/reports/compare/**', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Reports belong to different projects.' }),
    }));
    await page.getByRole('button', { name: /compare versions/i }).click();
    await expect(page.getByRole('alert')).toContainText(/different projects/i);
  });

  test('share controls reject an incomplete canonical page contract', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop share contract fixture');
    await installApiFixtures(page, 'workspace');
    await page.route('**/api/v1/reports/**/share', (route) => route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'fixture-share-token-1234567890', status: 'active', expiresAt: '2026-09-11T10:00:00.000Z' }),
    }));
    await page.goto('/app/reports');
    await page.locator('.report-timeline button').nth(1).click();
    await page.getByRole('button', { name: 'Create share link' }).click();
    await expect(page.getByRole('alert')).toContainText(/canonical public page path/i);
    await expect(page.getByLabel('Canonical public share link')).toHaveCount(0);
  });

  test('billing returns are explicit and query state is cleaned after refresh', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop billing return fixture');
    await installApiFixtures(page, 'workspace');
    await page.goto('/app?billing=success');
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('status')).toContainText(/current entitlement: Studio/i);
    await page.goto('/app/reports?billing=return&session_id=cs_fixture_return&keep=reports');
    await expect(page.getByText(/current entitlement: Studio/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/reports\?keep=reports$/);
    await page.goto('/app?billing=portal_return&session_id=cs_fixture_legacy');
    await expect(page.getByText(/current entitlement: Studio/i)).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
    await page.goto('/app?billing=cancelled');
    await expect(page.getByText(/checkout was cancelled/i)).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
  });

  test('paid checkout requires a canonical recurring purchase confirmation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop checkout contract fixture');
    await installApiFixtures(page, 'workspace');
    await page.route('**/api/v1/legal/config', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...legalConfig, billing: { ...legalConfig.billing, paymentsEnabled: true, mode: 'paid', merchantOfRecord: 'Paddle', recurring: true } }),
    }));
    let checkoutBody: unknown;
    let idempotencyKey = '';
    await page.route('**/api/v1/billing/checkout', (route) => {
      checkoutBody = route.request().postDataJSON();
      idempotencyKey = route.request().headers()['idempotency-key'] || '';
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ url: 'https://checkout.paddle.test/transaction-001' }) });
    });
    await page.route('https://checkout.paddle.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Paddle checkout fixture</title>' }));
    await page.goto('/app?checkout=studio');
    const dialog = page.getByRole('dialog', { name: /review the recurring purchase/i });
    await expect(dialog).toContainText('Studio');
    await expect(dialog).toContainText('99 USD');
    await expect(dialog).toContainText(/recurring until cancelled/i);
    await expect(dialog).toContainText(/merchant of record/i);
    await expect(dialog).toContainText('Paddle');
    await expect(dialog.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    await expect(dialog.getByRole('link', { name: 'Cancellation and Refund Policy' })).toHaveAttribute('href', '/refund');
    await dialog.getByRole('checkbox', { name: /recurring subscription/i }).check();
    await dialog.getByRole('button', { name: /continue to paddle/i }).click();
    await expect(page).toHaveURL('https://checkout.paddle.test/transaction-001');
    expect(checkoutBody).toEqual({ planId: 'studio', accepted: true, recurringAcknowledged: true, termsVersion: '1.0', refundPolicyVersion: '1.0' });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('scan progress reconnects EventSource from Last-Event-ID without duplicating actions', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop SSE reconnect fixture');
    await installApiFixtures(page, 'running');
    const progressStatuses: string[] = [];
    let progressCalls = 0;
    let progressComplete = false;
    let scanPosts = 0;
    await page.addInitScript(() => {
      const instances: Array<{ url: string; emit: (type: string, lastEventId: string) => void; fail: () => void }> = [];
      class FixtureEventSource extends EventTarget {
        url: string;
        readyState = 1;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        constructor(url: string) {
          super();
          this.url = url;
          instances.push(this);
          queueMicrotask(() => this.onopen?.(new Event('open')));
        }
        close() {
          this.readyState = 2;
        }
        emit(type: string, lastEventId: string) {
          this.dispatchEvent(new MessageEvent(type, { lastEventId, data: '{}' }));
        }
        fail() {
          this.onerror?.(new Event('error'));
        }
      }
      Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: FixtureEventSource });
      Object.defineProperty(window, '__wpaEventSources', { configurable: true, value: instances });
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/v1\/scans$/.test(new URL(request.url()).pathname)) scanPosts += 1;
    });
    await page.route('**/api/v1/dashboard', (route) => {
      const complete = progressComplete;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...workspaceDashboard, scans: [{ id: 'scan-live', status: complete ? 'completed' : 'running', createdAt: '2026-08-12T10:00:00.000Z' }] }),
      });
    });
    await page.route(/\/api\/v1\/scans\/scan-live\/progress(?:\?.*)?$/, (route) => {
      progressCalls += 1;
      const complete = progressComplete;
      const status = complete ? 'completed' : 'running';
      progressStatuses.push(status);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ scan: { id: 'scan-live', status, createdAt: '2026-08-12T10:00:00.000Z' }, counts: { [status]: 1 } }),
      });
    });
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__wpaEventSources?.length || 0)).toBe(1);
    await expect.poll(() => progressStatuses.includes('running')).toBe(true);
    const callsBeforeRunningEvent = progressCalls;
    await page.evaluate(() => (window as any).__wpaEventSources[0].emit('scan.running', '41'));
    await expect.poll(() => progressCalls).toBeGreaterThan(callsBeforeRunningEvent);
    await page.evaluate(() => (window as any).__wpaEventSources[0].fail());
    await expect.poll(() => page.evaluate(() => (window as any).__wpaEventSources?.length || 0)).toBe(2);
    const resumeUrl = await page.evaluate(() => (window as any).__wpaEventSources[1].url as string);
    expect(resumeUrl).toContain('after=41');
    progressComplete = true;
    const callsBeforeCompletedEvent = progressCalls;
    await page.evaluate(() => (window as any).__wpaEventSources[1].emit('scan.completed', '42'));
    await expect.poll(() => progressCalls).toBeGreaterThan(callsBeforeCompletedEvent);
    await expect.poll(() => progressStatuses.includes('completed')).toBe(true);
    expect(scanPosts).toBe(0);
    expect(progressStatuses).toContain('running');
  });

  test('customer scan progress exposes a stage estimate and real engine lifecycle states', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop live scan fixture');
    await installApiFixtures(page, 'running');
    await page.goto('/app');

    const panel = page.getByRole('region', { name: 'Live scan progress' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Scan stage estimate' })).toHaveAttribute('aria-valuenow', '36');
    await expect(panel).toContainText('2 / 7 engines completed');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Lighthouse' })).toContainText('Completed');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Accessibility / Axe' })).toContainText('Running');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Performance Plus' })).toContainText('Waiting');
    await expect(panel).toContainText(/Live event stream|Polling fallback/);
    if (process.env.WPA_CAPTURE_SCAN_PROGRESS === '1') await page.screenshot({ path: testInfo.outputPath('scan-progress-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    if (process.env.WPA_CAPTURE_SCAN_PROGRESS === '1') await page.screenshot({ path: testInfo.outputPath('scan-progress-mobile.png'), fullPage: true });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const runningIconAnimation = await panel.getByRole('listitem').filter({ hasText: 'Accessibility / Axe' }).locator('svg').evaluate((node) => getComputedStyle(node).animationName);
    expect(runningIconAnimation).toBe('none');

    await page.setViewportSize({ width: 320, height: 800 });
    const compactBounds = await panel.boundingBox();
    expect(compactBounds).not.toBeNull();
    expect(compactBounds!.x).toBeGreaterThanOrEqual(0);
    expect(compactBounds!.x + compactBounds!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test('workspace core survives an isolated surface outage', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop fail-soft fixture');
    const outages = [
      { path: '/api/v1/reports', button: 'Reports', heading: 'Reports is unavailable.' },
      { path: '/api/v1/findings', button: 'Findings', heading: 'Findings is unavailable.' },
      { path: '/api/v1/status', button: 'System Status', heading: 'System status is unavailable.' },
      { path: '/api/v1/integrations', button: 'Integrations', heading: 'Integrations is unavailable.' },
      { path: '/api/v1/settings', button: 'Settings', heading: 'Settings is unavailable.' },
    ];

    for (const outage of outages) {
      await page.unroute('**/api/**');
      await installApiFixtures(page, 'workspace', outage.path);
      await page.goto('/app');
      await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

      if (outage.button === 'Settings' || outage.button === 'System Status') {
        await page.getByRole('button', { name: /open profile menu/i }).click();
        await page.getByRole('button', { name: new RegExp(outage.button, 'i'), exact: true }).click();
      } else {
        await page.getByRole('button', { name: outage.button, exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: outage.heading, exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    }
  });

  test('dashboard surfaces follow deep links, history, aliases, and Support navigation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop route synchronization fixture');
    await installApiFixtures(page, 'workspace');
    const directRoutes = [
      { path: '/app', heading: 'Overview' },
      { path: '/app/dashboard', heading: 'Overview' },
      { path: '/app/findings', heading: 'Findings' },
      { path: '/app/reports', heading: 'Reports' },
      { path: '/app/targets', heading: 'Targets' },
      { path: '/app/integrations', heading: 'Integrations' },
      { path: '/app/settings', heading: 'Settings' },
      { path: '/app/status', heading: 'System health' },
    ];
    for (const route of directRoutes) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible();
    }

    await page.goto('/app/reports');
    await page.goto('/app/findings');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Findings', exact: true })).toBeVisible();

    await page.goto('/app/not-a-workspace-surface');
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

    await page.goto('/app/support');
    await expect(page.getByRole('heading', { name: /support, with a paper trail/i })).toBeVisible();
    await page.getByRole('button', { name: 'Reports', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  });

  test('mobile workspace views and Engine Lab remain inside the viewport', async ({ page }, testInfo) => {
    test.skip(!['mobile', 'compact'].includes(testInfo.project.name), 'mobile containment fixture');
    await installApiFixtures(page, 'admin');

    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    for (const section of ['Findings', 'Reports', 'Targets', 'Integrations']) {
      await page.getByRole('button', { name: /open navigation/i }).click();
      await page.getByRole('button', { name: section, exact: true }).click();
      await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
      if (section === 'Reports') {
        await expect(page.getByRole('heading', { name: /Compare two report versions/i })).toBeVisible();
        await page.locator('.report-timeline button').nth(1).click();
        await expect(page.getByRole('heading', { name: 'Share published evidence.' })).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole('button', { name: /open navigation/i }).click();
    await page.getByRole('button', { name: 'Targets', exact: true }).click();
    await page.getByRole('button', { name: /add target/i }).first().click();
    await expect(page.getByText(/Can you add a DNS TXT record/i)).toBeVisible();
    await expect(page.getByRole('radio', { name: /continue with the public link/i })).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await expectNativeViewportScrollbarHidden(page);
    await capture(page, testInfo, `workspace-target-access-${testInfo.project.name}`);
    await page.getByRole('button', { name: /close target registry/i }).last().click();
    await page.getByRole('button', { name: /open navigation/i }).click();
    await page.locator('.portal-identity').click();
    await page.getByRole('button', { name: /account settings/i }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /admin proof room/i })).toBeVisible();
    await page.getByRole('button', { name: /open navigation/i }).click();
    await page.getByRole('button', { name: /engine test lab/i }).click();
    await expect(page.getByRole('heading', { name: /set the test impression/i })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: /northstar\.example/i }).last().click();
    await expect(page.getByRole('progressbar', { name: /WPA Page progress/i })).toHaveAttribute('aria-valuenow', '100');
    await expectNoHorizontalOverflow(page);
  });

  test('mobile workspace actions meet the 44px touch target floor', async ({ page }, testInfo) => {
    test.skip(!['mobile', 'compact'].includes(testInfo.project.name), 'mobile touch target fixture');
    await installApiFixtures(page, 'workspace');
    await page.goto('/app');
    await page.getByRole('button', { name: /open navigation/i }).click();
    await page.getByRole('button', { name: 'Targets', exact: true }).click();
    const boxes = await page.locator('.portal-topbar__actions > button:visible, .targets-runway__heading button:visible, .runway-target>div button:visible').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: (element.textContent || element.getAttribute('aria-label') || '').trim(), width: rect.width, height: rect.height };
    }));
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.height, `${box.label} height`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${box.label} width`).toBeGreaterThanOrEqual(44);
    }
  });

  test('Signal target composer starts from a public link without asking for DNS', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop Signal fixture');
    await installApiFixtures(page, 'signal');
    await page.goto('/app');
    await page.getByRole('button', { name: 'Targets', exact: true }).click();
    await page.getByRole('button', { name: /add target/i }).first().click();
    await expect(page.getByText('No DNS record needed on Signal.')).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /add target & continue/i })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('workspace views keep a complete reduced-motion path', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'reduced-motion', 'reduced-motion workspace fixture');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApiFixtures(page, 'workspace');
    await page.goto('/app');
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    for (const section of ['Findings', 'Reports', 'Targets', 'Integrations']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
      if (section === 'Reports') {
        await expect(page.getByRole('heading', { name: /Compare two report versions/i })).toBeVisible();
        await page.locator('.report-timeline button').nth(1).click();
        await expect(page.getByRole('heading', { name: 'Share published evidence.' })).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole('button', { name: /open profile menu/i }).click();
    await page.getByRole('button', { name: /account settings/i }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.settings-cabinet__wall nav button').nth(2)).toHaveCSS('transition-duration', '0s');
  });

  test('ordinary workspace session is denied from admin', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop admin fixture');
    await installApiFixtures(page, 'admin-denied');
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /this account is not an administrator/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /return to workspace/i })).toBeVisible();
  });

  test('read-only admin navigation does not demand repeated step-up', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop admin fixture');
    await installApiFixtures(page, 'admin-reauth');
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /admin proof room/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /confirm your identity/i })).toHaveCount(0);
  });

  test('admin fixture exposes Engine Lab progress and results inspector escape flow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop admin fixture');
    await installApiFixtures(page, 'admin');
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /admin proof room/i })).toBeVisible();
    const openAdminSection = async (name: string | RegExp) => {
      const primary = page.getByRole('button', { name, exact: typeof name === 'string' });
      if (await primary.isVisible().catch(() => false)) {
        await primary.click();
        return;
      }
      await page.getByRole('button', { name: /more admin sections/i }).click();
      await page.getByRole('menuitem', { name, exact: typeof name === 'string' }).click();
    };
    for (const section of ['Users', 'Scans', 'Findings', 'Reports', 'Expert Reviews', 'Integrations', 'Settings']) {
      await openAdminSection(section);
      await expect(page.getByRole('heading', { name: section, exact: true }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    await openAdminSection(/engine test lab/i);
    await expect(page.getByRole('heading', { name: /set the test impression/i })).toBeVisible();
    await page.getByRole('button', { name: /inflight\.example/i }).last().click();
    await expect(page.getByRole('progressbar', { name: /WPA Page progress/i })).toHaveAttribute('aria-valuenow', '64');
    await page.getByRole('button', { name: /northstar\.example/i }).last().click();
    await expect(page.getByRole('progressbar', { name: /WPA Page progress/i })).toHaveAttribute('aria-valuenow', '100');
    await openAdminSection(/lab results/i);
    await expect(page.getByRole('heading', { name: /engine lab results/i })).toBeVisible();
    await page.getByRole('button', { name: /northstar\.example/i }).first().click();
    await page.getByRole('button', { name: /browser console errors occurred/i }).click();
    await expect(page.getByRole('heading', { name: 'Browser console errors occurred' })).toBeVisible();
    await expect(page.getByText(/Guard the checkout session/i)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('SELECT AN IMPRESSION')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, 'admin-lab-results-inspector');
  });
});
