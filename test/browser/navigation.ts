import type { Page } from '@playwright/test';

export async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '菜单', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name, exact: true })
    .click();
}
