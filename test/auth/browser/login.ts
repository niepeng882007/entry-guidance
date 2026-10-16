import { expect, type Page } from '@playwright/test';
import { users } from '../runtime.ts';

export async function login(page: Page, user = users[0]!) {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  for (let attempt = 0; attempt < 3; attempt++) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/sign-in/email') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const response = await responsePromise;
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      break;
    }
    // Multiple browser scenarios share a real server/IP; honor its actual login cooldown.
    const seconds = Number(response.headers()['retry-after']);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, (seconds + 0.1) * 1000));
  }
  await expect(page).toHaveURL('/dashboard');
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
}
