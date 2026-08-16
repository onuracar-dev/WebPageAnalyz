import { expect, test } from '@playwright/test';
import { createOTP } from '@better-auth/utils/otp';

const email = process.env.WPA_ACCEPTANCE_ADMIN_EMAIL;
const password = process.env.WPA_ACCEPTANCE_PASSWORD;
const totpSecret = process.env.WPA_ACCEPTANCE_TOTP_SECRET;
const liveBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

test.describe('live privileged WebAuthn acceptance', () => {
  test.skip(!email || !password || !totpSecret || !liveBaseUrl, 'Explicit local acceptance credentials and PLAYWRIGHT_BASE_URL are required.');

  test('enrolls, steps up, shows recovery codes once and preserves the final credential', async ({ page, context }) => {
    test.setTimeout(90_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    let assertions = 0;
    cdp.on('WebAuthn.credentialAsserted', () => { assertions += 1; });

    await page.goto('/login');
    await page.getByLabel('Email address').fill(email!);
    await page.getByLabel('Password', { exact: true }).fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Authenticator code')).toBeVisible();
    const loginCode = await createOTP(totpSecret!, { period: 30, digits: 6 }).totp();
    await page.getByLabel('Authenticator code').fill(loginCode);
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(page).toHaveURL(/\/admin(?:$|\?)/);
    await expect(page.getByRole('heading', { name: 'Admin proof room' })).toBeVisible();

    const assertionsBeforeRead = assertions;
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect.poll(() => assertions).toBe(assertionsBeforeRead);

    await page.getByRole('button', { name: 'More admin sections' }).click();
    await page.getByRole('menuitem', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Admin security' })).toBeVisible();
    await page.getByLabel('Credential name').fill('Virtual launch acceptance key');
    await page.getByLabel('Current password').first().fill(password!);
    const enrollmentCode = await createOTP(totpSecret!, { period: 30, digits: 6 }).totp();
    await page.getByLabel('Authenticator code').first().fill(enrollmentCode);
    await page.getByRole('button', { name: 'Verify and add first passkey' }).click();
    await expect(page.getByText('Passkey registered.', { exact: false })).toBeVisible();
    await expect(page.getByText('Virtual launch acceptance key')).toBeVisible();

    await page.getByLabel('Required audit reason').fill('Local launch acceptance for WebAuthn recovery lifecycle');
    await page.getByText('I confirm this intentional privileged operation.').click();
    const assertionsBeforeStepUp = assertions;
    await page.getByRole('button', { name: 'Rotate and show recovery codes once' }).click();
    await expect(page.getByText('Copy now — this panel will not be restored after leaving or refreshing.')).toBeVisible();
    await expect.poll(() => assertions).toBeGreaterThan(assertionsBeforeStepUp);
    const codes = (await page.locator('.admin-security__codes pre').innerText()).trim().split(/\s+/);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    await page.screenshot({ path: 'artifacts/privileged-access-security-live.png', fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Admin security' })).toBeVisible();
    await expect(page.getByText('Copy now — this panel will not be restored after leaving or refreshing.')).toHaveCount(0);
    await expect(page.locator('.admin-security__summary > div').filter({ hasText: 'RECOVERY CODES' }).locator('strong')).toHaveText('10');

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('alert')).toContainText(/replacement passkey|final required credential/i);
    await expect(page.getByText('Virtual launch acceptance key')).toBeVisible();

    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  });
});
