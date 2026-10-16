import { test, expect, type Page } from '@playwright/test';
import { login } from './login.ts';
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
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
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
