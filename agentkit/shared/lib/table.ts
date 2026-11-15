/**
 * 表格渲染与单元格安全断言（跨 kit 共享）。
 *
 * 策略是「拒绝 + 断言」而不是静默替换：竖线/换行在 schema 层已拒收，
 * 渲染层再断言一次，避免模型绕过 schema 直接调渲染路径时丢信息。
 */

export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RenderError"
  }
}

const CELL_FORBIDDEN = /\||[\r\n]/

export function assertCellSafe(value: unknown, where: string): string {
  const text = value === undefined || value === null ? "" : String(value)
  if (CELL_FORBIDDEN.test(text)) {
    throw new RenderError(`${where} 含竖线或换行，拒绝渲染（请修正结构化输入后再提交）`)
  }
  return text
}

export function renderTable(columns: string[], rows: string[][], separator = "----------"): string {
  const header = `| ${columns.join(" | ")} |`
  const rule = `|${columns.map(() => separator).join("|")}|`
  const body = rows.map((cells) => `| ${cells.join(" | ")} |`)
  return [header, rule, ...body].join("\n")
}
