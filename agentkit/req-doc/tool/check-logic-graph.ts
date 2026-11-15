/**
 * A/B 类逻辑判定（R14），纯代码、0 token。
 * A 类：跨章节引用一致性；B 类：结构化矛盾。
 * C 类（自洽/可度量/可落数/分摊合理）不在此处，由 logic-reviewer 带证据判定。
 */
import { tool } from "@opencode-ai/plugin"
import {
  CHAPTER_IDS,
  PLACEHOLDER_NEED_INPUT,
  loadSections,
  nowIso,
  ruleOf,
  workPath,
  writeJsonAtomic,
  type ChapterId,
} from "../lib/constants"

type LogicIssue = {
  code: string
  rule: string
  severity: "error" | "warning" | "info"
  stage: "A" | "B"
  chapter: number
  message: string
}

function textOf(payload: unknown): string {
  return payload === undefined ? "" : JSON.stringify(payload)
}

export default tool({
  description:
    "R14 逻辑图校验：A 类跨章节引用一致性（章节引用存在性、场景覆盖、占位闭环、输出使用方）与 B 类结构化矛盾（指标引用闭环、优先级与阻断问题、时效与加工频率），全部代码判定，结果写 .work/logic-errors.json。",
  args: {},
  async execute(_args, context) {
    const root = context.directory
    const rule = ruleOf("R14")
    const sections = loadSections(root)
    const issues: LogicIssue[] = []
    const add = (
      code: string,
      severity: LogicIssue["severity"],
      stage: "A" | "B",
      chapter: number,
      message: string,
    ) => issues.push({ code, rule: rule.id, severity, stage, chapter, message })

    const missing = CHAPTER_IDS.filter((id) => sections[id] === undefined)
    if (missing.length) {
      add("E14A_SECTION_MISSING", "error", "A", 0, `以下章节尚未提交：${missing.join(",")}`)
    }

    const allText = CHAPTER_IDS.map((id) => textOf(sections[id])).join("\n")

    // ── A1：显式章节引用「第 N 章」必须存在 ─────────────────────────────
    const refs = new Set<string>()
    for (const match of allText.matchAll(/第\s*(\d{1,2})\s*章/g)) refs.add(match[1])
    for (const ref of refs) {
      const id = Number(ref)
      if (!Number.isInteger(id) || id < 1 || id > 9) {
        add("E14A_REF_CHAPTER", "error", "A", 0, `引用了「第 ${ref} 章」，本文档只有 9 章`)
        continue
      }
      if (sections[id as ChapterId] === undefined) {
        add("E14A_REF_CHAPTER", "error", "A", id, `引用了「第 ${ref} 章」，但该章尚无结构化数据`)
      }
    }

    // ── A2：第 2 章场景与第 3 章应用场景的覆盖关系（不强制场景编号） ────
    const scenes: any[] = Array.isArray(sections[2]?.scenes) ? sections[2].scenes : []
    const metrics: any[] = Array.isArray(sections[3]) ? sections[3] : []
    for (const scene of scenes) {
      const name = String(scene?.name ?? "").trim()
      if (!name) continue
      const used = metrics.some((metric) => String(metric?.scenario ?? "").includes(name))
      if (!used) {
        add("E14A_SCENE_UNUSED", "info", "A", 2, `场景「${name}」未被任何指标的应用场景引用（仅提示，不阻断）`)
      }
    }

    // ── A3：占位引用必须在第 9 章闭环 ───────────────────────────────────
    const hasPlaceholder = allText.includes(PLACEHOLDER_NEED_INPUT) || allText.includes("待查证")
    const questions: any[] = Array.isArray(sections[9]?.questions) ? sections[9].questions : []
    if (hasPlaceholder && questions.length === 0) {
      add("E14A_PLACEHOLDER_OPEN", "error", "A", 9, "正文存在占位/待查证内容，但第 9 章待确认问题为空，必须逐条登记")
    }

    // ── A4：第 6 章使用方应出现在第 1 章使用对象中 ──────────────────────
    const audiences: string[] = Array.isArray(sections[1]?.audiences) ? sections[1].audiences : []
    const outputs: any[] = Array.isArray(sections[6]?.outputs) ? sections[6].outputs : []
    for (const output of outputs) {
      const consumer = String(output?.consumer ?? "").trim()
      if (!consumer) continue
      const known = audiences.some((audience) => audience.includes(consumer) || consumer.includes(audience))
      if (!known) {
        add("E14A_OUTPUT_AUDIENCE", "warning", "A", 6, `输出使用方「${consumer}」未在第 1 章使用对象中出现`)
      }
    }

    // ── B1：第 8 章验收标准引用的指标必须在第 3 章存在 ──────────────────
    const metricNames = new Set(metrics.map((metric) => String(metric?.name ?? "").trim()).filter(Boolean))
    const criteria: string[] = Array.isArray(sections[8]?.criteria) ? sections[8].criteria : []
    const METRIC_ISH = /(率|数|额|量|占比)$/
    for (const item of criteria) {
      const explicit = /指标|口径/.test(item)
      for (const match of item.matchAll(/「([^」]{2,24})」/g)) {
        const token = match[1]
        const known = [...metricNames].some((name) => name === token || token.includes(name))
        if (known) continue
        if (explicit) {
          add("E14B_METRIC_UNKNOWN", "error", "B", 8, `验收标准引用了「${token}」，但第 3 章没有同名指标`)
        } else if (METRIC_ISH.test(token)) {
          add("E14B_METRIC_UNKNOWN", "warning", "B", 8, `验收标准疑似引用了未定义的指标「${token}」`)
        }
      }
    }
    for (const name of metricNames) {
      const covered = criteria.some((item) => item.includes(name))
      if (!covered) add("E14B_METRIC_UNCOVERED", "info", "B", 3, `指标「${name}」未被任何验收标准覆盖（仅提示）`)
    }

    // ── B2：P0 与阻断型待确认问题矛盾 ───────────────────────────────────
    const priority = String(sections[8]?.priority ?? "")
    const blocking = questions.filter((item) => /阻断|阻塞|无法落数|无法取数|不可用/.test(String(item?.impact ?? "")))
    if (priority === "P0" && blocking.length > 0) {
      add("E14B_PRIORITY_CONFLICT", "warning", "B", 8, `优先级为 P0，但第 9 章存在 ${blocking.length} 条阻断型待确认问题`)
    }

    // ── B3：时效与加工频率矛盾 ──────────────────────────────────────────
    const frequency = String(sections[5]?.updateFrequency ?? "")
    const steps = Array.isArray(sections[4]?.processingSteps) ? sections[4].processingSteps.join(" ") : ""
    if (/实时|准实时/.test(frequency) && /每日|按天|日批|T\+1|次日/.test(steps)) {
      add("E14B_FREQUENCY_CONFLICT", "warning", "B", 5, "更新频率声明为实时/准实时，但加工逻辑包含日批/次日口径")
    }
    if (/T\+1|次日/.test(frequency) && /实时/.test(steps)) {
      add("E14B_FREQUENCY_CONFLICT", "warning", "B", 5, "更新频率声明为 T+1/次日，但加工逻辑包含实时处理")
    }

    const blockingCount = issues.filter((issue) => issue.severity === "error").length
    const report = { generatedAt: nowIso(), rule: rule.id, issues, blocking: blockingCount }
    writeJsonAtomic(workPath(root, "logic-errors.json"), report)

    return JSON.stringify({
      ok: blockingCount === 0,
      rule: rule.id,
      blocking: blockingCount,
      total: issues.length,
      issues,
      file: ".work/logic-errors.json",
      message:
        blockingCount === 0
          ? "A/B 类无阻断问题，可进入 C 类审查。"
          : "存在 error 级逻辑问题：按 chapter 路由给对应 writer 修正后重跑 check-logic-graph。",
    })
  },
})
