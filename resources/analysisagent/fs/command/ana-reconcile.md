---
description: 指标口径对账（预设 analysisType=reconcile）
agent: ana-orchestrator
subtask: false
---

# 任务

对两个指标口径做定义层对账，判断它们是否描述同一件事、差异在哪。

对账对象：`$ARGUMENTS`

# 执行

1. **S0**：从输入解析指标编码（可带 `projectCode` / `topic` / 版本）。
   - 少于两个口径 → 反问补齐，**结束本轮**。
2. **S1**：`ana_capabilities({ analysisType:"reconcile", indicators:[...] })`。
3. **S2**：派发给 `ana-indicator`，要求逐个 `ana_indicator` 取定义。
4. **S3**：若口径接口不可用 / 无权限 → 走 `ana_finalize_report({ fallback:true })`。
5. **S4**：`ana_finalize_report`。

# 约束

- 只做**定义层**对账：口径口径、过滤条件、字段、刷新方式、负责人。
- 数值是否一致需要受控数据查询（B-01），未纳管时必须写「数值未对账」，不得用其它通道推断。
- 结论级别最高 L3；没有口径引用时不得声称「口径一致」。
