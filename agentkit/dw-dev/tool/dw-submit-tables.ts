/**
 * D2：表设计分批提交（每批 ≤8 张）。
 * 批内原子：任一张不合格整批不落盘；跨批只追加，不覆盖已提交表。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { loadMeta, nowIso, tablesPath, updateJson } from "../lib/constants"
import { TableSchema, flattenIssues } from "../lib/schema"
import { buildMetaIndex, validateTable } from "../lib/design-validator"

const BATCH_LIMIT = 8

export default tool({
  description: `D2 分批提交表设计（每批最多 ${BATCH_LIMIT} 张）。校验命名/中文名/分类分级/脱敏/粒度/键/分区/生命周期/拉链/方言/字段来源/上游/数据源，通过后追加到 .dw/tables.json。`,
  args: {
    tables: z.array(z.unknown()).min(1),
    note: z.string().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    if (args.tables.length > BATCH_LIMIT) {
      return JSON.stringify({ ok: false, code: "E_BATCH_LIMIT", message: `单批最多 ${BATCH_LIMIT} 张，本次 ${args.tables.length} 张` })
    }
    let response = ""
    updateJson<{ tables?: any[]; updatedAt?: string }>(tablesPath(root), (state) => {
      const existing: any[] = Array.isArray(state?.tables) ? state!.tables! : []
      const names = new Set(existing.map((table) => table.enName))
      const rejected: { index: number; name: string | null; code: string; issues: string[] }[] = []
      const accepted: any[] = []

      const parsedBatch: any[] = []
      args.tables.forEach((raw, index) => {
        const parsed = TableSchema.safeParse(raw)
        if (!parsed.success) {
          rejected.push({ index, name: null, code: "W06_TABLE_NAME", issues: flattenIssues(parsed.error) })
          return
        }
        if (names.has(parsed.data.enName)) {
          rejected.push({ index, name: parsed.data.enName, code: "W06_TABLE_NAME", issues: [`表名 ${parsed.data.enName} 已提交过；如需改设计请新建表名或显式修订`] })
          return
        }
        names.add(parsed.data.enName)
        parsedBatch.push({ ...parsed.data, index })
      })

      const all = [...existing, ...parsedBatch.map(({ index, ...table }) => table)]
      const meta = buildMetaIndex(loadMeta(root))
      for (const table of parsedBatch) {
        const issues = validateTable(table, all, meta)
        if (issues.length) {
          rejected.push({ index: table.index, name: table.enName, code: issues[0].code, issues: issues.map((issue) => `${issue.code}: ${issue.message}`) })
        } else {
          const { index, ...value } = table
          accepted.push(value)
        }
      }

      if (rejected.length) {
        response = JSON.stringify({
          ok: false,
          acceptedCount: 0,
          rejected,
          message: "整批未写入（批内原子）。按 index/code 修正后整批重提。",
        })
        return undefined
      }

      const tables = [...existing, ...accepted.map((table) => ({ ...table, submittedAt: nowIso() }))]
      response = JSON.stringify({
        ok: true,
        file: ".dw/tables.json",
        acceptedNames: accepted.map((table) => table.enName),
        total: tables.length,
        message: `本批 ${accepted.length} 张已提交，累计 ${tables.length} 张。`,
      })
      return { tables, updatedAt: nowIso() }
    })
    return response
  },
})
