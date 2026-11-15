/**
 * D6：设计收口（W27）。
 *
 * 门禁顺序：结构化数据齐全 → 渲染 → W24 文档形状 → W22–W26 全量确定性校验
 * → C 类 open blocker → 增量合并冲突。任一不过都不写盘。
 * 写盘走 node:fs，不经过 edit 工具，因此 dw-* agent 即使被授予 edit 也绕不过本门禁。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
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
  ddlFilePath,
  designDocPath,
  loadMeta,
  loadMetrics,
  loadQuality,
  loadReq,
  loadReview,
  loadTables,
  nowIso,
  readText,
  tracePath,
  writeJsonAtomic,
  writeTextAtomic,
} from "../lib/constants"
import { ddlHeaderIssues, designDocIssues, mergeDdl, mergeDesignDocs, renderDesignDoc, renderDdlBundle } from "../lib/render"

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

export default tool({
  description:
    "D6 设计落盘门禁：渲染 8 章设计文档 + 按方言生成 DDL，跑 W22–W26 与文档形状校验、C 类 blocker 检查、增量合并，全部通过才原子写 docs/{业务}_数仓设计.md、ddls/{分层}_ddl.sql 与 .dw/trace.json。",
  args: {
    businessName: z.string().min(1),
    dryRun: z.boolean().optional(),
  },
  async execute(args, context) {
    const root = context.directory
    const req = loadReq(root)
    if (!req) {
      return JSON.stringify({ ok: false, code: "W01_REQ_MISSING", message: "缺少 .dw/req.json，请先调用 dw-extract-req" })
    }
    const tables = loadTables(root)
    const metrics = loadMetrics(root)
    const rules = loadQuality(root)
    const blocking: { code: string; message: string }[] = []
    if (!tables.length) blocking.push({ code: "W27_TABLES_MISSING", message: "没有已提交的表设计" })
    if (!metrics.length) blocking.push({ code: "W27_METRICS_MISSING", message: "没有已提交的指标映射" })
    if (!rules.length) blocking.push({ code: "W27_QUALITY_MISSING", message: "没有已提交的稽核规则" })
    if (blocking.length) {
      return JSON.stringify({ ok: false, code: "W27_FINALIZE_DESIGN_BLOCKED", blocking, wrote: false })
    }

    const meta = buildMetaIndex(loadMeta(root))
    const reqNames: string[] = (req.metrics ?? []).map((item: any) => item.name)
    const issues = [
      ...tables.flatMap((table) => validateTable(table, tables, meta)),
      ...metrics.flatMap((metric) => validateMetric(metric, tables, reqNames, meta)),
      ...validateQuality(rules, tables, meta),
      ...validateGraph(tables, metrics, req, meta),
    ]
    const trace = buildTrace(metrics)
    issues.push(...validateTrace(reqNames, metrics, trace))

    let markdown = ""
    try {
      markdown = renderDesignDoc(args.businessName, req, tables, metrics, rules)
      for (const issue of designDocIssues(markdown)) blocking.push({ code: issue.code, message: issue.message })
    } catch (error) {
      blocking.push({ code: "W27_RENDER_FAILED", message: error instanceof Error ? error.message : String(error) })
    }
    if (issues.filter((issue) => issue.severity === "error").length) {
      blocking.push({
        code: "W27_VALIDATE_FAILED",
        message: `${issues.filter((issue) => issue.severity === "error").length} 条确定性校验未通过：${issues
          .filter((issue) => issue.severity === "error")
          .slice(0, 6)
          .map((issue) => `${issue.code}@${issue.unit}`)
          .join(",")}`,
      })
    }

    const openBlockers = loadReview(root, "design").filter((finding) => finding.status === "open" && finding.severity === "blocker")
    if (openBlockers.length) {
      blocking.push({
        code: "W27_REVIEW_BLOCKED",
        message: `存在 ${openBlockers.length} 条未处理的设计 blocker：${openBlockers.slice(0, 6).map((item) => item.id).join(",")}`,
      })
    }

    const ddl = renderDdlBundle(tables)
    for (const message of ddl.issues) blocking.push({ code: "W27_DDL_FAILED", message })

    const target = designDocPath(root, args.businessName)
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""
    const merged = mergeDesignDocs(existing, markdown)
    if (merged.conflicts.length) {
      blocking.push({
        code: "W27_MERGE_CONFLICT",
        message: `与已有设计文档冲突 ${merged.conflicts.length} 处（不覆盖已有内容）：${merged.conflicts
          .slice(0, 6)
          .map((conflict) => `第${conflict.chapter}章/${conflict.key}`)
          .join(",")}`,
      })
    }

    const ddlMerged = ddl.files.map((file) => {
      const path = ddlFilePath(root, file.layer)
      const old = readText(path) ?? ""
      const result = mergeDdl(old, file.content)
      if (result.conflicts.length) {
        blocking.push({
          code: "W27_MERGE_CONFLICT",
          message: `${file.layer}_ddl.sql 冲突表：${result.conflicts.slice(0, 6).join(",")}`,
        })
      }
      const layerTables = tables.filter((table) => table.layer === file.layer)
      for (const issue of ddlHeaderIssues(result.content, {
        datasources: layerTables.map((table) => table.datasource),
        engines: layerTables.map((table) => table.engine),
      })) {
        blocking.push({ code: issue.code, message: `ddls/${file.layer}_ddl.sql：${issue.message}` })
      }
      return { layer: file.layer, path, content: result.content }
    })

    if (blocking.length) {
      return JSON.stringify({
        ok: false,
        code: "W27_FINALIZE_DESIGN_BLOCKED",
        blocking,
        conflicts: merged.conflicts,
        issues: issues.slice(0, 40),
        wrote: false,
        message: "未写盘。按 blocking 修正后重新调用 dw-finalize-design。",
      })
    }

    if (args.dryRun) {
      return JSON.stringify({
        ok: true,
        dryRun: true,
        mode: merged.mode,
        bytes: Buffer.byteLength(merged.content, "utf8"),
        ddlFiles: ddlMerged.map((file) => `${file.layer}_ddl.sql`),
        traceCount: trace.length,
        wrote: false,
      })
    }

    writeTextAtomic(target, merged.content)
    for (const file of ddlMerged) writeTextAtomic(file.path, file.content)

    const tracePayload = {
      businessName: args.businessName,
      generatedAt: nowIso(),
      requirementDoc: `docs/${args.businessName}_开发需求.md`,
      designDoc: `docs/${args.businessName}_数仓设计.md`,
      designSha256: sha256(fs.readFileSync(target, "utf8")),
      ddl: Object.fromEntries(
        ddlMerged.map((file) => [
          file.layer,
          { path: `ddls/${file.layer}_ddl.sql`, sha256: sha256(fs.readFileSync(file.path, "utf8")) },
        ]),
      ),
      counts: { tables: tables.length, metrics: metrics.length, rules: rules.length },
      entries: trace,
    }
    writeJsonAtomic(tracePath(root), tracePayload)

    return JSON.stringify({
      ok: true,
      mode: merged.mode,
      wrote: true,
      target: `docs/${args.businessName}_数仓设计.md`,
      ddlFiles: ddlMerged.map((file) => `ddls/${file.layer}_ddl.sql`),
      bytes: Buffer.byteLength(merged.content, "utf8"),
      traceCount: trace.length,
      message: merged.mode === "created" ? "设计文档与 DDL 已创建。" : "设计文档与 DDL 已增量合并，已有内容未被覆盖。",
    })
  },
})
