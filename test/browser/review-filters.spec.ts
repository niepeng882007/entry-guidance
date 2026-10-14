import { withStatistics } from './review-statistics-fixtures.ts';
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

test('a user pages the archive and combines filters without shrinking the total range', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.getByRole('heading', { name: '29 笔归档交易', exact: true })).toBeVisible();
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    await page.getByRole('button', { name: '下一页交易', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(9);
    await expect(page.getByText('第 2 / 2 页 · 本页 9 笔')).toBeVisible();
    await page.getByLabel('币种筛选', { exact: true }).fill('ETHUSDT');
    await page.locator('#filter-side').selectOption('short');
    await page.locator('#filter-pnl').selectOption('loss');
    await page.locator('#filter-status').selectOption('closed');
    await page.locator('#filter-entry-type').selectOption('mixed');
    await page.locator('#filter-plan').selectOption('unconfirmed');
    await page.getByLabel('筛选标签：顺势（已停用）').check();
    await page.getByLabel('筛选标签：回踩').check();
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(1);
    await expect(page.locator('.review-page__record')).toContainText('混合');
    await expect(page.locator('.review-page__record')).toContainText('-13.5265 USDT');
    await page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).click();
    await expect(page.locator('#trade-detail')).toBeFocused();
    await expect(page.locator('#trade-detail')).toContainText('入场类型：混合');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    await expect(page.getByRole('heading', { name: '29 笔归档交易', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('calendar fields, pending PnL, unknown entries and empty results stay explicit on mobile', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    await page.getByLabel('币种筛选', { exact: true }).fill('ETHUSDT');
    await page.getByLabel('起始日期', { exact: true }).fill('2026-10-10');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-10');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(1);
    await page.locator('#filter-date-field').selectOption('closedAt');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(2);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.locator('#filter-pnl-trigger').click();
    await page
      .locator('#filter-pnl-options')
      .getByRole('option', { name: '待确认', exact: true })
      .click();
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(3);
    await expect(page.locator('.review-page__record').filter({ hasText: '持仓中' })).toHaveCount(1);
    await page.locator('#filter-entry-type').selectOption('unknown');
    await page.locator('#filter-status').selectOption('incomplete');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(2);
    await expect(page.locator('.review-page__record').first()).toContainText('入场类型：未知');
    await expect(page.locator('.review-page__record').first()).toContainText('待确认');
    await page.getByRole('button', { name: '查看 SOLUSDT 交易详情' }).first().click();
    await expect(page.locator('#trade-detail')).toBeFocused();
    await expect(page.locator('#review-net-pnl')).toHaveText('待确认');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: test.info().outputPath(`filters-${width}.png`),
        fullPage: true,
      });
      await page.getByText('筛选交易记录', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`filters-form-${width}.png`) });
      await page.locator('.review-page__record').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`filters-results-${width}.png`) });
    }
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.getByLabel('币种筛选', { exact: true }).fill('ADAUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.getByText('没有符合当前筛选条件的交易，可清除筛选重新查看。')).toBeVisible();
    await expect(page.locator('.review-page__record')).toHaveCount(0);
    await page.getByLabel('起始日期', { exact: true }).fill('2026-10-11');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-10');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('#review-status')).toContainText('筛选参数无效');
    expect((await page.request.get(`${app.base}/api/review/trades?pnl=invalid`)).status()).toBe(
      400,
    );
  } finally {
    await app.close();
  }
});

test('filter changes, cancellation and page leave reject late list responses', async ({ page }) => {
  const app = await startFiltersPage(page);
  let release: (() => void) | undefined;
  try {
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    await page.route('**/api/review/trades?symbol=BTCUSDT', async (route) => {
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    await page.getByLabel('币种筛选', { exact: true }).fill('BTCUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    await page.getByLabel('币种筛选', { exact: true }).fill('SOLUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(4);
    release!();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('.review-statistics')).toContainText('净盈亏有效 1 笔');
    await expect(page.locator('.review-page__record').filter({ hasText: 'BTCUSDT' })).toHaveCount(
      0,
    );
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
      await expect(page.locator('.review-statistics')).toHaveCount(0);
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

test('failed or mismatched list responses cannot pass as the selected range', async ({ page }) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.locator('.review-page__record')).toHaveCount(20);
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
    await page.getByLabel('币种筛选', { exact: true }).fill('ETHUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('#review-status')).toContainText('筛选范围或分页结果不一致');
    await expect(page.locator('.review-page__record')).toHaveCount(0);
    await page.unrouteAll();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(3);
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
        json: withStatistics(
          {
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
          data.statistics.trades.map((trade: Record<string, unknown>) => ({
            ...trade,
            source: 'binance',
            accountId: '12345',
          })),
        ),
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
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    failed = true;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('#review-status')).toContainText('读取失败');
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

test('saved note tags update available filters and mark the old list stale without hiding the editor', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.locator('.review-page__record')).toHaveCount(20);
    await page.getByRole('button', { name: '查看 ETHUSDT 交易详情' }).first().click();
    await page.getByLabel('新标签名称').fill('新风格');
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    await expect(page.getByLabel('筛选标签：新风格', { exact: true })).toBeVisible();
    await page.getByLabel('新风格', { exact: true }).check();
    await page.getByLabel('自由笔记').fill('保存后保留表单');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已保存');
    await expect(page.locator('.review-statistics')).toHaveCount(0);
    await expect(page.getByLabel('自由笔记')).toHaveValue('保存后保留表单');
    await expect(
      page.getByText('上次读取结果 · 当前范围需重新读取确认，详情暂不可打开。'),
    ).toBeVisible();
    await page.getByLabel('筛选标签：新风格', { exact: true }).check();
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(1);
    await expect(page.locator('.review-page__record')).toContainText('风格标签：新风格');
  } finally {
    await app.close();
  }
});

test('statistics and charts use the full range, overlap tags, and remain readable at three widths', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    const panel = page.getByRole('region', { name: '筛选范围表现统计', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('净盈亏有效 26 笔');
    await expect(panel).toContainText('285.8375 USDT');
    await expect(panel).toContainText('时长有效 27 笔');
    await expect(panel.getByRole('img', { name: '累计交易净盈亏曲线' })).toBeVisible();
    await expect(panel.locator('.review-statistics__scale')).toContainText('142.39225');
    const evidence = await panel.locator('.review-statistics__evidence-id').textContent();
    await page.getByRole('button', { name: '下一页交易', exact: true }).click();
    await expect(page.locator('.review-page__record')).toHaveCount(9);
    await expect(panel.locator('.review-statistics__evidence-id')).toHaveText(evidence!);
    await page.getByLabel('筛选标签：顺势（已停用）').check();
    await page.getByLabel('筛选标签：回踩').check();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(panel).toContainText('净盈亏有效 1 笔');
    await expect(panel).toContainText('-13.5265 USDT');
    await panel.locator('#statistics-dimension').selectOption('tags');
    await expect(panel.locator('.review-statistics__group')).toHaveCount(3);
    await expect(
      panel.locator('.review-statistics__group').filter({ hasText: '顺势' }),
    ).toContainText('-13.5265 USDT');
    await expect(panel).toContainText('各标签组重叠，不能相加');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(panel).toContainText('净盈亏有效 26 笔');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await panel.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await panel
        .getByRole('heading', { name: '累计净盈亏 · USDT', exact: true })
        .scrollIntoViewIfNeeded();
      await panel
        .locator('.review-statistics__chart')
        .screenshot({ path: test.info().outputPath(`statistics-curve-${width}.png`) });
      await panel
        .locator('.review-statistics__groups')
        .screenshot({ path: test.info().outputPath(`statistics-groups-${width}.png`) });
      await panel
        .getByRole('heading', { name: '筛选范围表现统计', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`statistics-${width}.png`) });
    }
    await page.getByLabel('币种筛选', { exact: true }).fill('ADAUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(panel).toContainText('净盈亏有效 0 笔');
    await expect(panel).toContainText('没有可判定净盈亏的已结束交易');
    await expect(panel.getByRole('img', { name: '累计交易净盈亏曲线' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('statistics with a foreign identity or changed totals cannot become current', async ({
  page,
}) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.locator('.review-statistics')).toBeVisible();
    for (const change of ['identity', 'total', 'money', 'fingerprint'] as const) {
      await page.route('**/api/review/trades', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (change === 'identity') data.statistics.accountId = 'foreign';
        if (change === 'total') data.statistics.trades.pop();
        if (change === 'money') data.statistics.pnl.netPnl = '999';
        if (change === 'fingerprint') data.statistics.evidenceId = '0'.repeat(64);
        await route.fulfill({ response, json: data });
      });
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await expect(page.locator('#review-status')).toContainText('统计证据');
      await expect(page.locator('.review-statistics')).toHaveCount(0);
      await page.unrouteAll();
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await expect(page.locator('.review-statistics')).toContainText('285.8375 USDT');
    }
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await app.close();
  }
});

test('cancelling during fingerprint verification rejects its late result', async ({ page }) => {
  const app = await startFiltersPage(page);
  try {
    await expect(page.locator('.review-statistics')).toContainText('净盈亏有效 26 笔');
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let paused = false;
      Object.defineProperty(crypto.subtle, 'digest', {
        configurable: true,
        value: async (...args: Parameters<SubtleCrypto['digest']>) => {
          const result = await digest(...args);
          if (!paused) {
            paused = true;
            document.body.dataset.digestPaused = 'true';
            await new Promise<void>((resolve) =>
              window.addEventListener('release-statistics-digest', () => resolve(), { once: true }),
            );
          }
          return result;
        },
      });
    });
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-digest-paused', 'true');
    await page.getByRole('button', { name: '取消读取', exact: true }).click();
    await expect(page.locator('.review-statistics')).toHaveCount(0);
    await page.getByLabel('币种筛选', { exact: true }).fill('SOLUSDT');
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.locator('.review-statistics')).toContainText('净盈亏有效 1 笔');
    await page.evaluate(() => window.dispatchEvent(new Event('release-statistics-digest')));
    await expect(page.locator('.review-statistics')).toContainText('全范围 4 笔');
    await expect(page.locator('.review-page__record')).toHaveCount(4);
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event('release-statistics-digest')));
    await app.close();
  }
});
