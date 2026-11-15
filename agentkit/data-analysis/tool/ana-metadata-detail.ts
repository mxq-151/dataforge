import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, LIMITS } from "../lib/constants"
import { AnalysisError, aError, metadataGet, toolError, toolOk, toolFail } from "../lib/client"
import { spend } from "../lib/budget"
import { nowIso } from "../../shared/lib/io"
import { assertChannel, assertOwner, channelKeyFor, loadScope, saveEvidencePack } from "../lib/scope"

type ColumnVO = {
  columnName?: string
  columnType?: string
  columnComment?: string
  isPartition?: number
  isPrimaryKey?: number
  nullable?: number
  maskingType?: string
  canRead?: boolean
  canWrite?: boolean
}

type TableDetailVO = {
  id?: number
  databaseName?: string
  tableName?: string
  tableComment?: string
  tableType?: string
  storageFormat?: string
  rowCount?: number
  canRead?: boolean
  canWrite?: boolean
  columns?: ColumnVO[]
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof AnalysisError)) return false
  const detail = error.detail as { status?: number; businessCode?: number } | undefined
  return detail?.status === 404 || detail?.businessCode === 404
}

export default tool({
  description:
    "查询表结构与列级权限（metadata 侧只读）。未授权列不会返回；rowCount 为元数据同步的 T+1 值，不能当实时数据量。",
  args: {
    runId: z.string().min(1),
    database: z.string().min(1),
    table: z.string().min(1),
    datasource: z.string().min(1).optional().describe("仅用于缺口提示：当前表详情接口不支持按数据源过滤"),
    owner: z.string().min(1).default("ana-profile"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)
      const spec = assertChannel(scope, "metadata.table")
      assertOwner(spec, args.owner)

      let detail: TableDetailVO | null = null
      try {
        detail = await metadataGet<TableDetailVO>(
          "/api/metadata/agent/table-detail",
          { databaseName: args.database, tableName: args.table },
          LIMITS.apiTimeoutMs,
        )
      } catch (error) {
        if (isNotFound(error)) {
          detail = null
        } else if (error instanceof AnalysisError && error.code === CODES.AUTH_DENIED) {
          return toolFail(CODES.AUTH_DENIED, `表详情接口可达，但当前账号无权查看 ${args.database}.${args.table}`, {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: [`申请 ${args.database}.${args.table} 的元数据查看权限`],
          })
        } else if (error instanceof AnalysisError && error.code === CODES.API_UNAVAILABLE) {
          return toolFail(CODES.API_UNAVAILABLE, "表详情接口不可达。", {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: ["确认 dataforge-server 可访问", "确认 DATAFORGE_API_HOST 已注入"],
          })
        } else {
          throw error
        }
      }

      if (!detail) {
        return toolFail(CODES.TARGET_UNRESOLVED, `表不存在：${args.database}.${args.table}`, {
          outcome: "unavailable",
          contract: "metadata-readonly",
          requirements: ["确认库名与表名", "或先用 ana_resolve_target 检索"],
        })
      }
      if (detail.canRead === false) {
        return toolFail(CODES.AUTH_DENIED, `无读取权限：${args.database}.${args.table}`, {
          outcome: "unavailable",
          contract: "metadata-readonly",
          requirements: [`申请 ${args.database}.${args.table} 的读权限`],
        })
      }

      const allColumns = detail.columns ?? []
      const readable = allColumns.filter((column) => column.canRead !== false)
      const masked = readable.filter((column) => Boolean(column.maskingType))

      const gaps = []
      if (args.datasource) {
        gaps.push({
          code: "DATASOURCE_FILTER_UNSUPPORTED",
          detail: "表详情接口按 database+table 查询，不接收 datasource；同名表在不同数据源时会歧义",
          neededInterface: "B-05",
          requirements: ["表详情接口增加 datasource 参数"],
        })
      }
      gaps.push({
        code: "PARTITION_STATS_UNAVAILABLE",
        detail: "rowCount 是元数据同步的 T+1 表级值；没有分区级统计与历史基线",
        neededInterface: "B-03",
        requirements: ["分区级行数/体积", "历史序列与近 7 日基线", "按需刷新"],
      })

      const channelKey = channelKeyFor({
        channelId: "metadata.table",
        dataTypeId: "table",
        stream: "v1",
        ref: {
          database: args.database,
          table: args.table,
          datasource: args.datasource ?? "unspecified",
        },
      })

      const saved = saveEvidencePack(
        root,
        scope.runId,
        "table-detail",
        {
          runId: scope.runId,
          analysisType: scope.analysisType,
          owner: args.owner,
          step: "table-detail",
          channel: {
            id: "metadata.table",
            serviceType: args.datasource,
            dataTypeId: "table",
            stream: "v1",
            ref: { database: args.database, table: args.table },
          },
          channelKey,
          scopeTicketId: scope.runId,
          scan: { bytes: null, bytesUnavailable: true, durationMs: 0 },
          indicatorRefs: [],
          stats: [
            {
              name: "table.row_count_metadata",
              value: detail.rowCount ?? null,
              unit: "rows",
              scope: "metadata-sync",
            },
            { name: "table.readable_columns", value: readable.length, unit: "columns" },
            { name: "table.masked_columns", value: masked.length, unit: "columns" },
          ],
          samples: [],
          facts: [
            { key: "table.type", value: detail.tableType ?? null, source: "metadata.agent.table-detail" },
            { key: "table.storageFormat", value: detail.storageFormat ?? null, source: "metadata.agent.table-detail" },
            { key: "table.rowCountFreshness", value: "T+1-metadata-sync", source: "metadata.agent.table-detail" },
          ],
          gaps,
          createdAt: nowIso(),
        },
        channelKey,
      )
      spend(root, scope.runId, { queries: 1, rows: 0 }, "ana_metadata_detail")

      return toolOk({
        outcome: "ok",
        table: {
          database: detail.databaseName ?? args.database,
          table: detail.tableName ?? args.table,
          comment: detail.tableComment,
          type: detail.tableType,
          storageFormat: detail.storageFormat,
          rowCountMetadata: detail.rowCount ?? null,
          canRead: detail.canRead !== false,
          canWrite: Boolean(detail.canWrite),
        },
        columns: readable.slice(0, 200).map((column) => ({
          name: column.columnName,
          type: column.columnType,
          comment: column.columnComment,
          partition: column.isPartition === 1,
          primaryKey: column.isPrimaryKey === 1,
          nullable: column.nullable === 1,
          masking: column.maskingType ?? null,
        })),
        columnCounts: {
          total: allColumns.length,
          readable: readable.length,
          unreadable: allColumns.length - readable.length,
          masked: masked.length,
        },
        gaps,
        evidencePath: saved.path,
        reused: saved.reused,
        note: "rowCount 是 T+1 元数据值，不能作为「当前数据量是否异常」的证据",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
