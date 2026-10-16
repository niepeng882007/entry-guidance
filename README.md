# 开仓前 · 开仓与止损卡

个人、单 Binance 账户的手机网页工具，兼容电脑：生成开仓方案，由用户在 Binance 手动执行，返回后只读核验；另提供资产快照、交易记录与完整交易复盘。

| 入口 | 当前功能 |
| --- | --- |
| `/entry` 开仓卡 | 市价 / GTC 限价、单双层止损、资金与强平检查、模板及本单恢复 |
| `/account` 我的账户 | 资产快照与查询信息，正常前台每轮完成后等待 30 秒刷新 |
| `/review` 交易记录 | 默认按订单展示；完整交易周期用于笔记、统计、行情、模型分析和备份 |

所有功能页需要登录。工具不下单、撤单或修改账户设置；计划与核验结果不保证实际亏损封顶，核验通过只代表查询时点。

## 本机启动

需要 Node.js **22.21.0 或更高的受支持版本**，使用 **pnpm 11.7.0**；版本约束以 [package.json](package.json) 为准。

1. 运行 `pnpm install --frozen-lockfile`。
2. 参考 [`.env.example`](.env.example)，在本机 `.env` 设置至少 12 字符的独立 `APP_PASSWORD`；已有文件逐项合并，不覆盖。凭据只留在后端。
3. 构建并启动模拟模式，无需 Binance 凭据：

```sh
pnpm build
APP_MODE=demo pnpm start
```

打开 <http://127.0.0.1:3000> 登录。模拟数据有明确标识，不发送 Binance 请求，也不代表真实账户验收。

连接真实账户时，在本机 `.env` 配置专用只读 HMAC 凭据 `BINANCE_API_KEY`、`BINANCE_API_SECRET`，然后运行：

```sh
APP_MODE=real pnpm start
```

默认模式为 `real`；凭据不完整时可登录，但账户未连接。已有 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 由 Node 原生代理读取。不要开启可能记录签名请求的 HTTP 调试日志。

复盘账本默认按模式保存于 `.local/review/real.sqlite` 或 `demo.sqlite`；可用 `REVIEW_DATA_DIR` 指定目录。复盘外部取数与模型分析均需手动发起。手机 HTTPS、数据保存、备份和具体操作见[使用说明](docs/usage.md)。

## 开发与验证

本机热更新：`APP_MODE=demo pnpm dev`。首次运行浏览器测试前执行 `pnpm exec playwright install chromium webkit`；完整检查入口为 `pnpm check`。修改后端会重启服务，须重新登录；手机使用生产构建与 HTTPS。定向检查见[开发与验证](docs/development.md)。

功能代码及模拟验收记录已存在，**当前代码基线未在本次重新跑完整检查**。实体 iOS、完整真实账户链路和真实模型仍有未完成验收；已有一次真实订单文件格式核查不代表完整同步通过。证据及限制统一见[项目现状与验收](docs/status.md)。

## 文档入口

- [使用说明](docs/usage.md)：页面操作、刷新、存储、模型、备份与手机连接。
- [项目现状与验收](docs/status.md)：已实现能力、历史证据和未完成项。
- [项目索引](docs/index.md)：产品规格、模块地图及规则入口。
- [历史资料](docs/archive/README.md)：原始问答、早期规格与 25 份任务记录。
