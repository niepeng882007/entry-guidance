import { test, expect } from '@playwright/test';

test('trade chart distinguishes price sources and links real fill markers at mobile sizes', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?view=cycles');
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  const chart = page.getByRole('region', { name: '行情与交易事件' });
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('合约成交价');
  await expect(chart).toContainText('69 根原始 K 线');
  await expect(chart).toContainText('演示合成行情');
  await chart.getByRole('button', { name: '开仓 · demo-fill-1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(chart).toContainText('60000 USDT');
  await chart.getByRole('button', { name: '查看此成交原始详情' }).click();
  await expect(page.locator('#trade-fill-0')).toBeFocused();
  await expect(page.locator('#trade-fill-0')).toContainText('demo-order-1');
  await chart.getByLabel('行情价格来源').selectOption('mark');
  await expect(chart).toContainText('/fapi/v1/markPriceKlines');
  await chart.getByLabel('K 线周期').selectOption('1h');
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('33 根原始 K 线');
  await expect(chart).toContainText('整根 K 线在收盘后才完整可知');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`chart-${width}.png`), fullPage: true });
    await chart.screenshot({ path: test.info().outputPath(`chart-panel-${width}.png`) });
  }
});

test('late period responses, offline events and invalid sources cannot replace the current chart', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?view=cycles');
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  const chart = page.getByRole('region', { name: '行情与交易事件' });
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('69 根原始 K 线');
  let release!: () => void;
  await page.route('**/market?interval=1m&refresh=1', async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await chart.getByLabel('K 线周期').selectOption('1m');
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await chart.getByLabel('K 线周期').selectOption('1h');
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('33 根原始 K 线');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(chart).toContainText('33 根原始 K 线');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(chart).toContainText('仅保留已知时点');
  await expect(chart).toContainText('33 根原始 K 线');
  await page.route('**/market?interval=*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, accountId: 'wrong-account' } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(page.locator('#trade-detail')).toBeVisible();
  await expect(chart).toContainText('行情来源、时点或交易依据不一致');
  await expect(chart.getByRole('group', { name: /K 线、实际成交/ })).toHaveCount(0);
});

test('a mark-price gap stays separate from complete contract prices and can be retried', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?view=cycles');
  await page.route('**/market?interval=*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.series.mark = {
      ...data.series.mark,
      candles: [],
      rawCount: 0,
      complete: false,
      nextTime: data.startTime,
      gaps: [{ startTime: data.startTime, endTime: data.endTime }],
      error: '来源失败 · 历史合约可能不可查',
    };
    await route.fulfill({ json: data });
  });
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  const chart = page.getByRole('region', { name: '行情与交易事件' });
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('本来源请求范围已完整归档');
  await chart.getByLabel('行情价格来源').selectOption('mark');
  await expect(chart).toContainText('来源失败');
  await expect(chart).toContainText('0 根原始 K 线');
  await expect(chart).not.toContainText('本来源请求范围已完整归档');
  await chart.getByText('行情缺口 / 待完成区间 · 1 段').click();
  await page.unrouteAll({ behavior: 'wait' });
  await chart.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect(chart.getByRole('button', { name: '继续读取 / 重试行情' })).toBeEnabled();
  await expect(chart).toContainText('本来源请求范围已完整归档');
});
