import { test, expect } from '@playwright/test';
import { login } from './login.ts';
import { users } from '../runtime.ts';

test('model settings support save, failed replacement and revocation without a Binance binding', async ({
  page,
}, testInfo) => {
  await login(page);
  await page.goto('/dashboard/ai');
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.getByText('费用由你向 DeepSeek 支付；用量不等同于账单金额。')).toBeVisible();
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel('模型 API Key').fill('synthetic-model-alice');
  await page.getByLabel('模型 API Key').press('Enter');
  await expect(page.getByText('模型 Key 已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('模型 API Key')).toHaveValue('');
  await page.reload();
  await expect(page.getByText('模型 Key 已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('模型 API Key')).toHaveValue('');
  await page.getByLabel('模型 API Key').fill('synthetic-model-invalid');
  await page.getByRole('button', { name: '验证并保存' }).click();
  await expect(
    page.getByRole('region', { name: '自备模型 Key 设置' }).getByRole('alert'),
  ).toContainText('原有设置已保留');
  await expect(page.getByText('模型 Key 已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('模型 API Key')).toHaveValue('');
  await page.getByLabel('模型 API Key').fill('synthetic-model-alice-rotated');
  await page.getByRole('button', { name: '验证并保存' }).click();
  await expect(page.getByText('模型 Key 已保存。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销模型 Key' })).toBeEnabled();
  await page.getByRole('button', { name: '撤销模型 Key' }).click();
  await expect(page.getByText('模型 Key 已撤销。', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('model-settings-390.png'), fullPage: true });
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  await page.getByRole('link', { name: '返回工作台' }).click();
  await expect(page.getByRole('heading', { name: '我的工作台' })).toBeVisible();
});

test('model keys clear on hiding and cross-tab logout; delayed settings cannot restore the old identity', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/dashboard/ai');
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await page.getByLabel('模型 API Key').fill('synthetic-unsaved-model-key');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('模型 API Key')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByLabel('模型 API Key')).toHaveValue('');
  const other = await context.newPage();
  await other.goto('/dashboard/ai');
  await expect(other.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  let arrived!: () => void;
  let release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await other.route('**/v1/users/*/model', async (route) => {
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
    await expect(other.getByLabel('模型 API Key')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByLabel('模型 API Key')).toHaveCount(0);
  } finally {
    release();
  }
});

test('a cookie identity switch cannot send the previous user model key to the next account', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/dashboard/ai');
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await page.getByLabel('模型 API Key').fill('synthetic-model-alice');
  let switched = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await context.request.post('/api/auth/sign-in/email', {
      headers: { Origin: new URL(page.url()).origin },
      data: { email: users[1]!.email, password: users[1]!.password },
    });
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      switched = true;
      break;
    }
    const seconds = Number(response.headers()['retry-after']);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, (seconds + 0.1) * 1000));
  }
  expect(switched).toBe(true);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/model')) writes.push(request.url());
  });
  await page.getByRole('button', { name: '验证并保存' }).click();
  await expect(page).toHaveURL('/login');
  expect(writes).toEqual([]);
});
