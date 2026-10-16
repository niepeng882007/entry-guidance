import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ReviewLedger, demoTrade } from '../../src/review-ledger.ts';
import { reviewCsv } from '../../src/review-export.ts';
import { parseReviewQuery } from '../../src/review-filters.ts';
import { BackupError } from '../../src/review-backup.ts';

test('downloads, previews and confirms a backup, preserving current notes and showing old versions across viewports', async ({
  page,
}, testInfo) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const id = ledger.archive(demoTrade());
  const content = {
    noteId: null,
    version: 0,
    basis: ledger.get(id)!.noteBasis,
    entryReason: '备份笔记',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '<script>不可执行</script>',
    tagIds: [],
  };
  const note = ledger.saveNote(id, content).notes[0]!;
  const backup = ledger.backup();
  ledger.saveNote(id, { ...content, noteId: note.id, version: 1, entryReason: '当前笔记' });
  // Isolated simulated ledger avoids interference from other browser tests' background tasks.
  await page.route('**/api/review/backup', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: {
        'Content-Disposition': 'attachment; filename="review-backup.json"',
        'X-Review-Source': 'demo',
        'X-Review-Account': 'demo-account',
      },
      body: JSON.stringify(backup),
    }),
  );
  await page.route('**/api/review/export', (route) =>
    route.fulfill({
      contentType: 'text/csv; charset=utf-8',
      headers: {
        'Content-Disposition': 'attachment; filename="review-trades.csv"',
        'X-Review-Source': 'demo',
        'X-Review-Account': 'demo-account',
      },
      body: reviewCsv(
        ledger,
        parseReviewQuery(new URLSearchParams(route.request().postDataJSON().query)).filters,
      ),
    }),
  );
  await page.route('**/api/review/restore**', async (route) => {
    const input = route.request().postDataJSON();
    try {
      const result = route.request().url().endsWith('/preview')
        ? ledger.previewRestore(input.backup)
        : route.request().url().endsWith('/versions')
          ? { versions: ledger.restoreVersions() }
          : {
              ...ledger.restoreBackup(input.backup, input.token, input.overwrite),
              versions: ledger.restoreVersions(),
              message: '恢复完成；当前笔记保留，备份旧版本可查看。',
            };
      await route.fulfill({ json: { ...ledger.scope(), ...result } });
    } catch (error) {
      await route.fulfill({
        status: error instanceof BackupError ? error.status : 503,
        json: { error: error instanceof Error ? error.message : '恢复失败' },
      });
    }
  });
  try {
    await page.goto('/');
    await page.getByLabel('个人访问密码').fill('browser-test-only');
    await page.getByRole('button', { name: '进入账户' }).click();
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    await page.goto('/review?view=cycles');
    await page.getByText('导出与备份恢复', { exact: true }).click();
    await expect(page.getByRole('button', { name: '下载完整备份' })).toBeEnabled();
    const csvEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出筛选范围 CSV' }).click();
    const csv = await csvEvent;
    expect(csv.suggestedFilename()).toBe('review-trades.csv');
    expect(readFileSync((await csv.path())!, 'utf8')).toContain('"12.4735"');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载完整备份' }).click();
    const download = await downloadEvent,
      path = (await download.path())!;
    expect(download.suggestedFilename()).toBe('review-backup.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).accountId).toBe('demo-account');
    await page.getByLabel('选择 JSON 备份并预览（上限 64 MiB）').setInputFiles(path);
    const preview = page.getByRole('region', { name: '恢复预览' });
    await expect(preview).toContainText('冲突 1');
    expect(ledger.journal().notes[0]!.entryReason).toBe('当前笔记');
    await preview.locator('summary').click();
    await expect(preview.getByRole('checkbox')).not.toBeChecked();
    await expect(preview).toContainText('<script>不可执行</script>');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByRole('button', { name: '确认恢复' }).click();
    await expect(page.getByRole('region', { name: '恢复预览' })).toHaveCount(0);
    await expect(
      page.getByText('恢复完成；当前笔记保留，备份旧版本可查看。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '查看恢复旧版本' }).click();
    const versions = page.getByRole('region', { name: '恢复旧版本' });
    await expect(versions).toContainText('1 条');
    await versions.locator('summary').click();
    await expect(versions).toContainText('备份笔记');
    expect(ledger.journal().notes[0]!.entryReason).toBe('当前笔记');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('backup-mobile.png'), fullPage: true });
    const file = page.getByLabel('选择 JSON 备份并预览（上限 64 MiB）');
    await file.setInputFiles({
      name: 'wrong-account.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...backup, accountId: 'other' })),
    });
    await expect(page.getByRole('button', { name: '确认恢复' })).toBeDisabled();
    await expect(page.getByRole('region', { name: '恢复预览' })).toContainText('不匹配');
    await file.setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{invalid'),
    });
    await expect(
      page.getByText('文件不是有效 JSON 备份；现有账本保留。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '恢复预览' })).toHaveCount(0);
    await file.setInputFiles(path);
    await expect(page.getByRole('button', { name: '确认恢复' })).toBeEnabled();
    await preview.locator('summary').click();
    const checkbox = preview.getByRole('checkbox');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await page.getByRole('button', { name: '确认恢复' }).click();
    await expect(preview).toHaveCount(0);
    expect(ledger.journal().notes[0]!.entryReason).toBe('备份笔记');
    expect(ledger.restoreVersions()).toHaveLength(2);
  } finally {
    ledger.close();
  }
});
