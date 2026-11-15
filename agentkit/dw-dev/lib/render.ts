/**
 * 设计文档渲染与增量合并。
 *
 * 渲染是确定性的：模型只提交结构化 JSON，章节文字、表格、DDL 全部由代码生成，
 * 因此不存在「模型整篇重写」的路径，也不会有排版漂移。
 */
import { normalize, splitRow, splitSections, trimTrailingBlank } from "../../shared/lib/md"
import { assertCellSafe, renderTable } from "../../shared/lib/table"
import {
  CLASSIFICATION_STANDARD,
  CYCLE_CODES,
  DDL_ENGINES,
  DESIGN_CHAPTERS,
  FIELD_COLUMNS,
  JOB_LIST_COLUMNS,
  LAYERS,
  LAYER_RANK,
  LAYER_SPEC,
  METRIC_DESIGN_COLUMNS,
  QUALITY_COLUMNS,
  TABLE_LIST_COLUMNS,
  designChapterDef,
  tableDb,
  tableFullName,
  type DesignChapterId,
  type MetricDesign,
  type QualityRuleDesign,
  type TableDesign,
} from "./constants"
import { deriveJobPlan } from "./jobs"
import { renderDdlFile } from "./ddl"

type Dict = Record<string, any>

export type MergeConflict = {
  chapter: DesignChapterId
  kind: "table" | "metric" | "rule" | "scalar"
  key: string
  existing: string
  incoming: string
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RenderError"
  }
}

function heading(id: DesignChapterId): string {
  return `## ${id}. ${designChapterDef(id).title}`
}

function bullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无"
}

function codeLabel(cycle: string): string {
  return CYCLE_CODES[cycle] ?? cycle
}

function fieldTable(table: TableDesign): string {
  const rows = table.fields.map((field) => [
    assertCellSafe(field.name, `${table.enName}.${field.name} 字段名`),
    assertCellSafe(field.cnName, `${table.enName}.${field.name} 中文名`),
    assertCellSafe(field.logicalType, `${table.enName}.${field.name} 类型`),
    field.nullable ? "否" : "是",
    assertCellSafe(field.defaultValue ?? "", `${table.enName}.${field.name} 默认值`),
    assertCellSafe(field.source ?? "", `${table.enName}.${field.name} 来源`),
    assertCellSafe(field.expression ?? "", `${table.enName}.${field.name} 计算逻辑`),
    assertCellSafe(field.personalInfo, `${table.enName}.${field.name} 个人信息`),
    assertCellSafe(field.level.tier, `${table.enName}.${field.name} 数据级别`),
    assertCellSafe(field.masking, `${table.enName}.${field.name} 脱敏方式`),
  ])
  return renderTable([...FIELD_COLUMNS], rows)
}

function tableSection(table: TableDesign): string {
  return [
    `### ${tableFullName(table)} ${table.cnName}`,
    "",
    `- 所属分层：${table.layer}`,
    `- 主题域：${table.domain}`,
    `- 粒度声明：${table.grain}`,
    `- 业务口径：${table.businessDefinition}`,
    `- 可下钻维度：${(table.drillDimensions ?? []).join("、") || "无"}`,
    `- 主键：${table.primaryKey.join(",") || "无"}`,
    `- 唯一键：${(table.uniqueKey ?? []).join(",") || "无"}`,
    `- 分区键：${table.partition.field}（${table.partition.format}，${table.partition.strategy}${table.partition.buckets ? `，${table.partition.buckets} 桶` : ""}）`,
    `- 存储格式：${table.storage.format}，压缩：${table.storage.compression}`,
    `- 生命周期：${table.lifecycleDays} 天`,
    `- 更新方式：${table.updateMode}`,
    `- 数据分类：行业领域 ${table.classification.industry}；业务属性 ${table.classification.businessAttribute}；分类路径 ${table.classification.categoryPath}；行业目录 ${table.classification.industryCatalog?.trim() || "待确认（行业目录缺失）"}`,
    `- 数据级别：${table.level.tier}；影响对象：${table.level.impactObject}；影响程度：${table.level.impactDegree}；定级依据：${table.level.basis}`,
    `- 负责人：${table.owner?.trim() || "未指定"}；使用方：${table.consumer?.trim() || "未指定"}`,
    `- 是否可重跑：${table.rerunnable ? "是" : "否"}`,
    `- 引擎：${table.engine}`,
    `- 数据源：${table.datasource}`,
    `- 上游表：${table.upstream.join("、") || "无"}`,
    "",
    fieldTable(table),
  ].join("\n")
}

export const TABLE_LIST_START = "<!-- dw:table-list:start -->"
export const TABLE_LIST_END = "<!-- dw:table-list:end -->"

/** 第 3 章表清单：一眼看全表，明细在各自 `### 库.表` 小节。 */
export function renderTableList(tables: TableDesign[]): string {
  const rows = tables.map((table) => [
    assertCellSafe(tableFullName(table), `${table.enName} 表英文名`),
    assertCellSafe(table.cnName, `${table.enName} 中文名`),
    table.tableType === "临时表" ? "临时表" : "正式表",
    table.layer,
    assertCellSafe(table.domain, `${table.enName} 主题域`),
    assertCellSafe(table.grain, `${table.enName} 粒度`),
    assertCellSafe(table.primaryKey.join(",") || "无", `${table.enName} 主键`),
    assertCellSafe(
      `${table.partition.field}（${table.partition.format}/${table.partition.strategy}）`,
      `${table.enName} 分区`,
    ),
    table.updateMode,
    assertCellSafe(table.classification.categoryPath, `${table.enName} 分类路径`),
    table.level.tier,
    `${table.lifecycleDays} 天`,
    assertCellSafe(table.owner?.trim() || "未指定", `${table.enName} 负责人`),
  ])
  return renderTable([...TABLE_LIST_COLUMNS], rows)
}

function tableListBlock(tables: TableDesign[]): string {
  return [TABLE_LIST_START, renderTableList(tables), TABLE_LIST_END].join("\n")
}

export function renderMetricTable(metrics: MetricDesign[]): string {
  const rows = metrics.map((metric) => [
    assertCellSafe(metric.code, `${metric.name} 指标编码`),
    assertCellSafe(metric.name, `${metric.name} 指标名称`),
    assertCellSafe(metric.domain, `${metric.name} 主题域`),
    assertCellSafe(metric.meaning, `${metric.name} 指标含义`),
    assertCellSafe(metric.expression, `${metric.name} 计算表达式`),
    assertCellSafe(metric.filter ?? "", `${metric.name} 过滤条件`),
    assertCellSafe(metric.dimensions || "无", `${metric.name} 下钻维度`),
    assertCellSafe(metric.sources, `${metric.name} 字段来源`),
    assertCellSafe(metric.datasource, `${metric.name} 数据源`),
  ])
  const added = metrics.filter((metric) => metric.isNew)
  const note = added.length
    ? `- 设计新增指标（需求文档未列出，需需求方确认）：${added.map((metric) => `${metric.code} ${metric.name}`).join("、")}`
    : ""
  return [renderTable([...METRIC_DESIGN_COLUMNS], rows), note].filter(Boolean).join("\n\n")
}

export function renderQualityTable(rules: QualityRuleDesign[]): string {
  const rows = rules.map((rule) => [
    assertCellSafe(rule.name, `${rule.name} 规则名`),
    assertCellSafe(rule.ruleType, `${rule.name} 规则类型`),
    assertCellSafe(rule.target, `${rule.name} 校验对象`),
    assertCellSafe(rule.threshold, `${rule.name} 阈值`),
    assertCellSafe(rule.disposition, `${rule.name} 处置方式`),
  ])
  return renderTable([...QUALITY_COLUMNS], rows)
}

function layerSpecTable(): string {
  const rows = LAYERS.map((layer) => [
    layer,
    LAYER_SPEC[layer].purpose,
    LAYER_SPEC[layer].stores,
    LAYER_SPEC[layer].excludes,
    LAYER_SPEC[layer].upstream.join("/") || "源系统",
  ])
  return renderTable(["分层", "定位", "存什么", "不存什么", "允许上游"], rows)
}

function responsibilityText(tables: TableDesign[]): string {
  const owners = tables.map((table) => `${table.enName}：${table.owner?.trim() || "未指定"}`).join("；")
  const consumers = tables.map((table) => `${table.enName}：${table.consumer?.trim() || "未指定"}`).join("；")
  return [
    "- 分层职责：ODS 只落源系统原始数据；DWD 保持最细业务粒度；DWS 统一指标口径；ADS 面向具体场景；DIM 提供公共维度。",
    "- 上游系统边界：ODS 只从源系统同步，不引用数仓内其他表；DWD 只读 ODS/DWD/DIM；DWS 只读 DWD/DWS/DIM；ADS 只读 DWD/DWS/ADS/DIM；DIM 只读 ODS/DWD/DIM。",
    "- 下游使用边界：DWD 不直接被报表使用，需经 DWS/ADS；ADS 表不跨场景复用；下游不得绕过上游层直接取更底层明细。",
    `- 表级负责人：${owners}`,
    `- 下游使用方：${consumers}`,
  ].join("\n")
}

function architectureText(tables: TableDesign[]): string {
  const byLayer = [...new Set(tables.map((table) => table.layer))]
  const engines = [...new Set(tables.map((table) => table.engine))]
  const storage = [...new Set(tables.map((table) => `${table.storage.format}/${table.storage.compression}`))]
  const ordered = [...byLayer].sort((a, b) => LAYER_RANK[a] - LAYER_RANK[b])
  return [
    "### 2.1 分层规范",
    "",
    layerSpecTable(),
    "",
    "### 2.2 职责与边界",
    "",
    responsibilityText(tables),
    "",
    "### 2.3 数据分类分级口径",
    "",
    `- 依据：${CLASSIFICATION_STANDARD}。分级只取核心数据/重要数据/一般数据三级（标准 6.1）。`,
    "- 分类：行业领域 + 业务属性 + 分类路径（标准 5.1）；行业分类目录由行业主管部门制定，缺失时进第 8 章待确认，不阻塞设计。",
    "- 定级：影响对象（6.4.1）× 影响程度（6.4.2）按标准表 1 推出级别（6.5），定级依据必须写明。",
    "- 一般数据不再细分小级：附录 H 为资料性参考，且平台口径明确禁止再细分。",
    "- 企业口径（非标准强制）：级别到最小管控措施的对应、核心/重要数据能否落离线仓，均不是 GB/T 43697-2024 的规定。",
    "",
    "### 2.4 技术架构",
    "",
    `- 涉及分层：${ordered.join(" → ")}`,
    `- 存储与计算引擎：${engines.join("、")}`,
    `- 存储格式与压缩：${storage.join("、")}`,
    `- 数据链路：${ordered
      .map((layer) => `${layer}（${tables.filter((table) => table.layer === layer).length} 张）`)
      .join(" → ")}`,
    "- 选型说明：以上组件取自各表声明的 @引擎/存储格式，未声明的组件不作为设计依据。",
  ].join("\n")
}

function etlText(tables: TableDesign[]): string {
  const ordered = [...tables].sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])
  return ordered
    .map((table, index) => {
      const upstream = table.upstream.length ? table.upstream.join("、") : "源系统（贴源同步）"
      const steps = table.etlSteps.map((step, stepIndex) => `   ${stepIndex + 1}) ${step}`).join("\n")
      return [
        `${index + 1}. ${table.enName}（${table.layer}）`,
        `   - 业务口径：${table.businessDefinition}`,
        `   - 输入：${upstream}`,
        `   - 加工步骤：`,
        steps,
        `   - 输出：以 ${table.updateMode} 方式写入 ${tableDb(table)}.${table.enName}，粒度「${table.grain}」，分区 ${table.partition.field}（${table.partition.format}），可重跑：${table.rerunnable ? "是" : "否"}`,
      ].join("\n")
    })
    .join("\n\n")
}

function scheduleText(tables: TableDesign[], rules: QualityRuleDesign[]): string {
  const ordered = [...tables].sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])
  const lines = ordered.map((table, index) => {
    const cycle = table.enName.split("_").pop() ?? ""
    const deps = table.upstream.length ? table.upstream.join("、") : "无"
    return `${index + 1}. ${table.enName}：依赖 ${deps}；调度周期 ${codeLabel(cycle)}（${cycle}）；产出 ${tableDb(table)}.${table.enName}`
  })
  const jobRows = deriveJobPlan(tables, rules).map((plan) => [
    `${plan.name}.sql`,
    plan.name,
    `sql/${plan.layer}`,
    plan.dependencies.join("、") || "无",
  ])
  return [
    "- 调度顺序（自下而上）：",
    ...lines.map((line) => `  ${line}`),
    "- 重跑影响：按分区覆盖写入，重跑只影响本分区；下游按依赖顺序重跑。",
    "",
    "### 7.1 程序与任务命名",
    "",
    "作业名由目标表推导为 `{分层}_{业务域}_{实体}_{操作}_{周期}`；`@依赖` 只写前置作业名，无依赖写 `无`。调度项目名前缀由平台在调度接入阶段生成，设计阶段不定义。",
    "",
    renderTable([...JOB_LIST_COLUMNS], jobRows),
  ].join("\n")
}

function questionText(req: any): string {
  const questions: Dict[] = Array.isArray(req?.questions) ? req.questions : []
  const lines = questions.length
    ? questions.map((item) => `- 问题：${item.question}；影响：${item.impact}`)
    : ["- 无需求侧待确认问题"]
  lines.push(
    `- 分类分级依据：${CLASSIFICATION_STANDARD}；分级仅核心/重要/一般三级，不细分小级（附录 H 为资料性，平台口径禁止再细分）。`,
  )
  lines.push("- 行业数据分类目录待补：标准只规定由行业主管部门制定分类目录，本设计只落到行业领域+业务属性+分类路径，目录缺失不阻塞。")
  lines.push("- 企业口径：级别到最小管控措施的对应、核心数据能否落离线仓（默认禁止，需显式放行并记录审批）不是标准强制，可被平台口径覆盖。")
  lines.push(`- 设计边界：调度项目名前缀由平台在调度接入阶段生成，本设计只定义作业名与作业间依赖，不写死项目名。`)
  return lines.join("\n")
}

export function renderDesignDoc(businessName: string, req: any, tables: TableDesign[], metrics: MetricDesign[], rules: QualityRuleDesign[]): string {
  if (tables.length === 0) throw new RenderError("没有表设计，无法渲染设计文档")
  if (metrics.length === 0) throw new RenderError("没有指标映射，无法渲染设计文档")
  if (rules.length === 0) throw new RenderError("没有稽核规则，无法渲染设计文档")

  const blocks: string[] = []
  const section = (id: DesignChapterId, body: string) => `${heading(id)}\n\n${body}`

  blocks.push(
    section(
      1,
      [
        `- 依据需求文档：docs/${businessName}_开发需求.md`,
        `- 业务目标：${req?.businessGoal ?? ""}`,
        `- 使用对象：${(req?.audiences ?? []).join("、") || "无"}`,
        `- 决策场景：${(req?.decisionScenes ?? []).join("、") || "无"}`,
        `- 数据时效：${req?.updateFrequency ?? ""}；最晚可用：${req?.latestAvailableTime ?? ""}；回溯：${req?.historyBackfill ?? ""}`,
        `- 输出方式：${(req?.outputs ?? []).map((item: Dict) => `${item.type}（${item.consumer}）`).join("、") || "无"}`,
      ].join("\n"),
    ),
  )

  blocks.push(section(2, architectureText(tables)))
  blocks.push(section(3, [tableListBlock(tables), ...tables.map(tableSection)].join("\n\n")))
  blocks.push(section(4, etlText(tables)))
  blocks.push(section(5, renderMetricTable(metrics)))
  blocks.push(section(6, renderQualityTable(rules)))
  blocks.push(section(7, scheduleText(tables, rules)))
  blocks.push(section(8, questionText(req)))

  return [`# ${businessName} 数仓设计`, "", blocks.join("\n\n"), ""].join("\n")
}

export type DdlBundle = { files: { layer: string; content: string }[]; issues: string[] }

export function renderDdlBundle(tables: TableDesign[]): DdlBundle {
  const issues: string[] = []
  const files: { layer: string; content: string }[] = []
  for (const layer of [...new Set(tables.map((table) => table.layer))]) {
    const result = renderDdlFile(layer, tables.filter((table) => table.layer === layer))
    issues.push(...result.issues)
    if (result.sql) files.push({ layer, content: result.sql })
  }
  return { files, issues }
}

// ── 文档形状校验（W24） ────────────────────────────────────────────────
export type DocIssue = { code: string; message: string }

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

export function designDocIssues(markdown: string): DocIssue[] {
  const issues: DocIssue[] = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const headings: { line: number; id: DesignChapterId | null }[] = []

  lines.forEach((line, index) => {
    const m = /^##(?!#)\s+(.*\S)\s*$/.exec(line)
    if (!m) return
    const text = m[1].replace(/^\d+\s*[.、)．]\s*/, "").trim()
    const def = DESIGN_CHAPTERS.find((chapter) => text.includes(chapter.match))
    headings.push({ line: index, id: def?.id ?? null })
  })

  for (const chapter of DESIGN_CHAPTERS) {
    const found = headings.filter((item) => item.id === chapter.id)
    if (found.length === 0) issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `缺少章节「${chapter.title}」` })
    if (found.length > 1) issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `章节「${chapter.title}」重复 ${found.length} 次` })
  }
  const ordered = headings.filter((item): item is { line: number; id: DesignChapterId } => item.id !== null)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].id <= ordered[i - 1].id) {
      issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `章节顺序错误：第 ${ordered[i].id} 章出现在第 ${ordered[i - 1].id} 章之后` })
    }
  }

  for (const chapter of DESIGN_CHAPTERS) {
    if (!chapter.table) continue
    const head = headings.find((item) => item.id === chapter.id)
    if (!head) continue
    const next = headings.find((item) => item.line > head.line)
    const end = next ? next.line : lines.length
    const blocks: { start: number; end: number }[] = []
    let cursor = -1
    for (let i = head.line + 1; i < end; i++) {
      if (isTableLine(lines[i])) {
        if (cursor === -1) cursor = i
        continue
      }
      if (cursor !== -1) {
        blocks.push({ start: cursor, end: i - 1 })
        cursor = -1
      }
    }
    if (cursor !== -1) blocks.push({ start: cursor, end: end - 1 })

    if (blocks.length !== 1) {
      issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `第 ${chapter.id} 章表格数量应为 1，实际 ${blocks.length}` })
      continue
    }
    const expected = chapter.table === "metrics" ? [...METRIC_DESIGN_COLUMNS] : [...QUALITY_COLUMNS]
    const header = splitRow(lines[blocks[0].start])
    if (header.join("|") !== expected.join("|")) {
      issues.push({
        code: "W24_DESIGN_DOC_SHAPE",
        message: `第 ${chapter.id} 章表头应为「${expected.join(" | ")}」，实际「${header.join(" | ")}」`,
      })
    }
    for (let i = blocks[0].start; i <= blocks[0].end; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
        issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `第 ${chapter.id} 章表格行必须以 | 开头并以 | 结尾` })
        break
      }
      if (splitRow(lines[i]).length !== expected.length) {
        issues.push({ code: "W24_DESIGN_DOC_SHAPE", message: `第 ${chapter.id} 章表格行列数应为 ${expected.length}` })
        break
      }
    }
  }

  return issues
}

// ── DDL 代码头校验（W24） ──────────────────────────────────────────────
export type DdlHeaderExpectation = { datasources?: string[]; engines?: string[] }

/**
 * 校验 DDL 文件开头的块注释：@数据源 / @引擎 必填、引擎在 DDL_ENGINES 内，
 * 并与该层设计表的引擎/数据源一致。finalize 会把合并后的 ddls/*.sql 内容送进来，
 * 因此这里判的是真正要落盘的文本，不是内存里的理想值。
 */
export function ddlHeaderIssues(content: string, expected: DdlHeaderExpectation = {}): DocIssue[] {
  const issues: DocIssue[] = []
  const text = content.replace(/\r\n?/g, "\n").trimStart()
  if (!text.startsWith("/*")) {
    return [{ code: "W24_DDL_HEADER", message: "DDL 文件必须以代码头块注释 /* ... */ 开头" }]
  }
  const end = text.indexOf("*/", 2)
  if (end === -1) return [{ code: "W24_DDL_HEADER", message: "DDL 代码头块注释未闭合" }]

  const entries: Record<string, string> = {}
  for (const line of text.slice(2, end).split("\n")) {
    const m = /^\s*\*\s*@([^:：]+?)\s*[:：]\s*(.*)$/.exec(line)
    if (!m) continue
    entries[m[1].trim()] = m[2].trim()
  }
  for (const key of ["数据源", "引擎"]) {
    if (!entries[key]) issues.push({ code: "W24_DDL_HEADER", message: `DDL 代码头缺少 @${key}` })
  }
  const engine = entries["引擎"]
  if (engine && !(DDL_ENGINES as readonly string[]).includes(engine)) {
    issues.push({ code: "W24_DDL_HEADER", message: `DDL 代码头 @引擎 ${engine} 不在 ${DDL_ENGINES.join("/")} 内` })
  }
  const engines = [...new Set(expected.engines ?? [])]
  if (engine && engines.length === 1 && engine !== engines[0]) {
    issues.push({ code: "W24_DDL_HEADER", message: `DDL 代码头 @引擎 ${engine} 与设计表引擎 ${engines[0]} 不一致` })
  }
  const wantedSources = [...new Set(expected.datasources ?? [])].sort()
  if (wantedSources.length) {
    const declared = (entries["数据源"] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .sort()
    if (declared.join("|") !== wantedSources.join("|")) {
      issues.push({
        code: "W24_DDL_HEADER",
        message: `DDL 代码头 @数据源 [${(entries["数据源"] ?? "").trim()}] 与设计表数据源 [${wantedSources.join(",")}] 不一致`,
      })
    }
  }
  return issues
}
type Section = { id: DesignChapterId; heading: string; lines: string[] }

function splitDesignSections(markdown: string): { preamble: string[]; sections: Section[] } {
  const split = splitSections<DesignChapterId>(markdown, (text) => {
    const def = DESIGN_CHAPTERS.find((chapter) => text.includes(chapter.match))
    return def?.id ?? null
  })
  return {
    preamble: split.preamble,
    sections: split.sections
      .filter((item): item is { key: DesignChapterId; heading: string; lines: string[] } => item.key !== null)
      .map((item) => ({ id: item.key, heading: item.heading, lines: item.lines })),
  }
}

function tableBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current) blocks.push(trimTrailingBlank(current))
      current = [line]
      continue
    }
    if (current) current.push(line)
  }
  if (current) blocks.push(trimTrailingBlank(current))
  return blocks
}

function markerRegion(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === TABLE_LIST_START)
  const end = lines.findIndex((line) => line.trim() === TABLE_LIST_END)
  if (start === -1 || end === -1 || end < start) return null
  return { start, end }
}

/** 表清单是派生内容：已存在就整块替换，避免表清单与表小节脱节。 */
function applyTableListMarker(existing: string[], incoming: string[]): string[] {
  const oldRegion = markerRegion(existing)
  const newRegion = markerRegion(incoming)
  if (!newRegion) return existing
  const replacement = incoming.slice(newRegion.start, newRegion.end + 1)
  if (oldRegion) {
    return [...existing.slice(0, oldRegion.start), ...replacement, ...existing.slice(oldRegion.end + 1)]
  }
  return [...existing, "", ...replacement]
}

function mergeTableSections(existing: string[], incoming: string[]): { lines: string[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = []
  const base = applyTableListMarker(existing, incoming)
  const oldBlocks = tableBlocks(base)
  const newBlocks = tableBlocks(incoming)
  if (oldBlocks.length === 0) return { lines: incoming, conflicts }
  const byKey = new Map<string, string[]>()
  for (const block of oldBlocks) byKey.set(normalize(block[0]), block)
  const output = [...base]
  for (const block of newBlocks) {
    const key = normalize(block[0])
    const previous = byKey.get(key)
    if (!previous) {
      byKey.set(key, block)
      output.push("", ...block)
      continue
    }
    if (normalize(previous.join("\n")) !== normalize(block.join("\n"))) {
      conflicts.push({ chapter: 3, kind: "table", key: block[0], existing: previous[0], incoming: block[0] })
    }
  }
  return { lines: trimTrailingBlank(output), conflicts }
}

function mergeKeyedTable(
  chapter: DesignChapterId,
  existing: string[],
  incoming: string[],
  kind: "metric" | "rule",
): { lines: string[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = []
  const indexes = existing.map((line, index) => (isTableLine(line) ? index : -1)).filter((index) => index >= 0)
  if (indexes.length < 3) return { lines: incoming, conflicts }
  const first = indexes[0]
  const last = indexes[indexes.length - 1]
  const before = existing.slice(0, first)
  const after = existing.slice(last + 1)
  const header = existing.slice(first, first + 2)
  const rows = existing.slice(first + 2, last + 1).filter((line) => line.trim()).map(splitRow)
  const byKey = new Map<string, string[]>()
  for (const cells of rows) if (cells[0]) byKey.set(cells[0], cells)

  for (const line of incoming.filter(isTableLine).slice(2)) {
    const cells = splitRow(line)
    const key = cells[0]
    if (!key) continue
    const previous = byKey.get(key)
    if (!previous) {
      rows.push(cells)
      byKey.set(key, cells)
      continue
    }
    if (normalize(previous.join("|")) !== normalize(cells.join("|"))) {
      conflicts.push({ chapter, kind, key, existing: previous.join(" | "), incoming: cells.join(" | ") })
    }
  }
  return { lines: [...before, ...header, ...rows.map((cells) => `| ${cells.join(" | ")} |`), ...after], conflicts }
}

function mergeLines(id: DesignChapterId, existing: string[], incoming: string[]): { lines: string[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = []
  const known = new Set(existing.map(normalize).filter(Boolean))
  const output = [...existing]
  for (const line of incoming) {
    const key = normalize(line)
    if (!key || known.has(key)) continue
    known.add(key)
    output.push(line)
  }
  return { lines: trimTrailingBlank(output), conflicts }
}

/**
 * 已存在文档时按章节合并：
 * - 第 3 章按 `### 库.表` 块合并；
 * - 第 5 章按指标编码、第 6 章按规则名合并；
 * - 其余章节行级并集，已存在内容永不覆盖，冲突由 finalize 阻断。
 */
export function mergeDesignDocs(existing: string, incoming: string): { content: string; mode: "created" | "merged"; conflicts: MergeConflict[] } {
  if (!existing.trim()) return { content: incoming, mode: "created", conflicts: [] }
  const old = splitDesignSections(existing)
  const next = splitDesignSections(incoming)
  const conflicts: MergeConflict[] = []
  const output: string[] = [...trimTrailingBlank(old.preamble)]

  for (const chapter of DESIGN_CHAPTERS) {
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
      chapter.id === 3
        ? mergeTableSections(oldLines, newLines)
        : chapter.id === 5
          ? mergeKeyedTable(5, oldLines, newLines, "metric")
          : chapter.id === 6
            ? mergeKeyedTable(6, oldLines, newLines, "rule")
            : mergeLines(chapter.id, oldLines, newLines)
    conflicts.push(...merged.conflicts)
    output.push("", oldSection!.heading, ...trimTrailingBlank(merged.lines))
  }

  return { content: `${trimTrailingBlank(output).join("\n")}\n`, mode: "merged", conflicts }
}

/** DDL 增量合并：按 `-- 库.表` 标记追加缺失表，同名不同内容记冲突。 */
export function mergeDdl(existing: string, incoming: string): { content: string; conflicts: string[] } {
  if (!existing.trim()) return { content: incoming, conflicts: [] }
  const blockOf = (text: string): Map<string, string> => {
    const map = new Map<string, string>()
    const parts = text.split(/\n(?=--\s+[A-Za-z])/)
    for (const part of parts) {
      const m = /(?:^|\n)--\s+([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/.exec(part)
      if (m) map.set(m[1], part.trim())
    }
    return map
  }
  const oldBlocks = blockOf(existing)
  const newBlocks = blockOf(incoming)
  const conflicts: string[] = []
  const additions: string[] = []
  for (const [key, block] of newBlocks) {
    const previous = oldBlocks.get(key)
    if (!previous) additions.push(block)
    else if (normalize(previous) !== normalize(block)) conflicts.push(key)
  }
  if (additions.length === 0) return { content: existing, conflicts }
  return { content: `${trimTrailingBlank(existing.split("\n")).join("\n")}\n\n${additions.join("\n\n")}\n`, conflicts }
}
