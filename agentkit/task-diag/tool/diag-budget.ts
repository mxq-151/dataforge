/**
 * 预算查询与扣减。所有工具在真正取数前都会调它，因此这里是「成本失控」的唯一闸门。
 * 超限直接抛 D05（工具返回 ok=false），调用方必须收敛为「证据不足」，不得继续取证。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { toolError, toolOk } from "../lib/http"
import { budgetSummary, peekBudget, spend } from "../lib/budget"

export default tool({
  description:
    "查询或扣减本次运行的预算（调用次数 / 扫描字节）。action=peek 只读；action=spend 扣减并在超限时返回 D05。",
  args: {
    runId: z.string().min(1).describe("运行 ID"),
    action: z.enum(["peek", "spend"]).describe("peek=只读，spend=扣减"),
    calls: z.number().int().nonnegative().optional().describe("本次消耗的调用次数"),
    bytes: z.number().int().nonnegative().optional().describe("本次消耗的扫描字节"),
    label: z.string().optional().describe("消耗来源，便于事后核对（例如 s2-logs:yarn-am）"),
  },
  async execute(args, context) {
    try {
      const root = context.directory
      if (args.action === "peek") {
        const state = peekBudget(root, args.runId)
        return toolOk({ runId: args.runId, ...budgetSummary(state) })
      }
      const result = spend(root, args.runId, { calls: args.calls, bytes: args.bytes }, args.label || "unspecified")
      return toolOk({
        runId: args.runId,
        ...budgetSummary(result.state),
        spent: { calls: args.calls ?? 0, bytes: args.bytes ?? 0 },
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
