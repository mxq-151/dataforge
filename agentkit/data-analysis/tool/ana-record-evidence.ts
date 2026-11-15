import { tool } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import { z } from "zod"
import { ANALYSIS_ROUTES, CODES, findingsPath } from "../lib/constants"
import { aError, toolError, toolOk } from "../lib/client"
import { nowIso, writeJsonAtomic } from "../../shared/lib/io"
import {
  FactSchema,
  FindingSchema,
  GapSchema,
  IndicatorRefSchema,
  QueryMetaSchema,
  ScanSchema,
  StatSchema,
} from "../lib/schema"
import { assertChannel, assertOwner, channelKeyFor, loadScope, saveEvidencePack } from "../lib/scope"

const SampleSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))

export default tool({
  description:
    "落盘结构化结果。kind=evidence 写证据包（统计量/事实/缺口，同内容只写一次）；kind=findings 写本类型结论 findings.json（仅限该分析类型的路由 agent）。",
  args: {
    runId: z.string().min(1),
    kind: z.enum(["evidence", "findings"]).default("evidence"),
    step: z.string().min(1).describe("步骤名，例如 trend-baseline / integrity-partitions"),
    channelId: z.string().min(1).optional().describe("证据来源通道 id（kind=evidence 时必填）"),
    owner: z.string().min(1),
    stats: z.array(StatSchema).max(50).default([]),
    facts: z.array(FactSchema).max(50).default([]),
    samples: z.array(SampleSchema).max(50).default([]),
    gaps: z.array(GapSchema).max(20).default([]),
    indicatorRefs: z.array(IndicatorRefSchema).max(10).default([]),
    query: QueryMetaSchema.optional(),
    scan: ScanSchema.optional(),
    finding: FindingSchema.optional().describe("kind=findings 时必填"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      const scope = loadScope(root, args.runId)

      if (args.kind === "findings") {
        if (!args.finding) {
          throw aError(CODES.SCHEMA_INVALID, "kind=findings 需要 finding")
        }
        const parsed = FindingSchema.safeParse(args.finding)
        if (!parsed.success) {
          throw aError(
            CODES.SCHEMA_INVALID,
            `findings 不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          )
        }
        if (parsed.data.runId !== scope.runId) {
          throw aError(CODES.SCHEMA_INVALID, `finding.runId(${parsed.data.runId}) 与 scope(${scope.runId}) 不一致`)
        }
        if (parsed.data.analysisType !== scope.analysisType) {
          throw aError(
            CODES.SCHEMA_INVALID,
            `finding.analysisType(${parsed.data.analysisType}) 与本次运行(${scope.analysisType}) 不一致`,
          )
        }
        if (args.owner !== ANALYSIS_ROUTES[scope.analysisType]) {
          throw aError(
            CODES.CHANNEL_FORBIDDEN,
            `只有 ${ANALYSIS_ROUTES[scope.analysisType]} 能写本次运行的结论，收到 ${args.owner}`,
          )
        }
        const file = findingsPath(root, scope.runId)
        writeJsonAtomic(file, parsed.data)
        return toolOk({
          findingsPath: file.replace(`${root}/`, ""),
          analysisType: parsed.data.analysisType,
          level: parsed.data.verdict.level,
          note: "结论已落盘；报告由编排器调用 ana_finalize_report 生成",
        })
      }

      if (!args.channelId) {
        throw aError(CODES.SCHEMA_INVALID, "kind=evidence 需要 channelId")
      }
      const spec = assertChannel(scope, args.channelId)
      assertOwner(spec, args.owner)

      if (args.stats.length + args.facts.length + args.samples.length + args.gaps.length === 0) {
        throw aError(CODES.SCHEMA_INVALID, "证据包为空：至少需要 stats / facts / samples / gaps 之一")
      }

      const digest = crypto
        .createHash("sha1")
        .update(JSON.stringify({ step: args.step, channelId: args.channelId, stats: args.stats, facts: args.facts, gaps: args.gaps }))
        .digest("hex")
        .slice(0, 12)

      const channelKey = channelKeyFor({
        channelId: args.channelId,
        dataTypeId: args.channelId,
        stream: "derived",
        ref: { step: args.step, digest },
      })

      const saved = saveEvidencePack(
        root,
        scope.runId,
        args.step,
        {
          runId: scope.runId,
          analysisType: scope.analysisType,
          owner: args.owner,
          step: args.step,
          channel: { id: args.channelId, dataTypeId: args.channelId, stream: "derived", ref: { step: args.step } },
          channelKey,
          scopeTicketId: scope.runId,
          query: args.query,
          scan: args.scan ?? {
            bytes: null,
            bytesUnavailable: true,
            durationMs: 0,
          },
          indicatorRefs: args.indicatorRefs,
          stats: args.stats,
          samples: args.samples,
          facts: args.facts,
          gaps: args.gaps,
          createdAt: nowIso(),
        },
        channelKey,
      )

      return toolOk({
        evidencePath: saved.path,
        reused: saved.reused,
        note: saved.reused ? "相同内容已存在，未重复写入" : "证据已落盘",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
