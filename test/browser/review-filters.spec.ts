import { test, expect, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.ts';
import { seedReviewFilters } from '../review-filter-fixtures.ts';

async function startFiltersPage(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-filters-'));
  const path = join(directory, 'demo.sqlite');
  const seeded = seedReviewFilters(path);
  const server = createServer({
    password: 'browser-test-only',
    mode: 'demo',
    reviewLedgerPath: path,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server');
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto(`${base}/`);
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto(`${base}/review`);
  return {
    base,
    seeded,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const tableRows = (page: Page) => page.locator('.review-table tbody tr[data-row-key]');
async function selectSymbol(page: Page, symbol: string) {
  await page.getByLabel('交易对', { exact: true }).fill(symbol);
  await page.locator('.ant-select-item-option').filter({ hasText: symbol }).click();
}

test('server pagination preserves total range and resets to page one after a symbol filter', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.getByRole('heading', { name: '29 笔归档交易', exact: true })).toBeVisible();
    await expect(tableRows(page)).toHaveCount(20);
    await page.locator('.ant-pagination-item-2').click();
    await expect(tableRows(page)).toHaveCount(9);
    await selectSymbol(page, 'ETHUSDT');
    await expect(tableRows(page)).toHaveCount(3);
    await expect(page).toHaveURL(app.base + '/review?symbol=ETHUSDT');
    await page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).first().click();
    await expect(page.locator('#trade-detail')).toBeFocused();
    await page.getByRole('button', { name: '← 返回交易记录' }).click();
    await expect(tableRows(page)).toHaveCount(3);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await expect(tableRows(page)).toHaveCount(20);
    await expect(page.getByText('当前匹配 29 笔', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Beijing day boundaries, unknown opening dates and pending PnL stay explicit', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await page.goto(app.base + '/review?from=2026-10-10&to=2026-10-10&symbol=ETHUSDT');
    await expect(tableRows(page)).toHaveCount(1);
    await expect(tableRows(page)).toContainText('-13.5265');
    await page.goto(app.base + '/review?symbol=SOLUSDT');
    await expect(tableRows(page)).toHaveCount(4);
    await expect(page.locator('.review-table__amount').filter({ hasText: '待确认' })).toHaveCount(
      3,
    );
    await page.goto(app.base + '/review?from=2026-10-10&to=2026-10-10&symbol=SOLUSDT');
    await expect(tableRows(page)).toHaveCount(3);
    await page.goto(app.base + '/review?symbol=ADAUSDT');
    await expect(page.getByText('没有符合条件的交易，请调整日期或交易对。')).toBeVisible();
    await expect(tableRows(page)).toHaveCount(0);
    await page.goto(app.base + '/review?from=2026-10-11&to=2026-10-10');
    await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期');
    await expect(tableRows(page)).toHaveCount(0);
    expect((await page.request.get(app.base + '/api/review/trades?pnl=invalid')).status()).toBe(
      400,
    );
  } finally {
    await app.close();
  }
});

test('changing filters and cancelling or leaving reject late responses', async ({ page }) => {
  const app = await startFiltersPage(page);
  let release: (() => void) | undefined;
  try {
    await expect(tableRows(page)).toHaveCount(20);
    await page.route('**/api/review/trades?symbol=BTCUSDT', async (route) => {
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    await selectSymbol(page, 'BTCUSDT');
    await expect.poll(() => typeof release).toBe('function');
    await selectSymbol(page, 'SOLUSDT');
    await expect(tableRows(page)).toHaveCount(4);
    release!();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(tableRows(page).filter({ hasText: 'BTCUSDT' })).toHaveCount(0);
    for (const cancel of ['cancel', 'leave'] as const) {
      release = undefined;
      await page.route('**/api/review/trades?symbol=SOLUSDT', async (route) => {
        const response = await route.fetch();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await expect.poll(() => typeof release).toBe('function');
      if (cancel === 'cancel')
        await page.getByRole('button', { name: '取消读取', exact: true }).click();
      else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      release!();
      await page.unrouteAll({ behavior: 'wait' });
      await expect(page.locator('#review-status')).toContainText(
        cancel === 'cancel' ? '读取已取消' : '页面已离开',
      );
      await expect(
        page.getByText('上次读取结果 · 当前范围需重新读取确认，详情暂不可打开。'),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: '查看 SOLUSDT 交易详情' }).first(),
      ).toBeDisabled();
    }
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
    await app.close();
  }
});

test('failed or mismatched responses cannot pass as the selected range', async ({ page }) => {
  const app = await startFiltersPage(page);
  try {
    await expect(tableRows(page)).toHaveCount(20);
    await page.route('**/api/review/trades', (route) =>
      route.fulfill({ status: 503, json: { error: 'controlled failure' } }),
    );
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('#review-status')).toContainText('读取失败');
    await expect(
      page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).first(),
    ).toBeDisabled();
    await page.unrouteAll();
    await page.route('**/api/review/trades?symbol=ETHUSDT', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.filters.symbol = 'BTCUSDT';
      await route.fulfill({ response, json: data });
    });
    await selectSymbol(page, 'ETHUSDT');
    await expect(page.locator('#review-status')).toContainText('筛选范围或分页结果不一致');
    await expect(tableRows(page)).toHaveCount(0);
    await page.unrouteAll();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(tableRows(page)).toHaveCount(3);
  } finally {
    await app.close();
  }
});
test('reading raw evidence cannot make a failed trade list current again', async ({ page }) => {
  const app = await startFiltersPage(page);
  try {
    await page.route('**/review', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace('data-mode="demo"', 'data-mode="binance"'),
      });
    });
    let failed = false;
    await page.route('**/api/review/trades', async (route) => {
      if (failed) return route.fulfill({ status: 503, json: { error: 'controlled failure' } });
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          source: 'binance',
          accountId: '12345',
          syncStatus: 'synced',
          trades: data.trades.map((trade: Record<string, unknown>) => ({
            ...trade,
            source: 'binance',
            accountId: '12345',
          })),
        },
      });
    });
    await page.route('**/api/review/journal', (route) =>
      route.fulfill({ json: { source: 'binance', accountId: '12345', notes: [], tags: [] } }),
    );
    await page.route('**/api/review/evidence?**', (route) =>
      route.fulfill({
        json: {
          source: 'binance',
          accountId: '12345',
          symbol: 'BTCUSDT',
          records: [],
          nextOffset: null,
        },
      }),
    );
    await page.reload();
    await expect(tableRows(page)).toHaveCount(20);
    failed = true;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('#review-status')).toContainText('读取失败');
    await page.getByText('归档管理 · 同步进度与原始证据', { exact: true }).click();
    await page.getByRole('button', { name: '查看所选合约原始证据' }).click();
    await expect(page.getByRole('heading', { name: 'BTCUSDT · 原始历史证据' })).toBeVisible();
    await expect(
      page.getByText('上次读取结果 · 当前范围需重新读取确认，详情暂不可打开。'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).first(),
    ).toBeDisabled();
  } finally {
    await page.unrouteAll();
    await app.close();
  }
});

test('saving notes leaves the editor visible and refreshes the list on return', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(tableRows(page)).toHaveCount(20);
    await page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).first().click();
    await page.getByText('维护交易风格标签', { exact: true }).click();
    await page.getByLabel('新标签名称').fill('新风格');
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    await page.getByLabel('新风格', { exact: true }).check();
    await page.getByLabel('自由笔记').fill('保存后保留表单');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已保存');
    await expect(page.getByLabel('自由笔记')).toHaveValue('保存后保留表单');
    await page.getByRole('button', { name: '← 返回交易记录' }).click();
    await expect(tableRows(page)).toHaveCount(20);
    await expect(
      page.getByText('上次读取结果 · 当前范围需重新读取确认，详情暂不可打开。'),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
