---
description: 独立触发 C 类逻辑审查，产出审查报告
agent: doc-orchestrator
subtask: false
---

# 任务

对已存在（或已提交结构化中间态）的业务需求做 C 类逻辑审查，产出 `docs/{业务名称}_审查报告.md`。

业务名称：`$ARGUMENTS`

这条命令**只审查、不改需求文档**：不调用 `submit-chapter` / `submit-metrics-batch` / `finalize-doc`。

# 执行流程

1. `extract-context({ businessName })`：确认目标文档与场景上下文。
2. 若 `.work/sec1.json ~ sec9.json` 不齐全：读取 `docs/{业务名称}_开发需求.md`，让 `logic-reviewer` 直接基于文档文本审查，并在报告开头注明「基于文档快照审查，未经过流水线校验」。
3. 派发 `logic-reviewer`，要求它按 C1 自洽 / C2 可度量 / C3 可落数 / C4 分摊合理四类清单逐项过，结论必须带原文证据。
4. `logic-reviewer` 调 `submit-review-findings({ findings, finalize: true })` 落 `.work/review.json` 并生成审查报告。
5. 如本次审查发现先前已存在但已修复的问题，沿用原 `id` 并置 `status=fixed`，不要新建重复条目。

# 输出

只回报：

- 审查报告路径
- `blocker / major / minor` 计数
- blocker 的一行摘要（id + 指标 + 问题），最多 5 条
- 若 `blocker > 0`，给出「需修正后才可定稿」的明确结论（对应 `E16_REVIEW_BLOCKED`）

不要粘贴审查报告全文。
