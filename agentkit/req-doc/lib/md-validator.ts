/**
 * Markdown 层校验：R01–R07、R10、R15。
 * 返回紧凑错误码数组，不回传原文，保证错误成本与问题量成正比。
 */
import { headingText } from "../../shared/lib/md"
import {
  CHAPTERS,
  METRIC_COLUMNS,
  PLACEHOLDER_NEED_INPUT,
  TECH_TERMS,
  UNRESOLVED_REFERENCES,
  ruleOf,
  type ChapterId,
  type Severity,
} from "./constants"

export { headingText }

export type MdIssue = {
  rule: string
  code: string
  severity: Severity
  chapter?: number
  line?: number
  message: string
}

type Heading = { line: number; text: string; chapter: ChapterId | null }

function resolveChapter(text: string): ChapterId | null {
  for (const chapter of CHAPTERS) {
    if (text.includes(chapter.match)) return chapter.id
  }
  return null
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

export function validateMarkdown(markdown: string): MdIssue[] {
  const issues: MdIssue[] = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")

  const push = (rule: string, message: string, line?: number, chapter?: ChapterId) => {
    const def = ruleOf(rule)
    issues.push({ rule: def.id, code: def.code, severity: def.severity, chapter, line, message })
  }

  // ── R01 / R02：章节齐全、唯一、顺序 ──────────────────────────────────
  const headings: Heading[] = []
  lines.forEach((line, index) => {
    const text = headingText(line)
    if (text === null) return
    headings.push({ line: index, text, chapter: resolveChapter(text) })
  })

  const occurrences = new Map<ChapterId, Heading[]>()
  for (const heading of headings) {
    if (!heading.chapter) continue
    const list = occurrences.get(heading.chapter) ?? []
    list.push(heading)
    occurrences.set(heading.chapter, list)
  }

  for (const chapter of CHAPTERS) {
    const list = occurrences.get(chapter.id) ?? []
    if (list.length === 0) {
      push("R01", `缺少章节「${chapter.title}」（匹配词：${chapter.match}）`)
      continue
    }
    if (list.length > 1) {
      push("R02", `章节「${chapter.title}」重复出现 ${list.length} 次`, list[1].line, chapter.id)
    }
  }

  const ordered = headings.filter((h): h is Heading & { chapter: ChapterId } => h.chapter !== null)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].chapter <= ordered[i - 1].chapter) {
      push(
        "R02",
        `章节顺序错误：「${ordered[i].text}」出现在「${ordered[i - 1].text}」之后`,
        ordered[i].line,
        ordered[i].chapter,
      )
    }
  }

  // ── R03–R07：第 3 章指标表 ───────────────────────────────────────────
  const chapter3 = occurrences.get(3)?.[0]
  if (chapter3) {
    const nextHeading = headings.find((h) => h.line > chapter3.line)
    const end = nextHeading ? nextHeading.line : lines.length
    const region: { line: number; text: string }[] = []
    for (let i = chapter3.line + 1; i < end; i++) region.push({ line: i, text: lines[i] })

    // 表格块：连续以 | 开头的行
    const blocks: { start: number; end: number }[] = []
    let cursor = -1
    for (let i = 0; i < region.length; i++) {
      if (isTableLine(region[i].text)) {
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
      push("R03", `第 3 章内表格数量应为 1，实际 ${blocks.length}`, undefined, 3)
    }

    if (blocks.length >= 1) {
      const block = blocks[0]
      const header = splitRow(region[block.start].text)
      if (header.join("|") !== METRIC_COLUMNS.join("|")) {
        push(
          "R04",
          `指标表表头应为「${METRIC_COLUMNS.join(" | ")}」，实际「${header.join(" | ")}」`,
          region[block.start].line,
          3,
        )
      }

      for (let i = block.start; i <= block.end; i++) {
        const text = region[i].text
        const trimmed = text.trim()
        if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
          push("R05", "表格行必须以 | 开头并以 | 结尾", region[i].line, 3)
          continue
        }
        // 先查变通写法，避免 \\| 被当成列分隔符后报成「列数错误」
        if (trimmed.includes("\\|") || /<br\s*\/?>/i.test(trimmed) || trimmed.includes("&nbsp;")) {
          push("R06", "单元格出现换行/竖线变通写法（\\|、<br>、&nbsp;）", region[i].line, 3)
          continue
        }
        const cells = splitRow(text)
        if (cells.length !== METRIC_COLUMNS.length) {
          push("R05", `表格行列数应为 ${METRIC_COLUMNS.length}，实际 ${cells.length}`, region[i].line, 3)
        }
      }

      // R07：表前、表后只允许空行
      for (let i = 0; i < block.start; i++) {
        if (region[i].text.trim() !== "") {
          push("R07", "指标表上方只允许空行，说明性文字须写在章节标题之前", region[i].line, 3)
          break
        }
      }
      for (let i = block.end + 1; i < region.length; i++) {
        if (region[i].text.trim() !== "") {
          push("R07", "指标表下方只允许空行，说明性文字须写在章节标题之前", region[i].line, 3)
          break
        }
      }
    }
  }

  // ── R10：外部引用占位合规 ────────────────────────────────────────────
  const hasPlaceholder = markdown.includes(PLACEHOLDER_NEED_INPUT)
  for (const reference of UNRESOLVED_REFERENCES) {
    if (markdown.includes(reference.label) && !hasPlaceholder) {
      push(
        "R10",
        `全文引用了「${reference.label}」但缺少占位标注「${PLACEHOLDER_NEED_INPUT}」`,
        undefined,
        reference.chapter,
      )
    }
  }
  // 反例守卫：把刷新周期写成单字母枚举（d/h/w/m/y/r/f）视为虚构
  const singleLetterCycle = /更新频率\*{0,2}\s*[：:]\s*(?:d|h|w|m|y|r|f)(?=$|[\s｜|])/im
  if (singleLetterCycle.test(markdown)) {
    push("R10", "更新频率出现单字母周期枚举（如 d/h/w），该枚举用户规范未提供，属虚构取值", undefined, 5)
  }

  // ── R15：业务语言约束 ────────────────────────────────────────────────
  lines.forEach((line, index) => {
    for (const term of TECH_TERMS) {
      if (term.pattern.test(line)) {
        const chapter = resolveChapterByLine(headings, index)
        push("R15", `出现技术术语「${term.term}」：${line.trim().slice(0, 60)}`, index, chapter)
      }
    }
  })

  return issues
}

function resolveChapterByLine(headings: Heading[], line: number): ChapterId | undefined {
  let current: ChapterId | undefined
  for (const heading of headings) {
    if (heading.line > line) break
    if (heading.chapter) current = heading.chapter
  }
  return current
}

/** 只保留 error 级，返回紧凑串（每条一行，约 40–80 字符）。 */
export function compactIssues(issues: MdIssue[], severity: Severity = "error"): string[] {
  return issues
    .filter((issue) => issue.severity === severity)
    .map((issue) => `${issue.code}${issue.line !== undefined ? `@L${issue.line + 1}` : ""}: ${issue.message}`)
}

export function hasError(issues: MdIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error")
}
