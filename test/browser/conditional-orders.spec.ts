import { expect, test, type Page } from '@playwright/test';

async function openOrders(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="password"]').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page).toHaveURL('/');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  await page.goto('/account');
  await page.getByRole('button', { name: '活跃委托', exact: true }).click();
  return page.getByRole('region', { name: '活跃委托', exact: true });
}

test('unified orders distinguish colliding IDs, close-all and exact conditional facts while retaining focus', async ({
  page,
}) => {
  let ordinary = 0,
    conditional = 0;
  await page.route('**/api/account/orders', async (route) => {
    ordinary++;
    await route.continue();
  });
  await page.route('**/api/account/conditional-orders', async (route) => {
    conditional++;
    await route.continue();
  });
  const orders = await openOrders(page);
  await expect(orders).toContainText('显示 6 / 全账户 6 张活跃委托');
  await expect(orders.locator('article')).toHaveCount(6);
  const filter = orders.getByRole('searchbox', { name: '筛选委托标的' });
  await filter.fill('btc');
  await expect(orders).toContainText('显示 3 / 全账户 6 张活跃委托');
  const ordinaryDetails = orders.getByRole('button', {
    name: 'BTCUSDT 委托 9007199254740993123 详情',
  });
  const conditionalDetails = orders.getByRole('button', {
    name: 'BTCUSDT 条件委托 9007199254740993123 详情',
  });
  await ordinaryDetails.click();
  await conditionalDetails.click();
  await conditionalDetails.focus();
  await expect(orders.getByText('9007199254740993123', { exact: true })).toHaveCount(2);
  await expect(orders).toContainText('标记价（MARK_PRICE）');
  await expect(orders).toContainText('整仓退出 · 不指定固定数量');
  await expect(orders).toContainText('未知 · 未返回');
  await page.clock.runFor(3000);
  await expect.poll(() => conditional).toBe(2);
  await expect.poll(() => ordinary).toBe(2);
  await expect(conditionalDetails).toBeFocused();
  await expect(filter).toHaveValue('btc');
  await expect(orders.getByText('9007199254740993123', { exact: true }).first()).toBeVisible();
  await expect(orders.getByText('9007199254740993123', { exact: true }).last()).toBeVisible();
  await orders.getByRole('button', { name: 'BTCUSDT 条件委托 2 详情' }).click();
  await expect(orders).toContainText('最新成交价（CONTRACT_PRICE）');
  await expect(orders).toContainText('触发价不保证成交价');
  await expect(orders).not.toContainText('止损核验通过');
});

test('ordinary and conditional failures remain independent, preserve original time and cannot claim all-account emptiness', async ({
  page,
}) => {
  let ordinary = 'ok',
    conditional = 'failure';
  await page.route('**/api/account/orders', async (route) => {
    if (ordinary === 'failure')
      return route.fulfill({ status: 502, json: { error: '普通分项失败' } });
    const data = await (await route.fetch()).json();
    if (ordinary === 'empty') data.orders = [];
    await route.fulfill({ json: data });
  });
  await page.route('**/api/account/conditional-orders', async (route) => {
    if (conditional === 'failure')
      return route.fulfill({ status: 502, json: { error: '条件分项失败' } });
    const data = await (await route.fetch()).json();
    if (conditional === 'empty') data.orders = [];
    if (conditional === 'changed') {
      data.orders = data.orders.filter((o: { algoId: string }) => o.algoId !== '2');
      data.orders[0].triggerPrice = '57000.00000001';
      data.orders.push({
        ...data.orders[0],
        algoId: '5',
        positionSide: 'SHORT',
        side: 'BUY',
        workingType: 'OTHER_PRICE',
      });
    }
    await route.fulfill({ json: data });
  });
  const orders = await openOrders(page);
  const fixed = orders
    .locator('article[data-kind=conditional]')
    .filter({ hasText: '卖出 · 多头' })
    .filter({ hasText: 'BTCUSDT' });
  await expect(orders).toContainText('尚无成功条件委托数据');
  await expect(orders).toContainText('不能确认全账户总数');
  await expect(orders.locator('article[data-kind=ordinary]')).toHaveCount(2);
  conditional = 'ok';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders.locator('article')).toHaveCount(6);
  const details = fixed.getByRole('button', { name: /详情$/ });
  await details.click();
  const queriedRow = fixed.locator('.details__row').filter({ hasText: '条件委托查询时间' });
  const queried = await queriedRow.textContent();
  conditional = 'failure';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('上次条件委托已过期');
  await expect(queriedRow).toHaveText(`${queried} · 已过期`);
  await expect(fixed).toHaveAttribute('data-current', 'false');
  await expect(orders.locator('article[data-kind=ordinary]').first()).toHaveAttribute(
    'data-current',
    'true',
  );
  await expect(orders).toContainText('不能确认全账户总数');
  conditional = 'changed';
  ordinary = 'failure';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(fixed).toContainText('57000.00000001');
  await expect(fixed).toHaveAttribute('data-current', 'true');
  await expect(orders.locator('article[data-kind=ordinary]').first()).toHaveAttribute(
    'data-current',
    'false',
  );
  await expect(orders.getByRole('button', { name: 'BTCUSDT 条件委托 2 详情' })).toHaveCount(0);
  await orders.getByRole('button', { name: 'BTCUSDT 条件委托 5 详情' }).click();
  await expect(orders).toContainText('交易所触发依据（OTHER_PRICE）');
  ordinary = 'empty';
  conditional = 'empty';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('成功查询：当前全账户无活跃委托。');
  await expect(orders.locator('article')).toHaveCount(0);
  conditional = 'failure';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).not.toContainText('成功查询：当前全账户无活跃委托。');
  await expect(orders).toContainText('上次成功查询无条件委托，当前状态未知。');
});

test('conditional response validation preserves the last successful list and never defaults quantities or trigger basis', async ({
  page,
}) => {
  let variant = 'ok';
  let confirmedAt = '';
  await page.route('**/api/account/conditional-orders', async (route) => {
    const data = await (await route.fetch()).json();
    data.queriedAt = new Date().toISOString();
    if (variant === 'ok') confirmedAt = data.queriedAt;
    if (variant === 'type-array') data.orders[0].type = ['STOP_MARKET'];
    if (variant === 'side-array') data.orders[0].side = ['SELL'];
    if (variant === 'source') data.source = 'binance';
    if (variant === 'time') data.queriedAt = new Date(Date.now() - 60000).toISOString();
    if (variant === 'older')
      data.queriedAt = new Date(Date.parse(confirmedAt) - 1000).toISOString();
    if (variant === 'quantity') data.orders[1].quantity = '0.00000000';
    if (variant === 'remaining') data.orders[2].remainingQty = '1.00000001';
    if (variant === 'id') data.orders[0].algoId = 9007199254740992;
    if (variant === 'flag') data.orders[0].priceProtect = 'false';
    if (variant === 'duplicate') data.orders.push(data.orders[0]);
    await route.fulfill({ json: data });
  });
  const orders = await openOrders(page);
  await expect(orders.locator('article[data-kind=conditional]')).toHaveCount(4);
  for (variant of [
    'type-array',
    'side-array',
    'source',
    'time',
    'quantity',
    'remaining',
    'id',
    'flag',
    'duplicate',
    'older',
  ]) {
    await page.getByRole('button', { name: '手动刷新' }).click();
    if (variant === 'source') {
      await expect(orders).toContainText('账户来源无效');
      await expect(orders.locator('article[data-current=true]')).toHaveCount(0);
    } else {
      await expect(orders).toContainText('上次条件委托已过期');
      await expect(orders).toContainText('普通委托查询成功');
    }
    await expect(orders.locator('article[data-kind=conditional]')).toHaveCount(4);
  }
  variant = 'ok';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(orders).toContainText('显示 6 / 全账户 6 张活跃委托');
  const trailing = orders.locator('article').filter({ hasText: 'SOLUSDT' });
  await trailing.getByRole('button', { name: /详情$/ }).click();
  await expect(trailing).toContainText('激活价');
  await expect(trailing).toContainText('150.00000001 USDT');
  await expect(trailing).toContainText('0.30000000%');
  await expect(trailing.locator('.details__row').filter({ hasText: '触发依据' })).toContainText(
    '未知 · 未返回',
  );
  await expect(trailing).toContainText('不适用 · 追踪止损');
  const close = orders.locator('article').filter({ hasText: 'BTCUSDT · 买入 · 空头' });
  await expect(close).toContainText('整仓退出 · 不指定固定数量');
  await expect(close).not.toContainText('0.00000000');
});

for (const width of [320, 390, 1280])
  test(`conditional fields and long IDs fit ${width}px and respect reduced motion`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const orders = await openOrders(page);
    await expect(orders.locator('article')).toHaveCount(6);
    for (const details of await orders.getByRole('button', { name: /详情$/ }).all())
      await details.click();
    const details = orders.getByRole('button', {
      name: 'BTCUSDT 条件委托 9007199254740993123 详情',
    });
    await details.focus();
    const fixed = orders
      .locator('article[data-kind=conditional]')
      .filter({ hasText: 'BTCUSDT · 卖出 · 多头' });
    await expect(fixed.getByText('9007199254740993123', { exact: true })).toBeVisible();
    await expect(fixed.locator('.details__row').filter({ hasText: '价格保护' })).toContainText(
      '是',
    );
    await expect(fixed.locator('.details__row').filter({ hasText: '只减仓' })).toContainText('是');
    await page.keyboard.press('Space');
    await expect(fixed.getByText('9007199254740993123', { exact: true })).toBeHidden();
    await page.keyboard.press('Space');
    await expect(details).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await details.evaluate((element) => getComputedStyle(element, '::before').transitionDuration),
    ).toBe('0s');
    await page.screenshot({
      path: testInfo.outputPath(`conditional-orders-${width}.png`),
      fullPage: true,
    });
  });
