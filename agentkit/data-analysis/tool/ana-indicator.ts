import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { CODES, LIMITS } from "../lib/constants"
import { AnalysisError, aError, metadataGet, toolError, toolOk, toolFail } from "../lib/client"
import { spend } from "../lib/budget"
import { nowIso } from "../../shared/lib/io"
import { IndicatorRefSchema } from "../lib/schema"
import { assertChannel, assertOwner, channelKeyFor, loadScope, saveEvidencePack } from "../lib/scope"

type IndicatorVO = {
  id?: number
  projectCode?: string
  topic?: string
  name?: string
  code?: string
  businessDefinition?: string
  calcExpr?: string
  defaultFilter?: string
  businessOwner?: string
  techOwner?: string
  refreshInterval?: number
  refreshUnit?: string
  refreshDesc?: string
  visibility?: string
  updatedAt?: string
  fields?: { fieldName?: string; fieldType?: string; fieldComment?: string }[]
}

const IndicatorArgs = z
  .object({
    runId: z.string().min(1),
    id: z.number().int().positive().optional().describe("指标 ID（已知时优先）"),
    indicatorCode: z.string().min(1).optional().describe("指标编码"),
    projectCode: z.string().min(1).optional(),
    topic: z.string().min(1).optional(),
    version: z.string().min(1).optional().describe("期望版本；当前指标接口无版本字段，会记为缺口"),
    owner: z.string().min(1).default("ana-indicator"),
  })
  .strict()

function isNotFound(error: unknown): boolean {
  if (!(error instanceof AnalysisError)) return false
  const detail = error.detail as { status?: number; businessCode?: number } | undefined
  return detail?.status === 404 || detail?.businessCode === 404
}

export default tool({
  description:
    "查询指标口径（metadata 侧，Q4 决策）。只返回定义，不返回业务数据；同名/多候选必须让调用方确认，不得任选。",
  args: IndicatorArgs.shape,
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)
      if (!args.id && !args.indicatorCode) {
        throw aError(CODES.INDICATOR_UNAVAILABLE, "需要指标 ID 或指标编码")
      }
      const spec = assertChannel(scope, "metadata.indicator")
      assertOwner(spec, args.owner)

      /** 接口不可达与无权限必须分开：前者是 unavailable + requirements，后者是权限类 code。 */
      const metadataUnavailable = (error: unknown): string | null => {
        if (!(error instanceof AnalysisError)) return null
        if (error.code === CODES.AUTH_DENIED) {
          return toolFail(CODES.AUTH_DENIED, "指标接口可达，但当前账号无指标查看权限。", {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: ["申请指标管理/查看权限"],
          })
        }
        if (error.code === CODES.API_UNAVAILABLE) {
          return toolFail(CODES.API_UNAVAILABLE, "指标接口不可达。", {
            outcome: "unavailable",
            contract: "metadata-readonly",
            requirements: ["确认 dataforge-server 可访问", "确认 DATAFORGE_API_HOST 已注入"],
          })
        }
        return null
      }

      let vo: IndicatorVO | null = null
      let candidates: IndicatorVO[] = []

      if (args.id) {
        try {
          vo = await metadataGet<IndicatorVO>(`/api/metadata/indicators/${args.id}`, undefined, LIMITS.apiTimeoutMs)
        } catch (error) {
          if (isNotFound(error)) vo = null
          else {
            const unavailable = metadataUnavailable(error)
            if (unavailable) return unavailable
            throw error
          }
        }
        if (!vo) {
          return toolFail(CODES.INDICATOR_UNAVAILABLE, `指标不存在：id=${args.id}`, {
            reason: "INDICATOR_NOT_FOUND",
            requirements: ["确认指标 ID", "或用指标编码检索"],
          })
        }
      } else {
        let list: IndicatorVO[] = []
        try {
          list = await metadataGet<IndicatorVO[]>(
            "/api/metadata/indicators/filter",
            {
              keyword: args.indicatorCode,
              projectCode: args.projectCode,
              topic: args.topic,
            },
            LIMITS.apiTimeoutMs,
          )
        } catch (error) {
          const unavailable = metadataUnavailable(error)
          if (unavailable) return unavailable
          throw error
        }
        const exact = (list ?? []).filter((item) => (item.code ?? "").toLowerCase() === args.indicatorCode!.toLowerCase())
        candidates = exact
        if (exact.length === 0) {
          return toolFail(CODES.INDICATOR_UNAVAILABLE, `指标不存在：code=${args.indicatorCode}`, {
            reason: "INDICATOR_NOT_FOUND",
            requirements: [
              "确认指标编码",
              "或提供 projectCode/topic 缩小范围",
              "若该口径尚未维护，需先在指标管理中登记",
            ],
          })
        }
        if (exact.length > 1) {
          return toolFail(CODES.INDICATOR_UNAVAILABLE, "同名指标存在多个候选，不能任选。", {
            reason: "INDICATOR_AMBIGUOUS",
            candidates: exact.map((item) => ({
              id: item.id,
              code: item.code,
              projectCode: item.projectCode,
              topic: item.topic,
              name: item.name,
            })),
            requirements: ["请指定 projectCode / topic / 指标 ID"],
          })
        }
        vo = exact[0]
      }

      const gaps = []
      if (args.version) {
        gaps.push({
          code: "INDICATOR_VERSION_UNSUPPORTED",
          detail: `指标接口未提供版本字段，无法确认 ${args.indicatorCode ?? args.id} 是否为 ${args.version}`,
          neededInterface: "B-02",
          requirements: ["指标定义补充 version 字段", "或返回可用版本清单"],
        })
      }

      const ref = IndicatorRefSchema.parse({
        projectCode: vo.projectCode,
        topic: vo.topic,
        indicatorCode: vo.code ?? args.indicatorCode,
        version: args.version,
      })

      const channelKey = channelKeyFor({
        channelId: "metadata.indicator",
        dataTypeId: "indicator",
        stream: "v1",
        ref: {
          code: ref.indicatorCode,
          version: ref.version ?? "unspecified",
        },
      })

      const saved = saveEvidencePack(
        root,
        scope.runId,
        "indicator",
        {
          runId: scope.runId,
          analysisType: scope.analysisType,
          owner: args.owner,
          step: "indicator",
          channel: { id: "metadata.indicator", dataTypeId: "indicator", stream: "v1" },
          channelKey,
          scopeTicketId: scope.runId,
          scan: { bytes: null, bytesUnavailable: true, durationMs: 0 },
          indicatorRefs: [ref],
          stats: [],
          samples: [],
          facts: [
            { key: "indicator.id", value: vo.id ?? null, source: "metadata.indicators" },
            { key: "indicator.code", value: vo.code ?? null, source: "metadata.indicators" },
            { key: "indicator.hasDefinition", value: Boolean(vo.businessDefinition), source: "metadata.indicators" },
            { key: "indicator.hasCalcExpr", value: Boolean(vo.calcExpr), source: "metadata.indicators" },
            { key: "indicator.fieldCount", value: vo.fields?.length ?? 0, source: "metadata.indicators" },
          ],
          gaps,
          createdAt: nowIso(),
        },
        channelKey,
      )
      spend(root, scope.runId, { queries: 1, rows: 0 }, "ana_indicator")

      return toolOk({
        outcome: "ok",
        indicator: {
          id: vo.id,
          code: vo.code,
          name: vo.name,
          projectCode: vo.projectCode,
          topic: vo.topic,
          businessDefinition: vo.businessDefinition,
          calcExpr: vo.calcExpr,
          defaultFilter: vo.defaultFilter,
          owners: [vo.businessOwner, vo.techOwner].filter(Boolean),
          refresh: [vo.refreshInterval, vo.refreshUnit, vo.refreshDesc].filter(Boolean).join(" "),
          visibility: vo.visibility,
          updatedAt: vo.updatedAt,
          fields: (vo.fields ?? []).slice(0, 100).map((field) => ({
            name: field.fieldName,
            type: field.fieldType,
            comment: field.fieldComment,
          })),
        },
        indicatorRef: ref,
        gaps,
        evidencePath: saved.path,
        reused: saved.reused,
        note: "口径只用于解释与对账；不得据此推断业务数据",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
