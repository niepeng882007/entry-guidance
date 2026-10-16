import { startAuthRuntime } from '../test/auth/runtime.ts';
const runtime = await startAuthRuntime({ web: 3100, business: 3101 });
console.log(
  `合成用户工作台：${runtime.webOrigin}/login；用户说明见 docs/development.md。退出后删除本次临时数据库。`,
);
