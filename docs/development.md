# 开发与验证

项目地图与规格入口见 [公共索引](index.md)。

## 开发与构建

- 前端使用 Vue 单文件组件和 TypeScript，Vite 处理热更新及生产构建；Node 后端仍直接执行 TypeScript。版本、依赖和命令以 [package.json](../package.json) 与锁文件为准。
- `APP_MODE=demo pnpm dev` 启动本机开发服务。`APP_ORIGIN` 必须为本机 HTTP 地址，默认 `http://127.0.0.1:3000`；HMR WebSocket 复用当前 HTTP 服务端口；多个 worktree 同时开发时使用不同的 `APP_ORIGIN` 端口。`dev` 使用 Node watch，修改后端及其导入的共享计算模块会自动重启；内存会话和未保存的本单状态随之失效，需刷新并重新登录。Vite 原生加载 TypeScript 配置，避免临时打包配置文件删除触发额外重启。登录和 API 仍经过同一 Node 服务的会话、Host/Origin 校验。开发模式仅为样式热更新放开内联样式及本机 HMR WebSocket，生产 CSP 保持严格。
- `pnpm build` 生成 `dist/`，然后 `APP_MODE=demo pnpm start` 验收生产构建。手机使用[使用说明](usage.md#手机连接本地电脑)的 HTTPS 配置和构建产物；修改后重新构建并重启服务。
- `frontend/useWorkbench.ts` 管理响应式字段、展示状态、请求取消与浏览器存储；Vue 组件负责模板和事件绑定。`public/draft.js` 继续供前后端共用，修改时检查两端调用方，服务端独立校验客户端输入。
- `public/select.js` 保留原生字段契约，`SelectControl.vue` 负责在组件更新后同步及卸载时清理。页面与样式修改遵循 [前端规则](../public/AGENTS.md)。
- TypeScript 检查后端和共享 JS，`vue-tsc` 检查 Vue 模板及前端 TS。仓库固定 TypeScript 6.0；升级时须同时验证 `vue-tsc` 与 ESLint 解析器兼容性，不将历史兼容结论当作新版工具现状。
- 交易记录模块按需加载 Ant Design Vue 4，`frontend/review-theme.ts` 为该库与现有黑白灰主题的映射。Vite 使用组件库官方静态提取入口，将组件 CSS 与缓存映射构建为同源资源；复盘 HTML 的 CSP 仅为固定图标 CSS 增加 hash，未开放任意内联样式。升级组件库后须验证 `test/review.test.ts` 的图标 hash 和 `test/browser/review-table.spec.ts` 的 CSP 检查。前端 `skipLibCheck` 跳过 Ant Design Vue 4 与当前 Vue 泛型不兼容的依赖声明，项目代码及模板继续严格检查；新增认证依赖的声明兼容处理见下文。`pnpm-workspace.yaml` 禁用传递依赖 core-js 的非必要安装脚本。

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

`pnpm lint`、`pnpm format` 和 `pnpm format:check` 仅作用于脚本列出的前端、新身份模块、工具配置及浏览器测试；已有交易后端、共享计算和 CSS 保持原风格，避免无关格式 diff。CI 尚未引入。

## 浏览器与外部验收

- 本地生产构建演示先 `pnpm build`，再运行 `APP_MODE=demo pnpm start`；密码配置见 [README](../README.md)，手机 HTTPS 连接见[使用说明](usage.md#手机连接本地电脑)。真实模式为默认启动模式，演示必须显式选择 `demo`。
- 前端视口、焦点与状态检查遵循前端规则；当前操作见[使用说明](usage.md)，原模拟数值与复验步骤在[历史记录](archive/implementation-log-2026-10-14.md)；历史步骤涉及已移除页面时须按现行规格调整。
- 分别记录自动测试、模拟浏览器、实体手机和真实账户结果。已有未完成项包括实体 iOS 交互、双层止损 App 组合流程及真实账户只读联调，统一见[项目现状](status.md)，历史任务不能证明当前代码已通过。
- 需要核实交易所规则时访问规格中对应官方来源，并记录核验日期；本地模拟和官方 API 说明不能替代实际 App 流程验收。

## 多用户兼容入口（票据 01）

运行目标统一为 `.nvmrc` 的 Node 24.22.0；继续使用 pnpm 11.7.0、单一 package 和锁文件。`pnpm build` 先生成 Prisma 客户端，再构建旧 Vite 和新 Next；构建不提供数据库连接、认证 Secret、委托私钥或用户 Key 解密主密钥。`pnpm typecheck` 同时检查旧入口和 Next，并先生成 Next 路由类型，支持干净检出。

新模块：`web/` 是 Next 页面与认证入口，`src/identity/` 管理 Better Auth、数据库和委托，`src/business-main.ts` 启动独立业务服务。业务服务只提供当前产品用户资料读取，所有旧账户、账本及静态路径均不转发。旧共享密码 Cookie 与新 `workbench` Cookie 相互不认可；旧 SQLite、本单及无归属浏览器存储保持在原入口。Next 认证页和私有页采用完整动态渲染及每请求 nonce CSP，不启用与 nonce 静态壳不兼容的部分预渲染；公开页缓存策略在票据 02 实施。Next 与 Better Auth 遥测显式关闭。

Prisma CLI、客户端及 pg adapter 锁定同一 7.10.1 patch；Next 16.4.2、React/React DOM 19.3.1、Better Auth 1.7.10。新增依赖承担已确认的框架、认证及 PostgreSQL 职责，现有 Vue/Vite 及计算模块保留。pnpm 仅放行 Prisma 与其 engines 的必要构建脚本，core-js 继续禁止。Better Auth 的跨运行时声明引用未安装的 `bun:sqlite`，因此 TypeScript 使用 `skipLibCheck` 跳过依赖声明检查；项目源码及 Vue/React 模板继续严格检查。

### 本地合成演示

1. 使用 Node 24，安装锁文件依赖，启动 Docker。
2. 运行 `pnpm build`。
3. 运行 `pnpm demo:auth`，进入 <http://127.0.0.1:3100/login>。两个用户为 `alice@example.test`、`bob@example.test`，合成测试口令均为 `synthetic-login-only-01`。这些值只用于临时演示，不能部署到外部环境。
4. 按 Ctrl-C 停止演示。脚本关闭两个服务并删除本次 PostgreSQL 容器；不挂载宿主机数据目录，不修改原 `.env`、SQLite 或真实数据库。

演示使用生产 Next 构建、3100 网页端口及 3101 业务端口；每次创建随机名称的 `postgres:17` 容器、随机本机数据库端口、新数据库、认证 Secret 及 Ed25519 密钥对。只有 Next 子进程接收委托私钥，业务子进程只接收公钥；两个子进程都不接收原进程的 Binance/模型凭据或解密配置。数据库仅预置合成用户且邮箱已验证，使用 Better Auth 的密码哈希格式，不提供公共注册或运维接口。

### 检查与安全边界

- `pnpm test:auth`：通过真实生产 HTTP 入口验证登录、资料、登出、停用、邮箱未验证、过期/伪造/跨用户委托、会话撤销及 Cookie 续期、授权代次、来源检查、故障关闭、旧身份隔离及启动中断清理；使用独立 PostgreSQL。HTTP 测试前运行 `pnpm build`。
- `pnpm test:browser:auth`：独立 Playwright 配置，生产构建和临时 PostgreSQL，Chromium/WebKit 覆盖 320px、390px、1280px、键盘、双用户、跨标签退出、返回与迟到响应。固定网页/业务端口 4180/4181。
- `pnpm check`：保留旧检查顺序，并在末尾运行上述两项；Docker 不可用时明确失败，不用内存或 SQLite 冒充 PostgreSQL 通过。

独立运行脚本为 `pnpm start:web`（默认 127.0.0.1:3100）、`pnpm dev:web` 和 `pnpm start:business`。它们不自动加载旧 `.env`，须由调用环境提供以下配置；本票演示/测试脚本自动生成全部配置，无需手动设值。

| 配置 | 使用者 | 要求 |
| --- | --- | --- |
| `DATABASE_URL` | Next、业务服务 | PostgreSQL 连接；分别按服务授予权限，迁移 DDL 凭据不用于构建 |
| `AUTH_ORIGIN` | 两个服务 | 网页精确 origin，本地 HTTP 只允许 loopback |
| `BUSINESS_ORIGIN` | 两个服务 | 业务精确 origin，必须与实际监听或受信 TLS 入口一致 |
| `AUTH_SECRET` | 仅 Next | 至少 32 字符，与委托及凭据加密密钥分开 |
| `DELEGATION_PRIVATE_KEY` | 仅 Next | Ed25519 PKCS8 DER 的 base64，只签发短期受限业务委托 |
| `DELEGATION_PUBLIC_KEY` | 仅业务服务 | 对应 SPKI DER 的 base64，用于验签 |
| `BUSINESS_HOST` | 仅业务服务，可选 | 默认 `127.0.0.1`，外部运行方式在获授权部署阶段确定 |

会话采用 7 天滚动有效期、24 小时续期检查；RSC 只读不续期，客户端必经的受保护 Route Handler 转发续期 Set-Cookie。委托有效期 60 秒，绑定原会话、产品用户、授权代次、签发方、接收服务及 `profile:read`。每次业务读取仍从数据库复核会话有效期、用户停用/邮箱验证、当前代次和资源归属。浏览器委托仅驻请求内存并经 Authorization 头发送，跨源只允许精确网页 origin，不开放跨主机 Cookie。登出、跨标签身份变化、页面隐藏/离开均清除可见资料并递增请求代次，迟到响应不能恢复旧内容。依赖不可用返回 503，不伪装成未登录或清除有效 Cookie。

票据 01 的本地验收不代表公开注册、Binance 绑定、云端数据库、真实外部链路、实体手机或部署已完成。
