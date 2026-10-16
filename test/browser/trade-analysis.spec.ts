import { test, expect } from '@playwright/test';

test('analysis is explicit, reports are text, and leaving the detail preserves the task', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
  let starts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/analysis')) starts++;
  });
  await page.goto('/review/trades/BTCUSDT-demo-fill-1');
  const analysis = page.getByRole('region', { name: '单笔模型复盘' });
  await expect(analysis).toBeVisible();
  await expect(analysis.getByRole('checkbox', { name: '发送已保存笔记' })).not.toBeChecked();
  expect(starts).toBe(0);
  await analysis.getByRole('button', { name: '发起分析 / 复用报告', exact: true }).click();
  await expect(analysis.getByText('完整报告', { exact: true }).first()).toBeVisible();
  await expect(
    analysis.getByText('DeepSeek · deepseek-v4-pro。发起分析可能产生费用。'),
  ).toBeVisible();
  const details = analysis.getByText('完整覆盖清单、分段结果与返回用量', { exact: true }).first();
  await expect(analysis.getByText(/UTF-8/)).toHaveCount(0);
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(analysis.getByText(/UTF-8/)).toBeVisible();
  await expect(analysis.getByText(/deepseek-v4-pro · high/)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(analysis.getByText(/UTF-8/)).toHaveCount(0);
  await expect(
    analysis.getByText('用量未知，可能产生费用', { exact: false }).first(),
  ).toBeVisible();
  expect(starts).toBe(1);
  await page.goto('/review?view=cycles');
  await page.goto('/review/trades/BTCUSDT-demo-fill-1');
  await expect(analysis.getByText('完整报告', { exact: true }).first()).toBeVisible();
  expect(starts).toBe(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await analysis.screenshot({ path: test.info().outputPath(`analysis-${width}.png`) });
  }
});

test('cancel and continue require explicit clicks; model text is escaped and invalid references are rejected', async ({
  page,
}) => {
  await page.goto('/review?view=cycles');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
  const endpoint = '/api/review/trades/BTCUSDT-demo-fill-1/analysis';
  await page.request.post(endpoint, {
    data: { includeNotes: false, regenerate: true, query: '' },
    headers: { Origin: new URL(page.url()).origin },
  });
  await expect
    .poll(async () => (await (await page.request.get(endpoint)).json()).tasks[0].status)
    .toBe('complete');
  const payload = await (await page.request.get(endpoint)).json();
  const complete = payload.tasks[0];
  complete.report.observations[0].text = '<script>window.analysisExecuted=true</script>';
  complete.requests.at(-1).report = complete.report;
  const pending = structuredClone(complete);
  pending.status = 'running';
  pending.report = null;
  pending.requests.at(-1).status = 'running';
  pending.requests.at(-1).report = null;
  let task = pending;
  let actions = 0;
  let invalid = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      actions++;
      if (input.action === 'cancel') task = { ...pending, status: 'cancelled' };
      if (input.action === 'continue') task = complete;
      await route.fulfill({ json: task });
      return;
    }
    const current = structuredClone(task);
    if (invalid && current.report) {
      current.report.observations[0].refs = ['unknown'];
      current.requests.at(-1).report = current.report;
    }
    await route.fulfill({ json: { ...payload, tasks: [current] } });
  });
  await page.goto('/review/trades/BTCUSDT-demo-fill-1');
  const analysis = page.getByRole('region', { name: '单笔模型复盘' });
  await expect(analysis.getByText('后台分析中', { exact: true })).toBeVisible();
  expect(actions).toBe(0);
  await analysis.getByRole('button', { name: '取消后台任务' }).click();
  await expect(analysis.getByText('未完成 · 已取消', { exact: true })).toBeVisible();
  await analysis.getByRole('button', { name: '继续（原证据与已完成分段）' }).click();
  await expect(
    analysis.getByText('<script>window.analysisExecuted=true</script>', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => 'analysisExecuted' in window)).toBe(false);
  invalid = true;
  await analysis.getByRole('button', { name: '重新读取任务' }).click();
  await expect(analysis).toContainText('不支持的证据引用');
  await expect(
    analysis.getByRole('button', { name: '发起分析 / 复用报告', exact: true }),
  ).toBeDisabled();
  expect(actions).toBe(2);
});
