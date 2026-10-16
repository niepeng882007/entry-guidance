import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { login } from './login.ts';
import { users } from '../runtime.ts';

async function switchCookie(context: BrowserContext) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await context.request.post('/api/auth/sign-in/email', {
      headers: { Origin: 'http://127.0.0.1:4180' },
      data: { email: users[1]!.email, password: users[1]!.password },
    });
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      return;
    }
    const seconds = Number(response.headers()['retry-after']);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, (seconds + 0.1) * 1000));
  }
  throw new Error('合成登录仍处于冷却。');
}

async function connect(page: Page, name = 'alice') {
  await page.goto('/dashboard/connections');
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await page.getByLabel('API Key', { exact: true }).fill(`synthetic-key-${name}`);
  await page.getByLabel('API Secret', { exact: true }).fill(`synthetic-secret-${name}`);
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/binding') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '验证并保存' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
}
test('two users see isolated assets, a three-second summary and a thirty-second asset page', async ({
  page,
  browser,
}) => {
  await login(page);
  await connect(page);
  const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4180' });
  const other = await otherContext.newPage();
  try {
    await other.goto('http://127.0.0.1:4180/login');
    await login(other, users[1]!);
    await connect(other, 'bob');
    await other.goto('http://127.0.0.1:4180/account');
    await expect(other.locator('#asset-equity')).toHaveText('2050.00000000');
    await page.clock.install();
    await page.goto('/account');
    await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
    await expect(page.getByText('模拟数据 · 不代表真实账户')).toBeVisible();
    const queried = await page.locator('#asset-queried').textContent();
    const details = page.locator('.account-page__details');
    await expect(details).toHaveAttribute('open', '');
    await details.locator('summary').click();
    let reads = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/account/assets') && request.method() === 'GET') reads++;
    });
    await page.clock.runFor(29000);
    expect(reads).toBe(0);
    await page.clock.runFor(1100);
    await expect.poll(() => reads).toBe(1);
    await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
    await expect(details).not.toHaveAttribute('open');
    expect(queried).not.toBe('尚无');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByRole('button', { name: '手动刷新' }).focus();
    await expect(page.getByRole('button', { name: '手动刷新' })).toBeFocused();
    expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
    await expect(page.getByRole('heading', { name: '当前持仓' })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('account-assets.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await details.locator('summary').click();
    await page.screenshot({
      path: test.info().outputPath('account-assets-phone.png'),
      fullPage: true,
    });
    await page.goto('/dashboard');
    await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
    let summaries = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/account/summary') && request.method() === 'GET') summaries++;
    });
    await page.clock.runFor(3100);
    await expect.poll(() => summaries).toBe(1);
  } finally {
    await otherContext.close();
  }
});

test('hiding the page clears private values and returning rechecks before showing assets', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#asset-equity')).toHaveCount(0);
  await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
});

test('a response received after a silent identity change cannot restore the previous user assets', async ({
  page,
  context,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/account/assets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: '手动刷新' }).click();
    await seen;
    await switchCookie(context);
    release();
    await expect(page).toHaveURL('/login');
    await expect(page.locator('#asset-equity')).toHaveCount(0);
  } finally {
    release();
  }
});

test('failed and cooling reads retain the original query time and cannot be bypassed by manual refresh', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.clock.install();
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  const queried = await page.locator('#asset-queried').textContent();
  let requests = 0;
  await page.route('**/account/assets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    requests++;
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'rate_limited',
        error: '合成限流',
        retryAt: new Date(Date.now() + 60000).toISOString(),
      }),
    });
  });
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('status')).toContainText('数据待更新');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  await expect(page.locator('#asset-queried')).toHaveText(queried!);
  await page.getByRole('button', { name: '手动刷新' }).click();
  await page.clock.runFor(30000);
  expect(requests).toBe(1);
  await expect(page.getByText('限流暂停', { exact: true })).toBeVisible();
});

test('offline aborts a pending read, recovery rechecks, and a silent cookie switch cannot show old assets', async ({
  page,
  context,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/account/assets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: '手动刷新' }).click();
    await seen;
    await context.setOffline(true);
    await expect(page.getByRole('status')).toContainText('网络已断开');
    release();
    await expect(page.locator('.balances')).toHaveAttribute('data-current', 'false');
    await page.unroute('**/account/assets');
    await context.setOffline(false);
    await expect(page.locator('.balances')).toHaveAttribute('data-current', 'true');
    await switchCookie(context);
    await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
    await expect(page.locator('#asset-equity')).toHaveCount(0);
  } finally {
    release();
    await context.setOffline(false);
  }
});

test('invalid source, old timestamps and inconsistent money cannot become a current asset snapshot', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
  for (const patch of [
    { source: 'binance' },
    { queriedAt: '2020-01-01T00:00:00Z' },
    { equity: '999' },
  ]) {
    await page.route('**/account/assets', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, ...patch } });
    });
    await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.getByRole('status')).toContainText('账户数据异常');
    await expect(page.locator('.balances')).toHaveAttribute('data-current', 'false');
    await expect(page.locator('#asset-equity')).toHaveText('975.09999999');
    await page.unroute('**/account/assets');
  }
});
