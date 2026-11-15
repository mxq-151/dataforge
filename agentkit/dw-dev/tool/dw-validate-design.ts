/**
 * D5：设计全局确定性校验（W01–W26）。
 * 一次性跑：表/指标/规则单体验证 + 依赖图 + 覆盖 + 反查 + 渲染形状 + DDL 方言。
 */
import { tool } from "@opencode-ai/plugin"
import {
  buildMetaIndex,
  buildTrace,
  validateGraph,
  validateMetric,
  validateQuality,
  validateTable,
  validateTrace,
} from "../lib/design-validator"
import {
  designErrorsPath,
  designDocPath,
  loadMeta,
  loadMetrics,
  loadQuality,
  loadReq,
  loadTables,
  nowIso,
  writeJsonAtomic,
} from "../lib/constants"
import { ddlHeaderIssues, designDocIssues, renderDesignDoc, renderDdlBundle } from "../lib/render"

export default tool({
  description:
    "D5 设计全局校验：表/指标/规则单体规则、分层依赖与成环、ADS 与场景覆盖、需求指标覆盖、反向可追溯、设计文档 9/5 列形状、DDL 方言与文件头。结果写 .dw/design-errors.json。",
  args: {},
  async execute(_args, context) {
    const root = context.directory
    const req = loadReq(root)
    if (!req) {
      return JSON.stringify({ ok: false, code: "W01_REQ_MISSING", message: "缺少 .dw/req.json，请先调用 dw-extract-req" })
    }
    const tables = loadTables(root)
    const metrics = loadMetrics(root)
    const rules = loadQuality(root)
    const meta = buildMetaIndex(loadMeta(root))
    const issues = [
      ...tables.flatMap((table) => validateTable(table, tables, meta)),
      ...metrics.flatMap((metric) => validateMetric(metric, tables, (req.metrics ?? []).map((item: any) => item.name), meta)),
      ...validateQuality(rules, tables, meta),
      ...validateGraph(tables, metrics, req, meta),
    ]

    const trace = buildTrace(metrics)
    issues.push(...validateTrace((req.metrics ?? []).map((item: any) => item.name), metrics, trace))

    let docIssues: { code: string; message: string }[] = []
    let ddlIssues: string[] = []
    if (tables.length && metrics.length && rules.length) {
      try {
        const markdown = renderDesignDoc(req.businessName, req, tables, metrics, rules)
        docIssues = designDocIssues(markdown)
      } catch (error) {
        ddlIssues.push(error instanceof Error ? error.message : String(error))
      }
      const bundle = renderDdlBundle(tables)
      ddlIssues.push(...bundle.issues)
      for (const file of bundle.files) {
        const layerTables = tables.filter((table) => table.layer === file.layer)
        docIssues.push(
          ...ddlHeaderIssues(file.content, {
            datasources: layerTables.map((table) => table.datasource),
            engines: layerTables.map((table) => table.engine),
          }),
        )
      }
    } else {
      ddlIssues.push("表/指标/规则未齐，无法渲染设计文档与 DDL")
    }

    const all = [
      ...issues,
      ...docIssues.map((issue) => ({ code: issue.code, rule: "W24", severity: "error" as const, unit: "design-doc", message: issue.message })),
      ...ddlIssues.map((message) => ({ code: "W12_DIALECT_UNSUPPORTED", rule: "W12", severity: "error" as const, unit: "ddl", message })),
    ]
    const blocking = all.filter((issue) => issue.severity === "error")
    writeJsonAtomic(designErrorsPath(root), {
      generatedAt: nowIso(),
      target: designDocPath(root, req.businessName),
      issues: all,
      blocking: blocking.length,
      counts: { tables: tables.length, metrics: metrics.length, rules: rules.length },
    })

    const byUnit: Record<string, number> = {}
    for (const issue of blocking) byUnit[issue.unit] = (byUnit[issue.unit] ?? 0) + 1

    return JSON.stringify({
      ok: blocking.length === 0,
      file: ".dw/design-errors.json",
      blocking: blocking.length,
      total: all.length,
      issues: all.slice(0, 80),
      byUnit,
      message:
        blocking.length === 0
          ? "A/B 类无阻断问题，可进入 C 类设计审查。"
          : "存在 error 级问题：按 unit 回退对应建模单元修正后重跑 dw-validate-design。",
    })
  },
})
