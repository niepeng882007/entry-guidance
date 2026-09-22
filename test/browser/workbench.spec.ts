import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
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

test('review navigation stays current when its section cannot reach the activation line', async ({
  page,
}) => {
  const link = (name: string) => page.locator('.module-nav__link', { hasText: name });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await link('成交核验').click();
    await expect(link('成交核验')).toHaveAttribute('aria-current', 'location');
    await expect(link('开仓卡')).not.toHaveAttribute('aria-current', 'location');
    await link('开仓卡').click();
    await expect(link('开仓卡')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(link('本次计划')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname + location.search);
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    });
    await expect(link('成交核验')).toHaveAttribute('aria-current', 'location');
  }
});

test('a nav click keeps its module current until the user takes over scrolling', async ({
  page,
}) => {
  const link = (name: string) => page.locator('.module-nav__link', { hasText: name });
  await page.setViewportSize({ width: 1280, height: 800 });
  const traveling = await page.evaluate(() => {
    const currentHref = () =>
      document.querySelector('.module-nav__link[aria-current="location"]')?.getAttribute('href');
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.querySelector<HTMLAnchorElement>('.module-nav__link[href="#review-module"]')?.click();
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

  await page.locator('.module-nav__brand').click();
  await expect(link('账户快照')).toHaveAttribute('aria-current', 'location');
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
