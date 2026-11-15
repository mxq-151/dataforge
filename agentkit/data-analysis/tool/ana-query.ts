import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, channelById } from "../lib/constants"
import { AnalysisError, toolError, toolFail } from "../lib/client"
import { loadScope, assertChannel } from "../lib/scope"
import { TargetSchema, TimeRangeSchema } from "../lib/schema"

/**
 * 数据内容类分析的唯一入口——当前**不会执行任何查询**。
 *
 * 设计文档 Q3：`/api/development/execution` 未做服务端只读白名单化之前，
 * 该通道固定为 `unmanaged`。本工具因此：
 * - 不接收 SQL（避免模型以为可以「写一条试试」）；
 * - 不拼 URL、不调执行端点、不在本地兜底；
 * - 固定返回 `not_implemented + requirements(B-01)`，让编排层如实降级。
 */
export default tool({
  description:
    "数据内容类分析入口（当前不可用）。任何需要读取表数据的问题都必须先经过它；它会返回 not_implemented + 所需接口，禁止改用开发执行端点或自拼 SQL。",
  args: {
    runId: z.string().min(1),
    purpose: z.string().min(1).describe("为什么要读数据，例如：判断订单表近 7 天分区是否缺失"),
    target: TargetSchema.optional(),
    timeRange: TimeRangeSchema.optional(),
    expectedEvidence: z.array(z.string()).max(10).optional().describe("期望得到的证据项，例如 [每日行数, 分区列表]"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)
      const spec = channelById("data.query")
      if (!spec) {
        return toolFail(CODES.CHANNEL_UNAVAILABLE, "data.query 通道未登记")
      }
      try {
        assertChannel(scope, "data.query")
        // 即使未来某天通道被错误地标成 available，也不在这里执行：
        // 执行能力必须来自 B-01 的独立实现，不能复用开发执行端点。
        return toolFail(CODES.NOT_IMPLEMENTED, "受控只读查询通道尚未实现", {
          outcome: "not_implemented",
          channelId: "data.query",
          neededInterface: "B-01",
          requirements: spec.requirements,
        })
      } catch (error) {
        if (error instanceof AnalysisError && error.code === CODES.CHANNEL_UNMANAGED) {
          return toolFail(CODES.CHANNEL_UNMANAGED, "受控只读查询通道未纳管（unmanaged）：无限定作用域、无幂等、结论不可复核。", {
            outcome: "not_implemented",
            channelId: "data.query",
            neededInterface: "B-01",
            requirements: spec.requirements,
            purpose: args.purpose,
            expectedEvidence: args.expectedEvidence ?? [],
            fallback:
              "只能改用运行态/日志/版本配置/指标口径做间接分析，并将结论上限压到 L3；不得声称数据正确性",
          })
        }
        throw error
      }
    } catch (error) {
      return toolError(error)
    }
  },
})
