/**
 * 代码阶段的确定性校验（W29–W36）。
 *
 * 分工：
 * - 静态规则（命名、代码头、SQL 规范、参数、对象存在性、字段顺序）在本文件里算；
 * - 语法校验通过 DataForge 的本地编译服务（/sql-validate、/compile）完成，
 *   服务不可用时 fail-closed，不伪造「已验证」；
 * - 语义等价（口径是否一致、聚合层级是否正确）不在这里，交 dw-code-reviewer。
 */
import fs from "node:fs"
import path from "node:path"
import {
  CODE_ENGINES,
  CYCLES,
  HEADER_DETAILS,
  HEADER_REQUIRED,
  LAYERS,
  OPS,
  RESOURCE_PARAM_KEYS,
  TASK_PARAM_KEYS,
  type JobSpec,
  type UtilSpec,
  type TableDesign,
  programFilePath,
  tableFullName,
} from "./constants"
import { tableSegments } from "./jobs"
import type { Issue, MetaIndex } from "./design-validator"
import { parseSources, targetTableOf, validateJobObjects } from "./design-validator"
import type { TraceEntry } from "./design-validator"

export type CodeHeader = {
  ok: boolean
  entries: Record<string, string>
  issues: string[]
  body: string
}

const HEADER_LINE = /^\s*\*\s*@([^:：]+?)\s*[:：]\s*(.*)$/

/** 提取参数串里的 `--键` / `-D键`，统一小写，用于资源参数/任务参数的归属校验。 */
function paramKeys(value: string): string[] {
  const keys: string[] = []
  for (const match of value.matchAll(/--([A-Za-z][A-Za-z0-9_.-]*)/g)) keys.push(match[1].toLowerCase())
  for (const match of value.matchAll(/-D([A-Za-z][A-Za-z0-9_.-]*)/g)) keys.push("d")
  return keys
}

/** 代码头必须是文件开头的块注释，逐行 `* @键: 值`，遇到第一个非代码头行即结束。 */
export function parseCodeHeader(code: string): CodeHeader {
  const text = code.replace(/\r\n?/g, "\n")
  if (!text.trimStart().startsWith("/*")) {
    return { ok: false, entries: {}, issues: ["代码头必须位于文件最开头，并使用块注释 /* ... */"], body: text }
  }
  const start = text.indexOf("/*")
  const end = text.indexOf("*/", start + 2)
  if (end === -1) {
    return { ok: false, entries: {}, issues: ["代码头块注释未闭合"], body: text }
  }
  const block = text.slice(start + 2, end)
  const entries: Record<string, string> = {}
  const issues: string[] = []
  for (const line of block.split("\n")) {
    if (!line.trim()) continue
    const m = HEADER_LINE.exec(line)
    if (!m) {
      issues.push(`代码头行不符合 "* @键: 值" 格式：${line.trim().slice(0, 40)}`)
      continue
    }
    const key = m[1].trim()
    const value = m[2].trim()
    if (!value) issues.push(`代码头 @${key} 的值为空`)
    entries[key] = value
  }
  for (const key of HEADER_REQUIRED) {
    if (!(key in entries)) issues.push(`代码头缺少必填字段 @${key}：${HEADER_DETAILS[key]}`)
  }
  return { ok: issues.length === 0, entries, issues, body: text.slice(end + 2) }
}

function add(issues: Issue[], rule: string, code: string, unit: string, message: string, severity: Issue["severity"] = "error") {
  issues.push({ code, rule, severity, unit, message })
}

function commentStripped(code: string, kind: JobSpec["kind"]): string {
  let text = code
  if (kind === "sql") {
    text = text.replace(/\/\*[\s\S]*?\*\//g, "")
    text = text.replace(/--[^\n]*/g, "")
  } else {
    text = text.replace(/\/\*[\s\S]*?\*\//g, "")
    text = text.replace(/\/\/[^\n]*/g, "")
  }
  return text
}

function declaredParams(value: string): string[] {
  return [...value.matchAll(/(?:^|\s)--?([A-Za-z_][A-Za-z0-9_.-]*)/g)].map((match) => match[1])
}

function parseVariableNames(code: string): string[] {
  return [...code.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1])
}

function tableRefs(code: string): string[] {
  const refs: string[] = []
  for (const match of code.matchAll(/\b(?:from|join|insert\s+(?:overwrite|into)\s+table)\s+([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*)/gi)) {
    refs.push(match[1])
  }
  return [...new Set(refs)]
}

/** 拆分 select 列表（按顶层逗号），返回输出列名：优先取别名，其次取末段标识符。 */
function selectColumns(code: string): string[] | null {
  const match = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(code)
  if (!match) return null
  const list = match[1]
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of list) {
    if (char === "(") depth += 1
    if (char === ")") depth = Math.max(0, depth - 1)
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts.map((part) => {
    const alias = /\bas\s+`?([A-Za-z][A-Za-z0-9_]*)`?\s*$/i.exec(part)
    if (alias) return alias[1]
    const tail = /`?([A-Za-z][A-Za-z0-9_]*)`?\s*$/.exec(part.replace(/\)\s*$/, ""))
    return tail ? tail[1] : part
  })
}

export type JobContext = {
  tables: TableDesign[]
  meta: MetaIndex
  trace: TraceEntry[]
  /** 作业计划中的全部作业名，用于校验 @依赖 的任务存在性 */
  jobNames?: string[]
  /** 工作空间根目录；其目录名即 Java/Scala 包声明的项目编码 */
  workspaceRoot?: string
}

export function validateJob(job: JobSpec, ctx: JobContext): Issue[] {
  const issues: Issue[] = []
  const unit = `job:${job.name}`
  const target = targetTableOf(ctx.tables, job.targetTable)

  // W29 命名与路径：作业名必须等于由目标表推导的五段名
  const expectedExt = job.kind === "sql" ? ".sql" : job.kind === "java" ? ".java" : ".scala"
  const base = path.posix.basename(job.filePath)
  const dir = path.posix.dirname(job.filePath)
  if (!job.filePath.endsWith(expectedExt)) {
    add(issues, "W29", "W29_JOB_NAME_PATH", unit, `文件扩展名应为 ${expectedExt}，实际 ${job.filePath}`)
  }
  if (base !== `${job.name}${expectedExt}`) {
    add(issues, "W29", "W29_JOB_NAME_PATH", unit, `文件名必须与作业名一致：${job.name}${expectedExt}，实际 ${base}`)
  }
  const expectedDir = `${job.kind === "sql" ? "sql" : "code"}/${job.layer}`
  if (dir !== expectedDir) {
    add(issues, "W29", "W29_JOB_NAME_PATH", unit, `目录应为 ${expectedDir}，实际 ${dir}`)
  }
  if (target) {
    const { namePrefix, layer, domain, entity, cycle } = tableSegments(target)
    const expectedName = `${namePrefix}_${domain}_${entity}_${job.op}_${cycle}`
    if (job.name !== expectedName) {
      add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业名必须等于由目标表 ${target.enName} 推导的五段名 ${expectedName}，实际 ${job.name}`)
    }
    if (job.layer !== layer) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业分层 ${job.layer} 与目标表 ${target.enName} 不一致`)
    if (job.domain !== domain) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业业务域 ${job.domain} 与目标表 ${target.enName} 不一致`)
    if (job.entity !== entity) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业实体 ${job.entity} 与目标表 ${target.enName} 不一致`)
    if (job.cycle !== cycle) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业周期 ${job.cycle} 与目标表 ${target.enName} 不一致`)
  } else if (!/^(ods|dwd|dws|ads|dim)_[a-z0-9]+_[a-z0-9]+_(load|etl|sync|calc|check|export)_(d|h|w|m|y|r|f)$/.test(job.name)) {
    add(issues, "W29", "W29_JOB_NAME_PATH", unit, `作业名不符合 {分层}_{业务域}_{实体}_{操作}_{周期}：${job.name}`)
  }
  if (!LAYERS.includes(job.layer)) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `分层 ${job.layer} 非法`)
  if (!OPS.includes(job.op)) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `操作类型 ${job.op} 非法`)
  if (!CYCLES.includes(job.cycle)) add(issues, "W29", "W29_JOB_NAME_PATH", unit, `执行周期 ${job.cycle} 非法`)

  // W29 依赖格式与存在性：只到作业名这一层，项目前缀由平台生成
  for (const dependency of job.dependencies) {
    if (!/^[A-Za-z0-9_]+$/.test(dependency)) {
      add(issues, "W29", "W29_JOB_NAME_PATH", unit, `依赖 ${dependency} 必须是合法的前置作业名（^[A-Za-z0-9_]+$）`)
      continue
    }
    if (ctx.jobNames && !ctx.jobNames.includes(dependency)) {
      add(issues, "W29", "W29_JOB_NAME_PATH", unit, `依赖作业 ${dependency} 不在作业清单中`)
    }
  }

  // W30 代码头
  const header = parseCodeHeader(job.code)
  for (const message of header.issues) add(issues, "W30", "W30_CODE_HEADER", unit, message)
  const engine = header.entries["引擎"]
  if (engine && !(CODE_ENGINES as readonly string[]).includes(engine)) {
    add(issues, "W30", "W30_CODE_HEADER", unit, `@引擎 ${engine} 不在 CODE_ENGINES 允许取值内`)
  }

  // W30 资源参数 vs 任务参数：归属边界（「无」表示未声明，跳过）
  const resource = header.entries["资源参数"]
  const resourceKeys = resource ? paramKeys(resource) : []
  if (resource && resource.trim() !== "无") {
    if (!/-[A-Za-z]/.test(resource)) {
      add(issues, "W30", "W30_CODE_HEADER", unit, "@资源参数 必须写成 --键 值 的形式，或填「无」")
    }
    const wrong = [...new Set(resourceKeys.filter((key) => (TASK_PARAM_KEYS as readonly string[]).includes(key)))]
    if (wrong.length) {
      add(issues, "W30", "W30_CODE_HEADER", unit, `@资源参数 中的 ${wrong.join("/")} 属于任务参数（提交/引擎侧配置），应写到 @任务参数`)
    }
  }
  const task = header.entries["任务参数"]
  const taskKeys = task ? paramKeys(task) : []
  if (task && task.trim() !== "无") {
    if (!/-[A-Za-z]/.test(task)) {
      add(issues, "W30", "W30_CODE_HEADER", unit, "@任务参数 必须写成 --键 值 的形式，或填「无」")
    }
    const wrong = [...new Set(taskKeys.filter((key) => (RESOURCE_PARAM_KEYS as readonly string[]).includes(key)))]
    if (wrong.length) {
      add(issues, "W30", "W30_CODE_HEADER", unit, `@任务参数 中的 ${wrong.join("/")} 属于资源参数（数量类资源），应写到 @资源参数`)
    }
  }

  // W34 代码头与作业声明一致
  if (engine && engine !== job.engine) {
    add(issues, "W34", "W34_HEADER_CONSISTENCY", unit, `@引擎 ${engine} 与作业声明 ${job.engine} 不一致`)
  }
  const deps = header.entries["依赖"]
  if (deps !== undefined) {
    const declared = deps === "无" ? [] : deps.split(",").map((item) => item.trim()).filter(Boolean)
    if (declared.join("|") !== job.dependencies.join("|")) {
      add(issues, "W34", "W34_HEADER_CONSISTENCY", unit, `@依赖 [${declared.join(",")}] 与作业依赖 [${job.dependencies.join(",")}] 不一致`)
    }
  }
  const ds = header.entries["数据源"]
  if (ds !== undefined) {
    const declared = ds.split(",").map((item) => item.trim()).filter(Boolean)
    if ([...declared].sort().join("|") !== [...job.datasource].sort().join("|")) {
      add(issues, "W34", "W34_HEADER_CONSISTENCY", unit, `@数据源 [${declared.join(",")}] 与作业声明 [${job.datasource.join(",")}] 不一致`)
    }
  }
  if (job.resourceParams !== undefined && resource !== undefined && resource.trim() !== job.resourceParams.trim()) {
    add(
      issues,
      "W34",
      "W34_HEADER_CONSISTENCY",
      unit,
      `@资源参数 [${resource}] 与作业声明 [${job.resourceParams}] 不一致`,
    )
  }
  if (job.taskParams !== undefined && task !== undefined && task.trim() !== job.taskParams.trim()) {
    add(issues, "W34", "W34_HEADER_CONSISTENCY", unit, `@任务参数 [${task}] 与作业声明 [${job.taskParams}] 不一致`)
  }

  const body = commentStripped(header.body, job.kind)

  // W32 参数
  for (const name of parseVariableNames(body)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      add(issues, "W32", "W32_PARAM", unit, `变量 \${${name}} 不是合法标识符`)
      continue
    }
    if (!declaredParams(job.programParams ?? "").includes(name)) {
      add(issues, "W32", "W32_PARAM", unit, `变量 \${${name}} 未在 @程序参数 中同名声明`)
    }
  }
  if (/\$\[\s*(yyyy|YYYY)/.test(body)) {
    add(issues, "W32", "W32_PARAM", unit, "禁止使用内置日期写法 $[yyyyMMdd]，系统不会把它当程序参数下发")
  }
  const dateMatch = /\b20\d{2}[-/]?(0[1-9]|1[0-2])[-/]?(0[1-9]|[12]\d|3[01])\b/.exec(body)
  if (dateMatch && !/\$\{/.test(dateMatch[0])) {
    add(issues, "W32", "W32_PARAM", unit, `出现硬编码业务日期 ${dateMatch[0]}，请改为 \${参数}`)
  }

  // W33 对象存在
  for (const message of validateJobObjects(job, ctx.tables, ctx.meta).map((item) => item.message)) {
    add(issues, "W33", "W33_UNKNOWN_OBJECT", unit, message)
  }
  for (const ref of tableRefs(body)) {
    const exists =
      ctx.tables.some((table) => tableFullName(table).toLowerCase() === ref.toLowerCase()) ||
      (ctx.meta.table.get(ref.toLowerCase()) ?? []).length > 0
    if (!exists) add(issues, "W33", "W33_UNKNOWN_OBJECT", unit, `代码引用的表 ${ref} 既不在设计中，也没有 metadata 证据`)
  }

  // W35 指标标注与字段顺序
  const sqlInsert = /insert\s+(?:overwrite|into)\s+table\s+([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)/i.exec(body)
  for (const code of job.metricCodes) {
    const entry = ctx.trace.find((item) => item.code === code)
    if (!entry) {
      add(issues, "W35", "W35_METRIC_ANNOTATION", unit, `指标编码 ${code} 不在设计指标表中`)
      continue
    }
    if (!new RegExp(`--\\s*指标[:：]\\s*${code}\\b`).test(job.code)) {
      add(issues, "W35", "W35_METRIC_ANNOTATION", unit, `产出指标 ${code} ${entry.name} 但代码中缺少 "-- 指标: ${code} ${entry.name}" 标注`)
    }
  }
  if (target) {
    const columns = sqlInsert
      ? sqlInsert[2].split(",").map((item) => item.trim().replace(/`/g, "")).filter(Boolean)
      : selectColumns(body)
    if (columns) {
      const expected = target.fields.map((field) => field.name)
      if (columns.join("|") !== expected.join("|")) {
        add(
          issues,
          "W35",
          "W35_FIELD_ORDER",
          unit,
          `输出列顺序应与设计字段一致：期望 ${expected.join(",")}，实际 ${columns.join(",")}`,
        )
      }
    }
  }

  // W46 质量回传契约（质检作业）
  if (job.op === "check" || /_check_/.test(job.name)) {
    const required = ["datasourceName", "batchNo", "ruleName", "ruleType", "passed", "checkTime"]
    const missing = required.filter((key) => !new RegExp(`\\b${key}\\b`).test(job.code))
    if (missing.length) {
      add(issues, "W46", "W46_QUALITY_REPORT", unit, `质量回传缺少字段：${missing.join(",")}`)
    }
    for (const env of ["DATAFORGE_QUALITY_REPORT_URL", "DATAFORGE_QUALITY_REPORT_TOKEN"]) {
      if (!job.code.includes(env)) add(issues, "W46", "W46_QUALITY_REPORT", unit, `必须通过环境变量 ${env} 注入回传地址/令牌`)
    }
    if (/https?:\/\//i.test(job.code)) {
      add(issues, "W46", "W46_QUALITY_REPORT", unit, "禁止硬编码回传地址，改用 DATAFORGE_QUALITY_REPORT_URL")
    }
  }

  // W31 SQL 规范
  if (job.kind === "sql") {
    if (/\bselect\s+\*/i.test(body)) add(issues, "W31", "W31_SQL_STATIC", unit, "禁止 select *，必须显式列名")
    if (/\b(drop\s+table|truncate\s+table|delete\s+from)\b/i.test(body)) {
      add(issues, "W47", "W47_DESTRUCTIVE_SQL", unit, "禁止 DROP TABLE / TRUNCATE TABLE / DELETE FROM 等破坏性语句")
    }
    const partitionField = target?.partition.field
    if (partitionField) {
      const partitioned = new RegExp(`partition\\s*\\(\\s*${partitionField}\\s*=`, "i").test(body)
      const filtered = new RegExp(`\\bwhere[\\s\\S]*\\b${partitionField}\\b\\s*(=|in|between)`, "i").test(body)
      if (!partitioned && !filtered) {
        add(issues, "W31", "W31_SQL_STATIC", unit, `缺少分区过滤：必须按 ${partitionField} 限定范围`)
      }
    }
  } else {
    const className = base.replace(/\.(java|scala)$/, "")
    const packageDecl = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(body)
    if (!packageDecl) {
      add(issues, "W43", "W43_PACKAGE_CLASS", unit, "Java/Scala 文件缺少 package 声明")
    } else if (ctx.workspaceRoot) {
      const projectCode = path.basename(ctx.workspaceRoot)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(projectCode)) {
        add(issues, "W43", "W43_PACKAGE_CLASS", unit, `工作空间目录名 ${projectCode} 不能作为 package 首段（需为合法 Java 标识符）`)
      }
      const expected = [projectCode, ...path.posix.dirname(job.filePath).split("/").filter(Boolean)].join(".")
      if (packageDecl[1] !== expected) {
        add(issues, "W43", "W43_PACKAGE_CLASS", unit, `package 应为 ${expected}（{项目编码}.{目录路径}），实际 ${packageDecl[1]}`)
      }
    } else {
      const last = packageDecl[1].split(".").pop()
      if (last !== job.layer) add(issues, "W43", "W43_PACKAGE_CLASS", unit, `package 末段应为 ${job.layer}，实际 ${last}`)
    }
    const classDecl = new RegExp(`\\b(class|object)\\s+${className}\\b`).test(body)
    if (!classDecl) add(issues, "W43", "W43_PACKAGE_CLASS", unit, `主类名/对象名必须与文件名逐字一致：${className}`)
  }

  return issues
}

/** W43：公共 UDF 的 package 与类名（code/utils 下）。 */
export function validateUtil(util: UtilSpec, workspaceRoot?: string): Issue[] {
  const issues: Issue[] = []
  const unit = `util:${util.name}`
  const base = path.posix.basename(util.filePath)
  const className = base.replace(/\.(java|scala)$/, "")
  if (className !== util.name) {
    add(issues, "W43", "W43_PACKAGE_CLASS", unit, `UDF 名称必须与文件名一致：${className}`)
  }
  const packageDecl = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(util.code)
  if (!packageDecl) {
    add(issues, "W43", "W43_PACKAGE_CLASS", unit, "公共 UDF 缺少 package 声明")
  } else if (workspaceRoot) {
    const projectCode = path.basename(workspaceRoot)
    const expected = [projectCode, "code", "utils"].join(".")
    if (packageDecl[1] !== expected) {
      add(issues, "W43", "W43_PACKAGE_CLASS", unit, `package 应为 ${expected}，实际 ${packageDecl[1]}`)
    }
  }
  const classDecl = new RegExp(`\\b(class|object)\\s+${className}\\b`).test(util.code)
  if (!classDecl) add(issues, "W43", "W43_PACKAGE_CLASS", unit, `主类名/对象名必须与文件名一致：${className}`)
  return issues
}

/** 去注释、空行与纯分隔行后的逻辑行，用于跨作业重复实现检测。 */
export const DUPLICATE_BLOCK_LINES = 20

function logicLines(code: string): string[] {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(package|import)\b/.test(line) && !/^[{}();,]+$/.test(line))
}

type LogicFile = { name: string; kind: string; code: string }

/** W44：Java/Scala 作业与公共 UDF 之间连续 ≥20 行逻辑完全相同，视为复制实现。 */
export function duplicateLogicIssues(jobs: LogicFile[]): Issue[] {
  const targets = jobs.filter((job) => job.kind !== "sql").map((job) => ({ job, lines: logicLines(job.code) }))
  const issues: Issue[] = []
  const reported = new Set<string>()
  for (let i = 0; i < targets.length; i += 1) {
    for (let k = i + 1; k < targets.length; k += 1) {
      const a = targets[i]
      const b = targets[k]
      if (a.job.kind === "util" && b.job.kind === "util") continue
      if (a.lines.length < DUPLICATE_BLOCK_LINES || b.lines.length < DUPLICATE_BLOCK_LINES) continue
      const windows = new Map<string, number>()
      for (let p = 0; p + DUPLICATE_BLOCK_LINES <= a.lines.length; p += 1) {
        windows.set(a.lines.slice(p, p + DUPLICATE_BLOCK_LINES).join("\n"), p)
      }
      let hit: string | null = null
      for (let q = 0; q + DUPLICATE_BLOCK_LINES <= b.lines.length; q += 1) {
        const key = b.lines.slice(q, q + DUPLICATE_BLOCK_LINES).join("\n")
        if (windows.has(key)) {
          hit = key
          break
        }
      }
      if (!hit || reported.has(hit)) continue
      reported.add(hit)
      const firstLine = hit.split("\n")[0].slice(0, 60)
      const flag = (target: LogicFile, other: LogicFile) =>
        add(
          issues,
          "W44",
          "W44_DUPLICATE_LOGIC",
          `${target.kind === "util" ? "util" : "job"}:${target.name}`,
          `与 ${other.name} 存在连续 ${DUPLICATE_BLOCK_LINES} 行相同逻辑（起始：${firstLine}），应抽取到 utils/ 复用`,
        )
      if (a.job.kind === "util") flag(b.job, a.job)
      else if (b.job.kind === "util") flag(a.job, b.job)
      else {
        flag(a.job, b.job)
        flag(b.job, a.job)
      }
    }
  }
  return issues
}

/** W49：同一指标编码只能由一个作业产出。 */
export function metricOwnershipIssues(jobs: JobSpec[]): Issue[] {
  const owners = new Map<string, string[]>()
  for (const job of jobs) {
    for (const code of job.metricCodes ?? []) {
      owners.set(code, [...(owners.get(code) ?? []), job.name])
    }
  }
  const issues: Issue[] = []
  for (const [code, names] of owners) {
    if (names.length < 2) continue
    for (const name of names) {
      add(issues, "W49", "W49_METRIC_OWNERSHIP", `job:${name}`, `指标 ${code} 同时由 ${names.join("、")} 产出；一个指标只能在一层一张表产出`)
    }
  }
  return issues
}

// ── staging 与语法校验 ─────────────────────────────────────────────────
export function stagingPath(root: string, job: JobSpec): string {
  return path.join(root, ".dw", "staging", ...job.filePath.split("/"))
}

export function writeStaging(root: string, job: JobSpec): string {
  const target = stagingPath(root, job)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, job.code, "utf8")
  return target
}

export type SyntaxResult = {
  status: "passed" | "failed" | "unavailable" | "skipped"
  errors: { job: string; file: string; message: string }[]
  endpoint?: string
}

type Endpoint = { port: string; token: string }

function endpoint(): Endpoint | null {
  const port = process.env.DATAFORGE_COMPILE_PORT
  if (!port) return null
  return { port, token: process.env.DATAFORGE_COMPILE_TOKEN ?? "" }
}

async function post(base: string, route: string, body: unknown, token: string): Promise<any> {
  // 鉴权只有一种：Authorization: Bearer <token>（与 compileServer.ts 的契约一致）
  const response = await fetch(`http://127.0.0.1:${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { error: text }
  }
  return { ok: response.ok, status: response.status, json }
}

function errorText(payload: any): string {
  if (!payload) return "语法校验失败（无返回内容）"
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim()
  if (Array.isArray(payload.errors) && payload.errors.length) {
    return payload.errors
      .map((item: any) => (typeof item === "string" ? item : item?.message ?? JSON.stringify(item)))
      .join(" / ")
  }
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim()
  return JSON.stringify(payload).slice(0, 400)
}

/**
 * 语法校验：逐文件调用本地编译服务。
 * 未注入 DATAFORGE_COMPILE_PORT（不在 DataForge 应用内运行）时返回 unavailable，
 * 由调用方按 W36 阻断落盘，而不是假定「没报错就是通过」。
 */
export async function checkSyntax(
  root: string,
  jobs: JobSpec[],
  options: { enabled: boolean },
): Promise<SyntaxResult> {
  if (!options.enabled) return { status: "skipped", errors: [] }
  const config = endpoint()
  if (!config) {
    return {
      status: "unavailable",
      errors: [
        {
          job: "(all)",
          file: "",
          message: "未检测到 DATAFORGE_COMPILE_PORT：请从 DataForge 客户端内运行，或显式关闭语法校验（仅调试）",
        },
      ],
    }
  }

  const errors: SyntaxResult["errors"] = []
  for (const job of jobs) {
    const file = writeStaging(root, job)
    try {
      const response =
        job.kind === "sql"
          ? await post(
              config.port,
              "/sql-validate",
              { filePath: file, cwd: root, datasources: job.datasource, engineType: job.engine },
              config.token,
            )
          : await post(config.port, "/compile", { filePath: file, cwd: root }, config.token)
      const payload = response.json ?? {}
      const success = response.ok && payload.success !== false && !payload.error
      if (!success) {
        errors.push({ job: job.name, file: job.filePath, message: errorText(payload) })
      }
    } catch (error) {
      return {
        status: "unavailable",
        endpoint: `127.0.0.1:${config.port}`,
        errors: [
          {
            job: job.name,
            file: job.filePath,
            message: `编译服务不可用：${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      }
    }
  }
  return { status: errors.length ? "failed" : "passed", errors, endpoint: `127.0.0.1:${config.port}` }
}

/** 落盘目标路径（finalize 用，与 staging 同构）。 */
export function finalPath(root: string, job: JobSpec): string {
  return programFilePath(root, job.kind, job.layer, job.name)
}

export { parseSources }
