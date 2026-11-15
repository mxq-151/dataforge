import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES } from "../lib/constants"
import { aError, toolError, toolOk } from "../lib/client"
import { budgetSummary, peekBudget, spend } from "../lib/budget"
import { loadScope } from "../lib/scope"

export default tool({
  description: "查看或扣减本次分析的预算（查询次数 / 返回行数）。预算耗尽时必须停止取数并输出证据不足，不得继续尝试。",
  args: {
    runId: z.string().min(1),
    action: z.enum(["peek", "spend"]).default("peek"),
    queries: z.number().int().nonnegative().max(200).optional(),
    rows: z.number().int().nonnegative().max(1_000_000).optional(),
    label: z.string().min(1).default("manual"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)

      if (args.action === "peek") {
        const state = peekBudget(root, scope.runId)
        return toolOk({ action: "peek", budget: budgetSummary(state), limit: state.limit, used: state.used })
      }

      if (!args.queries && !args.rows) {
        throw aError(CODES.SCHEMA_INVALID, "spend 需要 queries 或 rows 至少一项")
      }
      const result = spend(root, scope.runId, { queries: args.queries ?? 0, rows: args.rows ?? 0 }, args.label)
      return toolOk({
        action: "spend",
        budget: budgetSummary(result.state),
        remaining: result.remaining,
        trail: result.state.trail.slice(-5),
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
