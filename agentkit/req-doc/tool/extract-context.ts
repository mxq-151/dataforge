/**
 * S0：抽取目标文档上下文 → .work/context.json
 * 只回传摘要（标题树、已有指标名、缺失章节），不回传正文，避免把旧文档塞进上下文。
 */
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CHAPTERS,
  DOCS_DIR,
  docPath,
  nowIso,
  workPath,
  writeJsonAtomic,
} from "../lib/constants"
import { headingText } from "../lib/md-validator"

function columnCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
}

/** 从已有文档中解析第 3 章指标名称（表头后跳过 1 行分隔行）。 */
function existingMetricNames(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const start = lines.findIndex((line) => {
    const text = headingText(line)
    return text !== null && text.includes("数据指标")
  })
  if (start === -1) return []
  const names: string[] = []
  let tableRows = 0
  for (let i = start + 1; i < lines.length; i++) {
    if (headingText(lines[i]) !== null) break
    if (!/^\s*\|/.test(lines[i])) continue
    tableRows += 1
    if (tableRows <= 2) continue
    const cells = columnCells(lines[i])
    if (cells[0]) names.push(cells[0])
  }
  return names
}

export default tool({
  description:
    "S0 上下文抽取：读取目标需求文档（若存在），输出标题树、已有指标名、已存在章节到 .work/context.json。返回摘要而非正文。",
  args: {
    businessName: z.string().min(1).describe("业务名称，用于拼 docs/{业务名称}_开发需求.md"),
  },
  async execute(args, context) {
    const root = context.directory
    const target = docPath(root, args.businessName)
    const exists = fs.existsSync(target)
    const markdown = exists ? fs.readFileSync(target, "utf8") : ""

    const titles = markdown
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => headingText(line))
      .filter((text): text is string => text !== null)

    const present = CHAPTERS.filter((chapter) => titles.some((title) => title.includes(chapter.match))).map(
      (chapter) => chapter.id,
    )
    const names = existingMetricNames(markdown)

    const payload = {
      businessName: args.businessName,
      targetFile: `${DOCS_DIR}/${args.businessName}_开发需求.md`,
      exists,
      extractedAt: nowIso(),
      titleTree: titles,
      chaptersPresent: present,
      existingMetricNames: names,
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
    }
    writeJsonAtomic(workPath(root, "context.json"), payload)

    return JSON.stringify({
      ok: true,
      businessName: payload.businessName,
      targetFile: payload.targetFile,
      exists,
      chaptersPresent: present,
      existingMetricCount: names.length,
      existingMetricNames: names.slice(0, 50),
      titleTree: titles.slice(0, 40),
      note: exists
        ? "目标文档已存在：S3 将按章节增量合并，同名指标不覆盖，冲突会在 finalize-doc 报出。"
        : "目标文档不存在：S3 将新建文档。",
    })
  },
})
