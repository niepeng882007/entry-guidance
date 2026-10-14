import { navigate } from './navigation';
import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto('/entry');
  await expect(page.locator('#status')).toHaveText('模拟查询成功');
}

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
  await page.getByText('资金占用与查询信息', { exact: true }).click();
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

test('asset refresh uses fixed ticks, skips busy reads and discards canceled late responses', async ({
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
  await details.click();
  await details.focus();
  await page.clock.runFor(2999);
  expect(requests).toBe(1);
  await page.clock.runFor(1);
  await expect(page.locator('#asset-equity')).toHaveText('1252.00000000');
  await expect(details).toBeFocused();
  await expect(page.locator('#asset-queried')).toBeVisible();
  hold = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => requests).toBe(3);
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
  await page.clock.runFor(9000);
  expect(requests).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  hold = false;
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#asset-equity')).toHaveText('1252.00000000');
  await expect(page.getByRole('status')).toContainText('已过期');
  await page.clock.runFor(9000);
  expect(requests).toBe(3);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
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
  await page.getByText('资金占用与查询信息', { exact: true }).click();
  const queried = await page.locator('#asset-queried').textContent();
  const attempted = await page.locator('#asset-attempted').textContent();
  fail = true;
  await page.clock.setFixedTime(new Date(now.getTime() + 5000));
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('status')).toContainText('受控读取失败');
  await expect(page.getByRole('status')).toContainText('已过期');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await expect(page.locator('#asset-queried')).toHaveText(queried!);
  await expect(page.locator('#asset-attempted')).not.toHaveText(attempted!);
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('网络已断开');
  const before = requests;
  await page.clock.runFor(12_000);
  expect(requests).toBe(before);
  fail = false;
  await context.setOffline(false);
  await expect(page.getByRole('status')).toContainText('模拟查询成功');
  expect(requests).toBe(before + 1);
  await expect(page.locator('#asset-queried')).toBeVisible();
});

test('hidden asset pages pause and query immediately on returning', async ({ page }) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let requests = 0;
  await page.route('**/api/account/assets', async (route) => {
    requests++;
    await route.continue();
  });
  await page.goto('/account');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status')).toContainText('页面已隐藏');
  await page.clock.runFor(12_000);
  expect(requests).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status')).toContainText('模拟查询成功');
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
  await expect(page.getByRole('status')).toContainText('尚无成功数据');
  await expect(page.locator('#asset-equity')).toHaveText('—');
  await page.getByText('资金占用与查询信息', { exact: true }).click();
  await expect(page.getByText('等待查询', { exact: true })).toHaveCount(5);
  await expect(page.locator('#asset-queried')).toHaveText('尚无');
  expired = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('link', { name: '重新登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
  await page.clock.runFor(30_000);
  expect(requests).toBe(2);
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
    if (variant === 'time') data.queriedAt = '2000-01-01T00:00:00.000Z';
    if (variant === 'amount') data.maintMargin = 'NaN';
    if (variant === 'equity') data.equity = '999';
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  for (variant of ['source', 'time', 'amount', 'equity']) {
    if (variant !== 'source') await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.getByRole('status')).toContainText('尚无成功数据');
    await expect(page.locator('#asset-equity')).toHaveText('—');
    await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  }
  variant = 'valid';
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
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
      path: `/private/tmp/entry-account-${testInfo.project.name}-${width}.png`,
      fullPage: true,
    });
  }
});

test('current positions show hedge sides and exact PnL, filter and preserve expanded focused records on refresh', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto('/account');
  const positions = page.getByRole('region', { name: '当前持仓' });
  await expect(positions.getByText('显示 3 / 全账户 3 份持仓', { exact: true })).toBeVisible();
  await expect(positions.getByText('+1.00000000 USDT', { exact: true })).toBeVisible();
  await expect(positions.getByText('-2.00000000 USDT', { exact: true })).toBeVisible();
  const btcLong = positions.getByRole('button', { name: 'BTCUSDT 多头详情' });
  await btcLong.click();
  await btcLong.focus();
  await expect(positions.getByText('60101.00000000 USDT', { exact: true }).first()).toBeVisible();
  await page.clock.runFor(3000);
  await expect(btcLong).toBeFocused();
  await expect(positions.getByText('60101.00000000 USDT', { exact: true }).first()).toBeVisible();
  await positions.getByLabel('筛选持仓标的').fill('ETH');
  await expect(positions.getByText('显示 1 / 全账户 3 份持仓', { exact: true })).toBeVisible();
  await expect(positions.getByText('0.12345678', { exact: true })).toBeVisible();
  await positions.getByLabel('筛选持仓标的').fill('NORESULT');
  await expect(
    positions.getByText('筛选无结果，全账户仍有 3 份持仓。', { exact: true }),
  ).toBeVisible();
});

test('position failures retain old facts and independent times while lists and auxiliary data recover', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let phase = 'first-failure';
  await page.route('**/api/account/positions', async (route) => {
    if (phase === 'first-failure' || phase === 'failure') {
      await route.fulfill({ status: 502, json: { error: '受控持仓失败' } });
      return;
    }
    const data = await (await route.fetch()).json();
    if (phase === 'aux-failure') {
      data.positions[0].quantity = '0.03000000';
      data.last = { status: 'error', error: '受控成交价失败' };
      data.funding = { status: 'error', error: '受控资金费失败' };
    } else if (phase === 'invalid') data.positions[0].unrealizedProfit = 'NaN';
    else if (phase === 'changed') {
      data.positions = [
        data.positions[0],
        { ...data.positions[2], symbol: 'SOLUSDT', quantity: '1.00000001' },
      ];
    } else if (phase === 'empty') data.positions = [];
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  const positions = page.getByRole('region', { name: '当前持仓' });
  const refresh = page.getByRole('button', { name: '手动刷新' });
  await expect(positions).toContainText('尚无成功持仓数据');
  await expect(positions).not.toContainText('当前全账户空仓');
  await expect(page.locator('#asset-equity')).toHaveText('1237.65000000');
  phase = 'success';
  await refresh.click();
  const longDetails = positions.getByRole('button', { name: 'BTCUSDT 多头详情' });
  await longDetails.click();
  const detail = longDetails.locator('..');
  const queried = await detail
    .locator('.details__row')
    .filter({ hasText: '持仓查询时间' })
    .textContent();
  phase = 'failure';
  await page.clock.setFixedTime(new Date(Date.now() + 5000));
  await refresh.click();
  await expect(positions).toContainText('上次持仓已过期');
  await expect(detail.locator('.details__row').filter({ hasText: '持仓查询时间' })).toHaveText(
    `${queried} · 已过期`,
  );
  await expect(positions.getByText('+1.00000000 USDT', { exact: true })).toBeVisible();
  phase = 'aux-failure';
  await refresh.click();
  await expect(positions).toContainText('持仓查询成功');
  await expect(positions.getByText('0.03000000', { exact: true })).toBeVisible();
  await expect(detail).toContainText('受控成交价失败');
  await expect(detail).toContainText('受控资金费失败');
  await expect(detail).toContainText('60101.00000000 USDT · 已过期');
  phase = 'invalid';
  await refresh.click();
  await expect(positions).toContainText('上次持仓已过期');
  await expect(positions).not.toContainText('NaN');
  phase = 'changed';
  await refresh.click();
  await expect(positions).toContainText('显示 2 / 全账户 2 份持仓');
  await expect(positions.getByRole('heading', { name: 'BTCUSDT · 空头' })).toHaveCount(0);
  await expect(positions.getByRole('heading', { name: 'SOLUSDT · 多头' })).toBeVisible();
  await expect(detail).toContainText('60101.00000000 USDT');
  await expect(detail).not.toContainText('已过期');
  phase = 'empty';
  await refresh.click();
  await expect(positions).toContainText('成功查询：当前全账户空仓');
  await expect(positions).toContainText('显示 0 / 全账户 0 份持仓');
  await expect(positions.getByRole('heading', { level: 3 })).toHaveCount(0);
});

test('busy position reads do not pile up and canceled responses cannot restore old lists', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let requests = 0;
  let hold = false;
  let release!: () => void;
  await page.route('**/api/account/positions', async (route) => {
    requests++;
    const data = await (await route.fetch()).json();
    if (hold) {
      data.positions = [];
      await new Promise<void>((resolve) => (release = resolve));
    }
    await route.fulfill({ json: data });
  });
  await page.goto('/account');
  const positions = page.getByRole('region', { name: '当前持仓' });
  await expect(positions).toContainText('显示 3 / 全账户 3 份持仓');
  await page.clock.runFor(2999);
  expect(requests).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeEnabled();
  hold = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.clock.runFor(9000);
  expect(requests).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(positions).toContainText('上次持仓已过期');
  hold = false;
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(positions).toContainText('显示 3 / 上次全账户 3 份持仓');
  await page.clock.runFor(9000);
  expect(requests).toBe(3);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(positions).toContainText('持仓查询成功');
});

for (const width of [320, 390, 1280]) {
  test(`position details are readable at ${width}px and respect reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page);
    await page.route('**/api/account/positions', async (route) => {
      const data = await (await route.fetch()).json();
      data.positions[0].quantity = '123456789012345678901234.12345678';
      await route.fulfill({ json: data });
    });
    await page.goto('/account');
    const positions = page.getByRole('region', { name: '当前持仓' });
    await expect(positions).toContainText('显示 3 / 全账户 3 份持仓');
    for (const summary of await positions.getByRole('button').all()) await summary.click();
    await expect(positions.getByText('不适用 · 全仓', { exact: true })).toBeVisible();
    await expect(positions.getByText('未知 · 未返回', { exact: true }).first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await positions
        .locator('details[open] dl')
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
    await page.screenshot({
      path: `test-results/positions-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
  });
}

test('position session expiry marks retained data stale and stops all subsequent polling', async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let expired = false;
  let requests = 0;
  await page.route('**/api/account/positions', async (route) => {
    requests++;
    if (expired) await route.fulfill({ status: 401, json: { error: '登录已过期' } });
    else await route.continue();
  });
  await page.goto('/account');
  const positions = page.getByRole('region', { name: '当前持仓' });
  await expect(positions).toContainText('显示 3 / 全账户 3 份持仓');
  expired = true;
  await page.getByRole('button', { name: '手动刷新' }).click();
  await expect(page.getByRole('link', { name: '重新登录' })).toBeVisible();
  await expect(positions).toContainText('持仓已过期');
  await expect(positions).toContainText('显示 3 / 上次全账户 3 份持仓');
  await page.clock.runFor(12000);
  expect(requests).toBe(2);
  await expect(page.getByRole('button', { name: '手动刷新' })).toBeDisabled();
});

for (const expiredPart of ['assets', 'positions']) {
  test(`a ${expiredPart} 401 immediately expires all facts and cancels a blocked sibling read`, async ({
    page,
  }) => {
    await login(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto('/account');
    const positions = page.getByRole('region', { name: '当前持仓' });
    await expect(positions).toContainText('显示 3 / 全账户 3 份持仓');
    let release!: () => void;
    const sibling = expiredPart === 'assets' ? 'positions' : 'assets';
    await page.route(`**/api/account/${sibling}`, async (route) => {
      const data = await (await route.fetch()).json();
      await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: data });
    });
    await page.route(`**/api/account/${expiredPart}`, async (route) => {
      await expect.poll(() => typeof release).toBe('function');
      await route.fulfill({ status: 401, json: { error: '登录已过期' } });
    });
    await page.getByRole('button', { name: '手动刷新' }).click();
    await expect(page.getByRole('link', { name: '重新登录' })).toBeVisible();
    await expect(positions).toContainText('上次持仓已过期');
    await expect(page.getByRole('status')).toContainText('上次快照已过期');
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(positions).toContainText('上次持仓已过期');
  });
}
