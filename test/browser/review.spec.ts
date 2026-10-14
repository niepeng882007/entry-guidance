import { defaultReviewFilters } from '../../src/review-filters.ts';
import { navigate } from './navigation';
import { test, expect } from '@playwright/test';
const emptyRange = {
  filters: defaultReviewFilters(),
  total: 0,
  page: 1,
  pageSize: 20,
  nextPage: null,
  options: { symbols: [], tags: [] },
};

test('a user opens one archived trade and expands linked orders, fills and PnL', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await navigate(page, '交易记录分析');
  await expect(page).toHaveURL('/review');
  await expect(page.getByRole('heading', { name: '交易记录分析', exact: true })).toBeVisible();
  await expect(page.getByText('模拟数据 · 仅用于界面与流程验证')).toBeVisible();
  await expect(page.getByText('1 笔归档交易', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await expect(page.locator('#trade-detail')).toBeFocused();
  await expect(page.locator('#review-net-pnl')).toHaveText('12.4735 USDT');
  await expect(page.getByText('13 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('0.6065 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('0.08 USDT', { exact: true })).toBeVisible();
  const orders = page.getByText('订单证据 · 3 张', { exact: true });
  await orders.focus();
  await page.keyboard.press('Enter');
  await expect(orders).toBeFocused();
  await expect(page.locator('.review-order')).toHaveCount(3);
  await expect(page.locator('.review-order').last()).toContainText('未知');
  await page.getByText('逐笔成交 · 4 条', { exact: true }).click();
  await expect(page.locator('.review-fill')).toHaveCount(4);
  await expect(page.locator('.review-fill').first()).toContainText('demo-order-1');
  await expect(page.locator('.review-fill').first()).toContainText('0.004 BTC');
  await page.getByText('资金费流水 · 2 条', { exact: true }).click();
  await expect(page.getByText('0.12 USDT', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('-0.04 USDT', { exact: true })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`review-${width}.png`), fullPage: true });
  }
  await navigate(page, '账户快照');
  await navigate(page, '交易记录分析');
  await expect(page.getByText('1 笔归档交易', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.goto('/review');
  await expect(page).toHaveURL('/login');
});

test('clearing the current plan leaves archived trades available after relogin', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await page.locator('#symbol-trigger').click();
  await page
    .locator('#symbol-options')
    .getByRole('option', { name: 'BTCUSDT', exact: true })
    .click();
  await page.locator('#side-trigger').click();
  await page.locator('#side-options').getByRole('option', { name: '做多', exact: true }).click();
  for (const [id, value] of Object.entries({
    budget: '10',
    stop: '2',
    leverage: '5',
    slippage: '0.1',
    'minimum-buffer': '1',
  })) {
    await page.locator(`#${id}`).fill(value);
  }
  await page.locator('#generate').click();
  await expect(page.locator('#entry-card')).toHaveAttribute('data-current', 'true');
  await navigate(page, '交易记录分析');
  await expect(page.getByText('1 笔归档交易', { exact: true })).toBeVisible();
  await navigate(page, '开仓卡');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#clear-trade').click();
  await expect(page.locator('#recovery-status')).toContainText('已清除本单');
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await navigate(page, '交易记录分析');
  await expect(page.getByText('1 笔归档交易', { exact: true })).toBeVisible();
});

test('review handles expired login, failed reads and invalid source without showing a confirmed result', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({
      json: { source: 'binance', accountId: 'wrong', syncStatus: 'demo', trades: [] },
    }),
  );
  await page.goto('/review');
  await expect(page.locator('#review-status')).toContainText('来源或同步状态无效');
  await expect(page.getByRole('button', { name: '查看 BTCUSDT 交易详情' })).toHaveCount(0);
  await page.unroute('**/api/review/trades');
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({ status: 503, json: { error: '受控失败' } }),
  );
  await page.getByRole('button', { name: '重新读取' }).click();
  await expect(page.locator('#review-status')).toContainText('读取失败');
  await page.unroute('**/api/review/trades');
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({ status: 401, json: { error: '过期' } }),
  );
  await page.getByRole('button', { name: '重新读取' }).click();
  await expect(page.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新读取' })).toBeDisabled();
});

test('leaving review cancels a pending detail and rejects its late response', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await page.goto('/review');
  await expect(page.getByText('1 笔归档交易', { exact: true })).toBeVisible();
  let release!: () => void;
  await page.route('**/api/review/trades/*', async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#review-status')).toContainText('页面已离开');
  await expect(page.locator('#trade-detail')).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.locator('#review-status')).toContainText('演示归档');
  await expect(page.getByRole('button', { name: '查看 BTCUSDT 交易详情' })).toBeEnabled();
});

test('the real-mode page clearly displays an unsynced empty ledger', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  // The backend real-mode contract is independently verified by the HTTP tests.
  await page.route('**/review', async (route) => {
    const response = await route.fetch();
    const html = (await response.text())
      .replace('data-mode="demo"', 'data-mode="binance"')
      .replace('模拟数据 · 仅用于界面与流程验证', '真实模式 · 数据由 Binance 只读接口查询');
    await route.fulfill({ response, body: html });
  });
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({
      json: {
        ...emptyRange,
        source: 'binance',
        accountId: null,
        syncStatus: 'not-synced',
        trades: [],
      },
    }),
  );
  await page.goto('/review');
  await expect(page.locator('#review-status')).toContainText('尚未同步 · 无真实交易归档');
  await expect(page.getByText('0 笔归档交易', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看 BTCUSDT 交易详情' })).toHaveCount(0);
  await expect(page.getByText('模拟数据 · 仅用于界面与流程验证')).toHaveCount(0);
});

test('real history sync shows progress, gaps and retry without claiming old results are current', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await page.route('**/review', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text())
        .replace('data-mode="demo"', 'data-mode="binance"')
        .replace('模拟数据 · 仅用于界面与流程验证', '真实模式 · 数据由 Binance 只读接口查询'),
    });
  });
  await page.route('**/api/symbols', (route) =>
    route.fulfill({ json: { source: 'binance', symbols: ['BTCUSDT', 'ETHUSDT'] } }),
  );
  const range = {
    source: 'history',
    startTime: Date.parse('2026-10-01'),
    endTime: Date.parse('2026-10-07'),
    page: 1,
  };
  const sync = {
    symbol: 'BTCUSDT',
    startTime: range.startTime,
    endTime: range.endTime,
    status: 'running',
    pages: 1,
    records: 2,
    pending: [range],
    completed: [],
    missing: [],
    lastSuccessAt: null,
  };
  let started = false;
  let failed = true;
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({
      json: started
        ? {
            ...emptyRange,
            source: 'binance',
            accountId: '12345',
            syncStatus: 'synced',
            trades: [],
            sync: {
              ...sync,
              status: failed ? 'failed' : 'complete',
              pending: failed ? [range] : [],
              missing: failed ? ['Binance 限流，请稍后再试。'] : [],
              lastSuccessAt: failed ? null : '2026-10-07T00:00:00Z',
            },
          }
        : {
            ...emptyRange,
            source: 'binance',
            accountId: null,
            syncStatus: 'not-synced',
            trades: [],
          },
    }),
  );
  await page.route('**/api/review/sync', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ symbol: 'BTCUSDT' });
    started = true;
    await route.fulfill({ status: 202, json: sync });
  });
  await page.goto('/review');
  await expect(page.getByLabel('USDT 永续合约')).toBeVisible();
  await page.getByRole('button', { name: '开始同步' }).click();
  await expect(page.locator('#review-status')).toContainText('正在同步真实历史');
  await expect(page.getByRole('button', { name: '开始同步' })).toBeDisabled();
  await expect(page.locator('#review-status')).toContainText('同步失败');
  await expect(page.getByText('同步缺口：Binance 限流，请稍后再试。')).toBeVisible();
  await page.getByText('待补查区间', { exact: true }).click();
  await expect(page.getByText(/history ·/)).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: '开始同步' }).click();
  await expect(page.locator('#review-status')).toContainText('历史读取结束');
  await expect(page.getByText('同步缺口：Binance 限流，请稍后再试。')).toHaveCount(0);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`history-sync-${width}.png`),
      fullPage: true,
    });
  }
  await page.route('**/api/review/sync', (route) =>
    route.fulfill({ status: 401, json: { error: '登录过期' } }),
  );
  await page.getByRole('button', { name: '开始同步' }).click();
  await expect(page.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始同步' })).toBeDisabled();
});

test('a late sync response after leaving the page cannot restore current progress', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await page.route('**/review', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('data-mode="demo"', 'data-mode="binance"'),
    });
  });
  await page.route('**/api/symbols', (route) => route.fulfill({ json: { symbols: ['BTCUSDT'] } }));
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({
      json: {
        ...emptyRange,
        source: 'binance',
        accountId: null,
        syncStatus: 'not-synced',
        trades: [],
      },
    }),
  );
  let release!: () => void;
  await page.route('**/api/review/sync', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 202,
      json: {
        symbol: 'BTCUSDT',
        startTime: Date.parse('2026-10-01'),
        endTime: Date.parse('2026-10-07'),
        status: 'running',
        pages: 0,
        records: 0,
        pending: [],
        completed: [],
        missing: [],
        lastSuccessAt: null,
      },
    });
  });
  await page.goto('/review');
  await page.getByRole('button', { name: '开始同步' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#review-status')).toContainText('页面已离开');
  await expect(page.getByText(/已读取 \d+ 页/)).toHaveCount(0);
});

test('complex trade detail shows mixed execution types, shared reversal evidence and dated open PnL', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  const list = await (await page.request.get('/api/review/trades')).json();
  const detail = await (await page.request.get(`/api/review/trades/${list.trades[0].id}`)).json();
  Object.assign(detail, {
    groupingVersion: 2,
    status: 'open',
    closedAt: null,
    netPnl: null,
    observedAt: '2026-10-10T13:00:00Z',
    unrealizedPnl: '7.25',
    unrealizedAt: '2026-10-10T13:00:01Z',
  });
  detail.evidence.endPosition = '0.002';
  detail.evidence.fills[0].event = 'entry';
  detail.evidence.fills[0].allocation = 'open';
  detail.evidence.fills[1].event = 'add';
  detail.evidence.fills[1].orderId = 'demo-order-4';
  detail.evidence.orders.push({ ...detail.evidence.orders[0], id: 'demo-order-4', type: 'MARKET' });
  detail.evidence.fills[2].event = 'reduce';
  detail.evidence.fills[3].event = 'reduce';
  detail.evidence.funding[0].attribution = 'ambiguous';
  detail.missing = ['资金费无法唯一归属'];
  detail.fundingNet = null;
  await page.route('**/api/review/trades', (route) =>
    route.fulfill({ json: { ...list, trades: [{ ...detail, entryType: 'mixed', tagIds: [] }] } }),
  );
  await page.route('**/api/review/trades/*', (route) => route.fulfill({ json: detail }));
  await page.goto('/review');
  await expect(
    page.locator('.review-page__record .tag').getByText('持仓中', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await expect(page.locator('#trade-detail')).toBeFocused();
  await expect(page.locator('#trade-detail')).toContainText('入场类型：混合（限价单、市价单）');
  await expect(page.locator('#trade-detail')).toContainText('退出类型：混合（市价单、未知）');
  await expect(page.locator('#trade-detail')).toContainText('查询时点浮动盈亏');
  await expect(page.locator('#trade-detail')).toContainText('7.25 USDT');
  await expect(page.locator('#trade-detail')).toContainText('12 小时 59 分钟');
  await expect(page.locator('#review-net-pnl')).toHaveText('待确认');
  await page.getByText('逐笔成交 · 4 条', { exact: true }).click();
  await expect(page.locator('.review-fill').first()).toContainText('反手开仓分配');
  await expect(page.locator('.review-fill').first()).toContainText('原始成交：demo-fill-1');
  await expect(page.locator('.review-fill').nth(1)).toContainText('加仓');
  await page.getByText('资金费流水 · 2 条', { exact: true }).click();
  await expect(page.locator('.review-funding').first()).toContainText('归属待确认');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`complex-review-${width}.png`),
      fullPage: true,
    });
  }
});
