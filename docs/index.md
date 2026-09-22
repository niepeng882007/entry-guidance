# 项目上下文索引

## 按任务读取

| 任务 | 权威来源 |
| --- | --- |
| 确认产品范围、输入与风险规则 | [产品决策](product-spec.md)；[实现规格与验收要求](issue-spec.md) |
| 修改领域用语或界面文案 | [领域词汇表](../CONTEXT.md) |
| 修改仓位算法 | [ADR 0002：按最终止损确定仓位](adr/0002-size-to-final-stop.md) |
| 修改账户接入或执行边界 | [ADR 0003：只读账户核验](adr/0003-readonly-account-verification.md) |
| 修改代码、选择检查方式 | [开发与验证](development.md) |
| 修改页面结构、样式或渲染 | [前端规则](../public/AGENTS.md) |
| 启动、连接手机、查验已实现行为及验收记录 | [README](../README.md) 中对应章节；[任务 01–08](../.scratch/entry-guidance/issues/) |

[ADR 0001](adr/0001-manual-execution.md) 已由 ADR 0003 取代，仅保留历史背景。[原始问答](../Q%20%26%20A.md) 是需求来源，其中示例参数与双层算法不能覆盖现行产品决策。规格描述目标，README 与任务记录描述实现和验收状态；发现两者不一致时明确列出差异，不把目标当成已验收结果。

## 模块地图

| 入口 | 职责与关联 |
| --- | --- |
| [src/main.ts](../src/main.ts) | 读取启动配置，选择 HTTP/HTTPS 并启动服务 |
| [src/server.ts](../src/server.ts) | 登录、会话、静态文件白名单、方案保存与签名恢复、HTTP 业务入口 |
| [src/account.ts](../src/account.ts) | Binance 白名单读取与签名、权限与账户口径校验；`transport` 是测试替换外部响应的边界 |
| [src/market.ts](../src/market.ts) | 汇集账户、行情、费率、合约规则及模拟快照 |
| [public/draft.js](../public/draft.js) | 前后端共用的十进制计算、模板应用、草稿、正式方案和分层数量计算 |
| [src/verification.ts](../src/verification.ts) | 建立空仓起点、冻结方案，核对实际成交、成本与止损覆盖；复用共享计算模块 |
| [frontend/EntryWorkbench.vue](../frontend/EntryWorkbench.vue) | 工作台布局与模块导航；表单、开仓卡、核验面板位于 `frontend/components/` |
| [frontend/useWorkbench.ts](../frontend/useWorkbench.ts) | 响应式表单与展示状态、请求取消、复制、浏览器存储、返回后刷新；调用共享计算及 HTTP 入口 |
| [public/select.js](../public/select.js) | 保留原生字段的下拉增强；Vue 包装组件负责同步与清理监听 |
| [vite.config.ts](../vite.config.ts) | 前端开发编译与生产构建；Node 服务发布构建资源 |
| [test/](../test/) | Node 测试覆盖 HTTP 与业务入口；`test/browser/` 使用 Playwright 验证生产构建的交互 |

## 规则入口

- [根 AGENTS.md](../AGENTS.md) 是共享入口；[CLAUDE.md](../CLAUDE.md) 导入它。
- 前端差异只维护在 [public/AGENTS.md](../public/AGENTS.md)。Codex/Cursor 使用嵌套入口；从根目录处理前端任务时也按根入口的指示读取。
- Claude 的 [路径规则](../.claude/rules/public.md) 在读取 `frontend/`、HTML 或 CSS 时指向同一份前端规则。纯计算修改按共享模块边界处理。
- 当前无需 Cursor 专属规则，也没有遗留 `.cursorrules`。按需读取本索引链接的文档，不将整个知识库加入启动导入。
