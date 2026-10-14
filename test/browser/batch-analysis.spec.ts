import { test, expect } from '@playwright/test';

test('list batch analysis is explicit, freezes its range and preserves old reports across filters and reloads', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/review?view=cycles&symbol=BTCUSDT');
  const analysis = page.getByRole('region', { name: '筛选范围模型复盘' });
  let starts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/review/analysis')) starts++;
  });
  await expect(analysis).toBeVisible();
  await expect(analysis.getByRole('checkbox', { name: '发送已保存笔记' })).not.toBeChecked();
  expect(starts).toBe(0);
  await analysis.getByRole('button', { name: '发起分析 / 复用报告', exact: true }).click();
  await expect(analysis.getByText('完整报告', { exact: true }).first()).toBeVisible();
  const details = analysis.getByText('完整覆盖清单、分段结果与返回用量', { exact: true }).first();
  const explanation = analysis.getByText(/本报告基于已完成分段结果综合/).first();
  await expect(explanation).toBeHidden();
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(explanation).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(explanation).toBeHidden();
  await expect(analysis).toContainText('选择范围 1 笔');
  await page.goto('/review?view=cycles&symbol=ETHUSDT');
  await expect(analysis).toContainText('BTCUSDT');
  await expect(
    analysis.getByRole('button', { name: '发起分析 / 复用报告', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(analysis.getByText('完整报告', { exact: true }).first()).toBeVisible();
  expect(starts).toBe(1);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await analysis.screenshot({ path: test.info().outputPath(`batch-analysis-${width}.png`) });
  }
});

test('over 100 selected trades blocks a new analysis independently of the visible page size', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  const list = await (await page.request.get('/api/review/trades')).json();
  const { withStatistics } = await import('./review-statistics-fixtures.ts');
  const trades = Array.from({ length: 101 }, (_, index) => ({
    ...list.trades[0],
    id: `batch-${index}`,
  }));
  await page.route(new RegExp('/api/review/trades(?:[?]|$)'), (route) =>
    route.fulfill({
      json: withStatistics(
        { ...list, total: 101, page: 2, nextPage: 3, trades: trades.slice(20, 40) },
        trades,
      ),
    }),
  );
  await page.goto('/review?view=cycles&page=2');
  const analysis = page.getByRole('region', { name: '筛选范围模型复盘' });
  await expect(page.locator('.review-table tbody tr[data-row-key]')).toHaveCount(20);
  await expect(analysis).toContainText('当前范围超过 100 笔，请缩小筛选范围');
  await expect(
    analysis.getByRole('button', { name: '发起分析 / 复用报告', exact: true }),
  ).toBeDisabled();
});

test('a model style suggestion stays separate until the user saves a personal tag in the trade detail', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  const endpoint = '/api/review/analysis';
  await page.request.post(endpoint, {
    data: { includeNotes: false, regenerate: true, query: 'symbol=BTCUSDT' },
    headers: { Origin: new URL(page.url()).origin },
  });
  await expect
    .poll(async () => (await (await page.request.get(endpoint)).json()).tasks[0].status)
    .toBe('complete');
  const payload = await (await page.request.get(endpoint)).json();
  const task = payload.tasks[0];
  const name = `模型待确认-${test.info().project.name}`;
  const tradeId = 'BTCUSDT-demo-fill-1';
  const evidence = task.requests[0];
  const ref = evidence.records.find((row: { tradeId: string }) => row.tradeId === tradeId).id;
  evidence.report.styleSuggestions = [{ tradeId, name, refs: [ref] }];
  task.report.styleSuggestions = [{ tradeId, name, refs: [`${evidence.id}/styleSuggestions/0`] }];
  task.requests.at(-1).report = task.report;
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({ json: { ...payload, tasks: [task] } }),
  );
  await page.goto('/review?view=cycles&symbol=BTCUSDT');
  const analysis = page.getByRole('region', { name: '筛选范围模型复盘' });
  await expect(analysis.getByRole('region', { name: '风格推测' })).toContainText(name);
  let journal = await (await page.request.get('/api/review/journal')).json();
  expect(journal.tags.some((tag: { name: string }) => tag.name === name)).toBe(false);
  await analysis.getByRole('link', { name: '进入交易详情确认标签' }).click();
  await expect(page).toHaveURL(/review\/trades\/BTCUSDT-demo-fill-1\?view=cycles&symbol=BTCUSDT/);
  await page.getByText('维护交易风格标签', { exact: true }).click();
  await page.getByLabel('新标签名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(page.locator('#note-status')).toContainText('笔记已保存');
  journal = await (await page.request.get('/api/review/journal')).json();
  const tag = journal.tags.find((tag: { name: string }) => tag.name === name);
  expect(
    journal.notes.some(
      (note: { trade: { id: string }; tagIds: string[] }) =>
        note.trade.id === tradeId && note.tagIds.includes(tag.id),
    ),
  ).toBe(true);
});
