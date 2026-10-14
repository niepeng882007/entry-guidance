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
  await expect(page.locator('.position').first()).toHaveAttribute('data-current', 'true');
}

test('unconfirmed account scope revokes every current section even when another read arrives later', async ({
  page,
}) => {
  await open(page);
  await page.route('**/api/account/assets', (route) =>
    route.fulfill({
      status: 502,
      json: {
        source: 'demo',
        error: '只读权限未确认',
        scopeConfirmed: false,
        attemptedAt: new Date().toISOString(),
      },
    }),
  );
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('status')).toContainText('只读权限未确认');
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('.position').first()).toHaveAttribute('data-current', 'false');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  await expect(page.locator('.order[data-current="true"]')).toHaveCount(0);
  await expect(page.locator('#account-orders')).toContainText('不能确认全账户总数');
});

test('retry responses preserve the upstream attempt and show a wait without rewriting successful times', async ({
  page,
}) => {
  await open(page);
  await page.getByText('资金占用与查询信息', { exact: true }).click();
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
  await expect(page.getByRole('status')).toContainText('下次允许读取');
  await expect(page.locator('#asset-queried')).toHaveText(success!);
  await expect(page.locator('#asset-attempted')).toHaveText(
    new Date(attempt).toLocaleString('zh-CN', { hour12: false }),
  );
});

test('all sections use the three-second clock, skip a busy round and resume together after going offline', async ({
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
    if (held && path.endsWith('/positions'))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ response });
  });
  await open(page);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await page.clock.runFor(2999);
  expect([...counts.values()]).toEqual([1, 1, 1, 1]);
  await page.clock.runFor(1);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await expect.poll(() => [...counts.values()]).toEqual([2, 2, 2, 2]);
  held = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.clock.runFor(9000);
  expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  await context.setOffline(true);
  held = false;
  release();
  await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('.position[data-current=true]')).toHaveCount(0);
  await page.clock.runFor(6000);
  expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  await context.setOffline(false);
  await expect(page.locator('.position').first()).toHaveAttribute('data-current', 'true');
  await expect.poll(() => [...counts.values()]).toEqual([4, 4, 4, 4]);
});

test('all first reads failing show unknown facts instead of zero balances or empty current lists', async ({
  page,
}) => {
  await page.route('**/api/account/*', (route) =>
    route.fulfill({ status: 502, json: { error: '受控全体读取失败' } }),
  );
  await page.goto('/login');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/account');
  await expect(page.getByRole('status')).toContainText('尚无成功数据');
  await expect(page.locator('#asset-equity')).toHaveText('—');
  await expect(page.locator('#account-positions')).toContainText('不能确认是否空仓');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  await expect(page.locator('#account-orders')).toContainText('不能确认是否有挂单');
  await expect(page.locator('#account-orders')).toContainText('不能确认是否有条件挂单');
  await expect(page.locator('.position, .order')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('#account-orders')).toContainText('显示 6 / 全账户 6 张活跃委托');
});
