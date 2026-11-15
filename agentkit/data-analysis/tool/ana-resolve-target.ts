import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, LIMITS, channelById } from "../lib/constants"
import { AnalysisError, aError, metadataSearch, toolError, toolOk, toolFail } from "../lib/client"

type SearchItem = {
  kind?: string
  id?: number
  name?: string
  database?: string
  table?: string
  comment?: string
  layerCode?: string
  domainCode?: string
  score?: number
  matchedBy?: string
}

type SearchResponse = {
  items?: SearchItem[]
  total?: number
  truncated?: boolean
}

const ResolveSchema = z
  .object({
    datasource: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
  })
  .strict()

export default tool({
  description:
    "解析分析对象：按库名/表名或自然语言关键词检索库表，返回唯一目标或候选清单。解析不到唯一目标时不得猜，必须反问用户。",
  args: {
    keywords: z.array(z.string().min(1)).max(6).optional().describe("自然语言关键词，例如 [订单, 明细]"),
    target: ResolveSchema.optional().describe("已知的库表线索"),
    datasource: z.string().min(1).optional().describe("限定数据源名称"),
    limit: z.number().int().positive().max(50).optional(),
  },
  async execute(args) {
    try {
      const keywords = [...(args.keywords ?? [])]
      if (args.target?.table) keywords.push(args.target.table)
      if (args.target?.database) keywords.push(args.target.database)
      if (keywords.length === 0) {
        throw aError(CODES.TARGET_UNRESOLVED, "缺少分析对象：请给出库表线索或关键词。", {
          requirements: ["数据源 + 库 + 表", "或用于检索库表的业务关键词"],
        })
      }
      if (!channelById("metadata.retrieval")) {
        throw aError(CODES.CHANNEL_UNAVAILABLE, "metadata.retrieval 通道未登记")
      }

      let response: SearchResponse
      try {
        response = await metadataSearch<SearchResponse>(
          "/api/agent/retrieval/tables",
          {
            keywords: [...new Set(keywords)],
            filters: args.datasource ? { datasources: [args.datasource] } : undefined,
            types: ["table"],
            limit: args.limit ?? 20,
          },
          LIMITS.apiTimeoutMs,
        )
      } catch (error) {
        if (error instanceof AnalysisError && error.code === CODES.AUTH_DENIED) {
          return toolFail(CODES.AUTH_DENIED, "检索接口可达，但当前账号没有库表检索权限。", {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: ["申请元数据检索权限"],
          })
        }
        if (error instanceof AnalysisError && error.code === CODES.API_UNAVAILABLE) {
          return toolFail(CODES.API_UNAVAILABLE, "元数据检索接口不可达。", {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: ["确认 dataforge-server 可访问", "确认 DATAFORGE_API_HOST 已注入"],
          })
        }
        throw error
      }

      const items = (response.items ?? []).filter((item) => (item.kind ?? "table") === "table")
      const wantedTable = args.target?.table
      const wantedDatabase = args.target?.database
      const exact = items.filter((item) => {
        if (!wantedTable) return false
        if ((item.table ?? item.name ?? "") !== wantedTable) return false
        if (wantedDatabase && item.database && item.database !== wantedDatabase) return false
        return true
      })

      if (exact.length === 1) {
        const hit = exact[0]
        return toolOk({
          resolved: true,
          confidence: "exact",
          target: { datasource: args.datasource, database: hit.database, table: hit.table ?? hit.name },
          note: "库表来自检索结果；字段与权限仍需 ana_metadata_detail 确认",
        })
      }

      if (exact.length > 1 || items.length > 1) {
        const candidates = (exact.length > 1 ? exact : items).slice(0, 10).map((item) => ({
          database: item.database,
          table: item.table ?? item.name,
          comment: item.comment,
          matchedBy: item.matchedBy,
          score: item.score,
        }))
        return toolFail(CODES.TARGET_AMBIGUOUS, "存在多个候选对象，需要用户确认后再继续。", {
          resolved: false,
          ambiguous: true,
          contract: "metadata-readonly",
          candidates,
          requirements: ["请指定 数据源 + 库 + 表"],
        })
      }

      return toolFail(CODES.TARGET_UNRESOLVED, "未检索到匹配的库表。", {
        resolved: false,
        ambiguous: false,
        contract: "metadata-readonly",
        searchedKeywords: [...new Set(keywords)],
        requirements: ["确认库表名是否正确", "或提供数据源 + 库 + 表"],
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
