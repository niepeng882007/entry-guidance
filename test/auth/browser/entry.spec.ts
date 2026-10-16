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
  await page.getByLabel('止损方式').selectOption('price');
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
  await expect(page.getByRole('heading', { name: '单层市价开仓' })).toBeVisible();
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
  await page.reload();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('21');
  await expect(card.getByText('固定预算：20 USDT')).toBeVisible();
  await expect(card.getByRole('button', { name: '复制数量' })).toBeDisabled();
  await page.getByRole('button', { name: '恢复原方案输入并核验' }).click();
  await expect(page.getByLabel('亏损预算', { exact: true })).toHaveValue('20');
  await expect(page.getByRole('region', { name: '成交与止损核验' })).toContainText('尚未成交');
  await expect(card.getByRole('button', { name: '复制数量' })).toBeEnabled();
});

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
