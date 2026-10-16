# 开发与验证

项目地图与规格入口见 [公共索引](index.md)。

## 开发与构建

- 前端使用 Vue 单文件组件和 TypeScript，Vite 处理热更新及生产构建；Node 后端仍直接执行 TypeScript。版本、依赖和命令以 [package.json](../package.json) 与锁文件为准。
- `APP_MODE=demo pnpm dev` 启动本机开发服务。`APP_ORIGIN` 必须为本机 HTTP 地址，默认 `http://127.0.0.1:3000`；HMR WebSocket 复用当前 HTTP 服务端口；多个 worktree 同时开发时使用不同的 `APP_ORIGIN` 端口。`dev` 使用 Node watch，修改后端及其导入的共享计算模块会自动重启；内存会话和未保存的本单状态随之失效，需刷新并重新登录。Vite 原生加载 TypeScript 配置，避免临时打包配置文件删除触发额外重启。登录和 API 仍经过同一 Node 服务的会话、Host/Origin 校验。开发模式仅为样式热更新放开内联样式及本机 HMR WebSocket，生产 CSP 保持严格。
- `pnpm build` 生成 `dist/`，然后 `APP_MODE=demo pnpm start` 验收生产构建。手机使用[使用说明](usage.md#手机连接本地电脑)的 HTTPS 配置和构建产物；修改后重新构建并重启服务。
- `frontend/useWorkbench.ts` 管理响应式字段、展示状态、请求取消与浏览器存储；Vue 组件负责模板和事件绑定。`public/draft.js` 继续供前后端共用，修改时检查两端调用方，服务端独立校验客户端输入。
- `public/select.js` 保留原生字段契约，`SelectControl.vue` 负责在组件更新后同步及卸载时清理。页面与样式修改遵循 [前端规则](../public/AGENTS.md)。
- TypeScript 检查后端和共享 JS，`vue-tsc` 检查 Vue 模板及前端 TS。仓库固定 TypeScript 6.0；升级时须同时验证 `vue-tsc` 与 ESLint 解析器兼容性，不将历史兼容结论当作新版工具现状。
- 交易记录模块按需加载 Ant Design Vue 4，`frontend/review-theme.ts` 为该库与现有黑白灰主题的映射。Vite 使用组件库官方静态提取入口，将组件 CSS 与缓存映射构建为同源资源；复盘 HTML 的 CSP 仅为固定图标 CSS 增加 hash，未开放任意内联样式。升级组件库后须验证 `test/review.test.ts` 的图标 hash 和 `test/browser/review-table.spec.ts` 的 CSP 检查。前端 `skipLibCheck` 跳过 Ant Design Vue 4 与当前 Vue 泛型不兼容的依赖声明，项目代码及模板继续严格检查；后端检查不变。`pnpm-workspace.yaml` 禁用传递依赖 core-js 的非必要安装脚本。

## 检查选择

首次安装后运行 `pnpm exec playwright install chromium webkit` 安装测试浏览器。完整交付检查为 `pnpm check`，依次执行类型检查、lint、格式检查、构建、Node 测试和浏览器测试。

代码修改先运行 `pnpm typecheck`，再做相关定向检查。HTTP 测试读取生产入口，运行前先 `pnpm build`；纯计算定向测试不需要构建。仅修改文档时检查相对链接与锚点、已迁移路径、规则作用域和 `git diff --check`；无需为文档调整运行全量应用测试。

| 修改内容 | 定向检查 |
| --- | --- |
| 账户读取、登录与访问控制 | `node --test test/account.test.ts` |
| 共享计算、精度、资金约束或模板 | `node --test test/draft.test.ts` |
| 方案起点、恢复、成交对账或止损核验 | `node --test test/verification.test.ts` |
| 历史同步、周期归并与手动归档 | `node --test test/history-sync.test.ts test/account-archive.test.ts` |
| 订单文件与列表 | `node --test test/order-file.test.ts test/review-orders.test.ts` |
| 复盘账本、列表与统计 | `node --test test/review-ledger.test.ts test/review.test.ts test/review-statistics.test.ts` |
| 模型任务或备份恢复 | `node --test test/trade-analysis.test.ts test/review-backup.test.ts` |
| 前端交互及组件 | `pnpm test:browser`（先构建）；可用 `pnpm exec playwright test test/browser/account-page.spec.ts` 定向验证对应文件 |

Node 测试使用内置 `node:test` 和断言，以本机临时 HTTP 端口及替换的 Binance 响应验证行为。Playwright 启动固定模拟服务器（127.0.0.1:4179），不加载 `.env` 或真实凭据，覆盖 Chromium 和 WebKit；失败记录留在忽略的 `test-results/`。部分超时用例约需 10 秒。`test/development.test.ts` 还使用 Chromium 与临时项目副本运行真实 `pnpm dev`，验证并发实例的 Vue/CSS 热更新、页面不跳转及后端自动重启；运行 Node 测试前也需安装 Chromium。

`pnpm lint`、`pnpm format` 和 `pnpm format:check` 仅作用于脚本列出的前端、工具配置及浏览器测试；已有后端、共享计算和 CSS 保持原风格，避免无关格式 diff。CI 尚未引入。

## 浏览器与外部验收

- 本地生产构建演示先 `pnpm build`，再运行 `APP_MODE=demo pnpm start`；密码配置见 [README](../README.md)，手机 HTTPS 连接见[使用说明](usage.md#手机连接本地电脑)。真实模式为默认启动模式，演示必须显式选择 `demo`。
- 前端视口、焦点与状态检查遵循前端规则；当前操作见[使用说明](usage.md)，原模拟数值与复验步骤在[历史记录](archive/implementation-log-2026-10-14.md)；历史步骤涉及已移除页面时须按现行规格调整。
- 分别记录自动测试、模拟浏览器、实体手机和真实账户结果。已有未完成项包括实体 iOS 交互、双层止损 App 组合流程及真实账户只读联调，统一见[项目现状](status.md)，历史任务不能证明当前代码已通过。
- 需要核实交易所规则时访问规格中对应官方来源，并记录核验日期；本地模拟和官方 API 说明不能替代实际 App 流程验收。
