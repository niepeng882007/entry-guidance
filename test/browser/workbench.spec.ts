import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
  await page.goto('/entry');
  await expect(page.locator('#status')).toHaveText('模拟查询成功');
}

async function select(page: Page, id: string, label: string) {
  await page.locator(`#${id}-trigger`).click();
  await page.locator(`#${id}-options`).getByRole('option', { name: label, exact: true }).click();
}

async function fillPlan(page: Page) {
  await select(page, 'symbol', 'BTCUSDT');
  await expect(page.locator('#fee')).toContainText('模拟费率');
  await select(page, 'side', '做多');
  for (const [id, value] of Object.entries({
    budget: '10',
    stop: '2',
    leverage: '5',
    slippage: '0.1',
    'minimum-buffer': '1',
  })) {
    await page.locator(`#${id}`).fill(value);
  }
  await expect(page.locator('#draft-result')).toBeVisible();
}

async function generate(page: Page) {
  await page.locator('#generate').click();
  await expect(page.locator('#entry-card')).toHaveAttribute('data-current', 'true');
  await expect(page.locator('#entry-card')).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error;
  });
  await login(page);
});

test('entry card retains execution parameters and risk warnings with optional amount help', async ({
  page,
}) => {
  await fillPlan(page);
  await generate(page);
  const card = page.locator('#entry-card');
  await expect(card.getByText(/实际亏损可能超过预算/)).toBeVisible();
  await expect(page.locator('#card-instructions')).toContainText(
    '标记价触发、关闭价格保护、整仓退出',
  );
  await expect(card).not.toContainText('手动执行');
  const explanation = card.getByText('按入场参考价计算的仓位价值，不等于保证金。', { exact: true });
  await expect(explanation).toBeHidden();
  await card.getByLabel('开仓卡名义价值说明', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(explanation).toBeVisible();
});

test('review navigation stays current when its section cannot reach the activation line', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const link = (name: string) => page.locator('.module-nav__link', { hasText: name });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await page.locator('.module-nav').evaluate((node) => {
      (node as HTMLElement).style.minHeight = '300px';
    });
    await link('成交核验').click();
    await expect(link('成交核验')).toHaveAttribute('aria-current', 'location');
    await expect(link('开仓卡')).not.toHaveAttribute('aria-current', 'location');
    await link('开仓卡').click();
    await expect(link('开仓卡')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await expect(link('本次计划')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname + location.search);
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    });
    await expect(link('成交核验')).toHaveAttribute('aria-current', 'location');
  }
});

test('a nav click keeps its module current until the user takes over scrolling', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const link = (name: string) => page.locator('.module-nav__link', { hasText: name });
  await page.setViewportSize({ width: 1280, height: 800 });
  const traveling = await page.evaluate(() => {
    const currentHref = () =>
      document.querySelector('.module-nav__link[aria-current="location"]')?.getAttribute('href');
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.querySelector<HTMLAnchorElement>('.module-nav__link[href="#review-module"]')?.click();
    // A completion event from the previous scroll must not release this new destination.
    window.dispatchEvent(new Event('scrollend'));
    const during = {
      current: currentHref(),
      top: document.getElementById('review-module')?.getBoundingClientRect().top ?? 0,
    };
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true }));
    window.scrollTo({ top: 80, behavior: 'instant' });
    window.scrollTo({ top: 0, behavior: 'instant' });
    return { during, followed: currentHref(), y: window.scrollY };
  });
  expect(traveling.during.current).toBe('#review-module');
  expect(traveling.during.top).toBeGreaterThan(120);
  expect(traveling.followed).toBe('#plan-module');
  expect(traveling.y).toBe(0);

  await link('账户摘要').click();
  await expect(link('账户摘要')).toHaveAttribute('aria-current', 'location');
});

test('short mobile viewport follows scrolling when section navigation is not sticky', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 330 });
  const link = page.locator('.module-nav__link[href="#account-module"]');
  await expect(page.locator('.module-nav')).toHaveCSS('position', 'static');
  await page.evaluate(() =>
    document
      .getElementById('account-module')
      ?.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  await expect(link).toHaveAttribute('aria-current', 'location');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.module-nav__link[href="#plan-module"]')).toHaveAttribute(
    'aria-current',
    'location',
  );
});

test('navigation animates scrolling and selection, respecting reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const link = page.locator('.module-nav__link[href="#review-module"]');
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.locator('.module-nav__link[href="#plan-module"]')).toHaveAttribute(
      'aria-current',
      'location',
    );
    const animated = reducedMotion === 'no-preference';
    await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
    await expect(link).toHaveCSS('transition-duration', animated ? '0.22s, 0.22s, 0.12s' : '0s');
    const start = await link.evaluate((node) => {
      (node as HTMLAnchorElement).click();
      return { y: window.scrollY, current: node.getAttribute('aria-current') };
    });
    expect(start.current).toBe('location');
    if (animated) expect(start.y).toBe(0);
    else expect(start.y).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Math.abs(document.documentElement.scrollHeight - innerHeight - scrollY),
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(link).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#review-module')).toBeFocused();
  }
});

test('responsive layout, navigation, keyboard select and initial hidden states', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 375, 390, 414, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  for (const id of ['draft-result', 'entry-checks', 'entry-card', 'verification'])
    await expect(page.locator(`#${id}`)).toBeHidden();
  expect(
    await page
      .locator('[id]')
      .evaluateAll((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length),
  ).toBe(true);
  const links = page.locator('.module-nav__link');
  await expect(links).toHaveCount(6);
  await links.filter({ hasText: '止损模板' }).click();
  await expect(page.locator('#templates-module')).toHaveAttribute('open', '');
  await page.locator('#side-trigger').focus();
  await expect(page.locator('#side-trigger')).toBeFocused();
  await expect(page.locator('#side-trigger')).toBeInViewport();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#side')).toHaveValue('long');
  await expect(page.locator('#side-trigger')).toBeFocused();
});

test('editing invalidates the card, copy and verification; original inputs recover', async ({
  page,
}) => {
  await fillPlan(page);
  await generate(page);
  const budget = await page.locator('#card-budget').textContent();
  await page.locator('#budget').fill('12');
  await expect(page.locator('#entry-card')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('[data-copy="quantity"]')).toBeDisabled();
  await expect(page.locator('#verify')).toBeDisabled();
  await expect(page.locator('#card-budget')).toHaveText(budget!);
  await page.locator('#restore-inputs').click();
  await expect(page.locator('#budget')).toHaveValue('10');
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'needs-action');
  await select(page, 'demo-scenario', '全部成交，已补齐止损');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await expect(page.locator('[data-copy="quantity"]')).toBeDisabled();
});

test('leverage shows live liquidation estimates, unsafe buffers and missing data without stale prices', async ({
  page,
  context,
}) => {
  await fillPlan(page);
  const price = page.locator('#leverage-liquidation');
  const note = page.locator('#leverage-liquidation-note');
  await expect(price).toContainText('USDT（模拟）');
  const original = await price.textContent();
  await page.locator('#leverage').fill('10');
  await expect(price).toContainText('USDT（模拟）');
  await expect(price).not.toHaveText(original!);
  const updated = await price.textContent();
  await page.locator('#minimum-buffer').fill('99');
  await expect(price).toHaveText(updated!);
  await expect(note).toContainText('低于要求');
  await expect(page.locator('#entry-checks')).toBeHidden();
  await page.locator('#generate').click();
  await expect(page.locator('#entry-error')).toContainText('低于要求');
  await expect(page.locator('#entry-card')).toBeHidden();
  await page.locator('#refresh').click();
  await expect(price).toContainText('USDT');
  await page.locator('#minimum-buffer').fill('1');
  await page.locator('#leverage').fill('50');
  await expect(price).toContainText('USDT');
  await expect(note).toContainText('先强平、后止损');
  await select(page, 'side', '做空');
  await expect(price).toContainText('USDT');
  await expect(note).toContainText('先强平、后止损');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.locator('#budget').fill('');
  await expect(price).toHaveText('—');
  await expect(note).toContainText('亏损预算');
  await page.locator('#budget').fill('10');
  await expect(price).toContainText('USDT');
  await context.setOffline(true);
  await expect(price).toHaveText('—');
  await expect(note).toContainText('快照');
  await context.setOffline(false);
  await expect(price).toContainText('USDT');
  await select(page, 'symbol', '仅查看账户');
  await expect(price).toHaveText('—');
});

test('account snapshots use fixed three-second ticks, skip busy requests and cancel on leaving', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0;
  let release!: () => void;
  let hold = false;
  await page.route('**/api/account', async (route) => {
    const count = ++requests;
    const response = await route.fetch();
    const data = await response.json();
    data.walletBalance = data.equity = String(1250 + count);
    data.unrealizedProfit = '0';
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ json: data });
  });
  await page.reload();
  await expect(page.locator('#equity')).toHaveText('1251');
  await page.clock.runFor(2999);
  expect(requests).toBe(1);
  hold = true;
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(2);
  await expect.poll(() => typeof release).toBe('function');
  await page.clock.runFor(6500);
  expect(requests).toBe(2);
  hold = false;
  release();
  await expect(page.locator('#equity')).toHaveText('1252');
  await page.clock.runFor(2499);
  expect(requests).toBe(2);
  await page.clock.runFor(1);
  await expect(page.locator('#equity')).toHaveText('1253');
  hold = true;
  release = undefined!;
  await page.clock.runFor(3000);
  await expect.poll(() => requests).toBe(4);
  await expect.poll(() => typeof release).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#equity')).toHaveText('1253');
  await page.clock.runFor(12_000);
  expect(requests).toBe(4);
});

test('account polling does not accelerate market quotes or verification or change their results', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let accounts = 0;
  let markets = 0;
  let verifications = 0;
  let changeBalance = false;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/market') markets++;
    if (path === '/api/verification') verifications++;
  });
  await page.route('**/api/account', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (changeBalance) data.availableBalance = '1';
    await route.fulfill({ json: data });
    accounts++;
  });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('模拟查询成功');
  await select(page, 'symbol', 'BTCUSDT');
  await expect(page.locator('#fee')).toContainText('模拟费率');
  await select(page, 'side', '做多');
  for (const [id, value] of Object.entries({
    budget: '10',
    stop: '2',
    leverage: '5',
    slippage: '0.1',
    'minimum-buffer': '1',
  }))
    await page.locator(`#${id}`).fill(value);
  await page.clock.runFor(500);
  await expect(page.locator('#draft-result')).toBeVisible();
  const marketCount = markets;
  const draftTime = await page.locator('#draft-time').textContent();
  const price = await page.locator('#leverage-liquidation').textContent();
  await page.clock.runFor(2500);
  await expect.poll(() => accounts).toBe(2);
  expect(markets).toBe(marketCount);
  expect(verifications).toBe(0);
  await expect(page.locator('#draft-time')).toHaveText(draftTime!);
  await expect(page.locator('#leverage-liquidation')).toHaveText(price!);
  await page.clock.runFor(7500);
  await expect.poll(() => markets).toBe(marketCount + 1);
  await expect(page.locator('#draft-result')).toBeVisible();
  await generate(page);
  await select(page, 'demo-scenario', '全部成交，已补齐止损');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  const verificationCount = verifications;
  const verificationTime = await page.locator('#verification-time').textContent();
  const accountCount = accounts;
  await page.clock.runFor(3000);
  await expect.poll(() => accounts).toBeGreaterThan(accountCount);
  await expect(page.locator('#account-error')).toBeHidden();
  expect(verifications).toBe(verificationCount);
  await expect(page.locator('#verification-time')).toHaveText(verificationTime!);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await page.clock.runFor(7000);
  await expect.poll(() => verifications).toBe(verificationCount + 1);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  changeBalance = true;
  await page.clock.runFor(3000);
  await expect(page.locator('#available')).toHaveText('1');
  expect(verifications).toBe(verificationCount + 1);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('#verification-status')).toContainText('账户余额已变化');
});

test('account failures keep stale balances, revoke readiness and stop polling when login expires', async ({
  page,
  context,
}) => {
  await fillPlan(page);
  await generate(page);
  await select(page, 'demo-scenario', '全部成交，已补齐止损');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  await page.reload();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  const equity = await page.locator('#equity').textContent();
  const queried = await page.locator('#queried').textContent();
  let requests = 0;
  let response: 'failure' | 'success' | 'stale' | 'expired' = 'failure';
  await page.route('**/api/account', async (route) => {
    requests++;
    if (response === 'failure' || response === 'expired') {
      await route.fulfill({
        status: response === 'expired' ? 401 : 503,
        json: { error: '测试账户查询失败' },
      });
    } else {
      const result = await route.fetch();
      const data = await result.json();
      if (response === 'stale') data.queriedAt = '2000-01-01T00:00:00.000Z';
      await route.fulfill({ json: data });
    }
  });
  await page.clock.runFor(3000);
  await expect(page.locator('#account-error')).toContainText('上次快照已过期');
  await expect(page.locator('#equity')).toHaveText(equity!);
  await expect(page.locator('#queried')).toHaveText(queried!);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('#entry-card')).toHaveAttribute('data-current', 'false');
  response = 'success';
  await page.clock.runFor(3000);
  await expect(page.locator('#account-error')).toBeHidden();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  response = 'stale';
  await page.clock.runFor(3000);
  await expect(page.locator('#account-error')).toContainText('查询时间无效');
  await context.setOffline(true);
  const beforeOffline = requests;
  await page.clock.runFor(6000);
  expect(requests).toBe(beforeOffline);
  response = 'success';
  await context.setOffline(false);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  response = 'expired';
  await page.clock.runFor(3000);
  await expect(page.locator('#relogin')).toBeVisible();
  const beforeExpiry = requests;
  await page.clock.runFor(30_000);
  expect(requests).toBe(beforeExpiry);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
});

test('estimates debounce edits, poll fresh quotes and discard late responses', async ({ page }) => {
  await fillPlan(page);
  await page.clock.install();
  await page.clock.setFixedTime(new Date());
  const price = page.locator('#leverage-liquidation');
  let quote = '100';
  let requests = 0;
  let holdNext = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/market?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.ask = data.mark = data.last = quote;
    data.bid = String(Number(quote) - 1);
    const hold = holdNext;
    holdNext = false;
    requests++;
    if (hold) await gate;
    await route.fulfill({ json: data });
  });
  await page.locator('#leverage').fill('6');
  await page.locator('#leverage').fill('7');
  await expect(price).toHaveText('—');
  await expect(page.locator('#leverage-liquidation-note')).toContainText('更新中');
  await page.clock.fastForward(500);
  await expect(price).toHaveText(/^\d+\.\d{2} USDT（模拟）$/);
  expect(requests).toBe(1);
  await expect(page.locator('#leverage-help')).toHaveCount(0);
  await expect(page.locator('#leverage-liquidation-help')).not.toContainText('快照估算');
  const original = await price.textContent();
  quote = '101';
  await page.clock.fastForward(10_000);
  await expect.poll(() => requests).toBe(2);
  await expect(price).toContainText('USDT');
  await expect(price).not.toHaveText(original!);
  holdNext = true;
  quote = '102';
  await page.clock.fastForward(10_000);
  await expect.poll(() => requests).toBe(3);
  await expect(price).toHaveText('—');
  quote = '103';
  await page.locator('#leverage').fill('8');
  await page.clock.fastForward(500);
  await expect.poll(() => requests).toBe(4);
  await expect(price).toContainText('USDT');
  const latest = await price.textContent();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(price).toHaveText(latest!);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.clock.fastForward(30_000);
  await expect(price).toHaveText('—');
  await expect(page.locator('#status')).not.toHaveText('正在查询');
});

test('original card checks refresh without changing its parameters and failures revoke readiness', async ({
  page,
}) => {
  await fillPlan(page);
  await generate(page);
  const quantity = await page.locator('#card-quantity').textContent();
  const stop = await page.locator('#card-stopPrice').textContent();
  const budget = await page.locator('#card-budget').textContent();
  await select(page, 'demo-scenario', '尚未成交 / 限价挂单中');
  await page.locator('#verify').click();
  await expect(page.locator('#card-check')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('[data-copy="quantity"]')).toBeEnabled();
  await page.clock.install();
  await page.clock.setFixedTime(new Date());
  await page.route('**/api/verification?*', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    result.entryCheck = {
      status: 'needs-action',
      queriedAt: new Date().toISOString(),
      issue: '原卡数量不再符合当前预算，请重新生成。',
    };
    await route.fulfill({ json: result });
  });
  // A manual refresh starts the next polling timer under the controlled clock.
  await page.locator('#verify').click();
  await expect(page.locator('#card-check')).toHaveAttribute('data-state', 'needs-action');
  await expect(page.locator('[data-copy="quantity"]')).toBeDisabled();
  await expect(page.locator('#card-quantity')).toHaveText(quantity!);
  await expect(page.locator('#card-stopPrice')).toHaveText(stop!);
  await expect(page.locator('#card-budget')).toHaveText(budget!);
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.fastForward(10_000);
  await expect(page.locator('#card-check')).toHaveAttribute('data-state', 'ready');
  await page.route('**/api/verification?*', (route) =>
    route.fulfill({ status: 503, json: { error: '测试查询失败' } }),
  );
  await page.clock.fastForward(10_000);
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'incomplete');
  await expect(page.locator('#entry-card')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('#leverage-liquidation')).toHaveText('—');
});

test('a late generation response cannot publish a card after the input changed', async ({
  page,
}) => {
  await fillPlan(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await page.locator('#generate').click();
  await requested;
  await page.locator('#budget').fill('12');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#entry-card')).toBeHidden();
  await expect(page.locator('#generate')).toBeEnabled();
  await generate(page);
  await expect(page.locator('#card-budget')).toHaveText('12 USDT');
});

test('reload and re-login restore the signed original plan and reverify it', async ({
  page,
  context,
}) => {
  await fillPlan(page);
  await generate(page);
  const quantity = await page.locator('#card-quantity').textContent();
  await page.reload();
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'needs-action');
  await expect(page.locator('#card-quantity')).toHaveText(quantity!);
  await context.clearCookies();
  await page.locator('#verify').click();
  await expect(page.locator('#relogin')).toBeVisible();
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'incomplete');
  await page.locator('#relogin a').click();
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
  await page.goto('/entry');
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'needs-action');
  await expect(page.locator('#card-quantity')).toHaveText(quantity!);
  await expect(page.locator('[data-copy="quantity"]')).toBeDisabled();
});

test('leaving and network loss invalidate results, return and reconnect reverify', async ({
  page,
  context,
}) => {
  await fillPlan(page);
  await generate(page);
  await select(page, 'demo-scenario', '全部成交，已补齐止损');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('#verification-details')).toBeHidden();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await context.setOffline(true);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await context.setOffline(false);
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'true');
  await select(page, 'demo-scenario', '模拟查询失败');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'incomplete');
  await expect(page.locator('#verification-details')).toBeHidden();
});

test('limit and two-level controls, stop templates and corrupted storage', async ({ page }) => {
  await fillPlan(page);
  await select(page, 'entry-type', '普通限价 · GTC');
  await expect(page.locator('#limit-price')).toBeEnabled();
  await page.locator('#limit-price').fill('100');
  await select(page, 'stop-levels', '双层止损');
  await page.locator('#near-stop').fill('1');
  await page.locator('#templates-module summary').click();
  await page.locator('#template-save').click();
  await expect(page.locator('#stop-template-trigger')).toContainText('双层');
  await page.locator('#stop').fill('3');
  await page.locator('#template-apply').click();
  await expect(page.locator('#stop')).toHaveValue('2');
  await generate(page);
  await expect(page.locator('#card-limit-row')).toBeVisible();
  await expect(page.locator('#card-near')).toBeVisible();
  await expect(page.locator('#demo-scenario')).toHaveValue('waiting');
  await select(page, 'demo-scenario', '限价：首次部分成交，余单仍在');
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'needs-action');
  // Install corruption after the old page's pagehide handler has saved its last state.
  await page.addInitScript(() =>
    localStorage.setItem('entry-guidance.current-trade.v1', '{invalid'),
  );
  await page.reload();
  await expect(page.locator('#recovery-status')).toContainText('未覆盖原记录');
  await expect(page.locator('#entry-card')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('entry-guidance.current-trade.v1'))).toBe(
    '{invalid',
  );
});

test('incomplete verification responses cannot produce a passing state', async ({ page }) => {
  await fillPlan(page);
  await generate(page);
  await page.route('**/api/verification?*', (route) =>
    route.fulfill({
      json: { status: 'verified', source: 'demo', queriedAt: new Date().toISOString(), issues: [] },
    }),
  );
  await page.locator('#verify').click();
  await expect(page.locator('#verification')).toHaveAttribute('data-state', 'incomplete');
  await expect(page.locator('#verification')).toHaveAttribute('data-current', 'false');
  await expect(page.locator('#verification-details')).toBeHidden();
});

test('symbol search filters contracts until a result is confirmed', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const menu = page.locator('#symbol-options');
  const search = page.locator('#symbol-search');
  await page.locator('#symbol-trigger').click();
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('placeholder', '搜索币种');
  await expect(menu.getByRole('option', { name: '仅查看账户', exact: true })).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error('币种菜单未定位');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await search.fill('eth');
  await expect(menu.getByRole('option', { name: 'ETHUSDT', exact: true })).toBeVisible();
  await expect(menu.getByRole('option', { name: 'BTCUSDT', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: '仅查看账户', exact: true })).toHaveCount(0);
  await expect(page.locator('#symbol')).toHaveValue('');
  await search.fill('zzzz');
  await expect(menu.getByText('无匹配币种')).toBeVisible();
  await search.press('Enter');
  await expect(menu).toBeVisible();
  await expect(page.locator('#symbol')).toHaveValue('');
  await search.press('Escape');
  await expect(menu).toBeHidden();
  await page.locator('#symbol-trigger').press('b');
  await expect(search).toHaveValue('b');
  await expect(menu.getByRole('option', { name: 'BTCUSDT', exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(page.locator('#symbol')).toHaveValue('BTCUSDT');
  await expect(page.locator('#symbol-trigger')).toBeFocused();
  await page.locator('#side-trigger').click();
  await expect(page.locator('#side-search')).toHaveCount(0);
});

test('existing native select accessibility and interaction checks still pass', async ({ page }) => {
  for (const [path, file, contentType] of [
    ['/test/select.browser.html', '../select.browser.html', 'text/html'],
    ['/public/select.js', '../../public/select.js', 'text/javascript'],
    ['/public/style.css', '../../public/style.css', 'text/css'],
  ]) {
    await page.route(`**${path}`, (route) =>
      route.fulfill({ body: readFileSync(new URL(file!, import.meta.url)), contentType }),
    );
  }
  await page.goto('/test/select.browser.html');
  await page.locator('#run').click();
  await expect(page.locator('#results')).toContainText('全部通过');
});
