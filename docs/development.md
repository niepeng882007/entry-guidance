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

演示使用生产 Next 构建、3100 网页端口及 3101 业务端口；每次创建随机名称的 `postgres:17` 容器、随机本机数据库端口、新数据库、认证 Secret 及 Ed25519 密钥对。只有 Next 子进程接收委托私钥，业务子进程只接收公钥；两个子进程都不接收原进程的 Binance/模型凭据或解密配置。数据库仅预置合成用户且邮箱已验证，使用 Better Auth 的密码哈希格式，注册与邮件验证见下方票据 02；不提供运维接口。

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

注册使用 Better Auth 创建邮箱密码身份，但禁止自动发信和自动登录；账号事务提交后，再在当前请求内等待发信，超时 3 秒。不创建邮件补偿队列，失败保留待验证账号，日志仅记 `auth-mail:unavailable`。注册和重发返回相同的通用确认，不返回已有用户资料、不保证投递；用户主动重发恢复。验证链接 1 小时有效，只验证邮箱，之后须手动登录。客户端密码不写入浏览器存储，提交成功清除密码字段。密码恢复与设备会话仍由票据 03 负责。

注册每 IP 每小时 10 次；注册发信和重发共享每邮箱每 15 分钟 3 次。所有认证配额使用同一 PostgreSQL 原子 upsert，429 附标准 Retry-After；数据库失败返回 503。配额键用认证 Secret 做 HMAC，不明文保存邮箱或 IP。Vercel 下按[官方请求头说明](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for)只信任平台覆盖的 `x-vercel-forwarded-for`，独立本地进程忽略自报的代理 IP、使用保守共享桶；其他托管入口的可信 IP 转发需上线前验证。限流过期按请求时判断，不依赖清理任务；过期记录的批次维护与其他认证状态清理一并在上线阶段落实。

`pnpm demo:auth` 另启本地 3102 fake 邮件夹具，在 `/messages` 查看仅本次合成环境的验证邮件。夹具只监听 loopback，不属于生产应用路由，不连接真实邮件服务。Ctrl-C 同时关闭收件箱、两个服务及临时 PostgreSQL。

`node --test test/auth/registration.test.ts` 覆盖两个新注册用户、验证前拒绝、字段保护、失败/超时重发、重复注册、过期/篡改链接、来源、数据库故障关闭、两个 Next 进程共享并发限流及公开原始 HTML。`pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/registration.spec.ts` 使用生产 CSP，验证完整注册与重发、错误/冷却、键盘及 320/375/390/414/768/1280px。运行前先 `pnpm build`；均仅使用 fake 邮件与隔离 PostgreSQL。

## Binance 只读绑定（票据 04）

已验证用户可从工作台进入 `/dashboard/connections`。首次绑定和同 UID 换 Key 均由业务服务复用固定白名单 GET 核实完整只读权限与稳定 UID；任何写权限、缺失字段、身份不明或上游失败都保留原数据。已有活跃绑定时不同 UID 返回 409；解绑、归档浏览及换账户由票据 23 实施。此页面不迁移旧 SQLite 或模拟身份，也不代表资产等业务已接入新绑定。

绑定读写分别使用 `binding:read`、`binding:write` 短期委托，资料仍只允许 `profile:read`。写入要求精确 Origin、有效数据库会话、已验证且未停用用户，以及 15 分钟内创建的密码登录会话；超时需重新登录。事务在用户和会话行锁下再次检查授权，唯一约束同时保证每用户最多一个活跃绑定及 UID 独占，归档 UID 也保留占位。同 UID 换 Key 保留绑定 ID，递增凭据、绑定授权及用户授权代次，旧委托失效。

每次提交带用户作用域 `requestId`；相同标识与相同凭据重试返回原结果，不重复核验或轮换，同标识不同内容返回 409。摘要使用主密钥 HMAC，不保存可离线猜测的明文摘要。浏览器只在当前提交处理凭据，提交即清空字段，后台、离开、退出或跨标签身份变化时清除可见状态并拒绝迟到响应。绑定读写强制对照页面所属产品用户与委托用户；Cookie 身份已改变而广播尚未收到时，也在发送凭据前拒绝。

业务服务写入绑定时另需两项独立配置，Next 不接收它们，构建也不要求配置：

| 配置                            | 要求                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CREDENTIAL_MASTER_KEY`         | 独立保管的 32 字节随机密钥，以规范 base64 提供；仅业务服务解密，不放数据库、仓库或业务备份，不复用认证 Secret |
| `CREDENTIAL_MASTER_KEY_VERSION` | 当前主密钥的正整数版本；AES-256-GCM 认证数据绑定产品用户、归属实例、用途、凭据版本及主密钥版本                |

主密钥缺失或无效时绑定写入返回 503，资料与非敏感连接状态仍可读。轮换主密钥不能只替换环境变量后声称旧密文仍可用；密钥管理设施、受控重加密和恢复流程须在部署前单独落实。数据库保存密文及版本，响应仅含绑定元数据，不回显 Key、Secret 或密文；原子替换失败不删除旧凭据。

`pnpm demo:auth` 可查看设置页，使用随机的合成主密钥且不会加载真实 Binance 凭据。真实 Binance 联调另需授权；仅提交专用只读凭据。`test/auth/binding-fixture.ts` 只用于自动测试，以替换 transport 提供合成 UID，生产入口没有切换到该 transport 的配置。

定向验证（先 `pnpm build`）：`node --test test/auth/binding.test.ts test/auth/credential.test.ts`；浏览器运行 `pnpm test:browser:auth`。测试使用隔离 PostgreSQL 17，覆盖权限/UID 失败关闭、首次绑定、同 UID 轮换、不同 UID 拒绝、幂等、双用户争同 UID、单用户争两个 UID、归档占位、来源和越权拒绝、15 分钟确认及核验中退出。凭据公开封装边界验证错用户、用途、绑定、版本、主密钥和篡改拒绝。Chromium/WebKit 覆盖三种视口、字段清空、浏览器存储、焦点、跨用户退出与迟到响应。
