# 多用户产品重构任务总览

2026-10-16 用户确认按 30 票发布。任务已按依赖顺序写入本地 tracker，初始状态均为 `ready-for-agent`；后续状态及完成证据以各任务文件为准。本次仅发布任务，未开始业务实现。

父规格为[多用户产品重构规格](spec.md)，本次未修改或关闭。实施范围与外部授权边界见[重构实施计划](../../docs/refactor-implementation-plan.md)。

## 领取规则

- `ready-for-agent` 表示规格就绪，不表示所有任务均已解除依赖；领取前检查任务的 `Blocked by`，只开展所有前置任务已完成的任务。
- 初始无任务依赖的是 [01：兼容启动与隔离登录工作台](issues/01-compatible-auth-workbench.md)。01 完成后，02 和 04 可并行。
- 01 扩展并隔离新旧入口，账本异步边界随各业务批次迁移，27 在所有迁移完成后移除旧栈。
- 01–27 为本地实现与模拟验收；28–30 还分别要求地区/预算/资源、真实外部调用、真实迁移或部署的明确授权。任务就绪不代替授权。
- 一票一个文件；只在对应任务维护验收勾选和进展，不能将一个任务的通过记录视为全项目通过。

## 任务与直接依赖

| 编号 | 任务 | Blocked by | 交付 |
| --- | --- | --- | --- |
| 01 | [兼容启动与隔离登录工作台](issues/01-compatible-auth-workbench.md) | 无 | 使用两个预置的合成用户分别登录新工作台，经受保护的 Next 到 Node 链路读取各自资料；原单用户演示流程继续可运行。 |
| 02 | [公开官网与邮箱注册验证](issues/02-public-site-registration.md) | [01](issues/01-compatible-auth-workbench.md) | 访客能阅读公开官网并注册，完成邮箱验证后进入自己的工作台；邮件失败能通过重发继续。 |
| 03 | [密码恢复与设备会话管理](issues/03-password-and-sessions.md) | [02](issues/02-public-site-registration.md) | 用户可找回和重置密码、撤销其他设备会话；旧网页和业务直连随会话撤销失去访问权。 |
| 04 | [Binance 只读绑定与同账户换 Key](issues/04-readonly-binance-binding.md) | [01](issues/01-compatible-auth-workbench.md) | 用户在设置页提交只读 Key，验证后获得独占账户绑定，并可更新同 UID 的 Key 而保留身份与历史。 |
| 05 | [资产快照与多用户读取协调](issues/05-account-assets-coordination.md) | [04](issues/04-readonly-binance-binding.md) | 用户能查看自己的资产快照、查询时点和冷却信息，资产页保持 30 秒节奏，并提供开仓复用的 3 秒摘要。 |
| 06 | [单层市价开仓草稿与固定方案](issues/06-single-stop-entry-plan.md) | [05](issues/05-account-assets-coordination.md) | 活跃账户用户可填写单层市价计划、即时看草稿，并在严格读取后生成固定预算和绝对止损的正式开仓卡。 |
| 07 | [单层成交核验与可信本单恢复](issues/07-single-stop-verification-recovery.md) | [06](issues/06-single-stop-entry-plan.md) | 用户手动成交后可核验实际成本与止损覆盖，并在刷新、重登或服务重启后恢复原方案继续查询。 |
| 08 | [限价开仓与部分成交处理](issues/08-limit-entry-partial-fill.md) | [07](issues/07-single-stop-verification-recovery.md) | 用户可生成 GTC 限价开仓方案，部分成交后按实际仓位核验，并明确处理尚未取消的入场余单。 |
| 09 | [双层止损与近端退出后余仓核验](issues/09-two-level-stop-verification.md) | [07](issues/07-single-stop-verification-recovery.md) | 用户可生成双层止损方案，并在近端退出后检查剩余仓位、已发生成本及最终止损覆盖。 |
| 10 | [私有偏好、模板与手机返回恢复](issues/10-private-workbench-state.md) | [07](issues/07-single-stop-verification-recovery.md) | 用户可保存自己的偏好和止损模板，并在手机切换 App 或页面返回后恢复本单，不暴露给其他登录者。 |
| 11 | [完整交易账本与分页详情浏览](issues/11-trade-cycle-ledger-browser.md) | [04](issues/04-readonly-binance-binding.md) | 用户能从 PostgreSQL 账本浏览自己的完整交易、筛选分页并打开包含证据与缺口的详情。 |
| 12 | [手动历史同步与周期归并](issues/12-manual-history-sync.md) | [05](issues/05-account-assets-coordination.md)、[11](issues/11-trade-cycle-ledger-browser.md) | 用户可主动同步历史并形成可追溯的完整交易；分页或服务中断后保留检查点，只在用户继续时恢复。 |
| 13 | [按日期下载订单并补齐历史](issues/13-historical-order-download.md) | [12](issues/12-manual-history-sync.md) | 用户可按北京时间范围手动获取历史订单文件，复用已有下载任务，并明确看到补齐范围、额度或格式异常。 |
| 14 | [订单主列表与完整交易关联](issues/14-order-records-table.md) | [13](issues/13-historical-order-download.md) | 用户默认看到一行一张订单的记录表，并可从订单进入相关完整交易，保留现有筛选与手机浏览体验。 |
| 15 | [复盘笔记、标签与未保存草稿](issues/15-review-notes-tags.md) | [11](issues/11-trade-cycle-ledger-browser.md) | 用户可为完整交易保存笔记和风格标签，页内导航保留草稿，并在并发修改时得到明确冲突提示。 |
| 16 | [原方案与实际执行对照](issues/16-plan-execution-comparison.md) | [07](issues/07-single-stop-verification-recovery.md)、[11](issues/11-trade-cycle-ledger-browser.md) | 用户在交易列表与详情中看到可信原方案与实际执行的对照，无法唯一关联时明确保持未确认。 |
| 17 | [全范围统计与 CSV 导出](issues/17-statistics-csv.md) | [15](issues/15-review-notes-tags.md) | 用户可按当前筛选范围查看完整统计、曲线与分组，并导出全范围 CSV，不受当前页面大小限制。 |
| 18 | [双来源行情与交易事件图表](issues/18-archived-market-chart.md) | [05](issues/05-account-assets-coordination.md)、[11](issues/11-trade-cycle-ledger-browser.md) | 用户可查看已归档合约价和标记价行情，主动补查并叠加交易事件与止损证据。 |
| 19 | [自备模型 Key 设置与撤销](issues/19-bring-own-model-key.md) | [04](issues/04-readonly-binance-binding.md) | 用户可在设置页加密保存、替换或撤销自己的模型 Key；没有有效 Key 时仍可使用非 AI 功能和旧记录。 |
| 20 | [单笔 AI 全量分析与任务续跑](issues/20-single-trade-analysis.md) | [12](issues/12-manual-history-sync.md)、[15](issues/15-review-notes-tags.md)、[18](issues/18-archived-market-chart.md)、[19](issues/19-bring-own-model-key.md) | 用户主动发起单笔分析后，可查看全量分段报告、取消任务或在中断后继续，离开页面不丢失已接受任务。 |
| 21 | [筛选范围批量 AI 分析](issues/21-batch-trade-analysis.md) | [17](issues/17-statistics-csv.md)、[20](issues/20-single-trade-analysis.md) | 用户可对当前筛选的最多 100 笔完整交易发起批量分析，获得覆盖全部选中记录且明确排除依据的报告。 |
| 22 | [带归属证明的备份与事务恢复](issues/22-owned-backup-restore.md) | [13](issues/13-historical-order-download.md)、[16](issues/16-plan-execution-comparison.md)、[21](issues/21-batch-trade-analysis.md) | 用户能导出完整 v2 业务备份，预览补缺与冲突后恢复到同一有效归属，失败不会破坏原账本。 |
| 23 | [解绑、只读归档与换账户](issues/23-unlink-and-archive.md) | [14](issues/14-order-records-table.md)、[22](issues/22-owned-backup-restore.md) | 用户可解绑当前账户、保留原 UID 的只读历史，并绑定新账户；重新验证原 UID 后能恢复原账本功能。 |
| 24 | [注销、完整清理与独立撤销记录](issues/24-account-deletion-journal.md) | [03](issues/03-password-and-sessions.md)、[23](issues/23-unlink-and-archive.md) | 用户重新认证并选择注销后立即失去访问权，平台完成全部在线清理后释放 UID，后来绑定者不能继承原资料。 |
| 25 | [隔离灾备恢复与 30 天清理](issues/25-disaster-recovery-retention.md) | [24](issues/24-account-deletion-journal.md) | 维护者能在隔离环境恢复账本并重放删除和撤销决定，证明旧用户、旧凭据和旧任务不会随快照复活。 |
| 26 | [旧账本、浏览器状态与本单迁移演练](issues/26-legacy-data-and-plan-migration.md) | [10](issues/10-private-workbench-state.md)、[24](issues/24-account-deletion-journal.md) | 原工具使用者能用一次受控迁移将旧账本和可信本单带入明确的新账号，验证数据一致且不会错误认领。 |
| 27 | [移除旧栈并完成全量本地验收](issues/27-contract-and-integrated-regression.md) | [08](issues/08-limit-entry-partial-fill.md)、[09](issues/09-two-level-stop-verification.md)、[25](issues/25-disaster-recovery-retention.md)、[26](issues/26-legacy-data-and-plan-migration.md) | 用户能在完整的新应用中完成所有原业务与多用户生命周期；维护者获得同一基线的全量通过证据。 |
| 28 | [选定资源并部署隔离试运行环境](issues/28-authorized-staging-environment.md) | [27](issues/27-contract-and-integrated-regression.md) | 在地区、预算及资源获得明确确认后，维护者能部署完整且隔离的试运行环境，并看到实际资源与恢复能力。 |
| 29 | [真实只读链路与实体手机验收](issues/29-authorized-live-acceptance.md) | [28](issues/28-authorized-staging-environment.md) | 在明确授权的测试范围内，维护者核实真实服务与实体手机的可用性，并分别记录通过和未通过的能力。 |
| 30 | [授权后的停写切换与试运行交付](issues/30-authorized-production-cutover.md) | [29](issues/29-authorized-live-acceptance.md) | 在真实迁移和生产部署获得独立确认后，原用户的数据经对账切换到新产品，并具备正确的回退与运行记录。 |

## 发布检查

- 30 个独立任务；编号连续，所有依赖均指向较早编号，无环路及冗余直接依赖。
- 覆盖父规格全部 82 条用户故事和 25 项实现决策，每票包含独立可验证的验收条件。
- 本轮只将审阅稿状态改为 `ready-for-agent`，标题、阻塞关系、交付范围和验收条件保持一致。
