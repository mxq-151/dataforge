---
description: 数据分析（自然语言入口，自动识别分析问题类型）
agent: ana-orchestrator
subtask: false
---

# 任务

用户提出了一个数据或任务产出相关的问题，需要给出可复核的分析结论。

问题描述：`$ARGUMENTS`

# 执行

按 `ana-orchestrator` 的状态机执行，不要跳步：

1. **S0 定目标**：解析数据源 / 库 / 表 / 服务实例 / 时间窗 / 指标口径。
   - 解析不到唯一目标 → 反问用户，列出缺什么，**结束本轮**。
   - 有多个候选 → 列出候选让用户选，**结束本轮**。
2. **S1 判能力**：`ana_capabilities`，拿到 `runId` 与可用通道。
3. **S2 派发**：按分析类型路由到一个子代理。
4. **S3 兜底**：可用通道为空 / 子代理无证据 / 预算内无结论 → `ana_finalize_report({ fallback:true })`。
5. **S4 落盘**：`ana_finalize_report`，报告与结论级别由工具生成。

# 分析类型路由

| 用户说法 | analysisType | 子代理 |
|---|---|---|
| 产出是否按时 / 任务结果是否正常 | `runtime` | `ana-runtime` |
| 最近涨了还是跌了 / 波动 | `trend` | `ana-trend` |
| 两个时间段 / 两个分组差多少 | `compare` | `ana-compare` |
| 有没有重复 / 有没有空值 / 分区是否缺失 | `integrity` | `ana-profile` |
| 分布是否异常 / 长尾 / 占比 | `distribution` | `ana-profile` |
| 为什么变了 / 哪个维度贡献最大 | `attribution` | `ana-attribution` |
| 同一个指标两个口径对不上 | `reconcile` | `ana-indicator` |

说不清就默认 `runtime`，并在报告里注明「分析类型由默认值推断」。

# 硬性要求

- 不要用模型常识补口径、补数据；缺少证据就写缺口。
- 数据内容类分析（完整性、唯一性、分布、业务趋势、数据维度归因）依赖受控只读查询 B-01；未纳管时必须返回 `not_implemented + requirements`，不得改用 `/api/development/execution` 兜底，也不得自拼 SQL。
- 结论级别 L1–L4 由 `ana_finalize_report` 计算并钳制，不得自行抬高。
- 结尾必须给出：报告路径、结论级别、一句话结论（或「无法判定」）、最关键 1–2 条缺口。
