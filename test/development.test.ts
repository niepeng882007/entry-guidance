import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { createServer } from '../src/server.ts';

test('development serves Vue through the authenticated origin and denies backend source files', async (t) => {
  const frontend = await createViteServer({ server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
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
  assert.match(await module.text(), /EntryWorkbench.vue/);
  const source = await fetch(`${origin}/@fs${new URL('../src/server.ts', import.meta.url).pathname}`, { headers: { Cookie } });
  assert.equal(source.status, 403);
  const crossOrigin = await fetch(`${origin}/api/plan`, { method: 'POST', headers: { Cookie, Origin: 'http://localhost:9999', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
});
