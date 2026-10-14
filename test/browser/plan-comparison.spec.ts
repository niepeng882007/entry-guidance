import { test, expect, type Page } from '@playwright/test';
import type { ReviewTrade } from '../../src/review-ledger.ts';
import type { SavedPlan } from '../../src/server.ts';
import type { Verification } from '../../src/verification.ts';

async function comparisonFixture(page: Page, two = false) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  const response = await page.request.post('/api/plan', {
    data: {
      symbol: 'BTCUSDT',
      side: 'long',
      budgetMode: 'amount',
      budget: '10',
      stopMode: 'percent',
      stop: '2',
      slippage: '0.1',
      funding: '0',
      leverage: '5',
      minimumBuffer: '1',
      fundingCap: '',
      ...(two
        ? { stopLevels: 'two', nearStopMode: 'percent', nearStop: '1', nearPercent: '50' }
        : {}),
    },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  const plan: SavedPlan = await response.json();
  const check: Verification = await (
    await page.request.get(
      `/api/verification?planId=${plan.id}&demo=${two ? 'near-filled' : 'protected'}`,
    )
  ).json();
  const list = await (await page.request.get('/api/review/trades')).json();
  const detail: ReviewTrade = await (
    await page.request.get(`/api/review/trades/${list.trades[0].id}`)
  ).json();
  detail.realizedPnl = '-11.947';
  detail.netPnl = '-12.4735';
  detail.planComparison = {
    status: 'linked',
    reason: '账户、合约、方向、时间与开仓成交证据一致。',
    candidatePlanIds: [plan.id],
    plan,
    input: plan.input,
    verifications: [check],
    actualEntry: {
      quantity: plan.quantity,
      price: plan.referencePrice,
      firstAt: plan.startedAt,
      lastAt: check.queriedAt,
      types: ['MARKET'],
    },
    quantityDifference: '0',
    priceDifference: '0',
    entryTypeDeviation: false,
    confirmedLoss: '12.4735',
    budgetExcess: '2.4735',
    stopChecks: [{ queriedAt: check.queriedAt, deviations: [] }],
    limitations: [
      '核验仅代表查询时点；未记录期间的止损变化与覆盖保持未知，不能推导持续保护状态。',
      '实际亏损超预算与用户违反计划分别表达；滑点、行情缺口或亏损结果不能单独证明违规或操作动机。',
    ],
  };
  await page.route('**/api/review/trades/*', (route) => route.fulfill({ json: detail }));
  return { detail, plan, check };
}

for (const two of [false, true])
  test(`${two ? 'two-level partial exit' : 'single-level'} review shows a frozen plan and timestamped checks without inferring violations`, async ({
    page,
  }) => {
    const { plan, check } = await comparisonFixture(page, two);
    await page.route('**/market?interval=*', async (route) => {
      const response = await route.fetch();
      const chart = await response.json();
      chart.stops = [
        {
          id: `${plan.id}-final`,
          kind: 'plan',
          price: plan.stopPrice,
          time: Date.parse(plan.startedAt),
          basis: 'MARK_PRICE',
          label: '原计划最终止损',
        },
      ];
      if (plan.nearStop)
        chart.stops.push({
          id: `${plan.id}-near`,
          kind: 'plan',
          price: plan.nearStop.price,
          time: Date.parse(plan.startedAt),
          basis: 'MARK_PRICE',
          label: '原计划近端止损',
        });
      const observed = check.reviewEvidence!.stops[0]!;
      chart.stops.push({
        id: observed.id,
        kind: 'observed',
        price: observed.triggerPrice,
        time: Date.parse(check.queriedAt),
        basis: observed.workingType,
        label: '查询时点实际止损设置',
      });
      await route.fulfill({ json: chart });
    });
    await page.goto('/review');
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await page.locator('summary').filter({ hasText: '原方案与执行对照' }).click();
    await expect(page.locator('#review-plan-link')).toContainText('原方案：已关联');
    const chart = page.getByRole('region', { name: '行情与交易事件' });
    await expect(chart).toContainText('原计划最终止损');
    await expect(chart).toContainText('查询时点实际止损设置');
    await expect(chart).toContainText('标记价触发依据');
    await expect(chart).toContainText('不能推导持续保护');
    if (two) await expect(chart).toContainText('原计划近端止损');
    await expect(page.locator('#review-plan-budget')).toHaveText('10 USDT');
    await expect(page.locator('#review-plan-stop')).toContainText(plan.stopPrice);
    await expect(page.locator('#review-budget-excess')).toHaveText('12.4735 USDT / 2.4735 USDT');
    await expect(page.locator('#trade-detail')).toContainText('不能单独证明违规或操作动机');
    const summary = page.locator('.review-check summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.review-check')).toHaveAttribute('open', '');
    await expect(page.locator('.review-check')).toContainText(
      `查询时点剩余仓位 ${check.quantity} BTC`,
    );
    await expect(page.locator('.review-check')).toContainText('MARK_PRICE');
    if (two) {
      await expect(page.locator('#trade-detail')).toContainText('原近端止损 / 分配数量');
      await expect(page.locator('.review-check')).toContainText('近端状态 已执行');
    }
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: test.info().outputPath(`plan-comparison-${two ? 'two' : 'single'}-${width}.png`),
        fullPage: true,
      });
    }
  });

test('ambiguous plans retain actual records and explain why execution deviations cannot be judged', async ({
  page,
}) => {
  const { detail } = await comparisonFixture(page);
  detail.planComparison = {
    status: 'ambiguous',
    reason: '多个原方案命中相同成交证据，无法唯一关联。',
    candidatePlanIds: ['plan-a', 'plan-b'],
    plan: null,
    input: null,
    verifications: [],
    actualEntry: null,
    quantityDifference: null,
    priceDifference: null,
    entryTypeDeviation: null,
    confirmedLoss: null,
    budgetExcess: null,
    stopChecks: [],
    limitations: ['未唯一关联原方案，预算偏离、计划入场与止损偏离无法判断。'],
  };
  await page.goto('/review');
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await page.locator('summary').filter({ hasText: '原方案与执行对照' }).click();
  await expect(page.locator('#review-plan-link')).toContainText('关联歧义');
  await expect(page.locator('#review-net-pnl')).toHaveText('-12.4735 USDT');
  await expect(page.locator('#trade-detail')).toContainText('无法判断');
  await expect(page.locator('#review-plan-budget')).toHaveCount(0);
});

test('a plan from another account cannot appear as a confirmed comparison', async ({ page }) => {
  const { detail } = await comparisonFixture(page);
  detail.planComparison!.plan!.reviewAccountId = 'another-account';
  await page.goto('/review');
  await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
  await expect(page.locator('#review-status')).toContainText('原方案来源、账户或交易关联无效');
  await expect(page.locator('#trade-detail')).toHaveCount(0);
});
