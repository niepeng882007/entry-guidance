import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="password"]').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page).toHaveURL('/');
}

test('ordinary orders show exact fields and retain filter, expansion and focus across refresh', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0;
  await page.route('**/api/account/orders', async (route) => {
    requests++;
    await route.continue();
  });
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
  await expect(orders).toContainText('显示 2 / 全账户 2 张普通委托');
  await expect(orders).toContainText('0.12345677');
  await expect(orders).toContainText('买入 · 多头');
  await expect(orders).toContainText('卖出 · 空头');
  const filter = orders.getByRole('searchbox', { name: '筛选普通委托标的' });
  await filter.fill('btc');
  await expect(orders).toContainText('显示 1 / 全账户 2 张普通委托');
  const details = orders.getByRole('button', { name: 'BTCUSDT 委托 9007199254740993123 详情' });
  await details.click();
  await details.focus();
  await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
  await expect(orders.getByText('59999.12345678 USDT', { exact: true })).toBeVisible();
  await page.clock.runFor(2999);
  expect(requests).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(2);
  await expect(details).toBeFocused();
  await expect(filter).toHaveValue('btc');
  await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '持仓', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当前持仓', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  await expect(filter).toHaveValue('btc');
  await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
  await filter.fill('none');
  await expect(orders).toContainText('筛选无结果，全账户仍有 2 张普通委托');
});

test('ordinary order changes replace the active list while errors preserve the old list and time', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let variant = 'initial';
  await page.route('**/api/account/orders', async (route) => {
    if (variant === 'failure')
      return route.fulfill({ status: 502, json: { error: '受控普通委托失败' } });
    const data = await (await route.fetch()).json();
    if (variant === 'changed') {
      data.orders[0].timeInForce = 'RPI';
      data.orders[0].executedQty = '0.10000000';
      data.orders[0].remainingQty = '0.02345678';
      data.orders.push({ ...data.orders[1], symbol: 'SOLUSDT', orderId: '3' });
      data.orders.reverse();
    }
    if (variant === 'removed') data.orders.splice(0, 1);
    if (variant === 'empty') data.orders = [];
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
  await expect(orders).toContainText('显示 2 / 全账户 2');
  const details = orders.getByRole('button', { name: 'BTCUSDT 委托 9007199254740993123 详情' });
  await details.click();
  const queried = await orders
    .locator('.details__row')
    .filter({ hasText: '普通委托查询时间' })
    .first()
    .textContent();
  variant = 'failure';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('受控普通委托失败');
  await expect(orders).toContainText('上次普通委托已过期');
  await expect(orders).toContainText('0.12345677');
  await expect(
    orders.locator('.details__row').filter({ hasText: '普通委托查询时间' }).first(),
  ).toHaveText(`${queried} · 已过期`);
  await expect(page.getByRole('status')).toContainText('模拟查询成功');
  variant = 'changed';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('显示 3 / 全账户 3');
  await expect(orders).toContainText('0.02345678');
  await expect(orders.getByText('RPI', { exact: true })).toBeVisible();
  await expect(orders.locator('article h3')).toHaveText([
    'BTCUSDT · 买入 · 多头',
    'ETHUSDT · 卖出 · 空头',
    'SOLUSDT · 卖出 · 空头',
  ]);
  await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
  variant = 'removed';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(details).toHaveCount(0);
  await expect(orders).toContainText('显示 1 / 全账户 1');
  variant = 'empty';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('成功查询：当前全账户无普通活跃委托。');
  variant = 'failure';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('上次成功查询无普通委托，当前状态未知。');
});

test('ordinary orders reject unavailable or inconsistent data and recover without affecting assets', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let variant = 'failure';
  await page.route('**/api/account/orders', async (route) => {
    if (variant === 'failure')
      return route.fulfill({ status: 502, json: { error: '首次委托读取失败' } });
    const data = await (await route.fetch()).json();
    if (variant === 'source') data.source = 'binance';
    if (variant === 'time') data.queriedAt = new Date(Date.now() - 60_000).toISOString();
    if (variant === 'remaining') data.orders[0].remainingQty = '0.12345678';
    if (variant === 'negative') data.orders[0].executedQty = '-0.1';
    if (variant === 'id') data.orders[0].orderId = 9007199254740992;
    if (variant === 'older') data.queriedAt = new Date(Date.now() - 1000).toISOString();
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
  await expect(orders).toContainText('尚无成功普通委托数据');
  await expect(orders).not.toContainText('成功查询：当前全账户无普通活跃委托');
  for (variant of ['source', 'time', 'remaining', 'negative', 'id']) {
    await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(orders.locator('article')).toHaveCount(0);
    await expect(orders).toContainText('无效');
    await expect(page.getByRole('status')).toContainText('模拟查询成功');
  }
  variant = 'ok';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders.locator('article')).toHaveCount(2);
  variant = 'older';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('早于上次成功查询');
  await expect(orders.locator('article')).toHaveCount(2);
});

test('busy ordinary reads pause on leaving and canceled responses cannot replace the resumed list', async ({
  page,
  context,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0,
    hold = false;
  let release!: () => void;
  await page.route('**/api/account/orders', async (route) => {
    requests++;
    const data = await (await route.fetch()).json();
    if (hold) {
      data.orders = [];
      await new Promise<void>((resolve) => (release = resolve));
    }
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
  await expect(orders.locator('article')).toHaveCount(2);
  hold = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.clock.runFor(9000);
  expect(requests).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(orders).toContainText('页面已离开');
  hold = false;
  release();
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await page.clock.runFor(9000);
  expect(requests).toBe(2);
  await expect(orders.locator('article')).toHaveCount(2);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(orders).toContainText('普通委托查询成功');
  expect(requests).toBe(3);
  await context.setOffline(true);
  await expect(orders).toContainText('网络已断开');
  await page.clock.runFor(9000);
  expect(requests).toBe(3);
  await context.setOffline(false);
  await expect(orders).toContainText('普通委托查询成功');
  expect(requests).toBe(4);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(orders).toContainText('页面已隐藏');
  await page.clock.runFor(9000);
  expect(requests).toBe(4);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(orders).toContainText('普通委托查询成功');
  expect(requests).toBe(5);
});

test('ordinary order session expiry revokes all snapshots and stops polling', async ({ page }) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0,
    expired = false;
  await page.route('**/api/account/orders', async (route) => {
    requests++;
    if (expired) await route.fulfill({ status: 401, json: { error: '请先登录。' } });
    else await route.continue();
  });
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
  await expect(orders.locator('article')).toHaveCount(2);
  expired = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('link', { name: '重新登录' })).toBeVisible();
  await expect(orders).toContainText('登录已过期');
  await expect(page.getByRole('status')).toContainText('已过期');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
  await page.clock.runFor(30_000);
  expect(requests).toBe(2);
});

for (const width of [320, 390, 1280])
  test(`ordinary order values and focus fit ${width}px with reduced motion`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page);
    await page.goto('/account');
    await page.getByRole('button', { name: '活跃委托', exact: true }).click();
    const orders = page.getByRole('region', { name: '普通活跃委托', exact: true });
    await expect(orders.locator('article')).toHaveCount(2);
    for (const details of await orders.getByRole('button', { name: /详情$/ }).all())
      await details.click();
    await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
    await expect(orders.getByText('不适用 · 尚未成交', { exact: true })).toBeVisible();
    await expect(orders.getByText('未知 · 未返回', { exact: true }).first()).toBeVisible();
    const details = orders.getByRole('button', { name: 'BTCUSDT 委托 9007199254740993123 详情' });
    await details.focus();
    await page.keyboard.press('Space');
    await expect(orders.getByText('9007199254740993123', { exact: true })).toBeHidden();
    await page.keyboard.press('Space');
    await expect(orders.getByText('9007199254740993123', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await details.evaluate((element) => getComputedStyle(element, '::before').transitionDuration),
    ).toBe('0s');
    await page.screenshot({ path: testInfo.outputPath(`orders-${width}.png`), fullPage: true });
  });
