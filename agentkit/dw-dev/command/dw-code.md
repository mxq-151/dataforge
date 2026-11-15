---
description: 按数仓设计生成可运行作业代码（SQL/Java/Scala），静态规则 + 语法校验通过后才落盘
agent: dw-orchestrator
---

按「数仓开发」套件完成代码阶段。业务名称：`$ARGUMENTS`。

前置：`docs/{业务}_数仓设计.md` 已定稿（`.dw/trace.json` 存在且 sha256 一致）。没有就先执行 `/dw-design`。

## 执行顺序

1. **生成作业计划**：调用 `dw-extract-design {businessName}`。
   - W28 → 设计未定稿或文档被改动，停止并回到设计阶段。
   - 成功 → 得到处理作业（每张表一个）+ 质检作业（每张被校验表一个）。

2. **分单元编码**：每组 ≤5 个作业，派 `dw-coder`。只给：
   - 本组 JobSpec 骨架；
   - 目标表/源表字段清单、分区字段、更新方式；
   - 相关指标编码、名称、表达式；
   - 依赖前驱。

   编码要求（由 `dw-submit-job` 强制）：
   - 7 字段代码头 + 合法 `@引擎`；
   - SQL 禁止 `select *`、select 输出列顺序必须与设计字段一致、必须带分区过滤、不得硬编码日期、变量必须声明；
   - 引用的库表必须在设计 DDL 或证据中；
   - 带 `-- 指标: {编码} {名称}`；
   - insert 列顺序与设计字段顺序一致；
   - 方言差异显式处理（Hive/Spark/Doris/StarRocks/ClickHouse/MySQL/PostgreSQL 不混用函数）。
   - Java/Scala：package 末段=分层目录，类名=文件名，参数从 `${day}` 读取。

3. **校验**：调用 `dw-check-code {}`。
   - `W36_SYNTAX_UNAVAILABLE`：当前不在 DataForge 客户端内（缺 `DATAFORGE_COMPILE_PORT`），停止落盘并说明；不要用 `syntax:false` 交付。
   - `W36_SYNTAX_FAILED` / `W36_STATIC_FAILED`：只回该 job 的错误摘要，回退 `dw-coder`。
   - 通过后进入语义审查。

4. **语义审查**：派 `dw-code-reviewer`，范围五类（口径等价/聚合层级/join 正确/幂等/指标标注），通过 `dw-submit-review {phase:"code"}` 提交。blocker 回退 `dw-coder`，复核沿用同一 finding id。

5. **落盘**：先 `dw-finalize-code {dryRun:true}` 看 plan，再正式调用。
   - 目标文件已存在且内容不同 → 冲突，交用户决定，不覆盖；
   - 成功 → 报告写入/跳过的文件与 `.dw/code-manifest.json`。

## 硬约束

- 不读整篇设计文档；只读 `.dw/design.json` 摘要与作业单元切片。
- 不让模型整篇重写代码；每个作业独立提交、独立复验。
- 不虚构表/字段/引擎/参数；缺信息就报设计问题，不硬编码兜底。
- 不跳过语法校验；服务不可用即失败，而不是「没报错就算过」。
- 同一作业最多重派 3 次；仍失败则交付草稿 + 未关闭问题，不宣告完成。

## 交付

```
产物：sql/{分层}/*.sql、code/{分层}/*.java|*.scala（N 个）；.dw/code-manifest.json
校验：静态 W29–W35 0 error；语法 passed；C 类 open blocker 0
跳过：内容相同的文件（逐个列出）
未关闭：finding-id（severity）… 或 无
未完成：作业名 + 原因（若有）
```
