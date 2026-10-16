import { test, expect } from '@playwright/test';
import { users } from '../runtime.ts';
import { login } from './login.ts';

test('two devices manage sessions and recover a password through fake mail', async ({
  page,
  browser,
  request,
  browserName,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) => {
      throw new Error(`CSP: ${event.violatedDirective}`);
    }),
  );
  await login(page);
  const device = await browser.newContext({
    baseURL: 'http://127.0.0.1:4180',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0',
  });
  const other = await device.newPage();
  try {
    await login(other);
    await page.bringToFront();
    await page.getByRole('link', { name: '安全设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '密码与设备会话' })).toBeVisible();
    await expect(page.getByText('当前设备', { exact: true })).toBeVisible();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const revoke = page
      .getByRole('region', { name: '其他设备会话' })
      .filter({ has: page.getByRole('heading', { name: 'Firefox · Linux', exact: true }) })
      .getByRole('button', { name: '撤销此会话', exact: true });
    await revoke.focus();
    await expect(revoke).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '已撤销' })).toBeVisible();
    await other.reload();
    await expect(other).toHaveURL('/login');
    await login(other);
    await page.bringToFront();
    await page.reload();
    await page.getByRole('button', { name: '退出其他设备', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已撤销' })).toBeVisible();
    await other.reload();
    await expect(other).toHaveURL('/login');
    await expect(page.getByText(users[0]!.email, { exact: true })).toBeVisible();
    if (browserName === 'chromium')
      await page.screenshot({ path: testInfo.outputPath('security.png'), fullPage: true });

    await page.getByRole('link', { name: '通过邮箱重置密码' }).click();
    await page.getByLabel('邮箱', { exact: true }).fill(users[0]!.email);
    await page.getByRole('button', { name: '发送重置邮件' }).click();
    await expect(page.getByRole('status')).toContainText('如果此邮箱存在');
    const letters = (await (await request.get('http://127.0.0.1:4182/messages')).json()) as {
      email: string;
      url: string;
    }[];
    const link = letters.findLast((item) => item.email === users[0]!.email)!.url;
    await page.goto(link);
    await expect(page.getByRole('heading', { name: '重置密码', exact: true })).toBeVisible();
    await expect(page).toHaveURL('/reset-password');
    // Use the same synthetic password so other independent browser scenarios keep their fixture.
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByLabel('新密码', { exact: true }).fill(users[0]!.password);
    await page.getByLabel('确认新密码', { exact: true }).fill(users[0]!.password);
    await page.getByRole('button', { name: '保存新密码' }).click();
    await expect(page.getByRole('status')).toContainText('全部旧会话已退出');
    await expect(page.getByLabel('新密码', { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
    ).toEqual({ local: [], session: [] });
    await page.goto(link);
    await expect(page.locator('form').getByRole('alert')).toContainText('链接无效或已过期');
    await login(page);
    await page.goto('/dashboard/security');
    await expect(page.getByText('当前设备', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await device.close();
  }
});

test('security page clears on cross-tab identity changes, back navigation and late responses', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/dashboard/security');
  await expect(page.getByText('当前设备', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/dashboard');
  await expect(other.getByText(users[0]!.email, { exact: true })).toBeVisible();
  await other.getByRole('button', { name: '退出登录' }).click();
  await expect(other).toHaveURL('/login');
  await page.bringToFront();
  await expect(page).toHaveURL('/login');
  await page.goBack();
  await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
  await login(page, users[1]!);
  let arrived!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/auth/list-sessions', async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.goto('/dashboard/security');
    await received;
    await page.getByRole('button', { name: '退出登录' }).click();
    release();
    await expect(page).toHaveURL('/login');
    await expect(page.getByText(users[1]!.email, { exact: true })).toHaveCount(0);
    await expect(page.getByText('当前设备', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
