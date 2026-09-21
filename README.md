# 开仓前 · 单层市价开仓卡

任务 01–03 的本地单人工作台：个人登录后查看 Binance USDT 合约账户，按预算、单层止损及成本假设即时试算；刷新并通过资金、账户档位及强平缓冲检查后，生成逐项复制的开仓卡，由用户在 Binance 手动带止损开仓。运行时仅使用 Node 内置模块和原生 HTML/CSS/JavaScript；TypeScript 和 Node 类型仅用于开发检查。工具不下单或修改账户设置，卡片不代表已挂好止损。

## 本机启动

需要 Node.js **22.21.0 或更高的受支持版本**（支持原生 TypeScript 和 `--use-env-proxy`），使用 npm。

1. `npm ci` 安装锁定的开发依赖。
2. 参考 [`.env.example`](.env.example)，在本机 `.env` 中设置至少 12 字符的独立 `APP_PASSWORD`。已有 `.env` 时合并变量，**不要覆盖原文件**。API Key、Secret、个人密码都只填写在本机，不发到聊天。
3. 首先运行模拟模式，无需 API 凭据：

```sh
APP_MODE=demo npm start
```

打开 <http://127.0.0.1:3000>，用 `APP_PASSWORD` 登录。模拟数据始终标识“模拟数据”，不发送任何 Binance 请求，也不代表真实账户验证。

连接真实账户时，在 `.env` 中配置专用 **HMAC** 类型的 `BINANCE_API_KEY`、`BINANCE_API_SECRET`，然后重启：

```sh
APP_MODE=real npm start
```

默认就是 `real`；没有完整凭据时可登录，但账户显示未连接。失败不会切换模拟数据。已有 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 由 Node 原生代理支持读取，无需复制代理地址到源码。不要启用 Node 的 HTTP 调试日志，以免记录请求头和签名 URL。

个人会话有效期 8 小时，仅保存在服务内存；退出、服务重启或到期后需重新登录。10 次失败登录后限制 15 分钟。所有页面和账户响应禁止缓存；浏览器只获得展示所需字段，不接收 API 凭据或原始账户响应。

## 手机连接本地电脑

手机和电脑处于同一可信局域网。默认 HTTP 仅供电脑本机使用；局域网需要 **HTTPS**，防止密码和会话明文传输。服务绑定 `APP_ORIGIN` 中指定的本机地址，不自动绑定所有网卡。

若已有本地可信证书，直接配置下面三个变量即可。也可用 OpenSSL 生成本地测试证书（将示例 IP 换成电脑局域网 IP）：

```sh
LAN_IP=192.168.1.100
mkdir -p .local
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout .local/key.pem -out .local/cert.pem \
  -subj '/CN=Entry Guidance Local' \
  -addext "subjectAltName=IP:${LAN_IP},IP:127.0.0.1,DNS:localhost" \
  -addext 'basicConstraints=critical,CA:TRUE'
chmod 600 .local/key.pem
```

在手机上安装并信任自己生成的 `cert.pem`（**不要传输 `key.pem`**）。在 `.env` 中设置以下变量，替换 IP 后重启 `npm start`：

```dotenv
APP_ORIGIN=https://192.168.1.100:3000
TLS_CERT_FILE=.local/cert.pem
TLS_KEY_FILE=.local/key.pem
```

手机访问该 HTTPS 地址；电脑也使用同一个地址。HTTPS 会话带 `Secure` 标记。证书及私钥放在被 Git 忽略的 `.local/`。本项目未配置公网部署或反向代理，不应将本地端口直接暴露到公网。

## 读取和金额口径

账户读取使用以下 **GET** 签名请求，禁止重定向、任意地址、任意参数或交易请求：

| 接口 | 用途 |
| --- | --- |
| `api.binance.com/sapi/v1/account/apiRestrictions` | 确认读取权限，拒绝交易、提现、划转等权限；关键权限字段缺失时停止。 |
| `api.binance.com/sapi/v1/portfolio/account` | 排除统一/组合保证金账户，含 Pro；只有明确的 `-21001 USER_IS_NOT_UNIACCOUNT` 错误才继续。其他失败不当作普通账户证明。 |
| `fapi.binance.com/fapi/v2/account` | 要求 `multiAssetsMargin=false`，读取唯一的 USDT 资产。 |

权益 = USDT 的 `walletBalance + unrealizedProfit`，并检查与 `marginBalance` 一致；可用余额直接采用该资产的 `availableBalance`，不减第二次已占保证金。不使用账户汇总值、`crossUnPnl` 或提现额度替代。金额以 8 位小数的 BigInt 计算；字段不合法、超出支持精度或口径不一致时停止展示新结果。

每次完整查询总计最多 10 秒。页面显示本次查询时间，不将交易所保留的 `updateTime=0` 当作查询时间。刷新失败保留原账户快照及原时间并标明过期，撤销试算结果；整页重新打开时重新查询。结果只表示该时点快照，不表示持续连接或可开仓状态。试算读取账户 V2 中目标币种的 `positionAmt`、`positionSide` 和 `isolated`，仅允许空仓、逐仓与单向持仓。

选择币种后，同次查询还使用以下固定 **GET** 接口。公共行情请求不携带 Key 或签名；私有请求仅接受经过校验的币种参数，前端无代签入口。

| 接口 | 用途 |
| --- | --- |
| `/fapi/v1/exchangeInfo`（公共） | 筛选交易中的 USDT 本位永续，读取 `PRICE_FILTER`、`LOT_SIZE`、`MARKET_LOT_SIZE`、`MIN_NOTIONAL` 及 `marketTakeBound`；不以显示精度替代步长。 |
| `/fapi/v1/ticker/bookTicker`、`/fapi/v1/premiumIndex`（公共） | 买卖报价、标记价及各自数据时间。 |
| `/fapi/v2/ticker/price`（公共） | 最新成交价，用于官方市价下单成本估值；保留最后成交时间。 |
| `/fapi/v1/leverageBracket` | 读取该账户、该币种的杠杆上限、名义价值边界、维持保证金率和速算额。 |
| `/fapi/v1/commissionRate` | 读取当前币种的账户 taker 费率，开平仓均采用该值；缺失或异常时阻断，不手填覆盖，不假定额外折扣。 |
| `/fapi/v1/positionSide/dual` | 再确认账户单向持仓。 |
| `/fapi/v1/openOrders`、`/fapi/v1/openAlgoOrders` | 分别查询目标币种普通与条件挂单；任一非空即要求用户处理，包括只减仓或整仓退出委托。 |

旧仓位、旧委托或模式不符合时撤销数量，保留输入和具体处理原因。工具不清仓、撤单或改变模式。模拟模式仅提供明确标注的 BTCUSDT / ETHUSDT 虚拟报价与规则；真实模式币种列表来自 Binance。

## 单层试算口径

市价多头参考卖一、空头参考买一；同一滑点百分比分别用于入场与止损退出的不利方向。手续费包括开平两次 taker 费用，资金费为可选固定 USDT 预留，空值或零明确显示“未预留资金费”。止损是标记价触发的止损市价、整仓退出、关闭价格保护。

通过公开业务函数 `generateDraft(input, snapshot)` 计算。金额、价格、数量和费率输入最多支持 8 位小数，超过精度明确拒绝；使用 BigInt 保留乘积全精度。止损按实际 tick 及价格下限多头向下、空头向上取整；数量按市价数量上下限及步长向下取整，复算风险，并用标记价检查最小开仓名义价值。止损退出使用整仓语义，不把开仓的最小名义价值套到止损。计划亏损展示向上取到 8 位小数，比例预算换算向下保留 8 位 USDT 小数；均不扩大预算。

首次预算、止损、滑点、杠杆及最低强平缓冲均为空，权益由账户读取。预算比例范围为 `(0,100]`%；滑点为 `[0,100)`%；预算须大于资金费预留。固定金额预算不等于可投入资金：草稿保留价格风险试算，正式卡还需下述资金和强平检查。

进入页面、换币及手动刷新时读取完整快照，修改输入只按最近成功快照重算草稿。正式生成按钮再次刷新，再换算并固定本单 USDT 预算和绝对止损。修改输入、普通刷新或查询失败后保留旧卡与时间，停用其复制；只有显式重新生成才替换。查询途中编辑会取消本次生成。采用手动刷新，不宣称实时监控；失败后不能继续用旧快照重算。浏览器记忆币种、方向、预算、成本、常用杠杆与最低缓冲；本单资金上限不跨单保存，绝对止损价不跨币种沿用。完整计划跨关闭/重新登录恢复属于任务 08。

## 正式开仓卡计算口径

公开入口 `generateEntryPlan(input, snapshot)` 复用草稿的精确风险计算。数量同时满足风险预算、USDT 可用余额、可选本单资金上限、账户所选杠杆名义价值上限及普通/市价数量规则交集。仅向下缩量，保持原止损和杠杆；不能满足最小数量或按标记价计算的最小开仓名义价值时拒绝。整仓止损输出关闭全部仓位语义，不构造固定退出数量。

令数量为 `q`、杠杆为 `L`、方向 `D`（多 +1、空 -1）、标记价 `M`、不利成交估值 `Ew`、账户 taker 费率 `f`。当前官方市价下单估值为 `A = 最新成交价 × 1.0015`，多空相同：

```text
初始保证金 = q × A / L
开仓浮亏 = q × max(0, D × (A - M))
开仓费用预留 = q × max(A, Ew) × f
资金需求 = 初始保证金 + 开仓浮亏 + 开仓费用预留
```

费用取两个估值中较大者是本工具的预留假设；止损预算仍按 `Ew` 计算两次手续费。名义价值上限同时约束 `M`、`A`、`Ew`；不利成交估值不能超出交易所市价成交边界。资金总需求向上展示到 8 位 USDT 小数，比较使用未取整乘积。

强平采用本次已确认模型：`WB = q × Ew / L − q × Ew × f`，不计额外/自动追加保证金及未来资金费变化。`WB` 是假设逐仓本金，不宣称等于交易所实际逐仓钱包余额，也不保证是其下界。每档维持保证金率 `r`、速算额 `c` 代入官方逐仓公式的单向化简：

```text
多头 LP = (q × Ew − WB − c) / (q × (1 − r))
空头 LP = (q × Ew + WB + c) / (q × (1 + r))
有方向缓冲 = D × (绝对止损 − LP) / 入场参考价 × 100%
```

每个候选强平价以未取整 `q × LP` 检查所属档位，跨档重新计算。最终强平价多头向上、空头向下显示到 8 位，按此不扩大缓冲的值检查用户正数阈值；先强平、缓冲不足、无有效正数强平价或档位缺失均拒绝。

账户 `canTrade` 必须明确为 true（与 API Key 的交易权限无关；Key 仍必须只读）。报价和标记价的时间与本机相差超过 30 秒时作为过期/不一致数据阻断；最后成交时间可能较早，单独展示。账户档位必须连续有效。官方未明确自定义 `notionalCoef` 是否已应用于返回边界和速算额，因此非 1 系数暂停新建议，不猜测缩放、不代入通用档位。真实账户联调仍待完成。

核验来源（2026-09-21）：[官方市价开仓成本](https://www.binance.com/en/support/faq/detail/87fa7ee33b574f7084d42bd2ce2e463b)、[逐仓强平与跨档公式](https://www.binance.com/en/support/faq/detail/b3c689c1f50a44cabb3a84e663b81d93)、[账户档位接口](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Notional-and-Leverage-Brackets)、[最新成交价](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Price-Ticker-v2)、[数量与订单过滤规则](https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition)。

权限不足时请检查只读 Key、IP 白名单、网络及账户类型；**不要通过开启 Futures/交易/提现/划转权限解决读取失败**。本实现会拒绝这些写权限。读取和账户模式必须由实际响应证明，不能以页面模拟通过代替。

官方核验依据（2026-09-21）：[Key 权限](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)、[USDT 合约账户](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account)、[组合保证金账户](https://developers.binance.com/zh-CN/docs/catalog/advanced-trading-derivatives-trading-portfolio-margin-pro/api/rest-api/account)、[SAPI 错误码](https://developers.binance.com/zh-CN/docs/products/common/sapi/error-code)。

## 验证

```sh
npm run typecheck
node --test test/account.test.ts
node --test test/draft.test.ts
npm test
```

测试在本机临时端口通过公开 HTTP 读取入口及 `generateDraft` / `generateEntryPlan` 业务入口验证，唯一替换的业务边界是 Binance 外部响应；不读取 `.env`，不进行真实资金操作。除原账户与草稿测试外，还覆盖资金缩量、浮亏、资金上限、档位边界及跨档、多空有方向缓冲、缺失偏好、规则/数据失败、预算与止损冻结、数量规则交集、同仓位杠杆不改变价格风险。超时用例约需 10 秒。

任务 02 手机流程复验（仅模拟模式，以下为测试数值，不作为默认参数）：

1. 使用干净浏览器登录，确认预算、止损和滑点为空。选 BTCUSDT、做多、固定预算 20 USDT、止损价格 98、每次滑点 1%、资金费 1 USDT。
2. 应即时显示 4.5 BTC、450 USDT 名义价值、止损 98、计划亏损 19.80109 USDT，且始终标注模拟与草稿。独立手算：入场 101、退出 97.02，每 BTC 损失 `3.98 + 0.101 + 0.09702`，乘 4.5 后加资金费 1。
3. 制造网络失败后点击刷新，确认结果隐藏、输入不变；恢复网络后再次刷新可继续。修改止损为 100 应立即撤销结果并提示错误。重开页面，预算与成本恢复且低频成本折叠，止损重新填写。
4. 检查 320px、390px 手机视口与 1280px 桌面，无横向溢出；金额提供 decimal 输入模式，整数杠杆提供 numeric 输入模式。

任务 03 手机流程复验（仅模拟模式）：

1. 沿用上述多头参数，填写杠杆 10、最低缓冲 1%、本单资金上限 5 USDT。点击“刷新并生成开仓卡”。应显示 0.4 BTC、止损 98、资金需求 4.1064 USDT、计划损失 2.671208 USDT、强平价 91.92020203、缓冲 6.07979797%。
2. 点击数量、止损、杠杆、退出方式，剪贴板应分别为 `0.4`、`98`、`10`、`整仓退出`；数量和价格不夹带单位。模拟卡始终明确不可用于真实交易。
3. 修改预算为 25，旧卡仍为 20 USDT、止损 98，复制停用。重新生成后预算才改为 25。查询超时后旧卡保留原时间，复制停用；恢复普通刷新仍不改写原卡，再次生成才恢复复制。
4. 清空最低缓冲，生成须失败；做空且止损 102 时指引须为市价卖出、止损买入。重开页面检查杠杆和缓冲恢复、低频设置折叠、止损重新填写。

任务 03 已用浏览器完成上述生成/复制/失效/查询超时恢复检查，并观察 320px、390px、1280px 视口无横向溢出。未用真实订单验证，也不等于实体手机或真实账户验收。

上述流程已用浏览器模拟视口验证，刷新失败使用受控网络异常；未将其当作实体手机软键盘、HTTPS 信任或真实 Binance 联调验收。

浏览器验收：原生表单登录与退出，320px / 390px 手机视口和 1280px 桌面布局；断网刷新显示失败并保留带原时间的旧快照，恢复后可再查；退出后返回不能进入账户页。没有实体手机信任证书的验收结论。

**真实账户联调尚未完成**：当前缺少 API Key，未请求真实账户。补齐只读凭据后需在真实模式验证权限响应、账户模式、USDT 字段和网络连通性。不能把受控响应测试当作真实 Binance 连通性通过。
