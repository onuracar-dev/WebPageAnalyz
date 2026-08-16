import { expect, test, type Page, type Route } from '@playwright/test';
import { ADMIN_FIXTURE_PERMISSIONS } from './iceberg-fixtures';

const now = '2026-08-14T08:00:00.000Z';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installAdminRouteFixtures(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/admin/me') return json(route, { admin: { actorId: 'admin-1', email: 'admin@example.test', role: 'admin', permissions: ADMIN_FIXTURE_PERMISSIONS, via: 'session' } });
    if (url.pathname === '/api/v1/admin/overview') return json(route, { totals: { users: 12, scans: 34, reports: 28, findings: 64, critical: 2 }, activity: [], health: [] });
    if (url.pathname === '/api/v1/admin/operator-tasks') return json(route, { tasks: [] });
    if (url.pathname === '/api/v1/admin/resources/users' || url.pathname === '/api/v1/admin/resources/scans' || url.pathname === '/api/v1/admin/resources/findings' || url.pathname === '/api/v1/admin/resources/reports') return json(route, { resources: [] });
    if (url.pathname === '/api/v1/admin/expert-reviews') return json(route, { reviews: [] });
    if (url.pathname === '/api/v1/admin/engine-lab/catalog') return json(route, { engines: [] });
    if (url.pathname === '/api/v1/admin/engine-lab/runs') return json(route, { runs: [] });
    if (url.pathname === '/api/v1/admin/support/tickets') return json(route, { tickets: [], limit: 25, nextCursor: null });
    return json(route, { error: `Unexpected admin fixture request: ${url.pathname}` }, 404);
  });
}

async function installSharedFixtures(page: Page, mode: 'success' | 'not-found' | 'expired') {
  await page.route('**/api/v1/shared-reports/**', async (route) => {
    if (mode === 'not-found') return json(route, { error: 'Shared report not found.', code: 'SHARED_REPORT_NOT_FOUND' }, 404);
    if (mode === 'expired') return json(route, { error: 'Shared report link expired.', code: 'SHARED_REPORT_EXPIRED' }, 404);
    return json(route, {
      report: {
        id: 'rpt-public-42', version: 3, status: 'published', publishedAt: now,
        workspaceId: 'private-workspace-must-not-render', shareTokenHash: 'private-token-hash-must-not-render',
        payload: {
          summary: { terminalState: 'complete', requestedPages: 4, completedPages: 4, incompletePages: 0, unavailablePages: 0 },
          modules: { core_audit: { status: 'completed', engines: ['lighthouse', 'axe'] }, runtime: { status: 'partial', engines: ['wpaPage'] } },
          pages: [{ url: 'https://example.com/' }, { url: 'https://example.com/pricing?private=omit' }],
        },
      },
    });
  });
}

test.describe('route residue and public share views', () => {
  test('every admin deep link resolves to its mapped view and aliases normalize', async ({ page }) => {
    await installAdminRouteFixtures(page);
    const views: Array<[string, string]> = [
      ['/admin', 'Admin proof room'],
      ['/admin/users', 'Users'],
      ['/admin/scans', 'Scans'],
      ['/admin/findings', 'Findings'],
      ['/admin/reports', 'Reports'],
      ['/admin/support', 'Support Inbox'],
      ['/admin/expert-reviews', 'Expert Reviews'],
      ['/admin/engine-lab', 'Engine Test Lab'],
      ['/admin/lab-results', 'Lab Results'],
      ['/admin/integrations', 'Integrations'],
      ['/admin/settings', 'Settings'],
    ];
    for (const [path, heading] of views) {
      await page.goto(path);
      await expect(page.locator('.portal-heading h1')).toHaveText(heading);
    }
    for (const [alias, canonical] of [['/admin/overview', '/admin'], ['/admin/dashboard', '/admin'], ['/admin/users/', '/admin/users'], ['/admin/expert_reviews', '/admin/expert-reviews'], ['/admin/engine_lab', '/admin/engine-lab'], ['/admin/lab_results', '/admin/lab-results']] as const) {
      await page.goto(alias);
      await expect.poll(() => new URL(page.url()).pathname).toBe(canonical);
    }
  });

  test('admin browser history restores the prior view and invalid children stay honest', async ({ page }) => {
    await installAdminRouteFixtures(page);
    await page.goto('/admin/users');
    const reportsNav = page.getByRole('button', { name: 'Reports', exact: true }).first();
    if (await reportsNav.isVisible().catch(() => false)) await reportsNav.click();
    else await page.goto('/admin/reports');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/reports');
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/users');
    await expect(page.locator('.portal-heading h1')).toHaveText('Users');
    await page.goto('/admin/not-a-real-view');
    await expect(page.getByRole('heading', { name: 'This admin route is not registered.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Admin proof room' })).toHaveCount(0);
  });

  test('public shared report renders a token-scoped evidence summary without private fields', async ({ page }) => {
    await installSharedFixtures(page, 'success');
    await page.goto('/shared-reports/valid-share-token-12345');
    await expect(page.getByRole('heading', { name: 'Evidence is sealed for reading.' })).toBeVisible();
    await expect(page.getByText('core audit', { exact: true })).toBeVisible();
    await expect(page.getByText('https://example.com/pricing', { exact: true })).toBeVisible();
    await expect(page.getByText('private-workspace-must-not-render', { exact: true })).toHaveCount(0);
    await expect(page.getByText('private-token-hash-must-not-render', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });

  test('public shared report distinguishes invalid, not-found, and expired links', async ({ page }) => {
    await page.goto('/shared-reports/short');
    await expect(page.getByRole('heading', { name: 'This share link is not valid.' })).toBeVisible();
    await installSharedFixtures(page, 'not-found');
    await page.goto('/shared-reports/valid-share-token-12345');
    await expect(page.getByRole('heading', { name: 'This shared report was not found.' })).toBeVisible();
    await page.unroute('**/api/v1/shared-reports/**');
    await installSharedFixtures(page, 'expired');
    await page.goto('/share/valid-share-token-12345');
    await expect(page.getByRole('heading', { name: 'This share link has expired.' })).toBeVisible();
  });
});
