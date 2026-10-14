import { test, expect, type Page } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewLedger } from '../../src/review-ledger.ts';
import { createServer } from '../../src/server.ts';

async function startNotesPage(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-notes-'));
  const server = createServer({
    password: 'browser-test-only',
    mode: 'demo',
    reviewLedgerPath: join(directory, 'demo.sqlite'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server');
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto(`${base}/`);
  await page.getByLabel('个人访问密码').fill('browser-test-only');
  await page.getByRole('button', { name: '进入账户' }).click();
  await page.goto(`${base}/review`);
  return {
    base,
    path: join(directory, 'demo.sqlite'),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('personal notes preserve failed edits, save tags and show user statements separately from facts', async ({
  page,
}) => {
  const app = await startNotesPage(page);
  try {
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await expect(page.getByRole('heading', { name: '个人笔记 · 用户自述' })).toBeVisible();
    await page.getByText('维护交易风格标签', { exact: true }).click();
    await page.getByLabel('新标签名称').fill(`顺势-${test.info().project.name}`);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const tag = page.getByLabel(`顺势-${test.info().project.name}`, { exact: true });
    await tag.check();
    await page.getByLabel('入场理由', { exact: true }).fill('突破确认');
    await page.getByLabel('退出理由（用户自述）').fill('按计划退出');
    await page.getByLabel('执行问题').fill('入场稍晚');
    await page.getByLabel('改进事项').fill('等待回踩');
    await page.getByLabel('自由笔记').fill('<script>window.noteExecuted = true</script>');
    await page.route('**/api/review/trades/*/note', (route) =>
      route.fulfill({ status: 503, json: { error: '保存失败，当前输入保留。' } }),
    );
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('保存失败');
    await expect(page.getByLabel('入场理由', { exact: true })).toHaveValue('突破确认');
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByLabel('入场理由', { exact: true })).toHaveValue('突破确认');
    await page.unroute('**/api/review/trades/*/note');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已保存');
    await expect(page.getByText(/保存时间：/)).toBeVisible();
    await expect(page.getByText('交易所事实', { exact: true })).toBeVisible();
    await expect(page.getByText('模型推测：暂无。分析时是否发送笔记需另行选择。')).toBeVisible();
    await expect(page.locator('#review-net-pnl')).toHaveText('12.4735 USDT');
    await page.reload();
    await expect(page.getByLabel('自由笔记')).toHaveValue(
      '<script>window.noteExecuted = true</script>',
    );
    expect(await page.evaluate(() => 'noteExecuted' in window)).toBe(false);
    await expect(tag).toBeChecked();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByLabel('自由笔记').focus();
      await expect(page.getByLabel('自由笔记')).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`notes-${width}.png`), fullPage: true });
    }
  } finally {
    await app.close();
  }
});

test('a changed grouping exposes the retained note and its original evidence instead of migrating it', async ({
  page,
}) => {
  const app = await startNotesPage(page);
  try {
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await page.getByLabel('自由笔记').fill('原周期的原因');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已保存');
    const list = await (await page.request.get(`${app.base}/api/review/trades`)).json();
    const ledger = new ReviewLedger(app.path, { source: 'demo', accountId: 'demo-account' });
    const changed = ledger.get(list.trades[0].id)!;
    changed.evidence.fills[0]!.quantity = '0.002';
    changed.evidence.fills[0]!.allocation = 'open';
    ledger.project(changed.symbol, [changed]);
    ledger.close();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByText(/当前草稿的交易依据已变化/)).toBeVisible();
    await expect(page.getByLabel('自由笔记')).toHaveValue('原周期的原因');
    await page.getByText('归属待确认笔记 · 1 条', { exact: true }).click();
    await expect(page.getByText('自由笔记：原周期的原因')).toBeVisible();
    await page.getByText('保存时的交易依据', { exact: true }).click();
    await expect(page.getByText(/"id":"demo-fill-1"/)).toBeVisible();
    await page.getByRole('button', { name: '载入已保存版本' }).click();
    await expect(page.getByLabel('自由笔记')).toHaveValue('');
  } finally {
    await app.close();
  }
});

test('conflicting device edits stay in the form and tags can be renamed and retired', async ({
  page,
}) => {
  const app = await startNotesPage(page);
  try {
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await expect(page.locator('#trade-detail')).toBeFocused();
    await expect(page.getByLabel('自由笔记')).toBeVisible();
    await page.getByText('维护交易风格标签', { exact: true }).click();
    await page.getByLabel('新标签名称').fill('顺势');
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    await page.getByLabel('顺势', { exact: true }).check();
    await page.getByLabel('自由笔记').fill('本机版本');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已保存');
    const journal = await (await page.request.get(`${app.base}/api/review/journal`)).json();
    const note = journal.notes[0];
    const remote = await page.request.post(`${app.base}/api/review/trades/${note.trade.id}/note`, {
      headers: { Origin: app.base },
      data: {
        noteId: note.id,
        version: note.version,
        basis: note.trade.noteBasis,
        entryReason: '',
        exitReason: '',
        executionProblem: '',
        improvement: '',
        freeNote: '另一设备版本',
        tagIds: note.tagIds,
      },
    });
    expect(remote.status()).toBe(200);
    await page.getByLabel('自由笔记').fill('未成功保存的编辑');
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('笔记已被更新');
    await expect(page.getByLabel('自由笔记')).toHaveValue('未成功保存的编辑');
    await page.getByRole('button', { name: '重新读取笔记与标签' }).click();
    await expect(page.locator('#note-status')).toContainText('已读取个人记录');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '载入已保存版本' }).click();
    await expect(page.getByLabel('自由笔记')).toHaveValue('另一设备版本');
    await page.getByRole('button', { name: '编辑标签 顺势', exact: true }).click();
    await page.getByLabel('标签名称', { exact: true }).fill('趋势');
    await page.getByRole('button', { name: '保存标签', exact: true }).click();
    await expect(page.getByLabel('趋势', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '编辑标签 趋势', exact: true }).click();
    await page.getByRole('button', { name: '停用标签（保留历史）' }).click();
    await expect(page.getByLabel('趋势（已停用）', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '编辑标签 趋势', exact: true }).click();
    await page.getByLabel('标签名称', { exact: true }).fill('趋势旧标签');
    await page.getByRole('button', { name: '保存标签', exact: true }).click();
    await expect(page.getByLabel('趋势旧标签（已停用）', { exact: true })).toBeChecked();
  } finally {
    await app.close();
  }
});

test('cancelled and expired saves retain the draft and late responses cannot erase newer edits', async ({
  page,
}) => {
  const app = await startNotesPage(page);
  try {
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await page.getByLabel('自由笔记').fill('提交版本');
    let release!: () => void;
    await page.route('**/api/review/trades/*/note', async (route) => {
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    await page.getByLabel('自由笔记').fill('较新的编辑');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByLabel('自由笔记')).toHaveValue('较新的编辑');
    await expect(page.locator('#note-status')).toContainText('请求已暂停');
    await page.route('**/api/review/trades/*/note', (route) =>
      route.fulfill({ status: 401, json: { error: '登录已过期，请重新登录。' } }),
    );
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.locator('#note-status')).toContainText('登录已过期');
    await expect(page.getByLabel('自由笔记')).toHaveValue('较新的编辑');
    await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('changing accounts through an unsynced state cannot reuse another account draft', async ({
  page,
}) => {
  const app = await startNotesPage(page);
  try {
    const list = await (await page.request.get(`${app.base}/api/review/trades`)).json();
    const original = await (
      await page.request.get(`${app.base}/api/review/trades/${list.trades[0].id}`)
    ).json();
    let account: string | null = '12345';
    await page.route('**/review', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace('data-mode="demo"', 'data-mode="binance"'),
      });
    });
    await page.route('**/api/review/trades', (route) =>
      route.fulfill({
        json: {
          ...list,
          total: account ? 1 : 0,
          source: 'binance',
          accountId: account,
          syncStatus: account ? 'synced' : 'not-synced',
          trades: account ? [{ ...list.trades[0], source: 'binance', accountId: account }] : [],
        },
      }),
    );
    await page.route('**/api/review/trades/*', (route) =>
      route.fulfill({ json: { ...original, source: 'binance', accountId: account } }),
    );
    await page.route('**/api/review/journal', (route) =>
      route.fulfill({ json: { source: 'binance', accountId: account, notes: [], tags: [] } }),
    );
    await page.reload();
    await page.getByRole('button', { name: '查看 BTCUSDT 交易详情' }).click();
    await page.getByLabel('自由笔记').fill('账户 A 的私有草稿');
    account = null;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByText('详情暂不可用，请重新读取或返回交易记录。')).toBeVisible();
    account = '54321';
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByLabel('自由笔记')).toHaveValue('');
    await expect(page.getByText('账户 A 的私有草稿')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
