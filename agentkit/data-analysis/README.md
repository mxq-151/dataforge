# data-analysis

数据分析 agent 套件。按**分析问题类型**拆分分析子代理（不按表、不按引擎、不按阶段），编排层只做目标解析、能力判定、派发与落盘。

配套设计见 `.trae/documents/按任务类型划分的Agent技术架构与数据分析Agent重新设计-2026-11-15.md` 第 3 章。

## 目录

| 目录 | 作用 |
|---|---|
| `agent/` | `ana-orchestrator`（primary）+ 分析子代理 |
| `command/` | 自然语言入口，全部落到 `ana-orchestrator` |
| `tool/` | 自有工具，zod 严格校验，统一经 `lib/http.ts` 访问后端 |
| `lib/` | 确定性逻辑：四态、scope、`channelKey`、证据包、预算、语句白名单、渲染 |
| `plugin/` | 写盘闸 |

## 产物与状态

- 产物：`analysis/AN-<runId>/`（报告、`findings.json`、证据包、只读查询文件）
- 状态：`.analysisagent/runs/<runId>/`（scope 票据、能力表、预算）

与 `task-diag` 的 `diagnosis/`、`.diagagent/` 完全隔离，不共用票据与幂等键。

## 只读通道

数据内容类分析依赖后端受控只读查询通道（设计文档 B-01）。该通道未落地前：

- 能力表把 `/api/development/execution` 标为 `unmanaged`；
- 工具返回 `not_implemented + requirements`，不兜底、不自拼 SQL；
- 运行态、日志、版本配置、指标口径仍可分析。

## 构建

```bash
npm run build:agentkits
```

产物落到 `resources/analysisagent/`（由 `kit.json` 的 `outDir` 决定）。
