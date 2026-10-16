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

| 修改内容                           | 定向检查                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 账户读取、登录与访问控制           | `node --test test/account.test.ts`                                                                                 |
| 共享计算、精度、资金约束或模板     | `node --test test/draft.test.ts`                                                                                   |
| 方案起点、恢复、成交对账或止损核验 | `node --test test/verification.test.ts`                                                                            |
| 历史同步、周期归并与手动归档       | `node --test test/history-sync.test.ts test/account-archive.test.ts`                                               |
| 订单文件与列表                     | `node --test test/order-file.test.ts test/review-orders.test.ts`                                                   |
| 复盘账本、列表与统计               | `node --test test/review-ledger.test.ts test/review.test.ts test/review-statistics.test.ts`                        |
| 模型任务或备份恢复                 | `node --test test/trade-analysis.test.ts test/review-backup.test.ts`                                               |
| 前端交互及组件                     | `pnpm test:browser`（先构建）；可用 `pnpm exec playwright test test/browser/account-page.spec.ts` 定向验证对应文件 |

Node 测试使用内置 `node:test` 和断言，以本机临时 HTTP 端口及替换的 Binance 响应验证行为。Playwright 启动固定模拟服务器（127.0.0.1:4179），不加载 `.env` 或真实凭据，覆盖 Chromium 和 WebKit；失败记录留在忽略的 `test-results/`。部分超时用例约需 10 秒。`test/development.test.ts` 还使用 Chromium 与临时项目副本运行真实 `pnpm dev`，验证并发实例的 Vue/CSS 热更新、页面不跳转及后端自动重启；运行 Node 测试前也需安装 Chromium。

浏览器用例先确认成功登录的首页已就绪，再发起后续导航，避免取消尚未完成的登录 POST。几何与键盘用例显式使用减弱动态效果，动画用例固定普通动效并验证过程；模拟用户接管滚动时发送对应输入事件。强制经典滚动条等夹具条件须先断言真实生效，不只注入样式后假定成功。

### 代码规范与提交

`pnpm lint` 检查全仓 JS、TypeScript、Vue 和 React/Next 代码，采用零警告门槛；`pnpm format` 与 `pnpm format:check` 使用同一范围，覆盖代码、测试、配置、HTML/CSS 和现行文档。排除目录以 ESLint 配置和 `.prettierignore` 为准：依赖、生成资源、测试报告、本地数据、历史档案、`.scratch` 调查/任务记录及安装的技能源文件不做批量重排。Prettier 保留现有单引号和 100 列设置，EditorConfig 统一 UTF-8、LF 与两空格缩进。Prisma schema 和 SQL migration 保持工具原格式。

ESLint 以正确性为主：沿用 JS/TypeScript 推荐规则与 Vue essential，增加有类型信息的 Promise 检查、React Hooks 调用/依赖规则及 Next 推荐规则。业务代码继续使用严格类型检查；有意不等待的异步操作显式表达交接，并由调用方或被调用方处理失败。必要的 lint 例外仅放在具体位置并说明原因，避免整文件或整目录关闭有效规则。

安装开发依赖时，`prepare` 自动安装 Husky 钩子。提交钩子只对暂存文件运行 lint-staged：安全 lint 修复、Prettier 格式化、再次 lint；剩余错误或警告阻止提交。不同任务使用不重叠的文件匹配，保留 lint-staged 默认备份、部分暂存隐藏与失败恢复，不在钩子中运行全量类型检查、构建或测试。自动修复后的内容会进入本次提交，提交前用 `git diff --cached` 复核；未暂存改动不会被顺带提交。不强制提交信息格式。

`node --test test/tooling.test.ts` 在临时仓库验证实际提交钩子，包括带空格路径、部分暂存、错误阻断及失败恢复；不改动当前仓库的暂存区。

### GitHub CI

`.github/workflows/check.yml` 对所有 PR 和 `main` 推送运行同一条 `pnpm check`；同一 PR/分支的新提交取消旧检查。Node 读取 `.nvmrc`，pnpm 读取 `package.json`，依赖用 `--frozen-lockfile` 安装；Linux runner 安装 Chromium/WebKit 及系统依赖，预取 `postgres:17`，认证测试继续自行创建并销毁临时数据库。工作流只有仓库只读权限，不提供生产 Secrets，不部署、不调用真实 Binance 或模型。CI 用 `HUSKY=0` 跳过本地钩子安装；失败时保留 `test-results/` 中的模拟浏览器证据 3 天，截图统一使用 `testInfo.outputPath()`，不依赖本机临时目录。

新增开发依赖 Husky、lint-staged 用于可靠处理部分暂存及失败恢复；globals 提供运行环境的全局变量定义；React Hooks 和 Next lint 插件补齐双栈规则。依赖兼容现有 ESLint/TypeScript/Next，不为规范统一升级业务框架。若远端默认分支调整，同步修改工作流的 push 分支。工作流文件的本地验证不代表 GitHub 已实际运行通过。

## 浏览器与外部验收

- 本地生产构建演示先 `pnpm build`，再运行 `APP_MODE=demo pnpm start`；密码配置见 [README](../README.md)，手机 HTTPS 连接见[使用说明](usage.md#手机连接本地电脑)。真实模式为默认启动模式，演示必须显式选择 `demo`。
- 前端视口、焦点与状态检查遵循前端规则；当前操作见[使用说明](usage.md)，原模拟数值与复验步骤在[历史记录](archive/implementation-log-2026-10-14.md)；历史步骤涉及已移除页面时须按现行规格调整。
- 分别记录自动测试、模拟浏览器、实体手机和真实账户结果。已有未完成项包括实体 iOS 交互、双层止损 App 组合流程及真实账户只读联调，统一见[项目现状](status.md)，历史任务不能证明当前代码已通过。
- 需要核实交易所规则时访问规格中对应官方来源，并记录核验日期；本地模拟和官方 API 说明不能替代实际 App 流程验收。

## 多用户兼容入口（票据 01）

运行目标统一为 `.nvmrc` 的 Node 24.22.0；继续使用 pnpm 11.7.0、单一 package 和锁文件。`pnpm build` 先生成 Prisma 客户端，再构建旧 Vite 和新 Next；构建不提供数据库连接、认证 Secret、委托私钥或用户 Key 解密主密钥。`pnpm typecheck` 同时检查旧入口和 Next，并先生成 Next 路由类型，支持干净检出。

新模块：`web/` 是 Next 页面与认证入口，`src/identity/` 管理 Better Auth、数据库和委托，`src/business-main.ts` 启动独立业务服务。业务服务提供当前产品用户资料及票据 04 的 Binance 绑定入口，所有旧账户、账本及静态路径均不转发。旧共享密码 Cookie 与新 `workbench` Cookie 相互不认可；旧 SQLite、本单及无归属浏览器存储保持在原入口。Next 认证页和私有页采用完整动态渲染及每请求 nonce CSP，不启用与 nonce 静态壳不兼容的部分预渲染；票据 02 的公开首页采用静态输出与构建脚本 hash CSP，见下文。Next 与 Better Auth 遥测显式关闭。

Prisma CLI、客户端及 pg adapter 锁定同一 7.10.1 patch；Next 16.4.2、React/React DOM 19.3.1、Better Auth 1.7.10。新增依赖承担已确认的框架、认证及 PostgreSQL 职责，现有 Vue/Vite 及计算模块保留。pnpm 仅放行 Prisma 与其 engines 的必要构建脚本，core-js 继续禁止。Better Auth 的跨运行时声明引用未安装的 `bun:sqlite`，因此 TypeScript 使用 `skipLibCheck` 跳过依赖声明检查；项目源码及 Vue/React 模板继续严格检查。

### 本地合成演示

1. 使用 Node 24，安装锁文件依赖，启动 Docker。
2. 运行 `pnpm build`。
3. 运行 `pnpm demo:auth`，进入 <http://127.0.0.1:3100/login>。两个用户为 `alice@example.test`、`bob@example.test`，合成测试口令均为 `synthetic-login-only-01`。这些值只用于临时演示，不能部署到外部环境。
4. 按 Ctrl-C 停止演示。脚本关闭两个服务并删除本次 PostgreSQL 容器；不挂载宿主机数据目录，不修改原 `.env`、SQLite 或真实数据库。

演示使用生产 Next 构建、3100 网页端口及 3101 业务端口；每次创建随机名称的 `postgres:17` 容器、随机本机数据库端口、新数据库、认证 Secret 及 Ed25519 密钥对。票据 05 起，演示运行器在自身进程内向业务服务注入合成 transport，Next 子进程接收委托私钥但不接收凭据主密钥。独立生产业务入口仍只接收委托公钥；演示不加载原进程的真实 Binance/模型凭据。数据库仅预置合成用户且邮箱已验证，使用 Better Auth 的密码哈希格式，注册与邮件验证见下方票据 02；不提供运维接口。

### 检查与安全边界

- `pnpm test:auth`：通过真实生产 HTTP 入口验证登录、资料、登出、停用、邮箱未验证、过期/伪造/跨用户委托、会话撤销及 Cookie 续期、授权代次、来源检查、故障关闭、旧身份隔离及启动中断清理；使用独立 PostgreSQL。HTTP 测试前运行 `pnpm build`。
- `pnpm test:browser:auth`：独立 Playwright 配置，生产构建和临时 PostgreSQL，Chromium/WebKit 覆盖 320px、390px、1280px、键盘、双用户、跨标签退出、返回与迟到响应。固定网页/业务端口 4180/4181。
- `pnpm check`：保留旧检查顺序，并在末尾运行上述两项；Docker 不可用时明确失败，不用内存或 SQLite 冒充 PostgreSQL 通过。

独立运行脚本为 `pnpm start:web`（默认 127.0.0.1:3100）、`pnpm dev:web` 和 `pnpm start:business`。它们不自动加载旧 `.env`，须由调用环境提供以下配置；本票演示/测试脚本自动生成全部配置，无需手动设值。

| 配置                     | 使用者           | 要求                                                         |
| ------------------------ | ---------------- | ------------------------------------------------------------ |
| `DATABASE_URL`           | Next、业务服务   | PostgreSQL 连接；分别按服务授予权限，迁移 DDL 凭据不用于构建 |
| `AUTH_ORIGIN`            | 两个服务         | 网页精确 origin，本地 HTTP 只允许 loopback                   |
| `BUSINESS_ORIGIN`        | 两个服务         | 业务精确 origin，必须与实际监听或受信 TLS 入口一致           |
| `AUTH_SECRET`            | 仅 Next          | 至少 32 字符，与委托及凭据加密密钥分开                       |
| `DELEGATION_PRIVATE_KEY` | 仅 Next          | Ed25519 PKCS8 DER 的 base64，只签发短期受限业务委托          |
| `DELEGATION_PUBLIC_KEY`  | 仅业务服务       | 对应 SPKI DER 的 base64，用于验签                            |
| `BUSINESS_HOST`          | 仅业务服务，可选 | 默认 `127.0.0.1`，外部运行方式在获授权部署阶段确定           |

会话采用 7 天滚动有效期、24 小时续期检查；RSC 只读不续期，客户端必经的受保护 Route Handler 转发续期 Set-Cookie。委托有效期 60 秒，绑定原会话、产品用户、授权代次、签发方、接收服务及 `profile:read`。每次业务读取仍从数据库复核会话有效期、用户停用/邮箱验证、当前代次和资源归属。浏览器委托仅驻请求内存并经 Authorization 头发送，跨源只允许精确网页 origin，不开放跨主机 Cookie。登出、跨标签身份变化、页面隐藏/离开均清除可见资料并递增请求代次，迟到响应不能恢复旧内容。依赖不可用返回 503，不伪装成未登录或清除有效 Cookie。

票据 01 的本地验收不代表公开注册、Binance 绑定、云端数据库、真实外部链路、实体手机或部署已完成。

## 公开官网与注册（票据 02）

`/` 在构建期生成真实产品正文、标题、描述、canonical 与 Open Graph；独立客户端导航读取最小登录状态，失败不影响正文。`/login`、`/register`、`/verify-email` 与私有入口保持 noindex/no-store。robots 不阻止认证页抓取，使搜索引擎能读取 noindex；sitemap 仅列公开首页。`APP_ENV=production` 才允许公开页面索引，local/test/staging 均加 X-Robots-Tag；此开关与 NODE_ENV 分离。

| 配置                    | 使用时点        | 要求                                                                                                                                 |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENV`               | 构建、Next 运行 | local（缺省）、test、staging、production；真实生产与预览分别显式配置                                                                 |
| `SITE_ORIGIN`           | 构建            | canonical/sitemap 的固定 origin，经过同等 origin 校验，不读取 Host；local/test 缺省 `http://127.0.0.1:3100`，staging/production 必填 |
| `AUTH_MAIL_FAKE_ORIGIN` | Next 运行       | 仅 local/test 允许的 loopback fake 收件服务；演示和测试自动提供，不支持真实收件人投递                                                |

`pnpm build:web` 先准备生成目录，再构建 Next，最后从静态首页 HTML 计算精确脚本/样式 SHA-256 hash，写入忽略的 `web/generated/public-security.json`。Proxy 为首页使用这些 hash，不开放任意内联脚本；认证和私有页继续每请求 nonce。生成文件包含在 Next 输出追踪中，缺失或空 hash 时官网故障关闭；须使用完整脚本构建。生产托管打包仍需在票据 28 验收，当前仅验证本地 `next start`。

注册使用 Better Auth 创建邮箱密码身份，但禁止自动发信和自动登录；账号事务提交后，再在当前请求内等待发信，超时 3 秒。不创建邮件补偿队列，失败保留待验证账号，日志仅记 `auth-mail:unavailable`。注册和重发返回相同的通用确认，不返回已有用户资料、不保证投递；用户主动重发恢复。验证链接 1 小时有效，只验证邮箱，之后须手动登录。客户端密码不写入浏览器存储，提交成功清除密码字段。密码恢复与设备会话见下方票据 03。

注册每 IP 每小时 10 次；注册发信和重发共享每邮箱每 15 分钟 3 次。所有认证配额使用同一 PostgreSQL 原子 upsert，429 附标准 Retry-After；数据库失败返回 503。配额键用认证 Secret 做 HMAC，不明文保存邮箱或 IP。Vercel 下按[官方请求头说明](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for)只信任平台覆盖的 `x-vercel-forwarded-for`，独立本地进程忽略自报的代理 IP、使用保守共享桶；其他托管入口的可信 IP 转发需上线前验证。限流过期按请求时判断，不依赖清理任务；过期记录的批次维护与其他认证状态清理一并在上线阶段落实。

`pnpm demo:auth` 另启本地 3102 fake 邮件夹具，在 `/messages` 查看仅本次合成环境的验证邮件。夹具只监听 loopback，不属于生产应用路由，不连接真实邮件服务。Ctrl-C 同时关闭收件箱、两个服务及临时 PostgreSQL。

`node --test test/auth/registration.test.ts` 覆盖两个新注册用户、验证前拒绝、字段保护、失败/超时重发、重复注册、过期/篡改链接、来源、数据库故障关闭、两个 Next 进程共享并发限流及公开原始 HTML。`pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/registration.spec.ts` 使用生产 CSP，验证完整注册与重发、错误/冷却、键盘及 320/375/390/414/768/1280px。运行前先 `pnpm build`；均仅使用 fake 邮件与隔离 PostgreSQL。

## 密码恢复与设备会话（票据 03）

`/forgot-password` 发送重置链接，`/reset-password` 设置新密码，`/dashboard/security` 展示当前用户有效会话及当前设备标记，提供单个撤销和退出其他设备。页面复用原生表单及工作台身份清理机制，保持 noindex/no-store 和 nonce CSP。

Better Auth 负责密码哈希和重置协议；链接有效期 1 小时，成功消费一次。PostgreSQL 事务将令牌消费、全部旧会话撤销和密码更新一起提交，失败一起回滚；重置后须手动登录。页面从地址栏移除令牌，不持久保存密码或令牌；提交、隐藏或离开时清空密码字段。找回响应对已有和未知邮箱均为通用确认，发信失败可主动重发。每 IP 每分钟最多 30 次找回请求，每邮箱每 15 分钟最多 3 次；配额沿用数据库原子更新，429 提供 Retry-After。邮件仍仅使用本机 fake 适配器，不代表真实投递已接通。

设备列表只返回会话 ID、当前设备标记、浏览器信息及登录/到期时间，不返回会话令牌或 IP。撤销由 Better Auth 执行，服务端检查页面所属用户、当前有效会话及最近 15 分钟内的密码登录；单个撤销不能选择当前设备或其他用户会话。旧业务委托在下一次请求中因原会话失效被拒绝。另一设备在刷新、重新显示页面或发起受保护请求时重新核验；不依赖跨设备推送。普通退出和页面会话撤销不等于取消已接受后台任务。

数据库故障返回 503，不冒充未登录，不清除有效 Cookie；故障恢复后可继续使用原会话。定向验证先 `pnpm build`，再运行 `node --test test/auth/password-sessions.test.ts` 和 `pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/password-sessions.spec.ts`。使用两个合成用户、两个设备会话、fake 邮件及隔离 PostgreSQL，涵盖并发消费、过期/重放、回调/来源、越权、登录时限、事务失败回滚、数据库故障与浏览器身份隔离。

### 票据 03 人工验证

1. 使用 Node 24.22.0，启动 Docker，运行 `pnpm build`，再运行 `pnpm demo:auth`。打开 <http://127.0.0.1:3100/login>；合成用户 `alice@example.test` 和 `bob@example.test` 的初始密码均为 `synthetic-login-only-01`。
2. 用普通窗口和隐私窗口分别登录 Alice，模拟两个设备；同一普通窗口的两个标签共享 Cookie，不能代替两个设备。在普通窗口进入“安全设置”，确认显示当前设备和另一会话。撤销另一会话后，隐私窗口刷新应回到登录页，普通窗口保持登录。重新登录隐私窗口，再测试“退出其他设备”。
3. 在安全设置选择“通过邮箱重置密码”，输入 Alice 邮箱。打开 <http://127.0.0.1:3102/messages>，复制最后一封发往 Alice 的邮件中 `url` 值并打开。输入两次相同的新密码（12–128 字），确认成功提示和全部旧会话失效；Bob 的独立会话仍可使用。用旧密码登录应失败，用新密码登录应成功。
4. 再次打开同一个邮件链接，应提示无效或过期。两次新密码不同应在页面被拒绝；未知邮箱的找回提示应与已有邮箱一致。同一邮箱连续第 4 次请求应收到冷却提示。
5. 同一浏览器打开两个工作台标签，在一个标签退出，另一个应清除私有资料；浏览器返回不能恢复原资料。改为 Bob 登录后应只显示 Bob 的资料和会话。分别用 320、390、1280px 视口检查溢出，用 Tab/Enter 操作表单及撤销按钮。
6. 可保留登录超过 15 分钟后验证撤销被要求重新登录；链接超过 1 小时后验证过期。并发消费和数据库事务故障由上述自动测试快速覆盖。Ctrl-C 关闭演示会清理本次临时数据库，下次启动恢复初始合成用户。

## Binance 只读绑定（票据 04）

已验证用户可从工作台进入 `/dashboard/connections`。首次绑定和同 UID 换 Key 均由业务服务复用固定白名单 GET 核实完整只读权限与稳定 UID；任何写权限、缺失字段、身份不明或上游失败都保留原数据。已有活跃绑定时不同 UID 返回 409；解绑、归档浏览及换账户由票据 23 实施。此页面不迁移旧 SQLite 或模拟身份；资产读取由下方票据 05 接入。

绑定读写分别使用 `binding:read`、`binding:write` 短期委托，资料仍只允许 `profile:read`。写入要求精确 Origin、有效数据库会话、已验证且未停用用户，以及 15 分钟内创建的密码登录会话；超时需重新登录。事务在用户和会话行锁下再次检查授权，唯一约束同时保证每用户最多一个活跃绑定及 UID 独占，归档 UID 也保留占位。同 UID 换 Key 保留绑定 ID，递增凭据、绑定授权及用户授权代次，旧委托失效。

每次提交带用户作用域 `requestId`；相同标识与相同凭据重试返回原结果，不重复核验或轮换，同标识不同内容返回 409。摘要使用主密钥 HMAC，不保存可离线猜测的明文摘要。浏览器只在当前提交处理凭据，提交即清空字段，后台、离开、退出或跨标签身份变化时清除可见状态并拒绝迟到响应。绑定读写强制对照页面所属产品用户与委托用户；Cookie 身份已改变而广播尚未收到时，也在发送凭据前拒绝。

业务服务写入绑定时另需两项独立配置，Next 不接收它们，构建也不要求配置：

| 配置                            | 要求                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CREDENTIAL_MASTER_KEY`         | 独立保管的 32 字节随机密钥，以规范 base64 提供；仅业务服务解密，不放数据库、仓库或业务备份，不复用认证 Secret |
| `CREDENTIAL_MASTER_KEY_VERSION` | 当前主密钥的正整数版本；AES-256-GCM 认证数据绑定产品用户、归属实例、用途、凭据版本及主密钥版本                |

主密钥缺失或无效时绑定写入返回 503，资料与非敏感连接状态仍可读。轮换主密钥不能只替换环境变量后声称旧密文仍可用；密钥管理设施、受控重加密和恢复流程须在部署前单独落实。数据库保存密文及版本，响应仅含绑定元数据，不回显 Key、Secret 或密文；原子替换失败不删除旧凭据。

`pnpm demo:auth` 可查看设置与资产页，使用随机的合成主密钥且不会加载真实 Binance 凭据。真实 Binance 联调另需授权；仅提交专用只读凭据。`test/auth/binding-fixture.ts` 及 `assets-fixture.ts` 用于自动测试和本地合成演示，以替换 transport 提供合成 UID 和资产，生产入口没有切换到这些 transport 的配置。

定向验证（先 `pnpm build`）：`node --test test/auth/binding.test.ts test/auth/credential.test.ts`；浏览器运行 `pnpm test:browser:auth`。测试使用隔离 PostgreSQL 17，覆盖权限/UID 失败关闭、首次绑定、同 UID 轮换、不同 UID 拒绝、幂等、双用户争同 UID、单用户争两个 UID、归档占位、来源和越权拒绝、15 分钟确认及核验中退出。凭据公开封装边界验证错用户、用途、绑定、版本、主密钥和篡改拒绝。Chromium/WebKit 覆盖三种视口、字段清空、浏览器存储、焦点、跨用户退出与迟到响应。

## 多用户资产与读取协调（票据 05）

新入口 `/account` 展示当前绑定的 USDT 资产；`/dashboard` 展示每轮完成后 3 秒更新的摘要，资产页每轮完成后等待 30 秒。业务服务开放 `account:read` 委托及 `/v1/users/:userId/account/{summary,assets,positions,orders,conditional-orders}` 固定 GET，拒绝查询参数；页面仅使用摘要或资产入口，持仓和两类委托只保留后端能力。资产自动读取最多复用 30 秒结果，主动读取与摘要最多复用 2.9 秒结果，响应保留原查询时点。正式开仓与核验仍需后续票据的严格读取。

`src/bindings/account.ts` 按产品用户、绑定、凭据和授权代次管理私有缓存及失败；每次实际发送前复核绑定和仍有效的读取会话，返回前再次复核调用者。`src/binance-egress.ts` 使用 PostgreSQL 原子领取调度权，持久化合约请求权重、归档预留和上游冷却。当前一个安装共用保守的出口桶，多个出口也共用额度；不得部署多个不共享数据库的调度者到同一出口。合约额度从白名单 exchangeInfo 获取，75% 后暂停归档、保留前台余量；429/418 冷却同时约束绑定与账户读取。实例交接不重置已记录的冷却，正常退出等待在途请求，崩溃后的执行权按租约回收。真实出口规则与生产交接另属外部验收。

新迁移 `202610160003_binance_egress` 由合成测试运行器应用到临时 PostgreSQL；本票不执行真实库迁移。构建不需要解密主密钥。`pnpm demo:auth` 和浏览器夹具直接注入合成 transport，不提供生产环境的模拟开关；其页面明确标注模拟来源。

### 人工验证

启动 Docker，使用 `.nvmrc` 的 Node 版本，在仓库执行：

若已有旧版本演示运行，先在对应终端按 Ctrl-C 释放 3100–3102 端口，再启动本票构建。

```sh
pnpm build
pnpm demo:auth
```

打开 <http://127.0.0.1:3100/login>，用两个相互隔离的浏览器配置（例如普通窗口和无痕窗口）验证：

| 合成用户 | 登录邮箱             | API Key               | API Secret               | 预期账户权益         |
| -------- | -------------------- | --------------------- | ------------------------ | -------------------- |
| 甲       | `alice@example.test` | `synthetic-key-alice` | `synthetic-secret-alice` | `975.09999999 USDT`  |
| 乙       | `bob@example.test`   | `synthetic-key-bob`   | `synthetic-secret-bob`   | `2050.00000000 USDT` |

两者登录口令均为 `synthetic-login-only-01`。表中全部是本地夹具值；不要在此演示中输入真实 Key。

1. 分别登录，进入“连接设置”，提交对应合成 Key。返回工作台，确认用户、UID、摘要金额对应，且标有“模拟数据 · 不代表真实账户”。两个用户不能串用金额。
2. 从“账户资产”进入 `/account`：账户权益、可用余额、未实现盈亏及默认展开的资金明细可读；页面没有持仓或委托列表。收起明细，刷新后仍保持收起，按钮焦点不跳动。
3. 在开发者工具 Network 中仅筛选 `/account/`：工作台摘要每轮完成后约 3 秒查询，资产页每轮完成后约 30 秒查询；手动刷新会重置计时，忙时不重复发起。2.9 秒内主动复用时，成功查询时间保持原值。
4. 开启浏览器离线模式：保留旧金额和原成功时间，标记“网络已断开 / 数据待更新”；恢复联网后重新查询。切换到其他标签页再返回，也会重新确认身份和查询，不接受已取消的旧响应。
5. 在同一浏览器另开标签页，退出登录：两个标签的旧资料和资产均消失；返回历史页面不能恢复旧资产。再登录另一用户，显示另一用户的资产。
6. 在连接设置用 `synthetic-key-alice-rotated` 和 `synthetic-secret-alice-rotated` 更新甲用户：UID 仍为 `10001`，重新读取后仍为甲的资产。登录超过 15 分钟时先重新登录。
7. 切换 320px、390px、1280px 视口，检查完整金额、无横向溢出、Tab 焦点、说明和资金明细开合。Ctrl-C 停止演示会删除本次临时数据库，下次启动须重新绑定。

共享限流、实例交接、权限失败隔离、超时及迟到响应由替换 transport 自动验收，不需要真实交易所触发限流：

```sh
node --test test/auth/assets.test.ts test/auth/egress.test.ts
pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/assets.spec.ts
```

浏览器测试使用固定 4180–4182 端口；完整 `pnpm check` 还使用旧入口 4179，避免多个 worktree 同时占用这些端口。测试需先构建；模拟浏览器不等于实体手机和真实 Binance 验收。

## 完整交易账本（票据 11）

新 `/review` 与 `/review/trades/:id` 从 PostgreSQL 读取当前用户活跃绑定的周期及证据。`src/review-reader.ts` 提供可等待的读取边界，原 SQLite 同步调用继续保留；摘要和交易校验沿用旧实现。`review_cycle` 按归属实例、来源和稳定周期 ID 隔离，金额为字符串；列表不携带完整证据，详情通过受保护 Node 直连返回，包含原始订单、成交、资金费与缺口，不经过 Next 代理大 JSON。

本票不提供同步、订单主列表、笔记或方案对照操作。真实新账户的空账本是正常状态；同步与归并由票据 12 接入。页面进入、主动筛选/翻页和列表/详情切换读取本地账本；隐藏/离线取消请求，恢复可见只确认身份，保留已有内容与筛选输入，不自动重读账本。退出、不同登录用户及绑定代次变化不会恢复旧私有内容。

定向检查（先 `pnpm build`）：

```sh
node --test test/auth/review.test.ts test/review-ledger.test.ts
pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/review.spec.ts
```

### 票据 11 人工验证

1. 使用 Node 24.22.0、pnpm 11.7.0 并启动 Docker。在当前分支运行 `pnpm build`，再运行 `pnpm demo:auth`。访问 <http://127.0.0.1:3100/login>。
2. 普通窗口登录 `alice@example.test`，无痕窗口登录 `bob@example.test`，密码均为 `synthetic-login-only-01`。分别在连接设置提交 `synthetic-key-alice` / `synthetic-secret-alice` 和 `synthetic-key-bob` / `synthetic-secret-bob`。这些全是合成夹具值，不能输入真实凭据。
3. 在另一个终端运行以下命令，将周期写入刚才两个绑定各自的临时 PostgreSQL 账本。此路由仅属于本机测试运行器，生产服务没有对应入口；未绑定的合成用户不会写入记录。

   ```sh
   curl --fail --request POST http://127.0.0.1:3102/seed-review
   ```

4. 从工作台进入“完整交易”。甲共 25 条，乙共 2 条；甲首页 20 条，第二页 5 条。打开两个用户都存在的 `cycle-00`，净盈亏分别为 `9.8 USDT`、`29.8 USDT`。页面显示模拟来源及未发现历史范围的提示。
5. 甲第二页打开 `missing-cost`：已实现盈亏 `10 USDT`，手续费和净盈亏待确认；打开 `missing-start`：起点、开仓时间和净盈亏待确认，已知成交仍可展开。检查订单、逐笔成交、资金费和原始证据。浏览器后退应回到第二页，详情 URL 可直接打开。
6. 按北京时间开仓日期筛选 `2026-10-14`：甲匹配 24 条，未知起点被排除；`2026-10-15` 无匹配记录。选择交易对、翻页、进入详情再返回，条件保持。反向日期应报错，不能显示为已确认的零记录。
7. 在筛选框填写日期但先不提交，切到其他标签页再返回：输入和原结果保留。Network 中复盘请求没有定时轮询或返回后重读，也没有 `/account/` 资产请求。离线时保留旧结果提示，联网后点击“重新读取”。
8. 同一浏览器另开复盘标签并退出登录：原标签私有内容清除，后退不能恢复；重新登录另一用户不会显示前一用户账本。检查 320px、390px、1280px：仅表格内部横向滚动，Tab 与 Enter 可操作，重新读取后按钮焦点保持。

Ctrl-C 停止演示会删除临时数据库，再次启动需要重新绑定并注入样本。自动测试另覆盖非法参数、详情越权、换 Key 后旧授权拒绝、超过 4.5 MiB 证据直传及无损金额；本地合成验收不代表真实 Neon/Binance、实体手机或生产部署通过。

## 自备模型 Key（票据 19）

已验证用户可从工作台进入 `/dashboard/ai`，不需要先绑定 Binance。固定使用现有 DeepSeek / `deepseek-v4-pro` / `high`；保存时只通过固定 `https://api.deepseek.com/models` 读取并验证容量元数据，失败保留已有设置，不发起分析请求。浏览页面与撤销不会访问模型商，不接受自定义 URL，也不回退到平台 Key。费用由用户向模型商支付，Token 用量不等同账单金额。

模型读写使用 `model:read` / `model:write` 委托，写入要求最近 15 分钟内的密码登录。服务端按产品用户授权，在事务内重新核验会话，保存时认证加密绑定用户、独立模型凭据 ID、用途及版本，复用票据 04 的主密钥配置。替换或撤销递增凭据和用户授权版本；旧委托失效，撤销删除密文及主密钥版本，即使主密钥不可用也可撤销。表单提交立即清空，隐藏、离开、退出清理组件与请求，页面身份和委托身份不一致时拒绝发送 Key。

PostgreSQL 迁移 `202610160004_model_credential` 增加独立凭据、用户作用域幂等请求及失效记录，替换/撤销与失效记录同一事务提交；失败全部回滚。重复请求不再次验证或轮换，返回当前设置，不能恢复旧版本。凭据不进入业务备份和公开 DTO；Next 不持有解密主密钥。本票失效记录仍在业务库内，**独立于恢复点的控制记录与恢复重放由票据 24/25 实施，尚不能证明恢复旧库后凭据不会复活**。任务使用版本及换 Key 后明确继续由票据 20/21 接入；本票不会新增或启动模型分析任务。

定向检查（先 `pnpm build`）：

```sh
node --test test/auth/model-key.test.ts test/auth/credential.test.ts
pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/model-key.spec.ts
```

### 票据 19 人工验证

1. 使用 `.nvmrc` 指定的 Node 24.22.0，启动 Docker，在仓库运行 `pnpm build`，再运行 `pnpm demo:auth`。若已有演示，先在原终端 Ctrl-C 关闭。打开 <http://127.0.0.1:3100/login>，用 `alice@example.test` / `synthetic-login-only-01` 登录。
2. 不绑定 Binance，进入“模型设置”。确认固定模型、费用说明与“尚未设置模型 Key”。提交合成值 `synthetic-model-alice`，应显示已保存和北京时间验证时点，输入框立即清空；刷新后状态保留，Key 不回显。
3. 提交 `synthetic-model-invalid`，应提示验证失败、原有设置保留；再提交 `synthetic-model-alice-rotated`，应成功更新。选择“撤销模型 Key”，应显示已撤销，刷新仍保持；再次保存可重新启用。成功替换、撤销及重新保存时，Network 响应的 `credential.version` 应递增。整个演示只使用合成 transport，勿输入真实 Key。
4. 浏览器 Network 中模型业务响应只返回设置元数据，不含 Key 或密文；Application 中 localStorage/sessionStorage 不含 Key。输入一个尚未提交的 Key，切换标签再返回或离开页面后返回，输入框应为空。
5. 在独立无痕窗口用 `bob@example.test` / `synthetic-login-only-01` 登录，设置 `synthetic-model-bob`。甲乙设置各自独立；同浏览器两个标签中任意一个退出，另一个须清除私有状态，返回不能恢复旧资料。
6. 撤销后返回工作台、进入安全设置或已绑定账户的资产页，仍可正常使用。登录超过 15 分钟后修改 Key 应要求重新登录。旧报告的多用户入口及任务续跑仍待后续票据，不能以本页面代替其验收。
7. 用 320px、390px、1280px 视口检查溢出，用 Tab/Enter 提交，确认按钮忙碌状态。Ctrl-C 停止演示会清理本次临时 PostgreSQL；下次启动恢复为未配置状态。

并发替换/撤销、旧委托拒绝、校验期间失效和数据库事务回滚由自动测试覆盖。真实 DeepSeek、Neon、实体手机及灾备恢复均需后续独立验收。
