# 开仓前 · 单层市价试算

任务 01–02 的本地单人工作台：个人登录后查看 Binance USDT 合约账户，并按预算、单层止损及成本假设即时试算市价开仓数量。运行时仅使用 Node 内置模块，原生 HTML/CSS/JavaScript；TypeScript 和 Node 类型仅用于开发检查。所有试算均为草稿，资金与强平检查尚未完成。无数据库、注册或交易功能。

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
| `/fapi/v1/exchangeInfo`（公共） | 筛选交易中的 USDT 本位永续，读取 `PRICE_FILTER`、`MARKET_LOT_SIZE` 和 `MIN_NOTIONAL`；不以显示精度替代步长。 |
| `/fapi/v1/ticker/bookTicker`、`/fapi/v1/premiumIndex`（公共） | 买卖报价、标记价及各自数据时间。 |
| `/fapi/v1/commissionRate` | 读取当前币种的账户 taker 费率，开平仓均采用该值；缺失或异常时阻断，不手填覆盖，不假定额外折扣。 |
| `/fapi/v1/positionSide/dual` | 再确认账户单向持仓。 |
| `/fapi/v1/openOrders`、`/fapi/v1/openAlgoOrders` | 分别查询目标币种普通与条件挂单；任一非空即要求用户处理，包括只减仓或整仓退出委托。 |

旧仓位、旧委托或模式不符合时撤销数量，保留输入和具体处理原因。工具不清仓、撤单或改变模式。模拟模式仅提供明确标注的 BTCUSDT / ETHUSDT 虚拟报价与规则；真实模式币种列表来自 Binance。

## 单层试算口径

市价多头参考卖一、空头参考买一；同一滑点百分比分别用于入场与止损退出的不利方向。手续费包括开平两次 taker 费用，资金费为可选固定 USDT 预留，空值或零明确显示“未预留资金费”。止损是标记价触发的止损市价、整仓退出、关闭价格保护。

通过公开业务函数 `generateDraft(input, snapshot)` 计算。金额、价格、数量和费率输入最多支持 8 位小数，超过精度明确拒绝；使用 BigInt 保留乘积全精度。止损按实际 tick 及价格下限多头向下、空头向上取整；数量按市价数量上下限及步长向下取整，复算风险，并用标记价检查最小开仓名义价值。止损退出使用整仓语义，不把开仓的最小名义价值套到止损。计划亏损展示向上取到 8 位小数，比例预算换算向下保留 8 位 USDT 小数；均不扩大预算。

首次预算、止损和滑点均为空，权益由账户读取。预算比例范围为 `(0,100]`%；滑点为 `[0,100)`%；预算须大于资金费预留。固定金额预算不等于可投入资金：本任务尚未检查余额能否覆盖开仓、杠杆档位或强平风险。

进入页面、换币及手动刷新时读取完整快照，修改预算、止损或成本只按最近成功快照重算，显示该快照时间。采用手动刷新，不宣称行情实时或后台监控；失败后不能继续用旧快照重算。浏览器记忆币种、方向、预算及成本偏好；绝对止损价不跨币种沿用，止损输入不持久化为模板。完整计划跨关闭/重新登录恢复属于任务 08。

权限不足时请检查只读 Key、IP 白名单、网络及账户类型；**不要通过开启 Futures/交易/提现/划转权限解决读取失败**。本实现会拒绝这些写权限。读取和账户模式必须由实际响应证明，不能以页面模拟通过代替。

官方核验依据（2026-09-21）：[Key 权限](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)、[USDT 合约账户](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account)、[组合保证金账户](https://developers.binance.com/zh-CN/docs/catalog/advanced-trading-derivatives-trading-portfolio-margin-pro/api/rest-api/account)、[SAPI 错误码](https://developers.binance.com/zh-CN/docs/products/common/sapi/error-code)。

## 验证

```sh
npm run typecheck
node --test test/account.test.ts
node --test test/draft.test.ts
npm test
```

测试在本机临时端口通过公开 HTTP 读取入口及 `generateDraft` 业务入口验证，唯一替换的业务边界是 Binance 外部响应；不读取 `.env`，不进行真实资金操作。覆盖登录/退出、未授权请求、跨站提交、限流、凭据脱敏、只读限制、精确余额、账户模式、超时和显式模拟，以及多空、权益预算、非零费用/滑点、资金费、取整和阻断条件。超时用例约需 10 秒。

任务 02 手机流程复验（仅模拟模式，以下为测试数值，不作为默认参数）：

1. 使用干净浏览器登录，确认预算、止损和滑点为空。选 BTCUSDT、做多、固定预算 20 USDT、止损价格 98、每次滑点 1%、资金费 1 USDT。
2. 应即时显示 4.5 BTC、450 USDT 名义价值、止损 98、计划亏损 19.80109 USDT，且始终标注模拟与草稿。独立手算：入场 101、退出 97.02，每 BTC 损失 `3.98 + 0.101 + 0.09702`，乘 4.5 后加资金费 1。
3. 制造网络失败后点击刷新，确认结果隐藏、输入不变；恢复网络后再次刷新可继续。修改止损为 100 应立即撤销结果并提示错误。重开页面，预算与成本恢复且低频成本折叠，止损重新填写。
4. 检查 320px、390px 手机视口与 1280px 桌面，无横向溢出；数字字段均提供 decimal 输入模式。

上述流程已用浏览器模拟视口验证，刷新失败使用受控网络异常；未将其当作实体手机软键盘、HTTPS 信任或真实 Binance 联调验收。

浏览器验收：原生表单登录与退出，320px / 390px 手机视口和 1280px 桌面布局；断网刷新显示失败并保留带原时间的旧快照，恢复后可再查；退出后返回不能进入账户页。没有实体手机信任证书的验收结论。

**真实账户联调尚未完成**：当前缺少 API Key，未请求真实账户。补齐只读凭据后需在真实模式验证权限响应、账户模式、USDT 字段和网络连通性。不能把受控响应测试当作真实 Binance 连通性通过。
