import { test, expect, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/login');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page).toHaveURL('/');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  await page.goto('/account');
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'true');
}

test('unconfirmed account scope revokes current assets', async ({ page }) => {
  await open(page);
  await page.route('**/api/account/assets', (route) =>
    route.fulfill({
      status: 502,
      json: {
        source: 'demo',
        code: 'unverified_permissions',
        error: '只读权限未确认',
        scopeConfirmed: false,
        attemptedAt: new Date().toISOString(),
      },
    }),
  );
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '只读权限未确认，请检查凭据。 数据待更新。',
  );
  await expect(page.getByText('只读权限未确认', { exact: true })).toBeHidden();
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'false');
});

test('retry responses preserve the upstream attempt and show a wait without rewriting successful times', async ({
  page,
}) => {
  await open(page);
  const success = await page.locator('#asset-queried').textContent();
  const attempt = new Date(Date.now() - 20_000).toISOString();
  const retry = new Date(Date.now() + 60_000).toISOString();
  await page.route('**/api/account/assets', (route) =>
    route.fulfill({
      status: 429,
      json: {
        source: 'demo',
        error: 'Binance 限流，读取已退避。',
        attemptedAt: attempt,
        retryAt: retry,
      },
    }),
  );
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '请求过于频繁，稍后自动重试。 数据待更新。',
  );
  await expect(page.locator('#asset-queried')).toHaveText(success!);
  await expect(page.locator('#asset-attempted')).toHaveText(
    new Date(attempt).toLocaleString('zh-CN', { hour12: false }),
  );
});

test('assets use the thirty-second clock, skip a busy round and resume after going offline', async ({
  page,
  context,
}) => {
  const counts = new Map<string, number>();
  let held = false;
  let release!: () => void;
  await page.route('**/api/account/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const response = await route.fetch();
    if (held && path.endsWith('/assets'))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ response });
  });
  await open(page);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await page.clock.runFor(29_999);
  expect([...counts.values()]).toEqual([1]);
  await page.clock.runFor(1);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await expect.poll(() => [...counts.values()]).toEqual([2]);
  await page.clock.runFor(20_000);
  held = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.clock.runFor(10_000);
  expect([...counts.values()]).toEqual([3]);
  await context.setOffline(true);
  held = false;
  release();
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'false');
  await page.clock.runFor(60_000);
  expect([...counts.values()]).toEqual([3]);
  await context.setOffline(false);
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'true');
  await expect.poll(() => [...counts.values()]).toEqual([4]);
});

test('first asset read failures show unknown facts and recover without zero balances', async ({
  page,
}) => {
  await page.route('**/api/account/*', (route) =>
    route.fulfill({ status: 502, json: { error: '受控全体读取失败' } }),
  );
  await page.goto('/login');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/account');
  await expect(page.locator('.status__message').first()).toHaveText('刷新失败，请重试。');
  await expect(page.locator('#asset-equity')).toHaveText('—');
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
});
