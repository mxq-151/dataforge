/**
 * C0：读取已定稿的设计 → 生成作业计划 .dw/design.json
 *
 * 只认「设计文档 sha256 与 trace 记录一致」的定稿，避免拿一份改过的设计去编码。
 * 作业计划是确定性的：一个目标表一个处理作业，每张被校验表一个质检作业。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  CODE_ENGINES,
  designDocPath,
  designStatePath,
  ddlFilePath,
  loadMetrics,
  loadQuality,
  loadReq,
  loadTables,
  nowIso,
  readJson,
  tracePath,
  writeJsonAtomic,
  type JobSpec,
  type TableDesign,
  tableFullName,
} from "../lib/constants"
import { deriveJobPlan } from "../lib/jobs"

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

export default tool({
  description:
    "C0 读已定稿设计（sha256 与 .dw/trace.json 一致），生成处理作业 + 每张被校验表的质检作业计划，写 .dw/design.json。设计未定稿返回 W28。",
  args: {
    businessName: z.string().min(1),
  },
  async execute(args, context) {
    const root = context.directory
    const trace = readJson<any>(tracePath(root))
    const doc = designDocPath(root, args.businessName)
    if (!trace) {
      return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", message: "缺少 .dw/trace.json：设计尚未定稿" })
    }
    if (!fs.existsSync(doc)) {
      return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", message: `缺少设计文档 docs/${args.businessName}_数仓设计.md` })
    }
    if (sha256(fs.readFileSync(doc, "utf8")) !== trace.designSha256) {
      return JSON.stringify({
        ok: false,
        code: "W28_DESIGN_NOT_FINALIZED",
        message: "设计文档已被修改，与定稿记录不一致：请重新走 dw-finalize-design",
      })
    }
    for (const [layer, info] of Object.entries(trace.ddl ?? {})) {
      const file = path.join(root, ...String((info as any).path ?? `ddls/${layer}_ddl.sql`).split("/"))
      if (!fs.existsSync(file) || sha256(fs.readFileSync(file, "utf8")) !== (info as any).sha256) {
        return JSON.stringify({
          ok: false,
          code: "W28_DESIGN_NOT_FINALIZED",
          message: `DDL ${layer} 已被修改或缺失，与定稿记录不一致：请重新走 dw-finalize-design`,
        })
      }
    }

    const req = loadReq(root)
    const tables = loadTables(root)
    const metrics = loadMetrics(root)
    const rules = loadQuality(root)
    const missing: string[] = []
    if (!req) missing.push(".dw/req.json")
    if (!tables.length) missing.push(".dw/tables.json")
    if (!metrics.length) missing.push(".dw/metrics.json")
    if (!rules.length) missing.push(".dw/quality.json")
    if (missing.length) {
      return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", missing, message: `设计中间态缺失：${missing.join(",")}` })
    }

    for (const table of tables) {
      if (!(CODE_ENGINES as readonly string[]).includes(table.engine)) {
        return JSON.stringify({
          ok: false,
          code: "W28_DESIGN_NOT_FINALIZED",
          message: `表 ${table.enName} 的引擎 ${table.engine} 不在程序代码头允许取值内，无法生成作业`,
        })
      }
      if (!fs.existsSync(ddlFilePath(root, table.layer))) {
        return JSON.stringify({ ok: false, code: "W28_DESIGN_NOT_FINALIZED", message: `缺少 ddls/${table.layer}_ddl.sql` })
      }
    }

    const jobs: JobSpec[] = deriveJobPlan(tables, rules).map((plan) => {
      const table = tables.find((item) => tableFullName(item) === plan.targetTable) as TableDesign
      const metricCodes = plan.isCheck
        ? []
        : metrics
            .filter((metric) => metric.sources.includes(table.enName) || metric.sources.includes(tableFullName(table)))
            .map((metric) => metric.code)
      return {
        name: plan.name,
        kind: "sql",
        engine: table.engine,
        layer: plan.layer,
        domain: plan.domain,
        entity: plan.entity,
        op: plan.op,
        cycle: plan.cycle,
        filePath: plan.filePath,
        code: "",
        dependencies: plan.dependencies,
        programParams: "--day ${day}",
        datasource: [table.datasource],
        targetTable: plan.targetTable,
        sourceTables: plan.sourceTables,
        metricCodes,
      }
    })

    writeJsonAtomic(designStatePath(root), {
      businessName: args.businessName,
      extractedAt: nowIso(),
      designDoc: `docs/${args.businessName}_数仓设计.md`,
      ddlFiles: Object.keys(trace.ddl ?? {}).map((layer) => `ddls/${layer}_ddl.sql`),
      tables,
      metrics,
      rules,
      trace: trace.entries ?? [],
      jobs,
    })

    return JSON.stringify({
      ok: true,
      file: ".dw/design.json",
      designFinalized: true,
      tables: tables.map((table) => tableFullName(table)),
      jobs: jobs.map((job) => ({ name: job.name, filePath: job.filePath, op: job.op, metricCodes: job.metricCodes })),
      message: `作业计划已生成：${tables.length} 张表、${jobs.length} 个作业（含质检）。按作业组分派 dw-coder。`,
    })
  },
})
