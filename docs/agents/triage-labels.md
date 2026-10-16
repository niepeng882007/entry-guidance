# Triage Labels

本仓库保留五个默认角色，使用相同字符串作为本地规格/任务的 `Status:` 值。

| 技能中的角色      | 本仓库状态        | 含义                        |
| ----------------- | ----------------- | --------------------------- |
| `needs-triage`    | `needs-triage`    | 等待维护者评估              |
| `needs-info`      | `needs-info`      | 等待补充信息                |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交给 agent 处理 |
| `ready-for-human` | `ready-for-human` | 需要人工实施                |
| `wontfix`         | `wontfix`         | 不予实施                    |

技能要求应用某个 triage 角色时，使用表中的原样字符串。普通规格或任务只保留一个当前 triage 状态；不要把历史状态并列成当前状态。
