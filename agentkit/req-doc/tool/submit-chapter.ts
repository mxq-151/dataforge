/**
 * 单章结构化提交（第 1/2/4–9 章）：R12 校验通过才写 .work/sec{N}.json。
 * 第 3 章必须走 submit-metrics-batch。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CHAPTER_IDS,
  nowIso,
  ruleOf,
  secPath,
  updateJson,
  type ChapterId,
  type SectionState,
} from "../lib/constants"
import { CHAPTER_PAYLOAD_SCHEMAS, flattenIssues } from "../lib/schema"

export default tool({
  description:
    "提交单章结构化 JSON（仅 1/2/4~9 章）。按 schema.ts 校验该章字段，通过后写入 .work/sec{N}.json；失败不落盘并返回错误码。第 3 章请用 submit-metrics-batch。",
  args: {
    chapter: z.number().int().min(1).max(9).describe("章节编号 1~9，不能是 3"),
    payload: z.unknown().describe("该章节的结构化对象，字段见 schema.ts 对应 Chapter{n}Schema"),
  },
  async execute(args, context) {
    const root = context.directory
    const chapter = args.chapter as number

    if (chapter === 3) {
      return JSON.stringify({
        ok: false,
        code: "E_ARG_CHAPTER3",
        message: "第 3 章必须通过 submit-metrics-batch 分批提交，不接受 submit-chapter。",
      })
    }
    if (!CHAPTER_IDS.includes(chapter as any)) {
      return JSON.stringify({ ok: false, code: "E_ARG_CHAPTER", message: `章节编号非法：${chapter}` })
    }

    const schema = CHAPTER_PAYLOAD_SCHEMAS[chapter as ChapterId]
    if (!schema) {
      return JSON.stringify({ ok: false, code: "E_ARG_CHAPTER", message: `第 ${chapter} 章没有对应 schema` })
    }

    const parsed = schema.safeParse(args.payload)
    if (!parsed.success) {
      const rule = ruleOf("R12")
      return JSON.stringify({
        ok: false,
        rule: rule.id,
        code: rule.code,
        chapter,
        issues: flattenIssues(parsed.error),
        message: `第 ${chapter} 章提交被拒绝，按 issues 修正后重新调用 submit-chapter。`,
      })
    }

    const file = secPath(root, chapter as ChapterId)
    let revision = 0
    updateJson<SectionState>(file, (previous) => {
      revision = (previous?.revision ?? 0) + 1
      return {
        chapter: chapter as ChapterId,
        payload: parsed.data,
        submittedAt: nowIso(),
        revision,
      }
    })

    return JSON.stringify({
      ok: true,
      chapter,
      file: `.work/sec${chapter}.json`,
      revision,
      message: `第 ${chapter} 章已写入中间态。`,
    })
  },
})
