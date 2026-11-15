---
description: 任务智能诊断（自然语言入口，自动识别引擎与诊断类型）
agent: diag-orchestrator
subtask: false
---

# 任务

用户描述了某个数据任务的异常，需要定位原因。

现象描述：`$ARGUMENTS`

# 执行

按 `diag-orchestrator` 的完整状态机执行，不要跳步：

1. **S0**：`diag_resolve_target`。从描述与对话里提取 `taskInstanceId` / `applicationId` / `jobId` / 任务名 / 时间窗。
   - 解析不到唯一目标 → 反问用户，列出缺什么，**结束本轮**。
   - 有多个候选 → 列出候选让用户选，**结束本轮**。
2. **S1**：`diag_capabilities` → 拿 `runId` 与能力结论。
3. **S1.5**：`diag_upstream_context`（只调一次）。
4. **S1.8**：按引擎路由到对应 `diag-*` agent；未登记类型走 `diag_unsupported_report`。
5. **S6**：`diag_save_report`。

# 判断诊断类型的规则

| 用户说法 | mode |
|---|---|
| 失败 / 挂了 / 报错 / 没跑出来 / 超时被 kill | `FAILED` |
| 变慢 / 比平时久 / 卡住 / 延迟高 / 积压 | `SLOW` |
| 数据不对 / 少了 / 重复（本套件只支持定位到"无法判定"或作业侧原因） | `FAILED`（并把数据类证据缺口写进 gaps） |

说不清就默认 `FAILED`，但在报告里注明"诊断类型由默认值推断"。

# 硬性要求

- 不要把所有引擎的排查逻辑混在一起；交给对应引擎 agent，你只做路由与汇总。
- 未登记引擎类型必须输出「该类型不可诊断」，不得硬套其它引擎的结论。
- 结尾必须给出：报告路径、结论级别、一句话根因（或「无法定位」）、最关键 1–2 条缺口。
