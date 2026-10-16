import { test, expect } from '@playwright/test';

test('public site and two registrations support recovery, keyboard, narrow screens and production CSP', async ({
  page,
  request,
  browserName,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) => {
      throw new Error(`CSP: ${event.violatedDirective}`);
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('先写下风险');
  for (const width of [320, 375, 390, 414, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  if (browserName === 'chromium')
    await page.screenshot({ path: testInfo.outputPath('public-home.png'), fullPage: true });
  await page.getByRole('link', { name: '注册邮箱账号', exact: true }).click();
  for (const index of [0, 1]) {
    const email = `browser-${browserName}-${index}-${Date.now()}@example.test`;
    const password = 'synthetic-registration-browser-02';
    await page.goto('/register');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByLabel('昵称', { exact: true }).fill(`注册用户${index}`);
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '注册并验证邮箱', exact: true }).focus();
    await expect(page.getByRole('button', { name: '注册并验证邮箱', exact: true })).toBeFocused();
    if (index === 0) await request.post('http://127.0.0.1:4182/mode', { data: { mode: 'fail' } });
    try {
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status')).toContainText('未收到可稍后重发');
      await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => ({
          local: Object.keys(localStorage),
          session: Object.keys(sessionStorage),
        })),
      ).toEqual({ local: [], session: [] });
    } finally {
      await request.post('http://127.0.0.1:4182/mode', { data: { mode: 'accept' } });
    }
    await page.getByRole('button', { name: '重发验证邮件', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('验证后请手动登录');
    const mailbox = await request.get('http://127.0.0.1:4182/messages');
    const letters = (await mailbox.json()) as { email: string; url: string }[];
    const letter = letters.findLast((value) => value.email === email);
    expect(letter).toBeDefined();
    await page.goto(letter!.url);
    await expect(page.getByRole('heading', { name: '邮箱验证完成', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '前往登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/auth/sign-in/email') &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '登录', exact: true }).click();
      const response = await pending;
      if (response.status() !== 429) {
        expect(response.status()).toBe(200);
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, (Number(response.headers()['retry-after']) + 0.1) * 1000),
      );
    }
    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL('/login');
  }
  await page.goto('/verify-email?error=TOKEN_EXPIRED');
  await expect(page.getByRole('alert').filter({ hasText: '验证链接无效或已过期' })).toContainText(
    '验证链接无效或已过期',
  );
  await page.getByLabel('邮箱', { exact: true }).fill(`unknown-${browserName}@example.test`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const pending = page.waitForResponse((response) =>
      response.url().endsWith('/send-verification-email'),
    );
    await page.getByRole('button', { name: '重发验证邮件' }).click();
    await pending;
  }
  await expect(page.locator('form').getByRole('alert')).toContainText('秒后重试');
  expect(errors).toEqual([]);
});
