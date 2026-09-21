# 开仓前 · 只读账户

任务 01 的本地单人工作台：个人登录后查看 Binance USDT 合约权益、可用余额及查询时间。运行时仅使用 Node 内置模块，原生 HTML/CSS/JavaScript；TypeScript 和 Node 类型仅用于开发检查。无数据库、注册或交易功能。

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

后端固定发送以下三个 **GET** 签名请求，禁止重定向、任意地址、任意参数或交易请求：

| 接口 | 用途 |
| --- | --- |
| `api.binance.com/sapi/v1/account/apiRestrictions` | 确认读取权限，拒绝交易、提现、划转等权限；关键权限字段缺失时停止。 |
| `api.binance.com/sapi/v1/portfolio/account` | 排除统一/组合保证金账户，含 Pro；只有明确的 `-21001 USER_IS_NOT_UNIACCOUNT` 错误才继续。其他失败不当作普通账户证明。 |
| `fapi.binance.com/fapi/v2/account` | 要求 `multiAssetsMargin=false`，读取唯一的 USDT 资产。 |

权益 = USDT 的 `walletBalance + unrealizedProfit`，并检查与 `marginBalance` 一致；可用余额直接采用该资产的 `availableBalance`，不减第二次已占保证金。不使用账户汇总值、`crossUnPnl` 或提现额度替代。金额以 8 位小数的 BigInt 计算；字段不合法、超出支持精度或口径不一致时停止展示新结果。

每次查询总计最多 10 秒。页面显示本次查询时间，不将交易所保留的 `updateTime=0` 当作查询时间。刷新失败保留原快照、保留原查询时间并标明过期；整页重新打开时重新查询。结果只表示该时点快照，不表示持续连接或可开仓状态。逐仓、单向持仓、目标币种空仓检查属于后续开仓任务。

权限不足时请检查只读 Key、IP 白名单、网络及账户类型；**不要通过开启 Futures/交易/提现/划转权限解决读取失败**。本实现会拒绝这些写权限。读取和账户模式必须由实际响应证明，不能以页面模拟通过代替。

官方核验依据（2026-09-21）：[Key 权限](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)、[USDT 合约账户](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account)、[组合保证金账户](https://developers.binance.com/zh-CN/docs/catalog/advanced-trading-derivatives-trading-portfolio-margin-pro/api/rest-api/account)、[SAPI 错误码](https://developers.binance.com/zh-CN/docs/products/common/sapi/error-code)。

## 验证

```sh
npm run typecheck
node --test test/account.test.ts
npm test
```

测试在本机临时端口通过公开 HTTP 入口验证，唯一替换的业务边界是 Binance 外部响应；不读取 `.env`，不进行真实资金操作。覆盖登录/退出、未授权请求、跨站提交、限流、凭据脱敏、只读限制、精确余额、账户模式、超时和显式模拟。超时用例约需 10 秒。

浏览器验收：原生表单登录与退出，320px / 390px 手机视口和 1280px 桌面布局；断网刷新显示失败并保留带原时间的旧快照，恢复后可再查；退出后返回不能进入账户页。没有实体手机信任证书的验收结论。

**真实账户联调尚未完成**：当前缺少 API Key，未请求真实账户。补齐只读凭据后需在真实模式验证权限响应、账户模式、USDT 字段和网络连通性。不能把受控响应测试当作真实 Binance 连通性通过。
