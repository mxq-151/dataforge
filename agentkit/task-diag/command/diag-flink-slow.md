---
description: 诊断 Flink 任务变慢
agent: diag-orchestrator
subtask: false
---

# 任务

诊断一个 Flink 任务的**变慢**问题。

引擎已预设为 `flink`、诊断类型已预设为 `SLOW`——**不要**改成其它引擎或其它类型。

任务引用：`$ARGUMENTS`

如果 `$ARGUMENTS` 为空，先向用户要「任务实例 ID / applicationId / jobId」中的任意一个，不要自己猜，也不要从最近的任务里挑一个。

# 执行

按 `diag-orchestrator` 的顺序执行：

1. **S0**：`diag_resolve_target`，带 `engine="flink"` 收窄候选。
2. **S1**：`diag_capabilities({ engine:"flink", mode:"SLOW", target })` → 拿 `runId`。
3. **S1.5**：`diag_upstream_context({ runId })`，只调一次。
4. **S1.8**：派发 `diag-flink`（runId 必传）。
5. **S6**：`diag_save_report({ runId })`。

# 硬性要求

- 指标优先：首轮必须先用 `diag_compare` 或 `diag_collect_runtime` 拿到耗时/吞吐/GC/背压，再定向查日志。禁止先翻 ERROR 日志然后说「无明显错误」。
- 结论级别不得超过 `capabilities.json` 里该引擎的 `ceiling`。
- 拿不到证据就输出「无法定位」，不得给出没有 `gap` 支撑的建议。
- 若是 `flink` 但能力表显示没有任何可用通道：不要反复尝试，直接由引擎 agent 输出 `UNRESOLVED` + 缺口。
