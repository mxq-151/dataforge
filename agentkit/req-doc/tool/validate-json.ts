/**
 * S2：JSON 层完整性与一致性校验（R13）→ .work/errors.json
 * 单章 schema 已由 submit-chapter / submit-metrics-batch 在写前校验（R12/R18），此处不重复。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CHAPTER_IDS,
  nowIso,
  readJson,
  ruleOf,
  secPath,
  workPath,
  writeJsonAtomic,
  type ChapterId,
  type SectionState,
} from "../lib/constants"

export default tool({
  description:
    "S2 JSON 完整性校验（R13）：检查 sec1~sec9 是否齐全、chapter 字段是否与文件编号一致、第 3 章指标是否非空，结果写入 .work/errors.json。",
  args: {
    chapters: z.array(z.number().int().min(1).max(9)).optional().describe("只校验指定章节，默认全部"),
  },
  async execute(args, context) {
    const root = context.directory
    const rule = ruleOf("R13")
    const targets: ChapterId[] = (args.chapters?.length ? args.chapters : CHAPTER_IDS).map((id) => id as ChapterId)
    const errors: { code: string; rule: string; chapter: number; message: string }[] = []
    const stats = { chapters: 0, metrics: 0, bytes: 0 }

    const contextInfo = readJson<{ businessName?: string }>(workPath(root, "context.json"))
    if (!contextInfo) {
      errors.push({
        code: "E13_CONTEXT_MISSING",
        rule: rule.id,
        chapter: 0,
        message: "缺少 .work/context.json，请先调用 extract-context。",
      })
    }

    for (const id of targets) {
      const state = readJson<SectionState>(secPath(root, id))
      if (!state) {
        errors.push({
          code: rule.code,
          rule: rule.id,
          chapter: id,
          message: `缺少 .work/sec${id}.json`,
        })
        continue
      }
      if (state.chapter !== id) {
        errors.push({
          code: rule.code,
          rule: rule.id,
          chapter: id,
          message: `sec${id}.json 的 chapter 字段为 ${state.chapter}，与文件名不一致`,
        })
      }
      if (id === 3) {
        const metrics = Array.isArray(state.payload) ? state.payload : null
        if (!metrics || metrics.length === 0) {
          errors.push({
            code: rule.code,
            rule: rule.id,
            chapter: 3,
            message: "第 3 章指标数组为空",
          })
        } else {
          stats.metrics = metrics.length
        }
      } else if (!state.payload || typeof state.payload !== "object") {
        errors.push({
          code: rule.code,
          rule: rule.id,
          chapter: id,
          message: `第 ${id} 章 payload 不是对象`,
        })
      }
      stats.chapters += 1
      stats.bytes += Buffer.byteLength(JSON.stringify(state.payload ?? null), "utf8")
    }

    const report = { generatedAt: nowIso(), rule: rule.id, errors, stats }
    writeJsonAtomic(workPath(root, "errors.json"), report)

    return JSON.stringify({
      ok: errors.length === 0,
      rule: rule.id,
      errorCount: errors.length,
      errors,
      stats,
      file: ".work/errors.json",
      message: errors.length === 0 ? "JSON 层校验通过，可进入逻辑校验。" : "存在缺口，按 errors 补齐对应章节后再跑 validate-json。",
    })
  },
})
