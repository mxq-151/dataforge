/**
 * D0：解析上游需求文档 → .dw/req.json
 *
 * 只在「文档结构可解析」时落盘：章节缺失、指标表形状错误、必填项为空都直接失败，
 * 因为需求文档是上游事实，猜一个只会把错误放大到设计与代码。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { headingText, splitRow } from "../../shared/lib/md"
import {
  docPathForRequirement,
  nowIso,
  reqPath,
  writeJsonAtomic,
} from "../lib/constants"

const REQ_CHAPTERS = [
  { id: 1, title: "需求背景", match: "需求背景" },
  { id: 2, title: "可分析场景梳理", match: "可分析场景" },
  { id: 3, title: "数据指标", match: "数据指标" },
  { id: 4, title: "数据范围与加工逻辑", match: "数据范围" },
  { id: 5, title: "数据时效要求", match: "数据时效" },
  { id: 6, title: "数据输出方式", match: "数据输出方式" },
  { id: 7, title: "质量检查要求", match: "质量检查" },
  { id: 8, title: "优先级与验收标准", match: "优先级与验收标准" },
  { id: 9, title: "待确认问题", match: "待确认问题" },
]

const METRIC_COLUMNS = ["指标名称", "主题域", "业务定义", "计算口径", "过滤条件", "下钻维度", "应用场景"]

function sectionText(lines: string[], head: number, headings: { line: number }[]): string[] {
  const next = headings.find((item) => item.line > head)
  return lines.slice(head + 1, next ? next.line : lines.length)
}

function afterLabel(text: string[], label: string): string {
  for (const line of text) {
    const m = new RegExp(`\\*\\*${label}\\*\\*\\s*[：:]\\s*(.+)$`).exec(line)
    if (m) return m[1].trim()
    const bullet = new RegExp(`^\\s*-\\s*${label}\\s*[：:]\\s*(.+)$`).exec(line)
    if (bullet) return bullet[1].trim()
  }
  return ""
}

function bulletsAfter(text: string[], label: string): string[] {
  const index = text.findIndex((line) => line.includes(label))
  if (index === -1) return []
  const output: string[] = []
  for (let i = index + 1; i < text.length; i++) {
    const line = text[i]
    if (!line.trim()) continue
    if (!/^\s*-\s+/.test(line)) break
    output.push(line.replace(/^\s*-\s+/, "").trim())
  }
  return output
}

export default tool({
  description:
    "D0 解析上游需求文档 docs/{业务}_开发需求.md（9 章、第 3 章 7 列指标表），校验通过后写 .dw/req.json。失败不落盘，返回 W01/W02/W03 错误码。",
  args: {
    businessName: z.string().min(1).describe("业务名称，与需求文档一致"),
  },
  async execute(args, context) {
    const root = context.directory
    const target = docPathForRequirement(root, args.businessName)
    if (!fs.existsSync(target)) {
      return JSON.stringify({
        ok: false,
        code: "W01_REQ_MISSING",
        message: `上游需求文档不存在：docs/${args.businessName}_开发需求.md，请先用需求文档套件产出`,
      })
    }
    const markdown = fs.readFileSync(target, "utf8").replace(/\r\n?/g, "\n")
    const lines = markdown.split("\n")
    const headings: { line: number; id: number | null; text: string }[] = []
    lines.forEach((line, index) => {
      const text = headingText(line)
      if (text === null) return
      const def = REQ_CHAPTERS.find((chapter) => text.includes(chapter.match))
      headings.push({ line: index, id: def?.id ?? null, text })
    })

    const issues: { code: string; message: string }[] = []
    const present = new Set(headings.map((item) => item.id).filter(Boolean) as number[])
    const missing = REQ_CHAPTERS.filter((chapter) => !present.has(chapter.id)).map((chapter) => chapter.id)
    if (missing.length) {
      issues.push({ code: "W01_REQ_CHAPTER", message: `需求文档缺少章节：${missing.join(",")}` })
    }
    const ordered = headings.filter((item): item is { line: number; id: number; text: string } => item.id !== null)
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].id <= ordered[i - 1].id) {
        issues.push({ code: "W01_REQ_CHAPTER", message: `章节顺序错误：第 ${ordered[i].id} 章出现在第 ${ordered[i - 1].id} 章之后` })
      }
    }

    // 第 3 章指标表
    const chapter3 = headings.find((item) => item.id === 3)
    const metrics: any[] = []
    if (chapter3) {
      const region = sectionText(lines, chapter3.line, headings)
      const blocks: { start: number; end: number }[] = []
      let cursor = -1
      for (let i = 0; i < region.length; i++) {
        if (/^\s*\|/.test(region[i])) {
          if (cursor === -1) cursor = i
          continue
        }
        if (cursor !== -1) {
          blocks.push({ start: cursor, end: i - 1 })
          cursor = -1
        }
      }
      if (cursor !== -1) blocks.push({ start: cursor, end: region.length - 1 })
      if (blocks.length !== 1) {
        issues.push({ code: "W02_REQ_METRIC_TABLE", message: `第 3 章表格数量应为 1，实际 ${blocks.length}` })
      } else {
        const block = blocks[0]
        const header = splitRow(region[block.start])
        if (header.join("|") !== METRIC_COLUMNS.join("|")) {
          issues.push({ code: "W02_REQ_METRIC_TABLE", message: `指标表表头应为「${METRIC_COLUMNS.join(" | ")}」，实际「${header.join(" | ")}」` })
        }
        for (let i = block.start; i <= block.end; i++) {
          const line = region[i]
          if (!line.trim().startsWith("|") || !line.trim().endsWith("|")) {
            issues.push({ code: "W02_REQ_METRIC_TABLE", message: "指标表每一行必须以 | 开头并以 | 结尾" })
            break
          }
          if (/^\|[\s:|-]+\|$/.test(line.trim())) continue
          const cells = splitRow(line)
          if (cells.length !== METRIC_COLUMNS.length) {
            issues.push({ code: "W02_REQ_METRIC_TABLE", message: `指标表行列数应为 ${METRIC_COLUMNS.length}，实际 ${cells.length}` })
            break
          }
          if (i === block.start) continue
          const [name, domain, definition, caliber, filter, dimensions, scenario] = cells
          const required: [string, string][] = [
            ["指标名称", name],
            ["主题域", domain],
            ["业务定义", definition],
            ["计算口径", caliber],
            ["下钻维度", dimensions],
            ["应用场景", scenario],
          ]
          for (const [label, value] of required) {
            if (!value) issues.push({ code: "W03_REQ_METRIC_REQUIRED", message: `指标「${name || "(空)"}」的${label}为空` })
          }
          metrics.push({ name, domain, definition, caliber, filter, dimensions, scenario })
        }
      }
    }

    const seen = new Set<string>()
    for (const metric of metrics) {
      if (!metric.name) continue
      if (seen.has(metric.name)) {
        issues.push({ code: "W03_REQ_METRIC_REQUIRED", message: `指标名称「${metric.name}」重复` })
      }
      seen.add(metric.name)
    }

    if (issues.length) {
      return JSON.stringify({ ok: false, issues, metricCount: metrics.length, message: "需求文档不可解析，未写入 .dw/req.json" })
    }

    const chapter = (id: number) => {
      const head = headings.find((item) => item.id === id)
      return head ? sectionText(lines, head.line, headings) : []
    }
    const ch1 = chapter(1)
    const ch2 = chapter(2)
    const ch4 = chapter(4)
    const ch5 = chapter(5)
    const ch6 = chapter(6)
    const ch7 = chapter(7)
    const ch9 = chapter(9)

    const scenes = ch2
      .map((line) => /^###\s+(.+)$/.exec(line)?.[1] ?? "")
      .map((text) => text.replace(/^场景\s*\d+\s*[：:]\s*/, "").trim())
      .filter(Boolean)

    const outputs = ch6
      .map((line) => {
        const m = /输出方式[：:]\s*([^；;]+)[；;]\s*使用方[：:]\s*([^；;]+)[；;]\s*访问方式[：:]\s*(.+)$/.exec(line)
        return m ? { type: m[1].trim(), consumer: m[2].trim(), access: m[3].trim() } : null
      })
      .filter(Boolean)

    const questions = ch9
      .map((line) => {
        const m = /问题[：:]\s*([^；;]+)[；;]\s*影响[：:]\s*(.+)$/.exec(line)
        return m ? { question: m[1].trim(), impact: m[2].trim() } : null
      })
      .filter(Boolean)

    const sourceSystems = [
      ...new Set(
        ch4.flatMap((line) => {
          const m = /(?:源系统|业务系统)[^：:]*[：:]\s*(.+)$/.exec(line)
          if (!m) return []
          return m[1]
            .split(/[、,，;；]/)
            .map((item) => item.trim())
            .filter(Boolean)
        }),
      ),
    ]
    const qualityRequirements = ch7
      .map((line) => /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim() ?? "")
      .filter(Boolean)

    const payload = {
      businessName: args.businessName,
      targetFile: `docs/${args.businessName}_开发需求.md`,
      extractedAt: nowIso(),
      chaptersPresent: [...present].sort((a, b) => a - b),
      metrics,
      scenes,
      businessGoal: afterLabel(ch1, "业务目标"),
      audiences: bulletsAfter(ch1, "使用对象"),
      decisionScenes: bulletsAfter(ch1, "决策场景"),
      updateFrequency: afterLabel(ch5, "更新频率"),
      latestAvailableTime: afterLabel(ch5, "最晚可用时间"),
      historyBackfill: afterLabel(ch5, "历史回溯范围"),
      outputs,
      questions,
      sourceSystems,
      qualityRequirements,
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
    }
    writeJsonAtomic(reqPath(root), payload)

    return JSON.stringify({
      ok: true,
      file: ".dw/req.json",
      metricCount: metrics.length,
      sceneCount: scenes.length,
      chaptersPresent: payload.chaptersPresent,
      metricNames: metrics.map((metric) => metric.name).slice(0, 60),
      message: `需求解析完成：${metrics.length} 个指标、${scenes.length} 个场景。下一步先登记 metadata 证据再设计表。`,
    })
  },
})
