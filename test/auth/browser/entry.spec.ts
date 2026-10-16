import { test, expect, type Page } from '@playwright/test';
import { login } from './login.ts';
import { users } from '../runtime.ts';
test.beforeEach(async ({ request }) => {
  for (const user of ['alice', 'bob'])
    expect(
      (
        await request.post('http://127.0.0.1:4182/entry-scenario', {
          data: { user, scenario: 'flat' },
        })
      ).ok(),
    ).toBe(true);
});
async function connect(page: Page, name = 'alice') {
  await page.goto('/dashboard/connections');
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
  await page.getByLabel('API Key', { exact: true }).fill(`synthetic-key-${name}`);
  await page.getByLabel('API Secret', { exact: true }).fill(`synthetic-secret-${name}`);
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/binding') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '验证并保存' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('button', { name: '验证并保存' })).toBeEnabled();
}

async function fillPlan(page: Page) {
  await page.getByLabel('合约', { exact: true }).selectOption('BTCUSDT');
  await page.getByLabel('方向', { exact: true }).selectOption('long');
  await page.getByLabel('亏损预算', { exact: true }).fill('20');
  await page.getByLabel('止损方式', { exact: true }).selectOption('price');
  await page.getByLabel('止损值', { exact: true }).fill('98');
  await page.getByLabel('杠杆倍数').fill('10');
  await page.getByLabel('滑点预留（%）').fill('1');
  await page.getByLabel('资金费预留（USDT）').fill('1');
  await page.getByLabel('最低强平缓冲（%）').fill('1');
  await page.getByLabel('本单资金上限（USDT）').fill('5');
}
test('single market entry previews, saves and copies a fixed card, then conservatively invalidates it', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await expect(page.getByRole('heading', { name: '开仓与止损' })).toBeVisible();
  await fillPlan(page);
  await expect(page.getByText('草稿数量：')).toBeVisible();
  const button = page.getByRole('button', { name: '刷新并生成开仓卡' });
  await expect(button).toBeEnabled();
  await button.click();
  const card = page.getByRole('region', { name: '本次开仓卡' });
  await expect(card).toBeVisible();
  await expect(card.getByText('0.4 BTC', { exact: true })).toBeVisible();
  await expect(card.getByText('98 USDT', { exact: true })).toBeVisible();
  await expect(card.getByText('模拟开仓卡 · 不可用于真实交易。')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await card.getByRole('button', { name: '复制数量' }).click();
  expect(await page.locator('html').getAttribute('data-copied')).toBe('0.4');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('entry-card-phone.png'), fullPage: true });
  await page.getByLabel('亏损预算', { exact: true }).fill('21');
  await expect(card.getByRole('button', { name: '复制数量' })).toBeDisabled();
  await expect(card.getByText('固定预算：20 USDT')).toBeVisible();
  // Ticket 07 records predate the optional limit field.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith('entry-current:'))!;
    const record = JSON.parse(localStorage.getItem(key)!);
    delete record.input.limitPrice;
    delete record.input.nearStopMode;
    delete record.input.nearStop;
    delete record.input.nearPercent;
    localStorage.setItem(key, JSON.stringify(record));
  });
  await page.reload();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('21');
  await expect(card.getByText('固定预算：20 USDT')).toBeVisible();
  await expect(card.getByRole('button', { name: '复制数量' })).toBeDisabled();
  await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('20');
  await expect(page.getByRole('region', { name: '成交与止损核验' })).toContainText('尚未成交');
  await expect(card.getByRole('button', { name: '复制数量' })).toBeEnabled();
});

for (const entryType of ['MARKET', 'LIMIT']) {
  test(`two-level ${entryType} keeps its fixed card through near exits, recovery and edits`, async ({
    page,
    request,
  }) => {
    await login(page);
    await connect(page);
    await page.goto('/entry');
    await fillPlan(page);
    await page.getByLabel('止损层数').selectOption('two');
    await expect(page.getByLabel('近端比例（%）')).toHaveValue('70');
    await expect(page.getByLabel('近端止损值', { exact: true })).toHaveValue('');
    await page.getByLabel('近端止损方式').selectOption('price');
    await page.getByLabel('近端止损值', { exact: true }).fill('99');
    await page.getByLabel('入场方式').selectOption(entryType);
    if (entryType === 'LIMIT') await page.getByLabel('限价委托价（USDT）').fill('100');
    await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
    const card = page.getByRole('region', { name: '本次开仓卡' });
    const checked = page.getByRole('region', { name: '成交与止损核验' });
    await expect(
      card.getByText(`${entryType === 'MARKET' ? '0.4' : '0.495'} BTC`, { exact: true }),
    ).toBeVisible();
    await expect(card).toContainText('近端部分退出');
    await expect(card).toContainText('最终整仓退出');
    await expect(card.getByText('99 USDT', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copied = text;
          },
        },
      });
    });
    await card.getByRole('button', { name: '复制近端数量' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute(
      'data-copied',
      entryType === 'MARKET' ? '0.2' : '0.3',
    );
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    async function scenario(value: string) {
      expect(
        (
          await request.post('http://127.0.0.1:4182/entry-scenario', {
            data: {
              user: 'alice',
              scenario: `two-${entryType === 'LIMIT' ? 'limit-' : ''}${value}`,
            },
          })
        ).ok(),
      ).toBe(true);
      await card.getByRole('button', { name: '重新查询原方案' }).click();
    }
    await scenario('protected');
    await expect(checked).toContainText('查询时点核验通过');
    await expect(checked).toContainText('有效待触发');
    await scenario('near-filled');
    await expect(checked).toContainText('查询时点核验通过');
    await expect(checked).toContainText('已执行');
    await expect(checked).toContainText('0.0598 USDT');
    await expect(checked).toContainText('1.875204 USDT');
    await expect(card).toContainText('固定预算：20 USDT');
    await page.reload();
    await expect(checked).toContainText('查询时点核验通过');
    await expect(page.getByLabel('近端止损值', { exact: true })).toHaveValue('99');
    for (const [key, value] of [
      ['近端比例（%）', '60'],
      ['近端止损值', '98.9'],
    ] as const) {
      await page.getByLabel(key, { exact: true }).fill(value);
      await expect(checked).toHaveCount(0);
      await expect(card.getByRole('button', { name: '复制近端数量' })).toBeDisabled();
      await page.reload();
      await expect(page.getByLabel(key, { exact: true })).toHaveValue(value);
      await expect(checked).toHaveCount(0);
      await card.getByRole('button', { name: '恢复原方案输入并核验' }).click();
      await expect(checked).toContainText('查询时点核验通过');
    }
    await page.getByLabel('近端止损方式').selectOption('percent');
    await expect(checked).toHaveCount(0);
    await card.getByRole('button', { name: '恢复原方案输入并核验' }).click();
    await expect(checked).toContainText('查询时点核验通过');
    await scenario('partial-canceled');
    await expect(checked).toContainText('需要处理');
    await expect(checked).toContainText('近端计划仍待补齐');
    await scenario('partial-covered');
    await expect(checked).toContainText('查询时点核验通过');
    await expect(checked).toContainText('部分执行，剩余近端有效待触发');
    await scenario('near-canceled');
    await expect(checked).toContainText('需要处理');
    await scenario('final-canceled');
    await expect(checked).toContainText('需要处理');
    await scenario('missing-pnl');
    await expect(checked).toContainText('无法完整核验');
    await expect(checked).not.toContainText('查询时点核验通过');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: test.info().outputPath(`two-level-${entryType}-phone.png`),
      fullPage: true,
    });
  });
}

test('failed generation, offline state and a late response cannot enable a card', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  const generate = page.getByRole('button', { name: '刷新并生成开仓卡' });
  await expect(generate).toBeEnabled();
  await page.route('**/entry/plans', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '方案保存失败' }),
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4180' },
    }),
  );
  await generate.click();
  await expect(page.getByRole('region', { name: '开仓计划' }).getByRole('alert')).toHaveText(
    '方案保存失败',
  );
  await expect(page.getByRole('region', { name: '本次开仓卡' })).toHaveCount(0);
  await page.unroute('**/entry/plans');
  await generate.click();
  const copy = page.getByRole('button', { name: '复制数量' });
  await expect(copy).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(copy).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByLabel('亏损预算', { exact: true }).fill('21');
  await expect(generate).toBeEnabled();
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/entry/plans', async (route) => {
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await generate.click();
    await seen;
    await page.getByLabel('亏损预算', { exact: true }).fill('23');
    release();
    await expect(copy).toBeDisabled();
    await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  } finally {
    release();
  }
});

test('account changes withdraw old estimates and an older summary cannot revoke a freshly saved card', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  const draft = page.getByText('草稿数量：');
  const generate = page.getByRole('button', { name: '刷新并生成开仓卡' });
  await expect(draft).toBeVisible();
  await expect(generate).toBeEnabled();
  await page.route('**/account/summary', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.equity = '976.09999999';
    value.walletBalance = '1001.10000001';
    value.queriedAt = new Date().toISOString();
    await route.fulfill({ response, json: value });
  });
  await expect(draft).not.toBeVisible();
  await expect(generate).toBeDisabled();
  await page.unroute('**/account/summary');
  await expect(generate).toBeEnabled();
  // Keep the pre-generation summary frozen while a newer strict snapshot produces the card.
  const summaryResponse = await page.waitForResponse((response) =>
    response.url().endsWith('/account/summary'),
  );
  const oldSummary = await summaryResponse.json();
  await page.route('**/account/summary', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: oldSummary,
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4180' },
    }),
  );
  await page.route('**/entry/plans', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.plan.account.equity = '976.09999999';
    value.plan.account.walletBalance = '1001.10000001';
    value.plan.account.queriedAt = value.plan.accountTime = new Date().toISOString();
    await route.fulfill({ response, json: value });
  });
  await generate.click();
  const copy = page.getByRole('button', { name: '复制数量' });
  await expect(copy).toBeEnabled();
  await page.unroute('**/account/summary');
  await expect(copy).toBeDisabled();
});

test('filled plans recover only after a fresh check and revoke approval on edits, offline, query failure and hiding', async ({
  page,
  request,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  await expect(page.getByRole('region', { name: '本次开仓卡' })).toBeVisible();
  await request.post('http://127.0.0.1:4182/entry-scenario', {
    data: { user: 'alice', scenario: 'protected' },
  });
  await page.getByRole('button', { name: '重新查询原方案', exact: true }).click();
  const approved = page.getByText('查询时点核验通过', { exact: true });
  await expect(approved).toBeVisible();
  await expect(
    page.getByRole('region', { name: '开仓计划', exact: true }).getByRole('alert'),
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: '成交与止损核验' })).toContainText('0.04 USDT');
  await expect(page.getByRole('button', { name: '复制数量' })).toBeDisabled();
  await page.getByLabel('亏损预算', { exact: true }).fill('999');
  await expect(approved).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('999');
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  await expect(approved).toHaveCount(0);
  await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
  await expect(approved).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(approved).toHaveCount(0);
  await page.route('**/entry/plans/*/verify', (route) =>
    route.fulfill({
      status: 503,
      json: { error: '合成查询失败' },
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4180' },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('合成查询失败', { exact: true })).toBeVisible();
  await expect(approved).toHaveCount(0);
  await page.unroute('**/entry/plans/*/verify');
  await page.getByRole('button', { name: '重新查询原方案', exact: true }).click();
  await expect(approved).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(approved).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(approved).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('entry-verification.png'), fullPage: true });
  const records = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(records).not.toMatch(
    /verified|synthetic-key|synthetic-secret|reviewEvidence|sealedCredential/,
  );
});

test('corrupt or unwritable browser storage is explicit and cannot silently replace the current trade', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((key) => key.startsWith('entry-current:'))!,
  );
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), key);
  await page.reload();
  await expect(
    page.getByText('本浏览器记录损坏，未覆盖原记录。可明确清除本单记录后重新开始。'),
  ).toBeVisible();
  await fillPlan(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('{broken');
  await page.getByRole('button', { name: '开始新一单 / 清除本浏览器记录' }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error('synthetic quota');
    };
  });
  await fillPlan(page);
  await expect(
    page.getByText('本浏览器保存失败；刷新或离开可能无法继续本单。原方案仍保留在服务端。'),
  ).toBeVisible();
});

test('logout clears all visible trade state and another user cannot restore this browser record', async ({
  page,
  context,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/dashboard');
  await other.getByRole('button', { name: '退出登录' }).click();
  await expect(other).toHaveURL('/login');
  await other.close();
  await expect(page).toHaveURL('/login');
  await expect(page.getByText('固定预算：20 USDT')).toHaveCount(0);
  await login(page, users[1]!);
  await connect(page, 'bob');
  await page.goto('/entry');
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('');
  await expect(page.getByRole('region', { name: '本次开仓卡' })).toHaveCount(0);
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/login');
  await login(page);
  await page.goto('/entry');
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  await expect(page.getByRole('region', { name: '成交与止损核验' })).toContainText('尚未成交');
});

test('failed recovery preserves the plan ID through edits and reconnect retries interrupted recovery', async ({
  page,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  const before = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith('entry-current:'))!;
    return { key, record: JSON.parse(localStorage.getItem(key)!) as { planId: string } };
  });
  await page.route('**/entry/plans/*', (route) =>
    route.fulfill({
      status: 503,
      json: { error: '合成恢复失败' },
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4180' },
    }),
  );
  await page.reload();
  await expect(page.getByText('本单恢复失败：合成恢复失败')).toBeVisible();
  await page.getByLabel('亏损预算', { exact: true }).fill('21');
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).planId, before.key),
  ).toBe(before.record.planId);
  let finishGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => {
    finishGeneration = resolve;
  });
  await page.route('**/entry/plans', async (route) => {
    await generationGate;
    await route.fulfill({
      status: 503,
      json: { error: '合成生成失败' },
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4180' },
    });
  });
  try {
    await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
    await expect(page.getByRole('button', { name: '重试恢复本单' })).toBeDisabled();
    finishGeneration();
    await expect(page.getByRole('button', { name: '重试恢复本单' })).toBeEnabled();
  } finally {
    finishGeneration();
  }
  await page.unroute('**/entry/plans');
  await page.unroute('**/entry/plans/*');
  await page.getByRole('button', { name: '重试恢复本单' }).click();
  await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('21');
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/entry/plans/*', async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.reload();
    await seen;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    release();
    await expect(page.getByText('固定预算：20 USDT')).toBeVisible();
    await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('21');
    await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
    await expect(page.getByRole('region', { name: '成交与止损核验' })).toContainText('尚未成交');
  } finally {
    release();
  }
});

test('GTC partial fills keep the fixed card and require manual remainder cancellation before approval', async ({
  page,
  request,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByLabel('入场方式').selectOption('LIMIT');
  await page.getByLabel('限价委托价（USDT）').fill('100');
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  const card = page.getByRole('region', { name: '本次开仓卡' });
  const check = page.getByRole('region', { name: '成交与止损核验' });
  await expect(card).toContainText('普通限价 · GTC');
  await expect(card.getByText('0.495 BTC', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '复制限价' })).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await card.getByRole('button', { name: '复制限价' }).focus();
  await page.keyboard.press('Enter');
  expect(await page.locator('html').getAttribute('data-copied')).toBe('100');
  await page.reload();
  await expect(page.getByLabel('限价委托价（USDT）')).toHaveValue('100');
  await expect(check).toContainText('尚未成交');
  for (const [scenario, state, quantity] of [
    ['limit-waiting', '尚未成交', '0'],
    ['limit-partial', '需要处理', '0.1'],
    ['limit-partial-more', '需要处理', '0.4'],
    ['limit-canceled', '查询时点核验通过', '0.4'],
  ]) {
    expect(
      (
        await request.post('http://127.0.0.1:4182/entry-scenario', {
          data: { user: 'alice', scenario },
        })
      ).ok(),
    ).toBe(true);
    await page.getByRole('button', { name: '重新查询原方案' }).click();
    await expect(check.getByRole('status')).toHaveText(state!);
    if (quantity !== '0')
      await expect(check.getByText(`${quantity} BTC`, { exact: true })).toBeVisible();
    await expect(card.getByText('0.495 BTC', { exact: true })).toBeVisible();
    await expect(card).toContainText('固定预算：20 USDT');
    if (scenario?.startsWith('limit-partial')) {
      await expect(check).toContainText('请先在 Binance 撤销');
      await expect(card.getByRole('button', { name: '复制限价' })).toBeDisabled();
    }
  }
  await expect(check).toContainText('0.04 USDT');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath('limit-partial-phone.png'),
    fullPage: true,
  });
  await page.getByLabel('限价委托价（USDT）').fill('99.9');
  await expect(check).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('限价委托价（USDT）')).toHaveValue('99.9');
  await expect(check).toHaveCount(0);
  await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
  await expect(page.getByLabel('限价委托价（USDT）')).toHaveValue('100');
  await expect(check).toContainText('查询时点核验通过');
  await page.getByLabel('入场方式').selectOption('MARKET');
  await expect(page.getByLabel('限价委托价（USDT）')).toHaveCount(0);
  await expect(check).toHaveCount(0);
});

test('changing a limit rejects late verification, and offline or failed queries revoke approval', async ({
  page,
  request,
}) => {
  await login(page);
  await connect(page);
  await page.goto('/entry');
  await fillPlan(page);
  await page.getByLabel('入场方式').selectOption('LIMIT');
  await page.getByLabel('限价委托价（USDT）').fill('100');
  await page.getByRole('button', { name: '刷新并生成开仓卡' }).click();
  await expect(page.getByRole('button', { name: '复制限价' })).toBeEnabled();
  await request.post('http://127.0.0.1:4182/entry-scenario', {
    data: { user: 'alice', scenario: 'limit-canceled' },
  });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route('**/entry/plans/*/verify', async (route) => {
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  const check = page.getByRole('region', { name: '成交与止损核验' });
  try {
    await page.getByRole('button', { name: '重新查询原方案' }).click();
    await seen;
    await page.getByLabel('限价委托价（USDT）').fill('99.9');
    release();
    await expect(check).toHaveCount(0);
    await expect(page.getByRole('button', { name: '复制限价' })).toBeDisabled();
  } finally {
    release();
  }
  await page.unroute('**/entry/plans/*/verify');
  await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
  await expect(check).toContainText('查询时点核验通过');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(check).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(check).toContainText('查询时点核验通过');
  await request.post('http://127.0.0.1:4182/entry-scenario', {
    data: { user: 'alice', scenario: 'failed' },
  });
  await page.getByRole('button', { name: '重新查询原方案' }).click();
  await expect(page.getByRole('region', { name: '开仓计划' }).getByRole('alert')).toBeVisible();
  await expect(check).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制限价' })).toBeDisabled();
});
