import { expect, test, type Page, type Route } from '@playwright/test';
import { ADMIN_FIXTURE_PERMISSIONS, legalConfig } from './iceberg-fixtures';

const now = '2026-08-14T08:00:00.000Z';

function ticket(id: string, subject: string, status = 'open') {
  return {
    id,
    reference: id.replace('ticket-', '').toUpperCase(),
    category: 'analysis',
    subject,
    status,
    priority: 'normal',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    requesterName: 'Avery Example',
    requesterEmail: 'avery@example.test',
    requesterId: 'user-avery',
    requesterEmailVerified: true,
    messages: [{ id: `${id}-message`, body: 'The first customer message.', visibility: 'customer', authorType: 'customer', createdAt: now }],
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installCustomerFixtures(page: Page, requests: Array<{ path: string; method: string; body?: unknown }>) {
  const first = ticket('ticket-a', 'First evidence question');
  const second = ticket('ticket-b', 'Second evidence question');
  let listCalls = 0;
  let current = first;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() as unknown;
    requests.push({ path: url.pathname + url.search, method: request.method(), body });
    if (url.pathname === '/api/v1/support/tickets' && request.method() === 'GET') {
      listCalls += 1;
      return json(route, url.searchParams.has('cursor') ? { tickets: [second], limit: 1, nextCursor: null } : { tickets: [current], limit: 1, nextCursor: 'cursor-customer-2' });
    }
    if (url.pathname === '/api/v1/support/tickets' && request.method() === 'POST') {
      current = { ...ticket('ticket-created', 'Created evidence question'), ...(body as Record<string, unknown>), messages: [] };
      return json(route, { ticket: current }, 201);
    }
    if (url.pathname === '/api/v1/support/tickets/ticket-a' && request.method() === 'GET') return json(route, { ticket: current });
    if (url.pathname === '/api/v1/support/tickets/ticket-created' && request.method() === 'GET') return json(route, { ticket: current });
    if (url.pathname.includes('/messages') && request.method() === 'POST') return json(route, { ticket: current }, 201);
    if (url.pathname.endsWith('/close') && request.method() === 'POST') { current = { ...current, status: 'closed' }; return json(route, { ticket: current }); }
    if (url.pathname.endsWith('/reopen') && request.method() === 'POST') { current = { ...current, status: 'open' }; return json(route, { ticket: current }); }
    return json(route, { error: `Unexpected support fixture request: ${url.pathname}` }, 404);
  });
}

async function installAdminFixtures(page: Page, requests: Array<{ path: string; method: string; body?: unknown }>) {
  const first = ticket('ticket-a', 'First admin question');
  const second = ticket('ticket-b', 'Second admin question');
  let listCalls = 0;
  let current = first;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() as unknown;
    requests.push({ path: url.pathname + url.search, method: request.method(), body });
    if (url.pathname === '/api/v1/admin/me') return json(route, { admin: { actorId: 'admin-1', email: 'admin@example.test', role: 'admin', permissions: ADMIN_FIXTURE_PERMISSIONS, via: 'session' } });
    if (url.pathname === '/api/v1/admin/overview') return json(route, { totals: { users: 1, scans: 2, reports: 3, findings: 4, critical: 0 }, activity: [], health: [] });
    if (url.pathname === '/api/v1/admin/operator-tasks') return json(route, { tasks: [] });
    if (url.pathname === '/api/v1/admin/support/tickets' && request.method() === 'GET') {
      listCalls += 1;
      return json(route, url.searchParams.has('cursor') ? { tickets: [second], limit: 1, nextCursor: null } : { tickets: [current], limit: 1, nextCursor: 'cursor-admin-2' });
    }
    if (url.pathname === '/api/v1/admin/support/tickets/ticket-a' && request.method() === 'GET') return json(route, { ticket: current });
    if (url.pathname === '/api/v1/admin/support/tickets/ticket-b' && request.method() === 'GET') return json(route, { ticket: second });
    if (url.pathname.includes('/messages') && request.method() === 'POST') return json(route, { ticket: current }, 201);
    if (url.pathname.startsWith('/api/v1/admin/support/tickets/') && request.method() === 'PATCH') { current = { ...current, ...(body as Record<string, unknown>) }; return json(route, { ticket: current }); }
    if (url.pathname.startsWith('/api/v1/admin/resources/')) return json(route, { resources: [] });
    return json(route, { error: `Unexpected admin fixture request: ${url.pathname}` }, 404);
  });
}

test.describe('support surfaces against the current API contracts', () => {
  test('customer creates with structured context, replies, closes, reopens, and paginates', async ({ page }) => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    await installCustomerFixtures(page, requests);
    await page.goto('/app/support');
    await expect(page.getByRole('heading', { name: /support, with a paper trail/i })).toBeVisible();
    await page.getByRole('button', { name: /new case/i }).first().click();
    await page.getByLabel('Subject').fill('Structured support question');
    await page.getByLabel('Message').fill('Please inspect this analysis result and explain the missing evidence.');
    await page.getByLabel('Target URL').fill('https://example.com/page');
    await page.getByLabel('Report ID').fill('report-42');
    await page.getByLabel('What should we know?').fill('Chromium 128, report opened from the findings ledger.');
    await page.getByRole('button', { name: /create case/i }).click();
    await expect(page.getByRole('heading', { name: 'Structured support question' })).toBeVisible();
    const create = requests.find((request) => request.method === 'POST' && request.path === '/api/v1/support/tickets');
    expect(create?.body).toMatchObject({ category: 'analysis', subject: 'Structured support question', body: 'Please inspect this analysis result and explain the missing evidence.', targetUrl: 'https://example.com/page', reportId: 'report-42', context: 'Chromium 128, report opened from the findings ledger.' });
    await page.getByLabel('Reply to this case').fill('Adding one more verified detail for the operator.');
    await page.getByRole('button', { name: /send reply/i }).click();
    await page.getByRole('button', { name: /close case/i }).click();
    await expect(page.getByRole('button', { name: /reopen case/i })).toBeVisible();
    await page.getByRole('button', { name: /reopen case/i }).click();
    await expect(page.getByRole('button', { name: /close case/i })).toBeVisible();
    await page.getByRole('button', { name: /load more cases/i }).click();
    await expect(page.getByText('Second evidence question')).toBeVisible();
    expect(requests.some((request) => request.path.includes('cursor=cursor-customer-2'))).toBe(true);
  });

  test('admin filters, assigns, notes, replies, changes state, and loads another page', async ({ page }) => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    await installAdminFixtures(page, requests);
    await page.goto('/admin/support');
    await expect(page.getByRole('heading', { name: 'Support inbox', exact: true })).toBeVisible();
    await expect(page.getByLabel('Requester identity')).toContainText('Avery Example');
    await expect(page.getByLabel('Requester identity')).toContainText('avery@example.test');
    await expect(page.getByLabel('Requester identity')).toContainText('user-avery');
    await page.getByPlaceholder('Assignee ID').fill('operator-7');
    await page.getByRole('combobox', { name: 'Status' }).first().selectOption('open');
    await page.getByRole('combobox', { name: 'Priority' }).first().selectOption('high');
    await page.getByRole('button', { name: /apply/i }).click();
    await expect(page.getByRole('heading', { name: 'First admin question', exact: true })).toBeVisible();
    await page.getByLabel('Assignee ID optional').fill('operator-7');
    await page.getByRole('button', { name: /save controls/i }).click();
    await page.getByRole('button', { name: /internal note/i }).click();
    await page.locator('.aux-admin-composer textarea').fill('Keep this context private for the next operator.');
    await page.getByRole('button', { name: /post note/i }).click();
    await page.getByRole('button', { name: /customer reply/i }).click();
    await page.locator('.aux-admin-composer textarea').fill('This customer-facing reply is ready.');
    await page.getByRole('button', { name: /post reply/i }).click();
    await page.getByRole('button', { name: /mark resolved/i }).click();
    await page.getByRole('button', { name: /load more cases/i }).click();
    await expect(page.getByText('Second admin question')).toBeVisible();
    expect(requests.some((request) => request.method === 'PATCH' && JSON.stringify(request.body).includes('operator-7'))).toBe(true);
    expect(requests.some((request) => request.method === 'POST' && JSON.stringify(request.body).includes('internal'))).toBe(true);
    expect(requests.some((request) => request.method === 'POST' && JSON.stringify(request.body).includes('customer'))).toBe(true);
    expect(requests.some((request) => request.path.includes('status=open') && request.path.includes('priority=high') && request.path.includes('assignedTo=operator-7'))).toBe(true);
    expect(requests.some((request) => request.path.includes('cursor=cursor-admin-2'))).toBe(true);
  });

  test('keyboard and reduced-motion support path remains usable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/faq');
    const firstQuestion = page.locator('summary').nth(1);
    await firstQuestion.focus();
    await expect(firstQuestion).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('details').first()).toHaveAttribute('open', '');
    await page.goto('/app/support');
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await expect.poll(() => page.locator('.aux-support-page .aux-dark-button').first().evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001);
  });

  test('public status, reset, and verification surfaces use their safe auth/status contracts', async ({ page }) => {
    let statusPath = '';
    let resetBody: unknown;
    let verificationPath = '';
    await page.route('**/api/v1/status', async (route) => {
      statusPath = new URL(route.request().url()).pathname;
      return json(route, { checkedAt: now, overall: 'operational', components: [{ id: 'api', label: 'API', status: 'operational', detail: 'Responding.' }] });
    });
    await page.goto('/status');
    await expect(page.locator('.aux-status-word').filter({ hasText: 'operational' })).toBeVisible();
    expect(statusPath).toBe('/api/v1/status');

    await page.route('**/api/auth/request-password-reset', async (route) => {
      resetBody = route.request().postDataJSON();
      return json(route, { status: true, message: 'If this email exists, check the inbox.' });
    });
    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill('avery@example.test');
    await page.getByRole('button', { name: /request recovery/i }).click();
    await expect(page.getByRole('status')).toContainText(/configured auth service/i);
    expect(resetBody).toEqual({ email: 'avery@example.test', redirectTo: '/forgot-password' });

    await page.route('**/api/auth/verify-email?token=valid-token', async (route) => {
      verificationPath = new URL(route.request().url()).pathname + new URL(route.request().url()).search;
      return json(route, { status: true });
    });
    await page.goto('/verify-email?token=valid-token&callbackURL=%2Fapp');
    await expect(page.getByRole('heading', { name: /address verified/i })).toBeVisible();
    expect(verificationPath).toBe('/api/auth/verify-email?token=valid-token');
    await expect(page.getByRole('link', { name: /continue/i })).toHaveAttribute('href', '/app');
    await page.route('**/api/v1/legal/config', (route) => json(route, legalConfig));
    for (const legalPath of ['/terms', '/privacy', '/kvkk', '/acceptable-use', '/refund', '/subprocessors']) {
      await page.goto(legalPath);
      await expect(page.getByText(/Version 1\.0/i).first()).toBeVisible();
      await expect(page.getByText(/DRAFT|COUNSEL-APPROVED/i)).toHaveCount(0);
      await expect(page.getByText('Northstar Test Yazilim Ltd. Sti.').first()).toBeVisible();
      if (legalPath === '/refund') await expect(page.getByRole('link', { name: /workspace billing settings/i })).toHaveAttribute('href', '/app/settings/billing');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    }
  });

  test('legal pages fail visibly without inventing operator identity', async ({ page }) => {
    await page.route('**/api/v1/legal/config', (route) => json(route, { ready: false, documents: {} }));
    await page.goto('/terms');
    await expect(page.getByRole('alert')).toContainText(/legal configuration unavailable/i);
    await expect(page.getByText(/Northstar Test Yazilim/i)).toHaveCount(0);
  });
});
