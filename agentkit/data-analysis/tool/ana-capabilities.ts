import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { ANALYSIS_ROUTES, ANALYSIS_TYPES, REQUIRED_CHANNELS } from "../lib/constants"
import { hasApiAccess, toolError, toolOk } from "../lib/client"
import { initBudget } from "../lib/budget"
import { TargetSchema, TimeRangeSchema, IndicatorRefSchema } from "../lib/schema"
import { buildCapabilities, buildScope, saveCapabilities } from "../lib/scope"

export default tool({
  description:
    "建立一次数据分析运行：创建 runId、作用域票据与预算，返回通道能力表。任何取数工具调用前必须先执行本工具。",
  args: {
    analysisType: z.enum(ANALYSIS_TYPES).describe("分析类型：runtime/trend/compare/distribution/integrity/attribution/reconcile"),
    target: TargetSchema.describe("分析对象：数据源/库/表，或服务实例标识"),
    timeRange: TimeRangeSchema.optional().describe("时间窗"),
    indicators: z.array(IndicatorRefSchema).optional().describe("需要引用的指标口径"),
    maxQueries: z.number().int().positive().max(200).optional().describe("查询次数预算，默认 12"),
    maxRows: z.number().int().positive().max(100_000).optional().describe("返回行数预算，默认 2000"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const apiAvailable = hasApiAccess()
      const { scope, scopePath } = buildScope(root, {
        analysisType: args.analysisType,
        target: args.target,
        timeRange: args.timeRange,
        indicators: args.indicators,
        maxQueries: args.maxQueries,
        maxRows: args.maxRows,
      })
      initBudget(root, scope.runId, { queries: scope.budget.maxQueries, rows: scope.budget.maxRows })

      const capabilities = buildCapabilities(scope, apiAvailable, ANALYSIS_ROUTES[args.analysisType])
      const capabilitiesPath = saveCapabilities(root, capabilities)

      const required = REQUIRED_CHANNELS[args.analysisType] ?? []
      const usable = capabilities.channels.filter((channel) => channel.usable).map((channel) => channel.id)
      const blocked = capabilities.channels.filter((channel) => !channel.usable)

      return toolOk({
        runId: scope.runId,
        analysisType: scope.analysisType,
        agent: capabilities.agent,
        apiAvailable,
        requiredChannels: required,
        usableChannels: usable,
        blockedChannels: blocked,
        missing: capabilities.missing,
        budget: scope.budget,
        scopePath,
        capabilitiesPath,
        evidenceDir: `analysis/AN-${scope.runId}/evidence`,
        next:
          blocked.length === 0
            ? "按 analysisType 路由到对应子代理取数"
            : "存在不可用通道：对应分析结论必须降级或返回 not_implemented + requirements，禁止伪造数据",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
