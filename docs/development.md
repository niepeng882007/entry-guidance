# 开发与验证

项目地图与规格入口见 [公共索引](index.md)。

## 双层止损与余仓核验（票据 09）

多用户 `/entry` 支持市价和 GTC 限价的双层方案，复用共享计算与核验，未改变风险算法。初始全部数量按最终止损计算；近端默认 70%，按退出步长向下取整，最终单始终为整仓退出，两层覆盖不相加。实际入场量变化后按原输入比例重算近端分配；原卡、原预算和两个绝对止损保持固定。

### 票据 09 人工验证

1. 使用 Node 24.22.0，启动 Docker，运行 `pnpm build`，再运行 `pnpm demo:auth`。打开 <http://127.0.0.1:3100/login>，使用 `alice@example.test` / `synthetic-login-only-01` 登录；连接设置保存 `synthetic-key-alice` / `synthetic-secret-alice`。这些都是合成值，勿输入真实 Key。
2. 打开 `/entry`，选 BTCUSDT、做多、市价、双层、固定预算 `20` USDT、最终绝对止损 `98`、近端绝对止损 `99`、近端比例 `70`%、杠杆 `10`、滑点 `1`%、资金费预留 `1` USDT、最低缓冲 `1`%、本单资金上限 `5` USDT。生成后开仓量应为 `0.4 BTC`，近端只减仓量 `0.2 BTC`，取整后实际比例 `50%`，最终计划余量 `0.2 BTC`；最终单的设置方式应明确为整仓退出。初次选择双层不应预填近端止损值。
3. 另开终端切换合成场景，再点击“重新查询原方案”：

   ```sh
   curl --fail http://127.0.0.1:3102/entry-scenario \
     -H 'Content-Type: application/json' \
     -d '{"user":"alice","scenario":"two-protected"}'
   ```

   `two-protected` 应通过，持仓 `0.4 BTC`、近端待退出量 `0.2 BTC`，最终覆盖为整仓。将场景改为 `two-final-only` 或 `two-near-canceled`，应显示“需要处理”和近端待补齐，不能仅凭最终单通过。

4. 切换 `two-near-filled`：余仓 `0.2 BTC`、近端“已执行”、待退出量 `0`、已实现损益 `-0.2 USDT`、全部已付手续费 `0.0598 USDT`、已付资金费 `0.3 USDT`、剩余预留 `0.7 USDT`、含成本计划亏损 `1.875204 USDT`，应通过。刷新页面会恢复原方案并重新查询，原卡仍保留数量 `0.4`、预算 `20`、两止损 `99` / `98`。
5. 切换 `two-partial-canceled`：余仓 `0.3 BTC`、近端尚需退出 `0.1 BTC`、含成本计划亏损 `2.073006 USDT`，应显示需要处理。切换 `two-partial-covered` 模拟补齐剩余近端单，应显示“部分执行，剩余近端有效待触发”并通过。`two-final-canceled` 应要求补齐最终保护；`two-missing-pnl`、`two-missing-attribution` 应无法完整核验，`two-missing-cost` 应显示读取错误，均不能保留旧通过。
6. 回到 `two-near-filled` 后分别编辑近端价格、方式或比例：当前通过立即消失，原卡复制禁用；刷新保留编辑输入，不能自动恢复通过。点击“恢复原方案输入并核验”才恢复原输入并重新查询。断网、切换到别的 App 后返回，也应重新查询。用 320px、390px、1280px 检查无横向溢出，Tab / Enter 可操作复制。
7. 切回 `flat`，清除本浏览器记录，按相同参数选择 GTC 限价 `100`：原卡数量 `0.495 BTC`、近端 `0.3 BTC`、最终计划余量 `0.195 BTC`。将以上场景前缀 `two-` 换成 `two-limit-`；它们模拟入场仅成交 `0.4 BTC` 且余单已撤，因此近端应按原比例重算为 `0.2 BTC`，原卡不变。改单层后近端输入隐藏，原单层恢复继续有效。
8. 无痕窗口用 `bob@example.test`（同口令）登录并绑定 `synthetic-key-bob` / `synthetic-secret-bob`，不应看到甲的本单。结束演示按 Ctrl-C，脚本会关闭服务并删除本次临时数据库。

真实 Binance App 双层组合操作、实体手机和真实账户读取仍属于外部验收；本机合成结果不替代这些证据。自动回归入口（HTTP/浏览器前先构建）：

```sh
node --test test/auth/entry.test.ts test/draft.test.ts test/verification.test.ts
pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/entry.spec.ts
```

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

## 单层市价开仓（票据 06）

本节保留票据 06 交付时的阶段边界；当前版本的成交核验、刷新恢复及原卡重查以[票据 07](#单层核验与本单恢复票据-07)为准。

新入口为 `/entry`，从工作台的“开仓计划”进入。复用原 BigInt 计算、合约步长、费用、资金缩量、强平缓冲及 `createPlan` 空仓起点检查。`src/bindings/entry.ts` 负责绑定内严格读取及方案事务保存，`entry_plan` 保存固定方案、原输入、来源和不可复用绑定归属。`entry:read` / `entry:write` 为独立受限委托，正式生成不使用观察缓存；数据库写入成功前不返回卡片。读取已保存方案仅返回原始记录，不表示重新验证或恢复可执行状态。

本票按用户确认采用阶段性保守失效：输入修改、离开/隐藏、离线、账户余额变化、读取失败或生成数据超过 30 秒后停用复制，摘要恢复成功不重启原卡。显式重新生成仍须严格确认空仓和无干扰委托，不能用于已有持仓扩大预算。成交核验、原卡最新检查和可信恢复留票据 07；限价、双层、浏览器偏好分别留后续票据。浏览器不持久化本票的输入与卡片，整页刷新后不恢复旧卡。

### 本地人工验证

使用 `.nvmrc` 指定的 Node 24.22.0、pnpm 11.7.0 并启动 Docker，然后运行：

```sh
pnpm build
pnpm demo:auth
```

1. 打开 `http://127.0.0.1:3100/login`，使用合成用户 `alice@example.test`、口令 `synthetic-login-only-01` 登录。
2. 在连接设置输入 `synthetic-key-alice` / `synthetic-secret-alice` 并保存。这里只验证合成响应，不提交真实 Key。
3. 打开 `/entry`，选 BTCUSDT、做多、固定 USDT 预算 `20`、绝对止损 `98`、杠杆 `10`、滑点 `1`%、资金费 `1` USDT、最低缓冲 `1`%、本单资金上限 `5` USDT。
4. 确认草稿与含资金约束的预演分开展示。点击“刷新并生成开仓卡”，预期数量 `0.4 BTC`、止损 `98 USDT`、固定预算 `20 USDT`，且明显标注模拟卡，不能用于真实交易。复制数量应仅得到 `0.4`，复制止损应仅得到 `98`。
5. 将预算改为 `21`，原卡预算仍为 `20`，复制停用。重新生成后断网或等待 30 秒，应再次停用复制；恢复联网不自动启用旧卡。切换页面或刷新后，不出现已恢复的可执行本单。
6. 将做多止损改为 `101`，或将最低缓冲提高到无法满足的值，应显示失败原因，不能生成有效卡。试用 320px、390px 和桌面宽度，并用 Tab 操作表单与按钮，检查溢出与焦点。
7. 无痕窗口用 `bob@example.test`（同一合成口令）及 `synthetic-key-bob` / `synthetic-secret-bob` 登录绑定，确认不会看到 Alice 的卡片；退出或跨标签退出后私有内容清除。
8. Ctrl-C 停止演示；临时数据库随之删除。演示数据不会保留到下次启动。

定向检查：`node --test test/auth/entry.test.ts test/draft.test.ts`；浏览器为 `pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/entry.spec.ts`，HTTP/浏览器之前先构建。存储失败、UID 不一致和生成期间凭据变化由合成故障测试验证，人工正常流程无法制造这些故障。真实 Binance、Neon 与实体手机验收仍属于后续授权范围。

## 单层核验与本单恢复（票据 07）

`/entry` 复用 `verifyPosition`，通过受保护 Node `POST /entry/plans/:id/verify` 查询原方案的实际持仓、成交成本、余单与止损覆盖。请求只接受空对象，预算、止损与空仓起点均来自服务端。核验结果与证据在 PostgreSQL `entry_verification` 保存成功后才返回；保存前重新检查会话和绑定版本，失败不能显示通过。

本浏览器以产品用户、绑定实例、UID、来源隔离保存方案 ID、未提交输入与上次查询时间，不保存通过状态、方案副本或凭据。刷新、重登、返回页面先确认身份并取回原方案；输入一致才自动重新核验，之后每轮完成 10 秒重查。联网恢复同样重新查询；编辑中的输入需显式“恢复原方案输入并核验”。账户变化、输入变化、离线、隐藏、过期或查询失败撤销当前结果。空仓只能为待成交，原卡最新检查适用时可复制；实际持仓只有完整核验通过才能显示查询时点通过。

同 UID 换 Key 保留可信方案，查询使用当前代次；归属、UID、来源不一致拒绝恢复。`trustedCurrent` 默认 false，历史备份不得授予此资格；迁移仅将票据 06 已由严格生成入口写入的既有记录标为可信。旧个人入口的签名凭证转换留给受控迁移票，不接收客户端上传计划。清除本浏览器记录不会删除服务端历史或改变交易所持仓。旧核验的不足 7 天、每类最多 1000 条等完整性限制继续适用。

### 票据 07 人工验证

1. 使用 Node 24.22.0、pnpm 11.7.0 并启动 Docker。运行 `pnpm build`，再运行 `pnpm demo:auth`。打开 <http://127.0.0.1:3100/login>，以 `alice@example.test` / `synthetic-login-only-01` 登录，在连接设置提交合成值 `synthetic-key-alice` / `synthetic-secret-alice`。
2. 进入 `/entry`，选择 BTCUSDT、做多，固定预算 `20` USDT、绝对止损 `98`、杠杆 `10`、滑点 `1`%、资金费 `1` USDT、最低缓冲 `1`%、资金上限 `5` USDT。生成后应为 `0.4 BTC`。刷新后恢复原卡并重新查询，显示“尚未成交”，不能显示成交核验通过。
3. 另开终端注入合成成交与有效止损；这个入口仅属于本机测试运行器，生产没有此路由：

   ```sh
   curl --fail http://127.0.0.1:3102/entry-scenario \
     -H 'Content-Type: application/json' \
     -d '{"user":"alice","scenario":"protected"}'
   ```

   回页面点击“重新查询原方案”，应显示“模拟核验”“查询时点核验通过”、数量 `0.4`、已付手续费 `0.04` USDT、已付资金费 `0.3` USDT，固定预算仍为 `20`、止损仍为 `98`。

4. 将上述命令的 `protected` 分别改成 `missing-stop`、`wrong-stop`、`missing-cost`、`failed`，每次点击重新查询：分别应提示缺少/错误止损、手续费缺失、查询失败，均不能保留通过。改回 `protected` 再查恢复通过。不要输入真实凭据；这些场景均由合成 transport 返回。
5. 将页面预算改为 `999`：通过立即消失，固定预算仍为 `20`。刷新后编辑值保留，不能自动核验；点击“恢复原方案输入并核验”后输入恢复为 `20`，重新查询才通过。已有持仓时尝试生成新方案应失败。
6. 断网、切换标签或离开页面，旧通过状态应撤销；回到页面/联网后确认身份并重查。退出后重登同用户可继续本单；另一标签退出应清除可见私有内容。无痕用 `bob@example.test`（同口令）及对应 `synthetic-key-bob` / `synthetic-secret-bob` 登录绑定，不应出现甲的本单。
7. 浏览器 Application 的本地存储只应包含按归属隔离的本单标识、输入与上次时间。清除本浏览器记录后卡片消失；服务端与模拟持仓不受影响。320px、390px、1280px 检查横向溢出、Tab 焦点和按钮禁用状态。

`pnpm demo:auth` 停止时删除临时数据库；重启演示会新建环境，不可用来证明同库重启恢复。业务服务保留数据库重启、查询途中会话撤销/换 Key、数据库写入失败和损坏浏览器存储由自动测试覆盖。真实 Binance/Neon、实体手机和生产迁移未在本票验收。

定向检查：先 `pnpm build`，再运行 `node --test test/auth/entry.test.ts test/verification.test.ts` 与 `pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/entry.spec.ts`。完整交付运行 `pnpm check`。

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

## 限价开仓与部分成交（票据 08）

`/entry` 支持单层市价及普通 GTC 限价。限价委托价必须满足原价格步长与范围，不静默取整；数量、资金缩量与费用预留继续复用共享 BigInt 计算。可信恢复支持两种入场方式，兼容票据 07 没有限价字段的浏览器记录。修改限价或入场方式立即撤销旧卡及核验，恢复只能取回固定原方案后重查。

部分成交按实际持仓与已发生费用核验，原方案数量、预算和绝对止损保持不变。入场余单存在时提示用户先在 Binance 撤销；止损或平仓不代表余单自动取消。历史终止状态与当前挂单不一致、费用缺失或止损不足均不能通过。工具只读，不下单或撤单。

### 票据 08 人工验证

使用 Node 24.22.0、pnpm 11.7.0，启动 Docker，在包含本票的工作目录执行：

```sh
pnpm build
pnpm demo:auth
```

1. 打开 `http://127.0.0.1:3100/login`，以 `alice@example.test` / `synthetic-login-only-01` 登录，在连接设置保存合成值 `synthetic-key-alice` / `synthetic-secret-alice`。勿输入真实 Key。
2. 打开 `/entry`，选 BTCUSDT、做多、普通限价 GTC、限价 `100`、固定预算 `20` USDT、绝对止损 `98`、杠杆 `10`、滑点 `1`%、资金费 `1` USDT、最低缓冲 `1`%、本单资金上限 `5` USDT。生成后数量为 `0.495 BTC`，可复制限价 `100`；刷新后恢复原卡并重新查询，空仓仍显示“尚未成交”。
3. 另开终端运行以下命令，再在页面点击“重新查询原方案”。这是本机演示夹具入口，生产没有此路由：

   ```sh
   curl --fail http://127.0.0.1:3102/entry-scenario \
     -H 'Content-Type: application/json' \
     -d '{"user":"alice","scenario":"limit-partial"}'
   ```

   预期实际持仓 `0.1 BTC`、手续费 `0.01 USDT`、余单 `0.395 BTC`，显示“需要处理”及人工撤余单提示，不显示通过。

4. 将命令中的场景改为 `limit-partial-more`：实际持仓 `0.4 BTC`、手续费 `0.04 USDT`、余单 `0.095 BTC`，仍不通过。改为 `limit-canceled` 模拟人工撤销余单，再查应显示“查询时点核验通过”；已付资金费 `0.3 USDT`、剩余预留 `0.7 USDT`、含成本计划亏损 `2.270808 USDT`。原卡始终为数量 `0.495`、预算 `20`、止损 `98`。
5. 依次切换 `limit-inconsistent`、`limit-missing-stop`、`limit-missing-cost`、`failed` 并重新查询：分别显示无法完整核验、需要处理或错误，不保留通过。恢复 `limit-canceled` 后重新查询才可通过。`limit-waiting` 为零成交挂单；`limit-unfilled-canceled` 为零成交已撤销，均不能通过。
6. 通过后将限价改为 `99.9`：旧通过立即消失，原卡仍为限价 `100`，复制停用。刷新保留编辑值且不自动核验；点击“恢复原方案输入并核验”恢复 `100` 并重查。断网、隐藏页面后旧结果失效，联网或返回后重新确认身份及查询。
7. 将夹具切为 `flat` 并清除本浏览器记录，重新填写相同参数但选市价：限价输入隐藏，生成数量回到 `0.4 BTC`。限价 `100.01`（不符合步长）或 `121`（超出价格范围）不能生成有效卡。
8. 用 320px、390px、1280px 检查横向溢出、Tab 焦点与 Enter 复制；无痕登录 `bob@example.test`（同口令）并绑定 `synthetic-key-bob` / `synthetic-secret-bob`，不应看到甲的本单。跨标签退出后私有内容清除。

演示全为合成响应；停止 `demo:auth` 会删除临时数据库。真实 Binance、Neon、实体手机及生产迁移未在本票验收。迟到响应、跨用户恢复拒绝及数据库持久恢复由自动测试补充。

定向检查（HTTP/浏览器前先构建）：

```sh
node --test test/auth/entry.test.ts test/draft.test.ts test/verification.test.ts
pnpm exec playwright test -c playwright.auth.config.ts test/auth/browser/entry.spec.ts
```
