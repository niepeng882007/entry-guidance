import { test, expect, type Page } from '@playwright/test';
import type { ReviewList, ReviewTrade } from '../../src/review-ledger.ts';

async function login(page: Page) {
  await page.goto('/review');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
}

test('date and searchable symbol filters paginate a real table without CSP violations or viewport overflow', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('CSP:')) violations.push(message.text());
  });
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`CSP:${event.effectiveDirective}:${event.blockedURI}`),
    ),
  );
  await login(page);
  const list: ReviewList = await (await page.request.get('/api/review/trades')).json();
  const original = list.trades[0]!;
  const trades = Array.from({ length: 24 }, (_, index) => ({
    ...original,
    id: `row-${String(index).padStart(2, '0')}`,
    symbol: index < 13 ? 'BTCUSDT' : 'ETHUSDT',
    baseAsset: index < 13 ? 'BTC' : 'ETH',
  }));
  await page.route('**/api/review/trades', (route) => route.fulfill({ json: { ...list, trades } }));
  await page.goto('/review?from=2026-10-10&to=2026-10-10');
  await expect(page.locator('.review-table tbody tr[data-row-key]')).toHaveCount(10);
  await page.getByLabel('交易对', { exact: true }).fill('BTC');
  await page.locator('.ant-select-item-option').filter({ hasText: 'BTCUSDT' }).click();
  await expect(page.getByText('当前匹配 13 笔', { exact: true })).toBeVisible();
  await page.locator('.ant-pagination-item-2').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.review-table tbody tr[data-row-key]')).toHaveCount(3);
  await page.getByLabel('开仓开始日期', { exact: true }).click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await page.locator('.ant-picker-dropdown:visible [title="2026-10-11"]').click();
  await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期');
  await expect(page.locator('.review-table tbody tr[data-row-key]')).toHaveCount(0);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page).toHaveURL('/review');
  await expect(page.getByText('当前匹配 24 笔', { exact: true })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const table = page.locator('.ant-table-content');
    expect(await table.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(
      true,
    );
    await page.getByLabel('开仓开始日期').click();
    const calendar = page.locator('.ant-picker-dropdown:visible');
    await expect(calendar).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`review-calendar-${width}.png`),
      fullPage: true,
    });
    await expect
      .poll(async () => {
        const box = await calendar.boundingBox();
        return !!box && box.x >= 0 && box.x + box.width <= width;
      })
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(calendar).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath(`review-table-${width}.png`),
      fullPage: true,
    });
  }
  expect(violations).toEqual([]);
});

test('detail URLs reload directly and browser navigation preserves list state and unsaved notes', async ({
  page,
}) => {
  await login(page);
  await page.goto('/review?symbol=BTCUSDT&from=2026-10-10');
  await expect(page.locator('#trade-detail')).toHaveCount(0);
  await page.locator('.review-table tbody tr[data-row-key]').click();
  await expect(page).toHaveURL(
    /\/review\/trades\/BTCUSDT-demo-fill-1\?from=2026-10-10&symbol=BTCUSDT/,
  );
  await expect(page.getByRole('group', { name: '交易记录筛选' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#review-net-pnl')).toHaveText('12.4735 USDT');
  await page.getByRole('button', { name: '← 返回交易记录' }).click();
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await page.getByLabel('入场理由', { exact: true }).fill('返回列表也保留草稿');
  await page.goBack();
  await expect(page.getByLabel('开仓开始日期')).toHaveValue('2026-10-10');
  await expect(page.locator('#trade-detail')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByLabel('入场理由', { exact: true })).toHaveValue('返回列表也保留草稿');
  await page.getByRole('button', { name: '← 返回交易记录' }).click();
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await expect(page.getByLabel('入场理由', { exact: true })).toHaveValue('返回列表也保留草稿');
});

test('returning to a paginated list rejects a late detail response and restores keyboard access', async ({
  page,
}) => {
  await login(page);
  const list: ReviewList = await (await page.request.get('/api/review/trades')).json();
  const detail: ReviewTrade = await (
    await page.request.get(`/api/review/trades/${list.trades[0]!.id}`)
  ).json();
  const trades = Array.from({ length: 12 }, (_, index) => ({
    ...list.trades[0]!,
    id: `trade-${index}`,
  }));
  await page.route('**/api/review/trades', (route) => route.fulfill({ json: { ...list, trades } }));
  let release!: () => void;
  await page.route('**/api/review/trades/*', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { ...detail, id: route.request().url().split('/').at(-1) } });
  });
  await page.goto('/review?page=2');
  const button = page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).first();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: '← 返回交易记录' }).click();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page).toHaveURL('/review?page=2');
  await expect(page.locator('#trade-detail')).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.locator('.review-table tbody tr[data-row-key]')).toHaveCount(2);
});
