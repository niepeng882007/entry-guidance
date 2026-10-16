import { test, expect } from '@playwright/test';
import { users } from '../runtime.ts';
import { login } from './login.ts';

test('protected production workbench supports both users, narrow screens and strict CSP', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dashboard');
  await expect(page).toHaveURL('/login');
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      throw new Error(`CSP: ${event.violatedDirective}`);
    });
  });
  for (const user of users) {
    await login(page, user);
    await expect(page.getByRole('heading', { name: user.name })).toBeVisible();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
    ).toEqual({ local: [], session: [] });
    await page.getByRole('button', { name: '退出登录' }).focus();
    await expect(page.getByRole('button', { name: '退出登录' })).toBeFocused();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL('/login');
    await expect(page.getByText(user.email, { exact: true })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('logout in another tab clears private content and returning never restores it', async ({
  page,
  context,
}) => {
  await login(page);
  const other = await context.newPage();
  await other.goto('/dashboard');
  await expect(other.getByText(users[0]!.email, { exact: true })).toBeVisible();
  await page.bringToFront();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/login');
  await other.bringToFront();
  await expect(other).toHaveURL('/login');
  await expect(other.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
  await other.goBack();
  await expect(other.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
  await login(page, users[1]!);
  await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
});

test('a profile response received before logout cannot restore private content after logout starts', async ({
  page,
}) => {
  await login(page);
  let profileArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    profileArrived = resolve;
  });
  let releaseProfile!: () => void;
  const profileGate = new Promise<void>((resolve) => {
    releaseProfile = resolve;
  });
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  await page.route('**/v1/users/*/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    profileArrived();
    await profileGate;
    // An aborted fetch is expected once the logout generation changes.
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.route('**/api/auth/sign-out', async (route) => {
    await logoutGate;
    await route.continue();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await arrived;
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
    releaseProfile();
    await expect(page.getByText(users[0]!.email, { exact: true })).toHaveCount(0);
    releaseLogout();
    await expect(page).toHaveURL('/login');
  } finally {
    releaseProfile();
    releaseLogout();
  }
});
