# 开发与验证

项目地图与规格入口见 [公共索引](index.md)。

## 修改边界

- 运行时沿用 Node 内置模块与原生 HTML/CSS/JavaScript；环境版本、依赖和命令以 [package.json](../package.json) 与 [pnpm 锁文件](../pnpm-lock.yaml) 为准。
- TypeScript 和浏览器 JavaScript 都受 [tsconfig.json](../tsconfig.json) 检查；JavaScript 类型沿用现有 JSDoc 写法。
- 修改 `public/draft.js` 时同时追踪浏览器和服务端调用方，复用现有计算函数；服务端保留对客户端输入的独立校验。
- 页面修改按 [前端规则](../public/AGENTS.md) 检查控件、状态与静态文件边界。服务端启动时读取静态资源，修改后须重启预览服务。

## 检查选择

代码修改先运行根入口列出的类型检查，再按行为选择现有测试；交付行为变更前运行完整测试。仅修改文档时检查链接、规则作用域和 `git diff --check`。

| 修改内容 | 定向检查 |
| --- | --- |
| 账户读取、登录、HTTP 或方案恢复 | `node --test test/account.test.ts` |
| 共享计算、精度、资金约束或模板 | `node --test test/draft.test.ts` |
| 方案起点、成交对账或止损核验 | `node --test test/verification.test.ts` |

测试使用 Node 内置 `node:test` 与断言，通过本机临时 HTTP 端口及业务入口验证，替换 Binance 外部响应。保持测试与真实凭据隔离；行为变更在相关现有测试文件补回归用例。部分超时用例约需 10 秒。

## 浏览器与外部验收

- 本地演示运行 `APP_MODE=demo pnpm start`；密码配置和手机 HTTPS 连接按 [README](../README.md) 对应章节执行。真实模式为默认启动模式，演示必须显式选择 `demo`。
- 前端视口、焦点与状态检查遵循前端规则；具体业务演示步骤查 README 的对应任务章节。
- 分别记录自动测试、模拟浏览器、实体手机和真实账户结果。已有未完成项包括实体 iOS 交互、双层止损 App 组合流程及真实账户只读联调，详情以 README 和对应任务记录为准。
- 需要核实交易所规则时访问规格中对应官方来源，并记录核验日期；本地模拟和官方 API 说明不能替代实际 App 流程验收。
