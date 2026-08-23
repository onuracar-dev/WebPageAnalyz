import { expect, test, type Page, type Route } from '@playwright/test';

type RequestRecord = { path: string; method: string; body?: Record<string, unknown> };

const ALL_ADMIN_PERMISSIONS = [
  'admin.session.read', 'system.read', 'users.read', 'users.ban', 'users.unban',
  'workspaces.read', 'workspaces.suspend', 'workspaces.unsuspend', 'workspaces.delete',
  'credits.read', 'credits.manage', 'entitlements.read', 'entitlements.manage', 'plans.manage',
  'scans.read', 'scans.retry', 'scans.cancel', 'support.read', 'support.reply',
  'support.internal_note', 'support.manage', 'redeem.read', 'redeem.manage', 'billing.read',
  'billing.reconcile', 'audit.read', 'webhooks.read', 'webhooks.replay', 'engine_lab.read',
  'engine_lab.execute', 'engine_lab.cancel', 'expert_reviews.read', 'expert_reviews.manage',
  'expert_reviews.finalize', 'expert_reviews.publish', 'reports.read', 'reports.publish',
  'security.self.read', 'security.self.manage', 'security.self.recovery', 'security.admins.read',
  'security.admins.manage', 'security.roles.read', 'security.roles.manage', 'security.mfa.manage',
  'security.recovery.manage', 'security.activity.read',
];
const SELF = ['admin.session.read', 'security.self.read', 'security.self.manage', 'security.self.recovery'];
const SUPPORT = [...SELF, 'system.read', 'users.read', 'workspaces.read', 'scans.read', 'reports.read', 'support.read', 'support.reply', 'support.internal_note'];
const MODERATOR = [...SUPPORT, 'users.ban', 'users.unban', 'workspaces.suspend', 'workspaces.unsuspend', 'scans.retry', 'scans.cancel', 'support.manage', 'audit.read', 'expert_reviews.read', 'expert_reviews.manage'];
function permissionsForFixtureRole(input: string) {
  const role = input === 'operator' ? 'moderator' : input;
  if (role === 'super_admin') return ALL_ADMIN_PERMISSIONS;
  if (role === 'admin') return ALL_ADMIN_PERMISSIONS.filter((permission) =>
    !permission.startsWith('security.admins.')
    && !permission.startsWith('security.roles.')
    && !['security.mfa.manage', 'security.recovery.manage', 'workspaces.delete', 'plans.manage', 'reports.publish', 'expert_reviews.publish'].includes(permission));
  if (role === 'moderator') return [...new Set(MODERATOR)];
  if (role === 'support') return [...new Set(SUPPORT)];
  return [];
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installFixtures(page: Page, requests: RequestRecord[], role = 'admin') {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() as Record<string, unknown> | undefined;
    requests.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === '/api/v1/admin/me') return json(route, { admin: { actorId: 'admin-1', email: 'admin@example.test', role: role === 'operator' ? 'moderator' : role, permissions: permissionsForFixtureRole(role), via: 'session' } });
    if (url.pathname === '/api/v1/admin/overview') return json(route, { totals: { users: 1, scans: 1, reports: 0, findings: 0, critical: 0 }, activity: [], health: [] });
    if (url.pathname === '/api/v1/admin/operator-tasks') return json(route, { tasks: [] });
    if (url.pathname === '/api/v1/admin/security/status') return json(route, {
      role: role === 'operator' ? 'moderator' : role,
      permissions: permissionsForFixtureRole(role),
      policy: { webAuthnRequired: role === 'super_admin' || role === 'admin', minimumCredentials: 1, recommendedCredentials: 2, stepUpMaxAgeSeconds: 600 },
      passkeys: [], recoveryCodesRemaining: 0, recentStepUp: null, recentActivity: [],
    });
    if (url.pathname === '/api/v1/admin/security/admins') return json(route, { admins: [] });
    if (url.pathname === '/api/v1/admin/resources/users') return json(route, { resources: [
      { id: 'user-1', name: 'Ada Operator', email: 'ada@example.test', emailVerified: true, twoFactorEnabled: true, state: 'active', createdAt: '2026-08-14T00:00:00.000Z', lastActivityAt: '2026-08-15T00:00:00.000Z', workspaces: [{ id: 'workspace-1', name: 'Ada Workspace', planId: 'free', state: 'active' }] },
      { id: 'user-2', name: 'Lin Reviewer', email: 'lin@example.test', emailVerified: true, twoFactorEnabled: true, state: 'active', createdAt: '2026-08-13T00:00:00.000Z', lastActivityAt: '2026-08-15T01:00:00.000Z', workspaces: [{ id: 'workspace-2', name: 'Lin Workspace', planId: 'signal', state: 'active' }] },
    ] });
    if (url.pathname === '/api/v1/admin/resources/workspaces') return json(route, { resources: [{ id: 'workspace-1', name: 'Ada Workspace', planId: 'free', state: 'active', projects: 1, scans: 1, failedScans: 1 }] });
    if (url.pathname === '/api/v1/admin/resources/scans') return json(route, { resources: [{ id: 'scan-1', workspaceId: 'workspace-1', status: 'failed', failureCode: 'BROWSER_UNAVAILABLE', createdAt: '2026-08-15T00:00:00.000Z' }] });
    if (url.pathname === '/api/v1/admin/resources/grants') return json(route, { resources: [{ id: 'grant-user-2', userId: 'user-2', userEmail: 'lin@example.test', temporaryPlanId: 'studio', expiresAt: '2099-01-01T00:00:00.000Z' }] });
    if (url.pathname === '/api/v1/admin/resources/audit') return json(route, { resources: [
      {
        id: 'audit-credit-1', workspaceId: 'workspace-2', actorId: 'admin-1', action: 'user.credits_granted', entityType: 'user_credit_adjustment', entityId: 'credit-adjustment-1',
        reason: 'Restore credits after a failed scan.', requestId: 'request-credit-1', createdAt: '2026-08-16T09:55:42.000Z',
        actor: { id: 'admin-1', name: 'Admin Operator', email: 'admin@example.test' }, targetUser: { id: 'user-2', name: 'Lin Reviewer', email: 'lin@example.test' },
        before: null, after: { userId: 'user-2', creditType: 'ai', amount: 25, expiresAt: '2099-01-01T00:00:00.000Z' },
        metadata: { targetUserId: 'user-2', creditType: 'ai', amount: 25, apiToken: '[REDACTED]' },
      },
      {
        id: 'audit-plan-1', actorId: 'admin-1', action: 'user.plan_changed', entityType: 'user_entitlement_profile', entityId: 'user-2',
        reason: 'Approved account plan correction.', requestId: 'request-plan-1', createdAt: '2026-08-16T09:50:00.000Z',
        actor: { id: 'admin-1', name: 'Admin Operator', email: 'admin@example.test' }, targetUser: { id: 'user-2', name: 'Lin Reviewer', email: 'lin@example.test' },
        before: { planId: 'free' }, after: { planId: 'signal' }, metadata: { targetUserId: 'user-2', source: 'admin' },
      },
    ] });
    const userMatch = url.pathname.match(/^\/api\/v1\/admin\/users\/(user-[12])$/);
    if (userMatch && request.method() === 'GET') {
      const userId = userMatch[1];
      const lin = userId === 'user-2';
      return json(route, { user: {
        user: { id: userId, name: lin ? 'Lin Reviewer' : 'Ada Operator', email: lin ? 'lin@example.test' : 'ada@example.test', state: 'active' },
        profile: { planId: lin ? 'signal' : 'free' }, effective: { effectivePlanId: lin ? 'signal' : 'free', limits: { pageCredits: lin ? 25 : 5, aiRemediations: lin ? 100 : 5 } }, usage: { consumed: 1, reserved: 0 },
        grants: lin ? [{ id: 'grant-user-2', userId, temporaryPlanId: 'studio', expiresAt: '2099-01-01T00:00:00.000Z' }] : [], creditAdjustments: [],
        workspaces: [{ id: lin ? 'workspace-2' : 'workspace-1', name: lin ? 'Lin Workspace' : 'Ada Workspace' }], subscription: null, aiUsage: [], audit: [],
      } });
    }
    if (url.pathname === '/api/v1/admin/workspaces/workspace-1' && request.method() === 'GET') return json(route, { workspace: { workspace: { id: 'workspace-1', name: 'Ada Workspace', planId: 'free', state: 'active' }, subscription: null, effective: {}, usage: { consumed: 1, reserved: 0 }, grants: [], creditAdjustments: [], projects: [{ id: 'project-1' }], recentScans: [{ id: 'scan-1' }], failedScans: [{ id: 'scan-1', status: 'failed', failureCode: 'BROWSER_UNAVAILABLE' }], aiUsage: [], supportTickets: [], audit: [] } });
    if (url.pathname === '/api/v1/admin/redeem-codes' && request.method() === 'GET') return json(route, { codes: [] });
    if (url.pathname === '/api/v1/admin/redeem-codes' && request.method() === 'POST') return json(route, { code: { id: 'redeem-1', codeHint: 'WPA…ERS', active: true } }, 201);
    if (request.method() === 'POST') return json(route, { ok: true });
    return json(route, { error: `Unexpected fixture request: ${url.pathname}` }, 404);
  });
}

test.describe('admin operations v2', () => {
  test('desktop admin navigation stays inside the header and exposes secondary sections through one menu', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await page.setViewportSize({ width: 1180, height: 820 });
    await installFixtures(page, requests);
    await page.goto('/admin');

    const navigation = page.getByRole('navigation', { name: 'Admin navigation' }).first();
    const actions = page.locator('.portal-topbar__actions');
    const more = navigation.getByRole('button', { name: 'More admin sections' });
    await expect(more).toBeVisible();

    const navigationBox = await navigation.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(navigationBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(navigationBox!.x + navigationBox!.width).toBeLessThanOrEqual(actionsBox!.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));

    await more.click();
    const menu = page.getByRole('menu', { name: 'More admin sections' });
    await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await more.click();
    await menu.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(menu).toHaveCount(0);
    await expect(more).toHaveAttribute('aria-current', 'page');
  });

  test('compact admin navigation is a complete scrollable drawer', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await page.setViewportSize({ width: 1024, height: 700 });
    await installFixtures(page, requests);
    await page.goto('/admin');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Admin navigation' });
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBeGreaterThanOrEqual(360);
    const settings = drawer.getByRole('button', { name: 'Settings' });
    await settings.scrollIntoViewIfNeeded();
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(drawer).toBeHidden();

    await page.setViewportSize({ width: 390, height: 700 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(drawer).toBeVisible();
    const mobileDrawerBox = await drawer.boundingBox();
    expect(mobileDrawerBox?.width).toBeGreaterThanOrEqual(340);
    expect(mobileDrawerBox?.width).toBeLessThanOrEqual(352);
    const dashboard = drawer.getByRole('button', { name: 'Dashboard' });
    await dashboard.scrollIntoViewIfNeeded();
    await dashboard.click();
    await expect(page).toHaveURL(/\/admin$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
  });

  test('dangerous user action requires reason and explicit confirmation', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/users');
    const console = page.locator('.admin-operations');
    await expect(console.getByText('Ada Operator')).toBeVisible();
    await expect(console.getByText(/^Created /).first()).toBeVisible();
    await expect(console.getByText(/^Last activity /).first()).toBeVisible();
    await console.getByRole('button', { name: 'Manage access' }).first().click();
    const inspector = console.getByRole('region', { name: 'Access controls for ada@example.test' });
    const ban = inspector.getByRole('button', { name: 'Ban user' });
    await expect(ban).toBeDisabled();
    await inspector.getByPlaceholder('Why is this operation necessary?').fill('Confirmed abuse investigation.');
    await inspector.getByRole('checkbox').check();
    await expect(ban).toBeEnabled();
    await ban.click();
    await expect(console.getByText('User access blocked.')).toBeVisible();
    const mutation = requests.find((item) => item.path === '/api/v1/admin/users/user-1/ban' && item.method === 'POST');
    expect(mutation?.body).toEqual({ reason: 'Confirmed abuse investigation.', confirm: true });
  });

  test('Manage access reveals and focuses the selected user inspector', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await page.setViewportSize({ width: 1180, height: 560 });
    await installFixtures(page, requests);
    await page.goto('/admin/users');
    const console = page.locator('.admin-operations');
    const manageAccess = console.getByRole('button', { name: 'Manage access' }).first();

    await manageAccess.click();

    const inspector = console.getByRole('region', { name: 'Access controls for ada@example.test' });
    await expect(inspector).toBeVisible();
    await expect(inspector).toBeFocused();
    await expect(inspector).toBeInViewport({ ratio: 0.1 });
    await expect(manageAccess).toHaveAttribute('aria-expanded', 'true');
    await expect(inspector.getByText(/Saved with your admin identity, target, time and request ID/)).toBeVisible();
    await expect(console.getByPlaceholder('Why is this operation necessary?')).toHaveCount(1);
    expect(requests.some((item) => item.path === '/api/v1/admin/users/user-1' && item.method === 'GET')).toBe(true);
  });

  test('user access inspector records page credits against the immutable user id', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/users?user=user-2');
    const console = page.locator('.admin-operations');
    await expect(console.getByText('USER ACCESS INSPECTOR')).toBeVisible();
    await expect(console.getByText(/immutable user id user-2/)).toBeVisible();
    await expect(console.getByText(/lin@example\.test · immutable user id user-2/)).toBeVisible();
    await console.getByPlaceholder('Why is this operation necessary?').fill('Goodwill credit for a failed scan.');
    await console.getByRole('checkbox').check();
    const adjustment = console.getByRole('button', { name: 'Record adjustment' });
    await console.getByLabel('Signed amount').fill('3456789');
    await expect(adjustment).toBeDisabled();
    await expect(console.getByText('Amount must be a non-zero whole number between -100,000 and 100,000.')).toBeVisible();
    await console.getByLabel('Signed amount').fill('25');
    await expect(adjustment).toBeEnabled();
    await adjustment.click();
    const mutation = requests.find((item) => item.path === '/api/v1/admin/users/user-2/credits' && item.method === 'POST');
    expect(mutation?.body).toMatchObject({ kind: 'page', amount: 25, reason: 'Goodwill credit for a failed scan.', confirm: true });
    expect(requests.some((item) => /^\/api\/v1\/admin\/workspaces\/[^/]+\/(credits|entitlements|plan)$/.test(item.path) && item.method === 'POST')).toBe(false);
  });

  test('user access inspector grants only launch feature overrides and keeps Expert Review assignable', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/users?user=user-2');
    const console = page.locator('.admin-operations');
    const featureForm = console.locator('form').filter({ hasText: 'Feature override' });
    const featureSelect = featureForm.getByLabel('Feature', { exact: true });
    await expect(featureForm).toBeVisible();
    await expect(featureSelect).toBeVisible();
    const options = await featureSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: node.textContent })));
    expect(options.some((option) => ['monitoring', 'white_label'].includes(option.value))).toBe(false);
    expect(options).toContainEqual({ value: 'expert_review', text: 'Expert Review' });
    await expect(console.getByText(/grant-user-2 · user lin@example\.test \(user-2\)/)).toBeVisible();
    await console.getByPlaceholder('Why is this operation necessary?').fill('Assign a scoped human review workflow.');
    await console.getByRole('checkbox').check();
    await featureSelect.selectOption('expert_review');
    await featureForm.getByLabel('Execution mode').selectOption('operator_assisted');
    const featureExpiry = '2099-01-01T00:00';
    const expectedExpiry = await page.evaluate((value) => new Date(value).toISOString(), featureExpiry);
    await featureForm.getByLabel('Feature expiry').fill(featureExpiry);
    await featureForm.getByRole('button', { name: 'Grant feature override' }).click();
    await expect(console.getByText('The feature override was recorded without changing the billing plan.')).toBeVisible();
    const mutation = requests.find((item) => item.path === '/api/v1/admin/users/user-2/entitlements' && item.method === 'POST');
    expect(mutation?.body).toEqual({
      moduleId: 'expert_review', executionMode: 'operator_assisted', expiresAt: expectedExpiry,
      reason: 'Assign a scoped human review workflow.', confirm: true,
    });
    expect(requests.some((item) => /^\/api\/v1\/admin\/workspaces\/[^/]+\/(credits|entitlements|plan)$/.test(item.path) && item.method === 'POST')).toBe(false);
  });

  test('super admin changes permanent and temporary plans on the user contract', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests, 'super_admin');
    await page.goto('/admin/users?user=user-2');
    const console = page.locator('.admin-operations');
    await console.getByPlaceholder('Why is this operation necessary?').fill('Approved account plan correction.');
    await console.getByRole('checkbox').check();
    const permanentForm = console.locator('form').filter({ hasText: 'Permanent plan' });
    await permanentForm.getByLabel('Permanent plan').selectOption('studio');
    await permanentForm.getByRole('button', { name: 'Change user plan' }).click();
    expect(requests.find((item) => item.path === '/api/v1/admin/users/user-2/plan' && item.method === 'POST')?.body).toEqual({ planId: 'studio', reason: 'Approved account plan correction.', confirm: true });

    await console.getByPlaceholder('Why is this operation necessary?').fill('Temporary enterprise pilot.');
    await console.getByRole('checkbox').check();
    const temporaryForm = console.locator('form').filter({ hasText: 'Temporary plan' });
    const expiry = '2099-02-01T00:00';
    const expectedExpiry = await page.evaluate((value) => new Date(value).toISOString(), expiry);
    await temporaryForm.getByLabel('Plan').selectOption('enterprise');
    await temporaryForm.getByLabel('Required expiry').fill(expiry);
    await temporaryForm.getByRole('button', { name: 'Grant temporarily' }).click();
    expect(requests.find((item) => item.path === '/api/v1/admin/users/user-2/entitlements' && item.method === 'POST')?.body).toEqual({ planId: 'enterprise', expiresAt: expectedExpiry, reason: 'Temporary enterprise pilot.', confirm: true });
    expect(requests.some((item) => /^\/api\/v1\/admin\/workspaces\/[^/]+\/(credits|entitlements|plan)$/.test(item.path) && item.method === 'POST')).toBe(false);
  });

  test('changing the selected user clears mutation authorization and draft fields', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/users');
    const console = page.locator('.admin-operations');
    await console.getByRole('button', { name: 'Manage access' }).first().click();
    await console.getByPlaceholder('Why is this operation necessary?').fill('Draft for first user.');
    await console.getByRole('checkbox').check();
    await console.getByLabel('Signed amount').fill('15');
    await console.getByRole('button', { name: 'Manage access' }).nth(1).click();
    await expect(console.getByText(/immutable user id user-2/)).toBeVisible();
    await expect(console.getByPlaceholder('Why is this operation necessary?')).toHaveValue('');
    await expect(console.getByRole('checkbox')).not.toBeChecked();
    await expect(console.getByLabel('Signed amount')).toHaveValue('');
  });

  test('workspace inspector has no user commercial mutation forms', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests, 'super_admin');
    await page.goto('/admin/workspaces');
    const console = page.locator('.admin-operations');
    await console.getByRole('button', { name: 'Inspect' }).click();
    await expect(console.getByText('WORKSPACE INSPECTOR')).toBeVisible();
    await expect(console.getByRole('button', { name: 'Record adjustment' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Change user plan' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Grant temporarily' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Grant feature override' })).toHaveCount(0);
  });

  test('operator can inspect user access but cannot mutate plan credits or features', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests, 'operator');
    await page.goto('/admin/users?user=user-2');
    const console = page.locator('.admin-operations');
    await expect(console.getByText('USER ACCESS INSPECTOR')).toBeVisible();
    await expect(console.getByText('User plan, credits and feature access are read-only for this role.')).toBeVisible();
    await expect(console.getByRole('button', { name: 'Record adjustment' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Change user plan' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Grant temporarily' })).toHaveCount(0);
    await expect(console.getByRole('button', { name: 'Grant feature override' })).toHaveCount(0);
  });

  test('support and moderator UI expose only controls allowed by the server permission model', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests, 'support');
    await page.goto('/admin/users?user=user-2');
    const supportConsole = page.locator('.admin-operations');
    await expect(supportConsole.getByText('USER ACCESS INSPECTOR')).toBeVisible();
    await expect(supportConsole.getByRole('button', { name: 'Ban user' })).toHaveCount(0);
    await expect(supportConsole.getByRole('button', { name: 'Record adjustment' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Engine Test Lab' })).toHaveCount(0);

    await page.unrouteAll({ behavior: 'wait' });
    await installFixtures(page, requests, 'moderator');
    await page.goto('/admin/users?user=user-2');
    const moderatorConsole = page.locator('.admin-operations');
    await expect(moderatorConsole.getByRole('button', { name: 'Ban user' })).toBeVisible();
    await expect(moderatorConsole.getByRole('button', { name: 'Record adjustment' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Engine Test Lab' })).toHaveCount(0);
  });

  test('admin UI permits operational commerce but does not expose privileged-role management', async ({ page }, testInfo) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests, 'admin');
    await page.goto('/admin/users?user=user-2');
    const console = page.locator('.admin-operations');
    await expect(console.getByRole('button', { name: 'Ban user' })).toBeVisible();
    await expect(console.getByRole('button', { name: 'Record adjustment' })).toBeVisible();
    if (['mobile', 'compact'].includes(testInfo.project.name)) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('dialog', { name: 'Admin navigation' }).getByRole('button', { name: 'Security' }).click();
    } else {
      await page.getByRole('button', { name: 'More admin sections' }).click();
      await page.getByRole('menuitem', { name: 'Security' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Admin security' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Role and credential register' })).toHaveCount(0);
  });

  test('audit rows disclose affected user, actor, amount and stored operation details', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/audit');
    const console = page.locator('.admin-operations');
    const creditEvent = console.getByRole('button', { name: /Added 25 AI credits to lin@example\.test\./ });

    await expect(creditEvent).toBeVisible();
    await expect(creditEvent).toHaveAttribute('aria-expanded', 'false');
    await expect(console.getByRole('button', { name: /Changed lin@example\.test's plan from Free to Signal\./ })).toBeVisible();
    await creditEvent.focus();
    await page.keyboard.press('Enter');
    await expect(creditEvent).toHaveAttribute('aria-expanded', 'true');

    const details = console.getByRole('region', { name: /Added 25 AI credits to lin@example\.test\./ });
    await expect(details).toBeVisible();
    await expect(details.getByText('Lin Reviewer · lin@example.test · user-2')).toBeVisible();
    await expect(details.getByText('Admin Operator · admin@example.test · admin-1')).toBeVisible();
    await expect(details.getByText('Restore credits after a failed scan.')).toBeVisible();
    await expect(details.getByRole('row', { name: /Amount Not recorded 25/ })).toBeVisible();
    await expect(details.getByText('[REDACTED]', { exact: false })).toBeVisible();
    await expect(console).not.toContainText('must-not-leak');

    await page.keyboard.press('Enter');
    await expect(creditEvent).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toHaveCount(0);
  });

  test('redeem creation keeps plaintext in the browser and sends audited limits once', async ({ page }) => {
    const requests: RequestRecord[] = [];
    await installFixtures(page, requests);
    await page.goto('/admin/redeem');
    const console = page.locator('.admin-operations');
    await console.getByPlaceholder('Why is this operation necessary?').fill('Founder pilot allocation.');
    await console.getByRole('checkbox').check();
    await console.getByLabel('Plaintext code').fill('WPAFOUNDERS');
    await console.getByRole('button', { name: 'Create code' }).click();
    await expect(console.getByText('WPAFOUNDERS')).toBeVisible();
    const mutation = requests.find((item) => item.path === '/api/v1/admin/redeem-codes' && item.method === 'POST');
    expect(mutation?.body).toMatchObject({ code: 'WPAFOUNDERS', temporaryPlan: 'studio', durationDays: 30, maxGlobalRedemptions: 20, maxPerWorkspace: 1, reason: 'Founder pilot allocation.', confirm: true });
  });
});
