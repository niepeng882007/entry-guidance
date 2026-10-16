# Issue tracker: Local Markdown

本仓库使用本地 Markdown 作为当前 issue tracker；规格和任务保存在 `.scratch/`，不需要远程平台。

## 规格与任务

- 每个功能一个目录：`.scratch/<feature-slug>/`。
- 规格使用 `.scratch/<feature-slug>/spec.md`。
- 实施任务分别使用 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，一项任务一个文件。
- 规格和任务顶部用 `Status:` 记录 [triage 状态](triage-labels.md)；`to-spec` 和已确认的 `to-tickets` 产物使用 `ready-for-agent`。
- 评论追加到文件末尾的 `## Comments`，不覆盖已有讨论。
- 已有目标先读取再更新，不重复发布；任务编号以功能目录为作用域，不能把不同功能的同号任务当作同一项。

## 技能操作映射

- “发布到 issue tracker”：在对应功能目录写入规格或独立任务文件，并报告完整路径及状态。
- “读取任务”：读取用户给出的文件；仅提供编号时在明确的功能目录中查找。
- “应用 triage 标签”：更新顶部 `Status:`，使用配置中的原样字符串。
- 已发布文件为任务/规格正文的维护入口；项目文档索引链接到它，避免维护两份正文。
- `ready-for-agent` 表示规格完备，不表示已实施、已验收或已授权采购、真实数据迁移和部署；继续遵守该任务明确的执行边界。

## Wayfinding

- 决策地图使用 `.scratch/<effort>/map.md`，子问题分别使用 `issues/NN-<slug>.md`。
- 子问题用 `Type:` 标记 `research`、`prototype`、`grilling` 或 `task`；用 `Blocked by: NN, NN` 表达依赖。
- 依赖均为 `resolved` 后才可领取；按编号选择未领取项，开始前写入 `Status: claimed`。
- 完成后追加 `## Answer`，设为 `Status: resolved`，并将结论与链接写入地图。
- `claimed` / `resolved` 是 wayfinding 子问题的专用状态，不扩展普通 triage 的五种状态。

## 历史资料与现有文件

历史任务保留在 `docs/archive/`，新任务不写入历史目录。保留现有 `.scratch/` 中的探测脚本、样本和忽略规则，发布仅操作对应功能的 Markdown 文件；不自动提交或上传这些资料。
