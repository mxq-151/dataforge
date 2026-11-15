/**
 * Markdown 解析原语（跨 kit 共享）。
 *
 * 只保留与业务无关的部分：标题识别、空白归一、行切分。章节清单与合并策略
 * 属于各 kit 自己的契约，仍留在各自的 lib 里。
 */

/** 识别 `## ` 二级标题；去掉可选编号，返回纯标题文本。 */
export function headingText(line: string): string | null {
  const m = /^##(?!#)\s+(.*\S)\s*$/.exec(line)
  if (!m) return null
  return m[1].replace(/^\d+\s*[.、)．]\s*/, "").trim()
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

export function trimTrailingBlank(lines: string[]): string[] {
  const output = [...lines]
  while (output.length && output[output.length - 1].trim() === "") output.pop()
  return output
}

export type MdSection = { heading: string; lines: string[] }

/**
 * 按二级标题切段。`resolve` 把标题文本映射成业务 key；返回 null 的段落
 * 仍会被保留（key 为 null），由调用方决定是否原样写回。
 */
export function splitSections<T>(
  markdown: string,
  resolve: (text: string) => T | null,
): { preamble: string[]; sections: { key: T | null; heading: string; lines: string[] }[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const preamble: string[] = []
  const sections: { key: T | null; heading: string; lines: string[] }[] = []
  let current: { key: T | null; heading: string; lines: string[] } | null = null

  for (const line of lines) {
    const text = headingText(line)
    if (text !== null) {
      current = { key: resolve(text), heading: line, lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  return { preamble, sections }
}
