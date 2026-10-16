import { navigate } from './navigation';
import { test, expect, type Page, type Route } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await expect(page.locator('#status')).toHaveText('模拟查询成功');
}

async function fulfillAtBrowserTime(page: Page, route: Route) {
  const data: Record<string, unknown> = await (await route.fetch()).json();
  const queriedAt = await page.evaluate(() => new Date().toISOString());
  data.queriedAt = data.attemptedAt = queriedAt;
  await route.fulfill({ json: data });
}

test('amount explanations are opt-in, keyboard accessible and fit narrow screens', async ({
  page,
}) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/account', '/entry']) {
    await page.goto(path);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [label, explanation] of [
        ['账户权益说明', '钱包余额 + 未实现盈亏。'],
        ['可用余额说明', '可用于开仓的余额，已计入现有资金占用。'],
      ] as const) {
        const help = page.getByLabel(label, { exact: true });
        const content = page.getByText(explanation, { exact: true });
        await expect(content).toBeHidden();
        await help.focus();
        await page.keyboard.press('Enter');
        await expect(content).toBeVisible();
        await expect(help).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (label === '账户权益说明')
          await page
            .locator('.balances')
            .first()
            .screenshot({
              path: test.info().outputPath(`amount-help-${path.slice(1)}-${width}.png`),
            });
        await page.keyboard.press('Enter');
        await expect(content).toBeHidden();
      }
    }
    if (path === '/account') {
      const content = page.getByText('当前持仓的浮动盈亏，未扣手续费与资金费。', { exact: true });
      await expect(content).toBeHidden();
      await page.getByLabel('未实现盈亏说明', { exact: true }).click();
      await expect(content).toBeVisible();
    }
  }
});

test('asset page opens from the workbench, displays details and supports return and logout', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: '查看账户详情' }).click();
  await expect(page).toHaveURL('/account');
  await expect(page.getByRole('heading', { name: '账户快照', exact: true })).toBeVisible();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.locator('#asset-available')).toHaveText('920.12540000');
  await expect(page.locator('#asset-pnl')).toHaveText('-12.35000000');
  await expect(page.getByText('模拟数据 · 仅用于界面与流程验证')).toBeVisible();
  await expect(page.getByText('280.00000000 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('37.52460000 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('6.00000000 USDT', { exact: true })).toBeVisible();
  await navigate(page, '开仓卡');
  await expect(page.locator('#equity')).toHaveText('1237.65000000');
  await page.goto('/account');
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/login');
  await page.goto('/account');
  await expect(page).toHaveURL('/login');
  expect((await page.request.get('/api/account/assets')).status()).toBe(401);
});

test('refresh ring shrinks without visible seconds and resets after a manual query completes', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0;
  let hold = false;
  let release: (() => void) | undefined;
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('CSP:')) violations.push(message.text());
  });
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`CSP:${event.effectiveDirective}:${event.blockedURI}`),
    ),
  );
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    const response = await route.fetch();
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ response });
  });
  await page.goto('/account');
  const refresh = page.getByRole('button', { name: '手动刷新' });
  const ring = page.getByRole('img', { name: /自动刷新倒计时/ });
  const progress = ring.locator('.account-page__countdown-progress');
  await expect(refresh).toBeEnabled();
  await expect(progress).toHaveAttribute('stroke-dashoffset', '0');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('USDT · 只读', { exact: true })).toHaveCount(0);
  await expect(page.getByText('正常前台每 30 秒刷新，限流时暂停')).toHaveCount(0);
  await expect(page.locator('.account-page__refresh')).toHaveText('');
  await page.clock.runFor(15_000);
  await expect(progress).toHaveAttribute('stroke-dashoffset', '50');
  expect(requests).toBe(1);
  hold = true;
  await refresh.click();
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByText('刷新中…', { exact: true })).toBeVisible();
  await expect(ring).toBeHidden();
  await page.clock.runFor(5000);
  expect(requests).toBe(2);
  hold = false;
  release?.();
  await expect(refresh).toBeEnabled();
  await expect(progress).toHaveAttribute('stroke-dashoffset', '0');
  await page.clock.runFor(29_999);
  expect(requests).toBe(2);
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(3);
  await expect(refresh).toBeEnabled();
  expect(violations).toEqual([]);
});

test('asset refresh waits thirty seconds after completion and discards canceled late responses', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0;
  let hold = false;
  let release!: () => void;
  await page.route('**/api/account/assets', async (route) => {
    const count = ++requests;
    const response = await route.fetch();
    const data = await response.json();
    data.walletBalance = data.equity = `${1250 + count}.00000000`;
    data.unrealizedProfit = '0.00000000';
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('1251.00000000');
  const details = page.getByText('资金占用与查询信息', { exact: true });
  await expect(page.locator('#asset-queried')).toBeVisible();
  await details.focus();
  await page.clock.runFor(29_999);
  expect(requests).toBe(1);
  await page.clock.runFor(1);
  await expect(page.locator('#asset-equity')).toHaveText('1252.00000000');
  await expect(details).toBeFocused();
  await expect(page.locator('#asset-queried')).toBeVisible();
  await page.clock.runFor(20_000);
  hold = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => requests).toBe(3);
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
  await page.clock.runFor(10_000);
  expect(requests).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  hold = false;
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#asset-equity')).toHaveText('1252.00000000');
  await expect(page.locator('.status__message').first()).toHaveText('数据待更新。');
  await page.clock.runFor(90_000);
  expect(requests).toBe(3);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
});

test('background refresh preserves content positions and reading state while queries are pending', async ({
  page,
}) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let hold = false;
  let release: (() => void) | undefined;
  await page.route('**/api/account/*', async (route) => {
    const data = await (await route.fetch()).json();
    data.reused = false;
    if (hold && new URL(route.request().url()).pathname.endsWith('/assets'))
      await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  const refresh = page.getByRole('button', { name: '手动刷新' });
  const querying = page.getByText('刷新中…', { exact: true });
  const details = page.getByText('资金占用与查询信息', { exact: true });
  await expect(refresh).toBeEnabled();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    const titleBox = await page
      .getByRole('heading', { name: '账户快照', exact: true })
      .boundingBox();
    const actionsBox = await page.locator('.account-page__actions').boundingBox();
    expect(titleBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    if (width > 560) {
      expect(
        Math.abs(titleBox!.y + titleBox!.height / 2 - actionsBox!.y - actionsBox!.height / 2),
      ).toBeLessThan(1);
      expect(actionsBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
    } else {
      expect(actionsBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    }
    await details.focus();
    const layout = () =>
      page.evaluate(() => ({
        assets: document.querySelector('.balances--assets')!.getBoundingClientRect().top + scrollY,
        details:
          document.querySelector('.account-page__details')!.getBoundingClientRect().top + scrollY,
        scroll: scrollY,
      }));
    const before = await layout();
    hold = true;
    const previousRelease = release;
    await page.clock.fastForward(30_000);
    try {
      await expect.poll(() => release !== previousRelease).toBe(true);
      await expect(querying).toBeVisible();
      await expect(refresh).toBeDisabled();
      expect(await layout()).toEqual(before);
      await expect(details).toBeFocused();
    } finally {
      hold = false;
      release?.();
    }
    await expect(refresh).toBeEnabled();
    await expect(querying).toBeHidden();
    expect(await layout()).toEqual(before);
    await expect(details).toBeFocused();
    await expect(page.locator('#asset-queried')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('failed asset reads preserve old values and successful time, then recover after reconnect', async ({
  page,
  context,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const now = new Date();
  await page.clock.setFixedTime(now);
  let fail = false;
  let requests = 0;
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    if (fail) await route.fulfill({ status: 502, json: { error: '受控读取失败' } });
    else await route.continue();
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  const queried = await page.locator('#asset-queried').textContent();
  const attempted = await page.locator('#asset-attempted').textContent();
  fail = true;
  await page.clock.setFixedTime(new Date(now.getTime() + 5000));
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '刷新失败，请重试。 数据待更新。',
  );
  await expect(page.getByText('受控读取失败', { exact: true })).toBeHidden();
  await page.getByText('错误详情', { exact: true }).click();
  await expect(page.getByText('受控读取失败', { exact: true })).toBeVisible();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.locator('#asset-queried')).toHaveText(queried!);
  await expect(page.locator('#asset-attempted')).not.toHaveText(attempted!);
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('网络已断开');
  await expect(page.getByRole('img', { name: /自动刷新倒计时/ })).toBeHidden();
  await expect(page.locator('.account-page__refresh')).toHaveText('已暂停');
  const before = requests;
  await page.clock.runFor(120_000);
  expect(requests).toBe(before);
  fail = false;
  await context.setOffline(false);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /自动刷新倒计时/ })).toBeVisible();
  expect(requests).toBe(before + 1);
  await expect(page.locator('#asset-queried')).toBeVisible();
});

test('hidden asset pages pause and query immediately on returning', async ({ page }) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.setFixedTime(new Date());
  let requests = 0;
  let release: (() => void) | undefined;
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    if (requests === 2) await new Promise<void>((resolve) => (release = resolve));
    await route.continue();
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.status__message').first()).toHaveText('数据待更新。');
  await page.clock.runFor(120_000);
  expect(requests).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByText('刷新中…', { exact: true })).toBeVisible();
  await expect(page.locator('.status__message').first()).toHaveText('数据待更新。');
  await expect(page.getByText(/页面已隐藏|离开期间不监控|返回后重新查询/)).toHaveCount(0);
  release?.();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(requests).toBe(2);
});

test('first failure never displays zero and session expiry stops subsequent asset reads', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let requests = 0;
  let expired = false;
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    await route.fulfill({
      status: expired ? 401 : 502,
      json: { error: expired ? '请先登录。' : '受控首次失败' },
    });
  });
  await page.goto('/account');
  await expect(page.locator('.status__message').first()).toHaveText('刷新失败，请重试。');
  await expect(page.locator('#asset-equity')).toHaveText('—');
  await expect(page.getByText('等待查询', { exact: true })).toHaveCount(5);
  await expect(page.locator('#asset-queried')).toHaveText('尚无');
  expired = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('link', { name: '重新登录' })).toBeVisible();
  await expect(page.locator('.status__message')).toHaveText('登录已过期，请重新登录。');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
  await page.clock.runFor(30_000);
  expect(requests).toBe(2);
});

test('rate-limit cooling stops automatic, manual and returning-page requests until recovery', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  const now = new Date();
  await page.clock.pauseAt(now);
  const requests = new Map<string, number>();
  let limited = false;
  await page.route('**/api/account/*', async (route) => {
    const part = new URL(route.request().url()).pathname;
    requests.set(part, (requests.get(part) ?? 0) + 1);
    if (limited && part.endsWith('/assets')) {
      await route.fulfill({
        status: 429,
        json: {
          code: 'rate_limited',
          error: '受控额度不足',
          retryAt: new Date(now.getTime() + 60_000).toISOString(),
          scopeConfirmed: false,
        },
      });
    } else await fulfillAtBrowserTime(page, route);
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  const queriedAt = await page.locator('#asset-queried').textContent();
  limited = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '请求过于频繁，稍后自动重试。 数据待更新。',
  );
  await expect(page.getByText('受控额度不足', { exact: true })).toBeHidden();
  await expect(page.getByText(/下次允许读取/)).toHaveCount(0);
  await expect(page.locator('.account-page__refresh')).toHaveText('限流暂停');
  await expect(page.getByRole('img', { name: /自动刷新倒计时/ })).toBeHidden();
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await expect.poll(() => [...requests.values()]).toEqual([2]);
  const before = new Map(requests);
  await page.clock.runFor(59_999);
  await page.getByRole('button', { name: '手动刷新' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('online'));
  });
  expect(requests).toEqual(before);
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.locator('#asset-queried')).toHaveText(queriedAt!);
  await expect(page.locator('.status__message').first()).toHaveText(
    '请求过于频繁，稍后自动重试。 数据待更新。',
  );
  await expect(page.getByText('受控额度不足', { exact: true })).toBeHidden();
  limited = false;
  await page.clock.runFor(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect.poll(() => [...requests.values()]).toEqual([3]);
});

test('failed assets respect their retry time for automatic, manual and returning-page queries', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  const now = new Date();
  await page.clock.pauseAt(now);
  let fail = false;
  let requests = 0;
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    if (fail) {
      await route.fulfill({
        status: 502,
        json: {
          error: '受控资产失败',
          retryAt: new Date(now.getTime() + 90_000).toISOString(),
        },
      });
    } else await fulfillAtBrowserTime(page, route);
  });
  await page.goto('/account');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  fail = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '刷新失败，稍后自动重试。 数据待更新。',
  );
  await expect(page.getByText('受控资产失败', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await page.clock.runFor(30_000);
  await page.getByRole('button', { name: '手动刷新' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  await page.clock.runFor(30_000);
  expect(requests).toBe(2);
  await expect(page.locator('.status__message').first()).toHaveText('稍后自动重试。 数据待更新。');
  fail = false;
  await page.clock.runFor(30_000);
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('account page only reads assets and preserves disclosure choices through refresh and re-entry', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const paths: string[] = [];
  await page.route('**/api/account/*', async (route) => {
    paths.push(new URL(route.request().url()).pathname);
    await fulfillAtBrowserTime(page, route);
  });
  await page.goto('/account');
  const details = page.getByText('资金占用与查询信息', { exact: true });
  const queried = page.locator('#asset-queried');
  const refresh = page.getByRole('button', { name: '手动刷新' });
  await expect(queried).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('button', { name: '持仓', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '活跃委托', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '当前持仓' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '活跃委托' })).toHaveCount(0);
  await details.click();
  await details.focus();
  await expect(queried).toBeHidden();
  await page.clock.runFor(30_000);
  await expect.poll(() => paths.length).toBe(2);
  await expect(refresh).toBeEnabled();
  await expect(queried).toBeHidden();
  await expect(details).toBeFocused();
  await refresh.click();
  await expect.poll(() => paths.length).toBe(3);
  await expect(refresh).toBeEnabled();
  await expect(queried).toBeHidden();
  await details.click();
  await refresh.click();
  await expect.poll(() => paths.length).toBe(4);
  await expect(refresh).toBeEnabled();
  await expect(queried).toBeVisible();
  await details.click();
  await page.reload();
  await expect(queried).toBeVisible();
  await expect(refresh).toBeEnabled();
  expect(paths).toEqual(Array(5).fill('/api/account/assets'));
});

test('asset page rejects an unexpected source, stale time and malformed amounts', async ({
  page,
}) => {
  await login(page);
  let variant = 'source';
  await page.route('**/api/account/assets', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (variant === 'source') data.source = 'binance';
    if (variant === 'time') data.queriedAt = new Date(Date.now() - 90_000).toISOString();
    if (variant === 'cached') {
      data.queriedAt = new Date(Date.now() - 45_000).toISOString();
      data.reused = true;
    }
    if (variant === 'amount') data.maintMargin = 'NaN';
    if (variant === 'equity') data.equity = '999';
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  for (variant of ['source', 'time', 'amount', 'equity']) {
    if (variant !== 'source') await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.locator('.status__message').first()).toHaveText('账户数据异常，请重新查询。');
    await expect(page.getByText('错误详情', { exact: true })).toBeVisible();
    await expect(page.locator('.status details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#asset-equity')).toHaveText('—');
    await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  }
  variant = 'cached';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#asset-queried')).not.toHaveText('尚无');
  variant = 'valid';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
});

test('asset errors show actionable summaries and keep technical details collapsed', async ({
  page,
}, testInfo) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let release: (() => void) | undefined;
  await page.route('**/api/account/assets', async (route) => {
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue();
  });
  await page.goto('/account');
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByText('刷新中…', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#asset-equity')).toHaveText('—');
  release?.();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await page.unrouteAll({ behavior: 'wait' });
  const cases = [
    ['missing_credentials', '账户尚未连接，请配置只读凭据。'],
    ['access_denied', '账户读取被拒绝，请检查只读凭据和 IP 限制。'],
    ['reading_disabled', '只读权限未确认，请检查凭据。'],
    ['unverified_permissions', '只读权限未确认，请检查凭据。'],
    ['unsafe_permissions', '请更换专用只读凭据。'],
    ['unsupported_account', '当前账户模式暂不支持。'],
    ['clock_error', '查询时间校验失败，请同步电脑时间后重试。'],
    ['invalid_response', '账户数据异常，请重新查询。'],
    ['scope_unconfirmed', '账户数据异常，请重新查询。'],
    ['timeout', '账户查询超时，请重试。'],
    ['connection_failed', '账户连接失败，请检查网络后重试。'],
    ['unknown_code', '刷新失败，请重试。'],
  ] as const;
  let code = '';
  const detail = `受控技术错误：${'response_field_'.repeat(40)}`;
  await page.route('**/api/account/assets', (route) =>
    route.fulfill({ status: 502, json: { code, error: detail, scopeConfirmed: false } }),
  );
  for (const [nextCode, summary] of cases) {
    code = nextCode;
    await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.locator('.status__message').first()).toHaveText(`${summary} 数据待更新。`);
    await expect(page.getByText(detail, { exact: true })).toBeHidden();
    await expect(page.locator('.balances--assets')).toHaveAttribute('data-current', 'false');
  }
  const details = page.getByText('错误详情', { exact: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`entry-account-error-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press('Enter');
    await expect(page.getByText(detail, { exact: true })).toBeHidden();
  }
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/account/assets', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid-json' }),
  );
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('.status__message').first()).toHaveText(
    '刷新失败，请重试。 数据待更新。',
  );
  await expect(page.locator('.account-page__error-detail')).toBeHidden();
});

test('asset amounts, unknown fields, disclosure and keyboard focus fit narrow and desktop views', async ({
  page,
}, testInfo) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/account/assets', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.walletBalance = data.equity = data.availableBalance = '999999999999999999999999.00000001';
    data.unrealizedProfit = '0';
    data.positionInitialMargin = data.maxWithdrawAmount = null;
    data.maintMargin = '0.00000000';
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('999999999999999999999999.00000001');
  const details = page.getByText('资金占用与查询信息', { exact: true });
  await details.focus();
  await expect(page.locator('#asset-queried')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#asset-queried')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(details.locator('..').getByText('未知 · 未返回', { exact: true })).toHaveCount(2);
  await expect(page.getByText('0.00000000 USDT', { exact: true })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(details).toBeFocused();
    const bounds = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      content: [...document.querySelectorAll('.amount, .details__value, .balance__unit')].map(
        (node) => {
          const rect = node.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            scroll: node.scrollWidth,
            client: node.clientWidth,
          };
        },
      ),
      outline: getComputedStyle(document.activeElement!).outlineStyle,
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
    expect(bounds.outline).toBe('solid');
    for (const item of bounds.content) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(bounds.width);
      expect(item.scroll).toBeLessThanOrEqual(item.client + 1);
    }
    await page.screenshot({
      path: testInfo.outputPath(`entry-account-${width}.png`),
      fullPage: true,
    });
  }
});
