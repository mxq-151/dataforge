/**
 * D1：metadata 证据登记。
 *
 * 本工具不访问 metadata 服务——仓库里的 metadata_search/metadata_detail 是外部 MCP 工具，
 * 只能由模型调用。这里做的是「把模型查到的证据固化成可校验的事实源」：
 * 后续表/字段/指标引用只能命中这些记录，查不到即失败，杜绝「猜一个差不多的表名」。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { metaPath, nowIso, updateJson } from "../lib/constants"
import { EvidenceSchema, flattenIssues } from "../lib/schema"

const BATCH_LIMIT = 20

export default tool({
  description: `D1 登记 metadata 证据（每批最多 ${BATCH_LIMIT} 条）。只接受 metadata_search/metadata_detail 的真实返回，后续所有库表字段引用必须命中登记表。`,
  args: {
    records: z.array(z.unknown()).min(1).describe("证据记录数组，字段见 EvidenceSchema"),
    note: z.string().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    if (args.records.length > BATCH_LIMIT) {
      return JSON.stringify({ ok: false, code: "E_BATCH_LIMIT", message: `单批最多 ${BATCH_LIMIT} 条` })
    }
    const rejected: { index: number; issues: string[] }[] = []
    const accepted: any[] = []
    args.records.forEach((raw, index) => {
      const parsed = EvidenceSchema.safeParse(raw)
      if (!parsed.success) rejected.push({ index, issues: flattenIssues(parsed.error) })
      else accepted.push(parsed.data)
    })
    if (rejected.length) {
      return JSON.stringify({
        ok: false,
        rule: "W04",
        code: "W04_META_EVIDENCE_SHAPE",
        rejected,
        message: "整批未写入。按 issues 修正后重提，已通过的条目需一并重提。",
      })
    }

    let response = ""
    updateJson<{ businessName?: string | null; records?: any[]; updatedAt?: string }>(metaPath(root), (state) => {
      const existing: any[] = Array.isArray(state?.records) ? state!.records! : []
      const byKey = new Map<string, any>()
      const keyOf = (item: any) => `${item.database}.${item.table}:${item.column ?? "*"}@${item.sourceTool}`
      for (const record of existing) byKey.set(keyOf(record), record)
      for (const record of accepted) byKey.set(keyOf(record), { ...record, submittedAt: nowIso() })
      const records = [...byKey.values()]
      response = JSON.stringify({
        ok: true,
        file: ".dw/meta.json",
        accepted: accepted.length,
        total: records.length,
        hits: records.filter((record) => record.hit).length,
        message: `已登记 ${accepted.length} 条证据，累计 ${records.length} 条（命中 ${records.filter((record) => record.hit).length}）。`,
      })
      return { businessName: args.note ?? null, records, updatedAt: nowIso() }
    })
    return response
  },
})
