/**
 * JSON → Markdown 渲染、单元格安全断言、增量合并 mergeDocs。
 *
 * 转义策略：不做字符替换式「转义」，而是「拒绝 + 断言」。
 * 竖线与换行在 schema 层已被拒（R09/R18 提交时），render 层再断言一次，
 * md-validator 的 R05/R06 作为最终兜底——静默替换（| → ｜、\n → 空格）会丢信息。
 */
import { normalize, splitRow, trimTrailingBlank } from "../../shared/lib/md"
import { assertCellSafe, RenderError } from "../../shared/lib/table"
import {
  CALIBER_PARTS,
  CHAPTERS,
  METRIC_COLUMNS,
  chapterDef,
  type ChapterId,
} from "./constants"

export { assertCellSafe, RenderError }

type Dict = Record<string, any>

export type MergeConflict = {
  chapter: ChapterId
  kind: "scalar" | "scene" | "metric"
  key: string
  existing: string
  incoming: string
}

export function chapterHeading(id: ChapterId): string {
  return `## ${id}. ${chapterDef(id).title}`
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n")
}

export function renderMetrics(metrics: Dict[]): string {
  const header = `| ${METRIC_COLUMNS.join(" | ")} |`
  const separator = `|${METRIC_COLUMNS.map(() => "----------").join("|")}|`
  const rows = metrics.map((metric, index) => {
    const where = `第 ${index + 1} 条指标`
    const cells = [
      assertCellSafe(metric.name, `${where}「指标名称」`),
      assertCellSafe(metric.domain, `${where}「主题域」`),
      assertCellSafe(metric.definition, `${where}「业务定义」`),
      assertCellSafe(
        CALIBER_PARTS.map((part) => metric.caliber?.[part.key]).join("；"),
        `${where}「计算口径」`,
      ),
      assertCellSafe(metric.filter ?? "", `${where}「过滤条件」`),
      assertCellSafe(metric.dimensions, `${where}「下钻维度」`),
      assertCellSafe(metric.scenario, `${where}「应用场景」`),
    ]
    return `| ${cells.join(" | ")} |`
  })
  return [header, separator, ...rows].join("\n")
}

function renderBody(id: ChapterId, payload: Dict): string {
  switch (id) {
    case 1:
      return [
        `**业务目标**：${payload.businessGoal}`,
        "",
        "**使用对象**：",
        bullets(payload.audiences ?? []),
        "",
        "**决策场景**：",
        bullets(payload.decisionScenes ?? []),
        "",
        `**期望价值**：${payload.expectedValue}`,
      ].join("\n")
    case 2:
      return (payload.scenes ?? [])
        .map((scene: Dict, index: number) =>
          [
            `### 场景 ${index + 1}：${scene.name}`,
            `- 分析目的：${scene.purpose}`,
            `- 分析维度：${(scene.dimensions ?? []).join("、")}`,
            `- 期望粒度：${scene.granularity}`,
          ].join("\n"),
        )
        .join("\n\n")
    case 3:
      return renderMetrics(payload as unknown as Dict[])
    case 4:
      return [
        `**数据时间范围**：${payload.timeRange}`,
        "",
        "**源系统与业务对象**：",
        (payload.sourceSystems ?? [])
          .map((system: Dict) => `- 源系统：${system.name}；业务对象：${system.businessObject}；查证依据：${system.verification}`)
          .join("\n"),
        "",
        "**加工逻辑**：",
        (payload.processingSteps ?? []).map((step: string, index: number) => `${index + 1}. ${step}`).join("\n"),
      ].join("\n")
    case 5:
      return [
        `**更新频率**：${payload.updateFrequency}`,
        `**最晚可用时间**：${payload.latestAvailableTime}`,
        `**历史回溯范围**：${payload.historyBackfill}`,
      ].join("\n")
    case 6:
      return (payload.outputs ?? [])
        .map((output: Dict) => `- 输出方式：${output.type}；使用方：${output.consumer}；访问方式：${output.access}`)
        .join("\n")
    case 7:
      return (payload.rules ?? [])
        .map((rule: Dict) => `- 规则类型：${rule.ruleType}；说明：${rule.description}；可接受偏差：${rule.tolerance}`)
        .join("\n")
    case 8:
      return [`**优先级**：${payload.priority}`, "", "**验收标准**：", bullets(payload.criteria ?? [])].join("\n")
    case 9: {
      const questions = payload.questions ?? []
      return questions.length
        ? questions.map((item: Dict) => `- 问题：${item.question}；影响：${item.impact}`).join("\n")
        : "- 暂无"
    }
    default:
      throw new RenderError(`未知章节：${id}`)
  }
}

export function renderChapter(id: ChapterId, payload: Dict): string {
  return `${chapterHeading(id)}\n\n${renderBody(id, payload)}\n`
}

export function renderDocument(businessName: string, payloads: Partial<Record<ChapterId, Dict>>): string {
  const blocks = CHAPTERS.map((chapter) => {
    const payload = payloads[chapter.id]
    if (payload === undefined) throw new RenderError(`第 ${chapter.id} 章缺少结构化数据，无法渲染`)
    return renderChapter(chapter.id, payload)
  })
  return [`# ${businessName} 开发需求`, "", ...blocks].join("\n")
}

// ── 增量合并 ────────────────────────────────────────────────────────────

type Section = { id: ChapterId | null; heading: string; lines: string[] }

function splitSections(markdown: string): { preamble: string[]; sections: Section[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const preamble: string[] = []
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of lines) {
    const text = /^##(?!#)\s+(.*\S)\s*$/.exec(line)
    if (text) {
      const raw = text[1].replace(/^\d+\s*[.、)．]\s*/, "").trim()
      const def = CHAPTERS.find((chapter) => raw.includes(chapter.match))
      current = { id: def ? def.id : null, heading: line, lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  return { preamble, sections }
}

function splitRowText(line: string): string[] {
  return splitRow(line)
}

function mergeMetricTable(existingLines: string[], incomingLines: string[]): { lines: string[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = []
  const tableIndexes = existingLines
    .map((line, index) => (/^\s*\|/.test(line) ? index : -1))
    .filter((index) => index >= 0)

  if (tableIndexes.length < 3) {
    return { lines: incomingLines, conflicts }
  }

  const first = tableIndexes[0]
  const last = tableIndexes[tableIndexes.length - 1]
  const before = existingLines.slice(0, first)
  const after = existingLines.slice(last + 1)
  const header = existingLines.slice(first, first + 2)
  const bodyRows = objectRows(existingLines.slice(first + 2, last + 1))

  const byName = new Map<string, string[]>()
  for (const cells of bodyRows) if (cells[0]) byName.set(cells[0], cells)

  const incomingRows = objectRows(incomingLines.filter((line) => /^\s*\|/.test(line)).slice(2))
  for (const cells of incomingRows) {
    const name = cells[0]
    if (!name) continue
    const previous = byName.get(name)
    if (!previous) {
      bodyRows.push(cells)
      byName.set(name, cells)
      continue
    }
    if (normalize(previous.join("|")) === normalize(cells.join("|"))) continue
    conflicts.push({
      chapter: 3,
      kind: "metric",
      key: name,
      existing: previous.join(" | "),
      incoming: cells.join(" | "),
    })
  }

  const merged = [...header, ...bodyRows.map((cells) => `| ${cells.join(" | ")} |`)]
  return { lines: [...before, ...merged, ...after], conflicts }
}

function objectRows(rows: string[]): string[][] {
  return rows.filter((row) => row.trim().length > 0).map(splitRowText)
}

/** 第 2 章按 `### 场景` 块合并，其余章节按行并集合并（只追加，不覆盖）。 */
function mergeByLines(
  id: ChapterId,
  existingLines: string[],
  incomingLines: string[],
): { lines: string[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = []
  if (id === 2) {
    const output = [...existingLines]
    const byHead = new Map<string, string[]>()
    for (const block of blockSplit(existingLines)) byHead.set(normalize(block[0] ?? ""), block)
    for (const block of blockSplit(incomingLines)) {
      const head = normalize(block[0] ?? "")
      if (!head) continue
      const previous = byHead.get(head)
      if (previous) {
        if (normalize(previous.join(" ")) !== normalize(block.join(" "))) {
          conflicts.push({ chapter: id, kind: "scene", key: block[0], existing: previous[0], incoming: block[0] })
        }
        continue
      }
      byHead.set(head, block)
      output.push("", ...block)
    }
    return { lines: trimTrailingBlank(output), conflicts }
  }

  const existingNorm = new Set(existingLines.map(normalize).filter(Boolean))
  const output = [...existingLines]
  for (const line of incomingLines) {
    const key = normalize(line)
    if (!key) continue
    if (existingNorm.has(key)) continue
    const scalar = /^\*\*([^*]+)\*\*：(.+)$/.exec(key)
    if (scalar) {
      const sameLabel = existingLines.find((item) => normalize(item).startsWith(`**${scalar[1]}**：`))
      if (sameLabel) {
        conflicts.push({ chapter: id, kind: "scalar", key: scalar[1], existing: sameLabel, incoming: line.trim() })
        continue
      }
    }
    existingNorm.add(key)
    output.push(line)
  }
  return { lines: trimTrailingBlank(output), conflicts }
}

function blockSplit(lines: string[]): string[][] {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current) blocks.push(current)
      current = [line]
      continue
    }
    if (!current) continue
    current.push(line)
  }
  if (current) blocks.push(current)
  return blocks.map((block) => trimTrailingBlank(block))
}

/**
 * 增量合并：已存在文档时按章节合并。
 * - 第 3 章：按指标名称合并，已存在同名指标永不覆盖，内容不同记为冲突。
 * - 第 2 章：按 `### 场景` 块合并。
 * - 其他章节：行级并集，同名 `**标签**：值` 冲突时不覆盖并上报。
 */
export function mergeDocs(
  existing: string,
  incoming: string,
): { content: string; mode: "created" | "merged"; conflicts: MergeConflict[] } {
  if (!existing.trim()) return { content: incoming, mode: "created", conflicts: [] }

  const old = splitSections(existing)
  const next = splitSections(incoming)
  const conflicts: MergeConflict[] = []

  const output: string[] = [...trimTrailingBlank(old.preamble)]

  for (const chapter of CHAPTERS) {
    const oldSection = old.sections.find((section) => section.id === chapter.id)
    const newSection = next.sections.find((section) => section.id === chapter.id)
    if (!oldSection && !newSection) continue
    if (!oldSection && newSection) {
      output.push("", newSection.heading, ...trimTrailingBlank(newSection.lines))
      continue
    }
    if (oldSection && !newSection) {
      output.push("", oldSection.heading, ...trimTrailingBlank(oldSection.lines))
      continue
    }
    const oldLines = trimTrailingBlank(oldSection!.lines)
    const newLines = trimTrailingBlank(newSection!.lines)
    const merged =
      chapter.id === 3 ? mergeMetricTable(oldLines, newLines) : mergeByLines(chapter.id, oldLines, newLines)
    conflicts.push(...merged.conflicts)
    output.push("", oldSection!.heading, ...trimTrailingBlank(merged.lines))
  }

  // 保留目标文档中不属于 9 章的其它二级标题（用户手写内容）
  for (const section of old.sections) {
    if (section.id !== null) continue
    output.push("", section.heading, ...trimTrailingBlank(section.lines))
  }

  return { content: `${trimTrailingBlank(output).join("\n")}\n`, mode: "merged", conflicts }
}
