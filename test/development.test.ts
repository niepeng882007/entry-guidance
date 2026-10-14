import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { createServer } from '../src/server.ts';

test('development serves Vue through the authenticated origin and denies backend source files', async (t) => {
  // This HTTP fixture checks module delivery, without background dependency scans during teardown.
  const frontend = await createViteServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
  const server = createServer({ password: 'development-test-only', mode: 'demo', frontend });
  t.after(async () => { server.closeAllConnections(); server.close(); await frontend.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${origin}/main.ts`)).status, 401);
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=development-test-only' });
  const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const page = await fetch(origin, { headers: { Cookie } });
  assert.match(await page.text(), /\/@vite\/client/);
  const module = await fetch(`${origin}/main.ts`, { headers: { Cookie } });
  assert.equal(module.status, 200);
  assert.match(await module.text(), /AppShell.vue/);
  const source = await fetch(`${origin}/@fs${new URL('../src/server.ts', import.meta.url).pathname}`, { headers: { Cookie } });
  assert.equal(source.status, 403);
  const crossOrigin = await fetch(`${origin}/api/plan`, { method: 'POST', headers: { Cookie, Origin: 'http://localhost:9999', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
});

// Exercise the real dev command in isolated copies, never .env or the user's ledger.
test('dev reloads Vue and CSS across concurrent instances, and restarts changed backend code', { timeout: 30_000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  async function startInstance() {
    const directory = mkdtempSync(join(tmpdir(), 'entry-development-'));
    let child: ReturnType<typeof spawn> | undefined;
    t.after(async () => {
      try {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          process.kill(-child.pid, 'SIGTERM');
          await once(child, 'exit');
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    for (const name of ['src', 'frontend', 'public', 'package.json', 'vite.config.ts']) cpSync(join(root, name), join(directory, name), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const portServer = createHttpServer();
    portServer.listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const address = portServer.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    child = spawn('pnpm', ['dev'], {
      cwd: directory, detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, APP_MODE: 'demo', APP_ORIGIN: origin, APP_PASSWORD: 'development-test-only', REVIEW_DATA_DIR: join(directory, 'review') },
    });
    await expect.poll(async () => {
      try { return (await fetch(`${origin}/login`)).status; } catch { return 0; }
    }, { timeout: 10_000 }).toBe(200);
    return { directory, origin };
  }
  const first = await startInstance();
  const second = await startInstance();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  async function openPage(origin: string) {
    const page = await browser.newPage();
    const messages: string[] = [];
    const sockets: string[] = [];
    page.on('console', (message) => messages.push(message.text()));
    page.on('websocket', (socket) => sockets.push(socket.url()));
    await page.goto(`${origin}/login`);
    await page.locator('#password').fill('development-test-only');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('h1')).toHaveText('首页');
    await expect.poll(() => messages.some((message) => message.includes('[vite] connected')), { timeout: 5_000 }).toBe(true);
    assert.ok(sockets.some((socket) => new URL(socket).origin === origin.replace('http:', 'ws:')));
    await page.evaluate(() => { document.body.dataset.hmrProbe = 'preserved'; });
    return page;
  }
  const page = await openPage(first.origin);
  const secondPage = await openPage(second.origin);
  const secondComponent = join(second.directory, 'frontend/HomePage.vue');
  writeFileSync(secondComponent, readFileSync(secondComponent, 'utf8').replace('规划开仓、复盘交易，或查看账户状况。', '第二实例热更新。'));
  await expect(secondPage.locator('.workspace__intro')).toHaveText('第二实例热更新。');
  await expect(page.locator('.workspace__intro')).toHaveText('规划开仓、复盘交易，或查看账户状况。');
  const component = join(first.directory, 'frontend/HomePage.vue');
  writeFileSync(component, readFileSync(component, 'utf8').replace('规划开仓、复盘交易，或查看账户状况。', '热更新回归测试。'));
  await expect(page.locator('.workspace__intro')).toHaveText('热更新回归测试。');
  const css = join(first.directory, 'public/style.css');
  writeFileSync(css, readFileSync(css, 'utf8') + '\n.home-page__heading { border-top: 7px solid rgb(1, 2, 3); }\n');
  await expect(page.locator('.home-page__heading')).toHaveCSS('border-top-width', '7px');
  assert.equal(await page.evaluate(() => document.body.dataset.hmrProbe), 'preserved');
  assert.equal(await secondPage.evaluate(() => document.body.dataset.hmrProbe), 'preserved');
  const backend = join(first.directory, 'src/server.ts');
  writeFileSync(backend, readFileSync(backend, 'utf8').replace("res.setHeader('X-Content-Type-Options', 'nosniff');", "res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Development-Probe', 'updated');"));
  await expect.poll(async () => {
    try { return (await fetch(`${first.origin}/login`)).headers.get('X-Development-Probe'); } catch { return null; }
  }, { timeout: 5_000 }).toBe('updated');
  assert.equal((await page.request.get(`${first.origin}/main.ts`)).status(), 401);
  await expect(secondPage.locator('.workspace__intro')).toHaveText('第二实例热更新。');
});
