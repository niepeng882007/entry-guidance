import { test, expect } from '@playwright/test';

test('orders are the default view with separate realized pnl and links to complete-trade review', async ({
  page,
}) => {
  const externalActions: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/api/symbols') ||
      request.url().includes('refresh=1') ||
      (request.method() === 'POST' && request.url().includes('/api/review/archive'))
    )
      externalActions.push(request.url());
  });
  await page.goto('/review');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?page=999');
  await expect(page.getByRole('heading', { name: '订单记录', exact: true })).toBeVisible();
  await expect(page.locator('.ant-table-row')).toHaveCount(3);
  await expect(page).toHaveURL('/review');
  await expect(page.getByRole('columnheader', { name: '已实现盈亏（USDT）' })).toBeVisible();
  await expect(page.locator('.ant-table-row').first()).toContainText('9');
  await page.locator('.ant-table-row-expand-icon').first().click();
  await expect(page.getByText('demo-order-3', { exact: true })).toBeVisible();
  await expect(page.getByText('0.1845 USDT', { exact: true })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const value of await page.locator('.review-orders__details .details__value').all()) {
      const box = await value.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath(`orders-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '查看完整交易复盘', exact: true }).click();
  await expect(page.locator('#review-net-pnl')).toHaveText('12.4735 USDT');
  await page.getByLabel('K 线周期').selectOption('1m');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(externalActions).toEqual([]);
  await page.getByRole('button', { name: '继续读取 / 重试行情' }).click();
  await expect.poll(() => externalActions.length).toBe(1);
  await page.getByRole('button', { name: '← 返回交易记录' }).click();
  await expect(page.getByRole('heading', { name: '订单记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完整交易复盘', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1 笔归档交易', exact: true })).toBeVisible();
});
