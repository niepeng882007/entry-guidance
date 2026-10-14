import { test, expect } from '@playwright/test';
import type { OrderList } from '../../src/review-orders.ts';

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
  for (const width of [320, 375, 390, 414, 768, 1280]) {
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

test('order filters wait for query, reject invalid dates and reset the submitted range', async ({
  page,
}) => {
  await page.goto('/review?from=2026-10-10&to=2026-10-10');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?from=2026-10-10&to=2026-10-10');
  const rows = page.locator('.ant-table-row');
  await expect(rows).toHaveCount(3);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/review/orders?')) reads.push(request.url());
  });
  await page.getByLabel('订单结束日期', { exact: true }).click();
  await page.locator('.ant-picker-dropdown:visible [title="2026-10-09"]').click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期');
  await expect(page.getByRole('button', { name: '查询', exact: true })).toBeDisabled();
  await expect(rows).toHaveCount(3);
  expect(reads).toEqual([]);
  await page.getByLabel('订单开始日期', { exact: true }).click();
  await page.locator('.ant-picker-dropdown:visible [title="2026-10-09"]').click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveURL('/review?from=2026-10-10&to=2026-10-10');
  expect(reads).toEqual([]);
  await page.getByRole('button', { name: '查询', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/review?from=2026-10-09&to=2026-10-09');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page).toHaveURL('/review');
  await expect(rows).toHaveCount(3);
  await expect(page.getByLabel('订单开始日期')).toHaveValue('');
  await expect(page.getByRole('button', { name: '重置', exact: true })).toBeDisabled();
});

test('all manual order actions fit the toolbar on mobile and desktop', async ({ page }) => {
  await page.goto('/review');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.route('**/review', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('data-mode="demo"', 'data-mode="binance"'),
    });
  });
  await page.route('**/api/review/orders?**', async (route) => {
    const response = await route.fetch();
    const data: OrderList = await response.json();
    await route.fulfill({ response, json: { ...data, source: 'binance', accountId: '12345' } });
  });
  await page.goto('/review');
  await expect(page.locator('.ant-table-row')).toHaveCount(3);
  const actions = page.locator('.review-table-panel__toolbar .ant-btn');
  await expect(actions).toHaveCount(3);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const action of await actions.all()) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({
      path: test.info().outputPath(`orders-toolbar-${width}.png`),
      fullPage: true,
    });
  }
});
