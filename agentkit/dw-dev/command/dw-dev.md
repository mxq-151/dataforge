---
description: 从需求文档完成数仓设计与作业代码（设计 → 设计校验 → 代码 → 代码校验的完整链路）
agent: dw-orchestrator
---

按「数仓开发」套件完成全链路。业务名称：`$ARGUMENTS`。

如果 `$ARGUMENTS` 为空，先在工作区 `docs/` 下查找唯一的 `*_开发需求.md`；找到多个就停下来问用户选哪个，不要猜。

本命令只串起 dw-orchestrator 已有的设计阶段与代码阶段，不新增阶段、不改编排器内部的单元划分与门禁规则。设计阶段未通过 `dw-finalize-design` 前，禁止进入代码阶段。

## 阶段一：数仓设计

1. **解析需求**：调用 `dw-extract-req {businessName}`。
   - 失败（W01/W02/W03）→ 停止，原样报告错误码与位置，不修补需求文档。
   - 成功 → 记录指标数量、场景、输出方式、数据时效。

2. **登记证据**：对需求第 4 章的源系统/业务对象、以及候选上游表，调用外部只读 `metadata_search`；必要时 `metadata_detail` 查字段。把真实命中整理成记录，调用 `dw-submit-meta`（每批 ≤20）。
   - 不命中就不登记；不命中对象一律不得进入设计。
   - 数据源名称以 metadata 返回为准，不自行起名。

3. **设计分层与表**：按主题域分组，每组 ≤8 张，派 `dw-modeler`（任务=table）。覆盖 ODS/DWD/DWS/ADS/DIM、粒度与主键、分区与生命周期、更新方式、维度建模与宽表边界；依据不足写入待确认，不虚构表。

4. **指标落地**：按主题域分组，每组 ≤10 条，派 `dw-modeler`（任务=metric）。指标名称逐字继承需求第 3 章，编码全局唯一，字段来源绑定真实 `库.表:字段`。

5. **稽核规则**：按表分组，每组 ≤20 条，派 `dw-modeler`（任务=quality）。规则类型只取 7 类，每张表至少 1 条。

6. **全局校验**：调用 `dw-validate-design {}`。有 error → 按 `byUnit` 回退对应单元，修完重跑，直到 `blocking=0`。

7. **语义审查**：派 `dw-design-reviewer`，结论通过 `dw-submit-review {phase:"design"}` 提交。blocker 必须回退修正，复核沿用同一 finding id。

8. **设计定稿**：先 `dw-finalize-design {businessName, dryRun:true}`，再正式调用；成功后调用 `dw-trace-metric` 抽查 3–5 个需求指标，任一 W26 即视为未完成，不得进入代码阶段。

## 阶段二：作业代码

9. **生成作业计划**：调用 `dw-extract-design {businessName}`。
   - W28 → 设计未定稿或文档被改动，停止并回到设计阶段。
   - 成功 → 得到处理作业（每张表一个）+ 质检作业（每张被校验表一个）。

10. **分单元编码**：每组 ≤5 个作业，派 `dw-coder`。只给本组 JobSpec 骨架、目标表/源表字段与分区、相关指标、依赖前驱。编码约束由 `dw-submit-job` 强制（代码头、`@引擎`、分区过滤、指标标注、方言一致性等）。

11. **校验**：调用 `dw-check-code {}`。
   - `W36_SYNTAX_UNAVAILABLE`：停止落盘并说明，不得用 `syntax:false` 交付。
   - `W36_SYNTAX_FAILED` / `W36_STATIC_FAILED`：回退 `dw-coder` 修复对应作业。

12. **语义审查**：派 `dw-code-reviewer`，结论通过 `dw-submit-review {phase:"code"}` 提交。blocker 回退 `dw-coder`，复核沿用同一 finding id。

13. **代码落盘**：先 `dw-finalize-code {dryRun:true}` 看 plan，再正式调用。
   - 目标文件已存在且内容不同 → 冲突，交用户决定，不覆盖；
   - 成功 → 报告写入/跳过的文件与 `.dw/code-manifest.json`。

## 硬约束

- 主 agent 不整篇读需求/设计文档，只读工具摘要与单元切片。
- 子代理只见自己单元；不把所有证据/所有表一次性塞给它。
- 不虚构库/表/字段/引擎/质量规则类型；缺信息登记为待确认或设计问题。
- 不跳过 `dw-validate-design` / `dw-check-code`；工具说失败就是失败。
- 同一单元最多重派 3 次；仍失败则交付草稿 + 未关闭问题，不宣告完成。

## 交付

```
产物：docs/{业务}_数仓设计.md；ddls/{分层}_ddl.sql；sql/{分层}/*.sql、code/{分层}/*.java|*.scala；.dw/trace.json；.dw/code-manifest.json
规模：N 张表 / M 个指标 / K 条规则 / J 个作业
校验：设计 A/B 0 error、C 类 open blocker 0；代码静态 0 error、语法 passed、C 类 open blocker 0
未关闭：finding-id（severity）… 或 无
未完成：作业名 + 原因（若有）
待确认：需求第 9 章 + metadata 缺口（逐条）
```
