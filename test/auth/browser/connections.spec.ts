import { test, expect } from '@playwright/test';
import { users } from '../runtime.ts';
import { login } from './login.ts';

test('connection settings clear secrets, preserve account identity and fit phone screens', async ({
  page,
}) => {
  await login(page);
  await page.goto('/dashboard/connections');
  await expect(page.getByRole('heading', { name: 'Binance 只读连接' })).toBeVisible();
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-key-alice');
  await page.getByLabel('API Secret', { exact: true }).fill('synthetic-secret-alice');
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/binding') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '验证并保存' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await expect(page.getByText('UID：10001', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API Secret', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  await page.getByLabel('API Key', { exact: true }).focus();
  await expect(page.getByLabel('API Key', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/login');
  await page.goBack();
  await expect(page.getByText('UID：10001', { exact: true })).toHaveCount(0);
});

test('cross-tab logout hides connection details and an already-received late response cannot restore them', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/dashboard/connections');
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  const other = await context.newPage();
  await other.goto('/dashboard/connections');
  await expect(other.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await other.getByLabel('API Key', { exact: true }).fill('synthetic-unsaved-key');
  let arrived!: () => void;
  let release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await other.route('**/v1/users/*/binding', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await other.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await seen;
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL('/login');
    release();
    await other.bringToFront();
    await expect(other).toHaveURL('/login');
    await expect(other.getByLabel('API Key', { exact: true })).toHaveCount(0);
    await expect(other.getByText('UID：10001', { exact: true })).toHaveCount(0);
    await login(page, users[1]!);
    await page.goto('/dashboard/connections');
    await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByText('UID：10001', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
