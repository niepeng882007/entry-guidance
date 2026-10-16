import { test, expect, type Page } from '@playwright/test';
import { login } from './login.ts';

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
  expect((await page.request.post('http://127.0.0.1:4182/seed-review')).ok()).toBe(true);
}
test('owned cycles support filtering, twenty-row pages, details and browser return without external reads', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  const accountReads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/account/')) accountReads.push(request.url());
  });
  await page.goto('/review?view=cycles');
  await expect(page.getByRole('heading', { name: '完整交易' })).toBeVisible();
  await expect(page.getByText('当前匹配 25 笔完整交易')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByRole('link', { name: '查看 missing-cost' }).click();
  await expect(page.locator('#review-net-pnl')).toHaveText('待确认');
  await expect(page.getByText('手续费缺失或非 USDT，缺少可靠换算', { exact: false })).toBeVisible();
  await page.getByText('逐笔成交 · 2 条', { exact: true }).click();
  await expect(page.getByText('原始成交：missing-cost-entry')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByLabel('开仓日期从').fill('2026-10-15');
  await page.getByLabel('开仓日期至').fill('2026-10-15');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByText('当前匹配 0 笔完整交易')).toBeVisible();
  expect(accountReads).toEqual([]);
});

test('hiding and returning rechecks identity without rereading the ledger or losing filter edits', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/review');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByLabel('开仓日期从').fill('2026-10-14');
  let reads = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/review\/[^/]+\/trades/.test(request.url())) reads++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('region', { name: '完整交易表格' })).not.toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('region', { name: '完整交易表格' })).toBeVisible();
  await expect(page.getByLabel('开仓日期从')).toHaveValue('2026-10-14');
  expect(reads).toBe(0);
});

test('review fits phone screens, exposes evidence and keeps keyboard focus under production CSP', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|violates.*directive/i.test(message.text()))
      errors.push(message.text());
  });
  await login(page);
  await connect(page);
  await page.goto('/review');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const refresh = page.getByRole('button', { name: '重新读取' });
  await refresh.focus();
  await refresh.press('Enter');
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await page.getByRole('link', { name: '查看 cycle-22' }).click();
  await expect(page.locator('#trade-detail')).toBeFocused();
  await page.getByText('关联原始证据 · 1 条', { exact: true }).click();
  await expect(page.locator('pre')).toContainText('cycle-22-entry');
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
  // WebKit screenshots inject Playwright's own style; verify application CSP before capture.
  await page.screenshot({
    path: test.info().outputPath('review-detail-phone.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: '返回完整交易', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: test.info().outputPath(`review-${width}.png`), fullPage: true });
  }
});

test('late responses and a silent cookie identity switch cannot reveal the previous ledger', async ({
  page,
  context,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/review');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/review/*/trades*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: '重新读取' }).click();
    await seen;
    const { users } = await import('../runtime.ts');
    const response = await context.request.post('/api/auth/sign-in/email', {
      headers: { Origin: 'http://127.0.0.1:4180' },
      data: { email: users[1]!.email, password: users[1]!.password },
    });
    expect(response.status()).toBe(200);
    release();
    await expect(page).toHaveURL('/login');
    await expect(page.locator('tbody tr')).toHaveCount(0);
  } finally {
    release();
  }
});

test('offline cancels a read and recovery waits for a manual action; another tab logout clears private content', async ({
  page,
  context,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/review');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  let reads = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/review\/[^/]+\/trades/.test(request.url())) reads++;
  });
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timestamp = await page.getByText('账本读取于', { exact: false }).textContent();
  await page.route('**/review/*/trades*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: '重新读取' }).click();
    await seen;
    await context.setOffline(true);
    await expect(page.getByRole('status')).toContainText('网络已断开');
    release();
    await expect(page.getByText('账本读取于', { exact: false })).toHaveText(timestamp!);
  } finally {
    release();
    await context.setOffline(false);
  }
  await page.unroute('**/review/*/trades*');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: '重新读取' })).toBeEnabled();
  expect(reads).toBe(1);
  await page.getByRole('button', { name: '重新读取' }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByText('当前匹配 25 笔完整交易')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/review');
  await expect(other.locator('tbody tr')).toHaveCount(20);
  await other.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL('/login');
  await other.close();
});

test('two browser users see different amounts for the same cycle ID', async ({ page, browser }) => {
  const { users } = await import('../runtime.ts');
  await login(page);
  await connect(page);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4180' });
  const other = await context.newPage();
  try {
    await login(other, users[1]!);
    await connect(other, 'bob');
    await page.goto('/review/trades/cycle-00?view=cycles');
    await other.goto('/review/trades/cycle-00?view=cycles');
    await expect(page.locator('#review-net-pnl')).toHaveText('9.8 USDT');
    await expect(other.locator('#review-net-pnl')).toHaveText('29.8 USDT');
    await expect(page.getByText('UID 10002', { exact: false })).toHaveCount(0);
    await expect(other.getByText('UID 10001', { exact: false })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
