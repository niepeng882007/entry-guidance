import { startAuthRuntime } from '../test/auth/runtime.ts';
import { modelTransport } from '../test/auth/model-fixture.ts';
import { entryScenarios } from '../test/auth/entry-fixture.ts';
const entry = entryScenarios();
const runtime = await startAuthRuntime({
  web: 3100,
  business: 3101,
  mail: 3102,
  transport: entry.transport,
  entryScenario: entry.select,
  modelTransport,
  simulation: true,
  reviewFixtures: true,
});
console.log(
  `合成用户工作台：${runtime.webOrigin}/；本地测试收件箱：http://127.0.0.1:3102/messages；用户说明见 docs/development.md。退出后删除本次临时数据库。`,
);
