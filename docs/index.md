# 项目上下文索引

## 按任务读取

| 任务 | 权威来源 |
| --- | --- |
| 确认产品范围、输入与风险规则 | [产品决策](product-spec.md)；[实现规格与验收要求](issue-spec.md) |
| 实施独立账户快照页、持仓与活跃委托详情 | [账户快照页规格](account-snapshot-spec.md)（整体方案已确认；[本地任务 01–05](../.scratch/account-snapshot/issues/)，待实现） |
| 实施交易记录、历史归并与复盘分析 | [交易复盘规格](trade-review-spec.md)（设计与拆分已确认；[本地任务 01–12](../.scratch/trade-review/issues/)，待实现） |
| 修改领域用语或界面文案 | [领域词汇表](../CONTEXT.md) |
| 修改仓位算法 | [ADR 0002：按最终止损确定仓位](adr/0002-size-to-final-stop.md) |
| 修改账户接入或执行边界 | [ADR 0003：只读账户核验](adr/0003-readonly-account-verification.md) |
| 确定复盘交易单位与加减仓、反手归属 | [ADR 0004：交易周期归并](adr/0004-trade-cycle-grouping.md)；[交易复盘规格](trade-review-spec.md) |
| 修改复盘数据留存、同步或备份恢复 | [ADR 0005：服务端复盘账本](adr/0005-server-trade-ledger.md)；[交易复盘规格](trade-review-spec.md) |
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
| [src/account-archive.ts](../src/account-archive.ts)；[src/history-sync.ts](../src/history-sync.ts)；[src/review-ledger.ts](../src/review-ledger.ts) | 按 UID 隔离的 SQLite 复盘账本、全账户发现与持续归档、历史分页及保守归并；`src/review-notes.ts` 定义个人记录校验及交易依据关联；`frontend/useReviewPage.ts` 和 `frontend/ReviewPage.vue` 展示进度、缺口与原始证据，`frontend/useReviewNotes.ts` 与 `frontend/components/ReviewNotes.vue` 管理个人笔记、标签与未保存草稿 |
| [src/review-filters.ts](../src/review-filters.ts) | 规范化上海日历日期与组合筛选参数、入场类型及稳定排序；账本 `list(filters)` 返回完整匹配范围，HTTP 以每页 20 条展示 |
| [src/order-download.ts](../src/order-download.ts)；[src/order-file.ts](../src/order-file.ts)；[src/review-orders.ts](../src/review-orders.ts)；[frontend/components/ReviewOrders.vue](../frontend/components/ReviewOrders.vue) | 手动生成并复用 Binance 订单下载任务、固定主机文件读取、ZIP/CSV 与 UID/UTC 校验；订单列表按原始成交汇总已实现盈亏，并链接原有完整交易复盘。外部取数仅手动触发，本地缓存读取不验证外部账户 |
| [src/review-backup.ts](../src/review-backup.ts)；[src/review-export.ts](../src/review-export.ts)；[frontend/components/ReviewBackup.vue](../frontend/components/ReviewBackup.vue) | 固定格式 JSON 备份与账户校验、全筛选 CSV；账本事务补缺恢复，个人记录冲突旧版本与逐条覆盖，预览变化拒绝写入 |
| [src/review-statistics.ts](../src/review-statistics.ts)；[frontend/components/ReviewStatistics.vue](../frontend/components/ReviewStatistics.vue) | 冻结列表筛选全范围统计，按指标保留有效与排除样本，使用 BigInt 计算金额、累计曲线与四类分组；列表响应提供稳定证据指纹及读取时点 |
| [src/plan-comparison.ts](../src/plan-comparison.ts)；[frontend/components/PlanComparison.vue](../frontend/components/PlanComparison.vue) | 依据长期保存的方案与查询证据判断唯一关联，计算并展示固定原计划、实际入场、净亏损与历史止损设置对照；列表和详情使用同一关联口径 |
| [src/trade-market.ts](../src/trade-market.ts)；[frontend/useTradeMarket.ts](../frontend/useTradeMarket.ts)；[frontend/components/TradeChart.vue](../frontend/components/TradeChart.vue) | 按交易与周期读取、分页留存合约价和标记价历史 K 线，分别记录完整性与缺口；冻结行情、交易事件和止损证据，屏幕抽稀与原始数值分开，迟到响应不覆盖当前周期 |
| [src/trade-analysis.ts](../src/trade-analysis.ts)；[src/analysis-model.ts](../src/analysis-model.ts)；[src/analysis-contract.ts](../src/analysis-contract.ts)；[frontend/components/TradeAnalysis.vue](../frontend/components/TradeAnalysis.vue) | 主动冻结单笔或最多 100 笔筛选全范围交易、允许的已保存笔记、全部已归档行情周期及筛选统计；按模型元数据全量分段并综合，任务、报告与尝试用量留存在同账户 SQLite，取消或中断后仅主动继续 |
| [frontend/ReviewPage.vue](../frontend/ReviewPage.vue)；[frontend/review-records.ts](../frontend/review-records.ts)；[frontend/useReviewLocation.ts](../frontend/useReviewLocation.ts) | Ant Design Vue 表格、北京时间开仓日期与交易对筛选、分页及列表/详情 URL 状态；`ReviewArchive.vue` 收纳同步与原始证据，`ReviewTradeDetail.vue` 展示单笔证据，笔记实例跨页内导航保留草稿 |
| [src/market.ts](../src/market.ts) | 汇集账户、行情、费率、合约规则及模拟快照 |
| [public/draft.js](../public/draft.js) | 前后端共用的十进制计算、模板应用、草稿、正式方案和分层数量计算 |
| [src/verification.ts](../src/verification.ts) | 建立空仓起点、冻结方案，核对实际成交、成本与止损覆盖；复用共享计算模块 |
| [frontend/AppShell.vue](../frontend/AppShell.vue)；[frontend/HomePage.vue](../frontend/HomePage.vue) | 首页与共享页面框架、桌面侧栏及手机菜单抽屉；功能页面使用独立受保护 URL |
| [frontend/EntryWorkbench.vue](../frontend/EntryWorkbench.vue) | 开仓页布局与页内导航；表单、开仓卡、核验面板位于 `frontend/components/` |
| [frontend/useWorkbench.ts](../frontend/useWorkbench.ts) | 响应式表单与展示状态、请求取消、复制、浏览器存储、返回后刷新；调用共享计算及 HTTP 入口 |
| [public/select.js](../public/select.js) | 保留原生字段的下拉增强；Vue 包装组件负责同步与清理监听 |
| [vite.config.ts](../vite.config.ts) | 前端开发编译与生产构建；Node 服务发布构建资源 |
| [test/](../test/) | Node 测试覆盖 HTTP 与业务入口；`test/browser/` 使用 Playwright 验证生产构建的交互 |

## 规则入口

- [根 AGENTS.md](../AGENTS.md) 是共享入口；[CLAUDE.md](../CLAUDE.md) 导入它。
- 前端差异只维护在 [public/AGENTS.md](../public/AGENTS.md)。Codex/Cursor 使用嵌套入口；从根目录处理前端任务时也按根入口的指示读取。
- Claude 的 [路径规则](../.claude/rules/public.md) 在读取 `frontend/`、HTML 或 CSS 时指向同一份前端规则。纯计算修改按共享模块边界处理。
- 当前无需 Cursor 专属规则，也没有遗留 `.cursorrules`。按需读取本索引链接的文档，不将整个知识库加入启动导入。
