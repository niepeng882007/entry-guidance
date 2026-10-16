import { test, expect, type Page } from '@playwright/test';
import { navigate } from './navigation';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
}

test('home is the login destination and does not query business data, including return from another page', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url());
  });
  await login(page);
  await expect(page.locator('body')).not.toContainText('交易由你在 Binance 执行');
  await expect(page.getByRole('navigation', { name: '功能入口' }).getByRole('link')).toHaveCount(3);
  expect(requests).toEqual([]);
  await page.clock.install();
  await page.clock.runFor(10000);
  expect(requests).toEqual([]);
  for (const [name, path, heading] of [
    ['开仓卡', '/entry', '开仓卡'],
    ['交易记录', '/review', '交易记录分析'],
    ['我的账户', '/account', '账户快照'],
  ] as const) {
    await page
      .getByRole('navigation', { name: '功能入口' })
      .getByRole('link', { name, exact: true })
      .click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('交易由你在 Binance 执行');
    await expect(page.locator('body')).not.toContainText('手动执行');
    await expect(page.locator('body')).not.toContainText('工具不会下单');
    await navigate(page, '首页');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    const count = requests.length;
    await page.clock.runFor(10000);
    expect(requests.length).toBe(count);
  }
});

test('real-mode home omits connection explanations', async ({ page }) => {
  await login(page);
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('data-mode="demo"', 'data-mode="binance"')
      .replace('模拟数据 · 仅用于界面与流程验证', '真实模式 · 数据由 Binance 只读接口查询');
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
  await expect(page.locator('.source')).toHaveCount(0);
});

test('mobile drawer traps focus, closes by Escape, button and backdrop, and transfers page selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const trigger = page.getByRole('button', { name: '菜单', exact: true });
  const dialog = page.getByRole('dialog', { name: '功能菜单' });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog).toBeVisible();
  const links = dialog.getByRole('link');
  await expect(dialog.locator('[aria-current="page"]')).toHaveText('首页');
  await links.last().focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '关闭菜单' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(links.last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await dialog.getByRole('button', { name: '关闭菜单' }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(380, 400);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await navigate(page, '开仓卡');
  await expect(page).toHaveURL('/entry');
  await expect(page.getByRole('dialog')).toBeHidden();
  await trigger.click();
  await expect(dialog.locator('[aria-current="page"]')).toHaveText('开仓卡');
  await expect(dialog.getByRole('link', { name: '首页', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('.workspace__sidebar [aria-current="page"]')).toHaveText('开仓卡');
});

test('shared shell fits home and all features at every supported width, with reduced motion and keyboard skip link', async ({
  page,
}) => {
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/', '/entry', '/review', '/account']) {
    await page.goto(path);
    for (const width of [320, 375, 390, 414, 768, 960, 961, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const menu = page.getByRole('button', { name: '菜单', exact: true });
      if (width <= 960) {
        await menu.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.app-nav__link')).toHaveCount(4);
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({
          path: test.info().outputPath(`drawer-${path.slice(1) || 'home'}-${width}.png`),
        });
        await page.keyboard.press('Escape');
      } else {
        await expect(menu).toBeHidden();
        await expect(page.locator('.workspace__sidebar .app-nav__link')).toHaveCount(4);
      }
      if ([320, 390, 1280].includes(width))
        await page.screenshot({
          path: test.info().outputPath(`shell-${path.slice(1) || 'home'}-${width}.png`),
        });
    }
    const skip = page.getByRole('link', { name: '跳到主要内容' });
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  }
});
