/**
 * 设计阶段的确定性校验（W05–W26）。
 *
 * 这里只做「能从结构化数据算出来」的判断：命名、粒度、键、分区、类型、引用闭包、
 * 依赖方向、指标继承、覆盖与可追溯。口径是否等价、聚合层级是否正确属于语义判断，
 * 交给 dw-design-reviewer 并强制带证据（W38）。
 */
import {
  CLASSIFICATION_STANDARD,
  CYCLES,
  DATA_TIERS,
  DIALECTS,
  IMPACT_DEGREES,
  IMPACT_OBJECTS,
  LAYER_SPEC,
  LAYERS,
  LEVEL_MASKING,
  OFFLINE_ALLOWED_TIERS,
  QUALITY_TYPE_LABELS,
  TABLE_NAME_MAX,
  TABLE_NAME_RESERVED,
  TIER_BY_IMPACT,
  TIER_RANK,
  expectedCnNameSuffix,
  tableDb,
  tableFullName,
  type EvidenceRecord,
  type JobSpec,
  type MetricDesign,
  type QualityRuleDesign,
  type TableDesign,
} from "./constants"
import { mapType } from "./ddl"

export type Issue = {
  code: string
  rule: string
  severity: "error" | "warning" | "info"
  unit: string
  message: string
}

export type MetaIndex = {
  table: Map<string, EvidenceRecord[]>
  column: Map<string, EvidenceRecord[]>
}

const lower = (value: string): string => value.trim().toLowerCase()

export function buildMetaIndex(records: EvidenceRecord[]): MetaIndex {
  const table = new Map<string, EvidenceRecord[]>()
  const column = new Map<string, EvidenceRecord[]>()
  for (const record of records) {
    if (!record.hit || record.total <= 0) continue
    const tableKey = `${lower(record.database)}.${lower(record.table)}`
    const tableList = table.get(tableKey) ?? []
    tableList.push(record)
    table.set(tableKey, tableList)
    if (record.column) {
      const columnKey = `${tableKey}:${lower(record.column)}`
      const columnList = column.get(columnKey) ?? []
      columnList.push(record)
      column.set(columnKey, columnList)
    }
  }
  return { table, column }
}

export function hasTableEvidence(meta: MetaIndex, db: string, table: string): boolean {
  return (meta.table.get(`${lower(db)}.${lower(table)}`) ?? []).length > 0
}

export function hasColumnEvidence(meta: MetaIndex, db: string, table: string, column: string): boolean {
  return (meta.column.get(`${lower(db)}.${lower(table)}:${lower(column)}`) ?? []).length > 0
}

export function evidenceDatasources(meta: MetaIndex, db: string, table: string): string[] {
  return [...new Set((meta.table.get(`${lower(db)}.${lower(table)}`) ?? []).map((record) => record.datasource))]
}

function parseRef(value: string): { db: string; table: string; column?: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?::([A-Za-z][A-Za-z0-9_]*))?$/.exec(value.trim())
  if (!m) return null
  return { db: m[1], table: m[2], column: m[3] }
}

/** 字段来源列：`库.表:字段,字段;库.表:字段`。 */
export function parseSources(value: string): { db: string; table: string; columns: string[] }[] | null {
  const output: { db: string; table: string; columns: string[] }[] = []
  const groups = value.split(";").map((item) => item.trim()).filter(Boolean)
  if (groups.length === 0) return null
  for (const group of groups) {
    const [head, cols] = group.split(":")
    const ref = parseRef(head)
    if (!ref || ref.column) return null
    const columns = (cols ?? "").split(",").map((item) => item.trim()).filter(Boolean)
    if (columns.length === 0) return null
    if (columns.some((column) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(column))) return null
    output.push({ db: ref.db, table: ref.table, columns })
  }
  return output
}

/** 下钻维度列：`时间(库.表:字段→字段);渠道(库.表:字段)`。 */
export function parseDimensions(value: string): { name: string; db: string; table: string; columns: string[] }[] | null {
  const text = value.trim()
  if (!text || text === "无") return []
  const output: { name: string; db: string; table: string; columns: string[] }[] = []
  for (const group of text.split(";").map((item) => item.trim()).filter(Boolean)) {
    const m = /^([^()]+)\(([^()]+)\)$/.exec(group)
    if (!m) return null
    const [, name, inner] = m
    const [head, cols] = inner.split(":")
    const ref = parseRef(head)
    if (!ref || ref.column) return null
    const columns = (cols ?? "").split("→").map((item) => item.trim()).filter(Boolean)
    if (columns.length === 0) return null
    output.push({ name: name.trim(), db: ref.db, table: ref.table, columns })
  }
  return output
}

function tableByName(tables: TableDesign[], db: string, name: string): TableDesign | undefined {
  return tables.find((table) => lower(tableDb(table)) === lower(db) && lower(table.enName) === lower(name))
}

function fieldExists(table: TableDesign, column: string): boolean {
  return table.fields.some((field) => lower(field.name) === lower(column))
}

function add(issues: Issue[], rule: string, code: string, unit: string, message: string, severity: Issue["severity"] = "error") {
  issues.push({ code, rule, severity, unit, message })
}

// ── 表 ──────────────────────────────────────────────────────────────────
export function validateTable(table: TableDesign, tables: TableDesign[], meta: MetaIndex): Issue[] {
  const issues: Issue[] = []
  const unit = `table:${table.enName}`
  const en = lower(table.enName)

  // W06 命名：正式表四段 {分层}_{业务域}_{实体}_{周期}；临时表四段 tmp_{业务域}_{实体}_{周期}
  const isTemp = table.tableType === "临时表"
  if (!isTemp && !LAYERS.includes(table.layer)) {
    add(issues, "W06", "W06_TABLE_NAME", unit, `分层 ${table.layer} 非法`)
  }
  const segments = en.split("_")
  if (segments.length !== 4) {
    add(
      issues,
      "W06",
      "W06_TABLE_NAME",
      unit,
      `表名 ${table.enName} 必须是四段 ${isTemp ? "tmp_{业务域}_{实体}_{周期}" : "{分层}_{业务域}_{实体}_{周期}"}，实际 ${segments.length} 段`,
    )
  } else {
    const [layerSeg, domainSeg, entitySeg, cycleSeg] = segments
    if (isTemp) {
      if (layerSeg !== "tmp") {
        add(issues, "W06", "W06_TABLE_NAME", unit, `临时表名首段必须是 tmp，实际 ${layerSeg}`)
      }
    } else if (layerSeg !== table.layer) {
      add(issues, "W06", "W06_TABLE_NAME", unit, `表名首段 ${layerSeg} 必须等于分层 ${table.layer}`)
    }
    if (domainSeg !== lower(table.domain)) {
      add(issues, "W06", "W06_TABLE_NAME", unit, `表名第二段 ${domainSeg} 必须等于业务域 ${table.domain}`)
    }
    if (!entitySeg) {
      add(issues, "W06", "W06_TABLE_NAME", unit, "表名实体段不能为空")
    }
    for (const segment of segments) {
      if (!/^[a-z][a-z0-9]*$/.test(segment)) {
        add(issues, "W06", "W06_TABLE_NAME", unit, `表名分段 ${segment} 必须小写字母开头且只含小写字母/数字`)
      }
    }
    if (!CYCLES.includes(cycleSeg)) {
      add(issues, "W06", "W06_TABLE_NAME", unit, `表名末段 ${cycleSeg} 必须是刷新周期（${CYCLES.join("/")}）`)
    }
  }
  if (isTemp && !en.startsWith("tmp_")) {
    add(issues, "W06", "W06_TABLE_NAME", unit, "临时表名必须以 tmp_ 开头")
  }
  if (en.length > TABLE_NAME_MAX) {
    add(issues, "W06", "W06_TABLE_NAME", unit, `表名长度 ${en.length} 超过上限 ${TABLE_NAME_MAX}`)
  }
  const reserved = segments.filter((segment) => (TABLE_NAME_RESERVED as readonly string[]).includes(segment))
  if (reserved.length) {
    add(issues, "W06", "W06_TABLE_NAME", unit, `表名分段命中 SQL 保留字：${reserved.join(",")}`)
  }

  // W40 分类分级：按 GB/T 43697-2024 校验必填、定级依据与表 1 一致性
  const classification = table.classification
  if (!classification.industry.trim() || !classification.businessAttribute.trim() || !classification.categoryPath.trim()) {
    add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, "表分类必须填行业领域、业务属性、分类路径；行业目录缺失不报错，进第 8 章待确认")
  }
  const level = table.level
  const tiers = DATA_TIERS as readonly string[]
  if (!tiers.includes(level.tier)) {
    add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, `表数据级别 ${level.tier} 不在 ${DATA_TIERS.join("/")} 内`)
  }
  const expectedTier = TIER_BY_IMPACT[level.impactObject]?.[level.impactDegree]
  if (!expectedTier) {
    add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, `影响对象/影响程度非法：${level.impactObject} × ${level.impactDegree}`)
  } else if (expectedTier !== level.tier) {
    add(
      issues,
      "W40",
      "W40_DATA_CLASSIFICATION",
      unit,
      `按 ${CLASSIFICATION_STANDARD} 表 1，${level.impactObject} × ${level.impactDegree} 应定为 ${expectedTier}，实际 ${level.tier}`,
    )
  }
  if (!level.basis.trim()) {
    add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, "定级依据必填：写明影响对象、影响程度与判定理由")
  }
  if (!OFFLINE_ALLOWED_TIERS.includes(level.tier)) {
    add(
      issues,
      "W40",
      "W40_DATA_CLASSIFICATION",
      unit,
      `${level.tier} 默认禁止落离线仓；确需落仓须在 constants 的 OFFLINE_ALLOWED_TIERS 中显式打开并记录审批依据`,
    )
  }
  let maxFieldTier = 0
  for (const field of table.fields) {
    const fieldTier = field.level.tier
    if (!tiers.includes(fieldTier)) {
      add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, `字段 ${field.name} 的数据级别 ${fieldTier} 非法`)
      continue
    }
    maxFieldTier = Math.max(maxFieldTier, TIER_RANK[fieldTier])

    // W41 级别与最小必要管控（企业口径，非标准强制）
    const allowed = LEVEL_MASKING[fieldTier]
    if (!allowed.includes(field.masking)) {
      add(
        issues,
        "W41",
        "W41_MASKING_MATCH",
        unit,
        `字段 ${field.name} 级别 ${fieldTier} 按企业口径只允许 ${allowed.join("/")}，实际 ${field.masking}`,
      )
    }
  }
  if (maxFieldTier > (TIER_RANK[level.tier] ?? 0)) {
    add(issues, "W40", "W40_DATA_CLASSIFICATION", unit, `表级 ${level.tier} 低于字段最高级别，表级必须不低于字段最高级`)
  }

  // W45 临时表清理要求
  if (isTemp) {
    if (!table.tempTtlDays) {
      add(issues, "W45", "W45_TEMP_TABLE", unit, "临时表必须填 tempTtlDays（≤7 天），并说明清理方式")
    } else if (table.tempTtlDays > 7) {
      add(issues, "W45", "W45_TEMP_TABLE", unit, `临时表 tempTtlDays=${table.tempTtlDays} 超过 7 天上限`)
    }
    if (table.lifecycleDays > 7) {
      add(issues, "W45", "W45_TEMP_TABLE", unit, `临时表生命周期 ${table.lifecycleDays} 天超过 7 天，必须设置自动清理`)
    }
  } else if (table.tempTtlDays) {
    add(issues, "W45", "W45_TEMP_TABLE", unit, "正式表不应填 tempTtlDays")
  }

  // W42 表中文名约定（只校验可确定性判定的后缀）
  const cnSuffix = expectedCnNameSuffix(table)
  if (!table.cnName.trim().endsWith(cnSuffix)) {
    add(issues, "W42", "W42_TABLE_CNNAME", unit, `表中文名 ${table.cnName} 必须以「${cnSuffix}」结尾`)
  }

  // W48 金额字段必须 decimal
  for (const field of table.fields) {
    if (/(amount|amt|price|fee|cost|money|payment)|(金额|价格|费用|成本)/i.test(`${field.name}${field.cnName}`)) {
      if (!/^decimal\s*\(/i.test(field.logicalType)) {
        add(issues, "W48", "W48_AMOUNT_DECIMAL", unit, `金额字段 ${field.name} 必须使用 decimal(p,s)，实际 ${field.logicalType}`)
      }
    }
  }

  // W07 粒度
  if (table.grain.trim().length < 4 || /^一行数据$/.test(table.grain.trim())) {
    add(issues, "W07", "W07_GRAIN_MISSING", unit, "粒度声明必须写清「一行代表什么」，不能是「一行数据」")
  }

  // W08 键
  for (const key of [...table.primaryKey, ...(table.uniqueKey ?? [])]) {
    if (!fieldExists(table, key)) add(issues, "W08", "W08_KEY_INVALID", unit, `键字段 ${key} 不在字段清单中`)
  }

  // W09 分区
  if (!fieldExists(table, table.partition.field)) {
    add(issues, "W09", "W09_PARTITION", unit, `分区字段 ${table.partition.field} 不在字段清单中`)
  }

  // W10 生命周期
  if (!Number.isInteger(table.lifecycleDays) || table.lifecycleDays <= 0) {
    add(issues, "W10", "W10_STORAGE_LIFECYCLE", unit, "lifecycleDays 必须是正整数")
  }

  // W11 拉链
  if (table.updateMode === "scd2") {
    for (const required of ["start_date", "end_date", "is_current"]) {
      if (!fieldExists(table, required)) add(issues, "W11", "W11_UPDATE_MODE", unit, `拉链表缺少字段 ${required}`)
    }
  }

  // W12 方言
  const dialect = table.engine === "kyuubi" ? "hive" : table.engine
  if (!DIALECTS.includes(dialect as any)) {
    add(issues, "W12", "W12_DIALECT_UNSUPPORTED", unit, `引擎 ${table.engine} 不支持 DDL 生成`)
  } else {
    for (const field of table.fields) {
      if (!mapType(dialect as any, field.logicalType)) {
        add(issues, "W12", "W12_DIALECT_UNSUPPORTED", unit, `字段 ${field.name} 的类型 ${field.logicalType} 在 ${dialect} 下无映射`)
      }
    }
  }

  // W13 字段来源 + 上游
  for (const field of table.fields) {
    if (!field.source) continue
    const ref = parseRef(field.source)
    if (!ref || !ref.column) {
      add(issues, "W13", "W13_FIELD_SOURCE", unit, `字段 ${field.name} 的来源 "${field.source}" 应为 库.表:字段`)
      continue
    }
    const local = tableByName(tables, ref.db, ref.table)
    if (local) {
      if (!fieldExists(local, ref.column)) {
        add(issues, "W13", "W13_FIELD_SOURCE", unit, `字段 ${field.name} 的来源 ${field.source} 不在表 ${local.enName} 中`)
      }
    } else if (!hasColumnEvidence(meta, ref.db, ref.table, ref.column)) {
      add(issues, "W05", "W05_META_UNVERIFIED", unit, `字段 ${field.name} 的来源 ${field.source} 没有 metadata 证据`)
    }
  }
  for (const upstream of table.upstream) {
    const ref = parseRef(upstream)
    if (!ref || ref.column) {
      add(issues, "W13", "W13_FIELD_SOURCE", unit, `上游 "${upstream}" 应为 库.表`)
      continue
    }
    if (!tableByName(tables, ref.db, ref.table) && !hasTableEvidence(meta, ref.db, ref.table)) {
      add(issues, "W05", "W05_META_UNVERIFIED", unit, `上游 ${upstream} 没有 metadata 证据`)
    }
  }

  // W17 数据源（表级）
  const ds = evidenceDatasources(meta, tableDb(table), table.enName)
  if (ds.length && !ds.includes(table.datasource)) {
    add(issues, "W17", "W17_DATASOURCE", unit, `表数据源 ${table.datasource} 与证据登记 ${ds.join(",")} 不一致`)
  }

  return issues
}

// ── 指标 ────────────────────────────────────────────────────────────────
export function validateMetric(
  metric: MetricDesign,
  tables: TableDesign[],
  reqNames: string[],
  meta: MetaIndex,
): Issue[] {
  const issues: Issue[] = []
  const unit = `metric:${metric.name}`

  // W14 逐字继承（设计新增指标显式标注 isNew 时不按改写处理，由 W50 单独管）
  const inReq = reqNames.includes(metric.name)
  if (!inReq && !metric.isNew) {
    const near = reqNames.find((name) => name.replace(/\s/g, "") === metric.name.replace(/\s/g, ""))
    add(
      issues,
      "W14",
      "W14_METRIC_NAME_MISMATCH",
      unit,
      near ? `指标名称必须逐字继承需求；疑似把「${near}」改写成了「${metric.name}」` : `指标「${metric.name}」不在需求文档第 3 章中`,
    )
  }

  // W50 设计新增标注
  if (inReq && metric.isNew) {
    add(issues, "W50", "W50_METRIC_NEW_FLAG", unit, `指标「${metric.name}」已在需求文档中，不得标记为设计新增`)
  }
  if (!inReq && !metric.isNew) {
    add(issues, "W50", "W50_METRIC_NEW_FLAG", unit, `指标「${metric.name}」不在需求文档中，必须标记 isNew=true 并列入待确认`)
  }

  // W16 字段来源
  const sources = parseSources(metric.sources)
  if (!sources) {
    add(issues, "W16", "W16_METRIC_BINDING", unit, `字段来源 "${metric.sources}" 应为 库.表:字段,字段;库.表:字段`)
  } else {
    for (const source of sources) {
      const local = tableByName(tables, source.db, source.table)
      if (local) {
        for (const column of source.columns) {
          if (!fieldExists(local, column)) {
            add(issues, "W16", "W16_METRIC_BINDING", unit, `字段来源 ${source.db}.${source.table}:${column} 的字段不在表 ${local.enName} 中`)
          }
        }
      } else {
        if (!hasTableEvidence(meta, source.db, source.table)) {
          add(issues, "W16", "W16_METRIC_BINDING", unit, `字段来源 ${source.db}.${source.table} 没有 metadata 证据`)
        }
        for (const column of source.columns) {
          if (!hasColumnEvidence(meta, source.db, source.table, column)) {
            add(issues, "W05", "W05_META_UNVERIFIED", unit, `字段来源 ${source.db}.${source.table}:${column} 没有字段级证据`)
          }
        }
      }
    }

    // W17 数据源一致
    const candidates = sources.flatMap((source) => {
      const local = tableByName(tables, source.db, source.table)
      if (local) return [local.datasource]
      return evidenceDatasources(meta, source.db, source.table)
    })
    if (candidates.length && !candidates.includes(metric.datasource)) {
      add(issues, "W17", "W17_DATASOURCE", unit, `指标数据源 ${metric.datasource} 与来源证据 ${[...new Set(candidates)].join(",")} 不一致`)
    }
  }

  // W18 维度
  const dimensions = parseDimensions(metric.dimensions)
  if (!dimensions) {
    add(issues, "W18", "W18_DIMENSION", unit, `下钻维度 "${metric.dimensions}" 应为 维度名(库.表:字段→字段)，多个用 ; 分隔`)
  } else {
    for (const dimension of dimensions) {
      const local = tableByName(tables, dimension.db, dimension.table)
      for (const column of dimension.columns) {
        const exists = local ? fieldExists(local, column) : hasColumnEvidence(meta, dimension.db, dimension.table, column)
        if (!exists) {
          add(issues, "W18", "W18_DIMENSION", unit, `维度 ${dimension.name} 的字段 ${dimension.db}.${dimension.table}:${column} 不存在`)
        }
      }
    }
  }

  return issues
}

// ── 稽核规则 ────────────────────────────────────────────────────────────
export function validateQuality(rules: QualityRuleDesign[], tables: TableDesign[], meta: MetaIndex): Issue[] {
  const issues: Issue[] = []
  const names = new Set<string>()

  for (const rule of rules) {
    const unit = `rule:${rule.name}`
    if (names.has(rule.name)) add(issues, "W21", "W21_QUALITY_COVERAGE", unit, `规则名「${rule.name}」重复`)
    names.add(rule.name)

    if (!QUALITY_TYPE_LABELS.includes(rule.ruleType as any)) {
      add(issues, "W19", "W19_QUALITY_TYPE", unit, `规则类型 ${rule.ruleType} 不在 7 类之内`)
    }
    if (!["阻断下游", "告警", "阻断下游+告警"].includes(rule.disposition)) {
      add(issues, "W19", "W19_QUALITY_SHAPE", unit, `处置方式 ${rule.disposition} 非法`)
    }

    const target = rule.target.trim()
    const parts = target.split(".")
    if (parts.length < 2 || parts.length > 3) {
      add(issues, "W20", "W20_QUALITY_TARGET", unit, `校验对象 ${target} 应为 库.表 或 库.表.字段`)
    } else {
      const [db, tableName, column] = parts
      const local = tableByName(tables, db, tableName)
      if (local) {
        if (column && !fieldExists(local, column)) {
          add(issues, "W20", "W20_QUALITY_TARGET", unit, `校验字段 ${target} 不在表 ${local.enName} 中`)
        }
      } else if (!hasTableEvidence(meta, db, tableName)) {
        add(issues, "W20", "W20_QUALITY_TARGET", unit, `校验对象 ${target} 没有 metadata 证据`)
      }
    }

    if (!/^[^=<>≥≤\s]{0,10}\s*(>=|<=|=|>|<|≥|≤)\s*\d+(\.\d+)?$/.test(rule.threshold.trim())) {
      add(issues, "W20", "W20_QUALITY_THRESHOLD", unit, `阈值 ${rule.threshold} 必须是 比较符+数值`)
    }

    if (rule.table && !tables.some((table) => tableFullName(table) === rule.table || table.enName === rule.table)) {
      add(issues, "W20", "W20_QUALITY_TARGET", unit, `规则所属表 ${rule.table} 不在设计中`)
    }
  }

  // W21 每张新建表至少 1 条规则
  for (const table of tables) {
    const full = tableFullName(table)
    const covered = rules.some((rule) => rule.table === full || rule.target.startsWith(`${full}.`) || rule.target === full)
    if (!covered) {
      add(issues, "W21", "W21_QUALITY_COVERAGE", `table:${table.enName}`, `表 ${full} 没有任何稽核规则`)
    }
  }

  return issues
}

// ── 全局图与覆盖 ────────────────────────────────────────────────────────
export function validateGraph(tables: TableDesign[], metrics: MetricDesign[], req: any, meta: MetaIndex): Issue[] {
  const issues: Issue[] = []
  const byFull = new Map(tables.map((table) => [lower(tableFullName(table)), table]))
  const edges = new Map<string, string[]>()

  for (const table of tables) {
    const key = lower(tableFullName(table))
    const ups: string[] = []
    const spec = LAYER_SPEC[table.layer]
    if (table.layer !== "ods" && table.upstream.length === 0) {
      add(issues, "W22", "W22_LINEAGE", `table:${table.enName}`, `非 ODS 表 ${table.enName} 必须声明上游表`)
    }
    for (const upstream of table.upstream) {
      const ref = parseRef(upstream)
      if (!ref) {
        add(issues, "W22", "W22_LINEAGE", `table:${table.enName}`, `上游 ${upstream} 不是 库.表`)
        continue
      }
      const upstreamTable = byFull.get(lower(`${ref.db}.${ref.table}`))
      if (upstreamTable) {
        ups.push(lower(tableFullName(upstreamTable)))
        if (!spec.upstream.includes(upstreamTable.layer)) {
          add(
            issues,
            "W22",
            "W22_LINEAGE",
            `table:${table.enName}`,
            `${table.layer} 层允许上游为 [${spec.upstream.join("/") || "源系统"}]，不能依赖 ${upstreamTable.layer} 表 ${upstreamTable.enName}`,
          )
        }
      } else if (!hasTableEvidence(meta, ref.db, ref.table)) {
        add(issues, "W05", "W05_META_UNVERIFIED", `table:${table.enName}`, `上游 ${upstream} 既不在设计中，也没有 metadata 证据`)
      }
    }
    edges.set(key, ups)
  }

  // 环检测（代码判定，不依赖模型）
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (node: string, path: string[]): boolean => {
    if (visiting.has(node)) {
      add(issues, "W22", "W22_LINEAGE", `table:${byFull.get(node)?.enName ?? node}`, `依赖成环：${[...path, node].join(" -> ")}`)
      return true
    }
    if (done.has(node)) return false
    visiting.add(node)
    for (const next of edges.get(node) ?? []) visit(next, [...path, node])
    visiting.delete(node)
    done.add(node)
    return false
  }
  for (const node of edges.keys()) visit(node, [])

  // W23 ADS 与场景覆盖
  const outputs: string[] = Array.isArray(req?.outputs) ? req.outputs.map((item: any) => String(item?.type ?? "")) : []
  if (outputs.length > 0 && !tables.some((table) => table.layer === "ads")) {
    add(issues, "W23", "W23_ADS_COVERAGE", "chapter:6", "需求第 6 章声明了数据输出方式，但设计中没有 ADS 表")
  }
  const scenes: string[] = Array.isArray(req?.scenes) ? req.scenes.map((item: any) => String(item?.name ?? "").trim()) : []
  for (const scene of scenes) {
    if (!scene) continue
    const covered = metrics.some((metric) => metric.meaning.includes(scene) || metric.name.includes(scene) || metric.expression.includes(scene))
    if (!covered) {
      add(issues, "W23", "W23_ADS_COVERAGE", `scene:${scene}`, `需求场景「${scene}」没有被任何指标覆盖（仅提示）`, "warning")
    }
  }

  return issues
}

// ── 反查索引 ────────────────────────────────────────────────────────────
export type TraceEntry = {
  code: string
  name: string
  domain: string
  table: string
  fields: string[]
  datasource: string
}

export function buildTrace(metrics: MetricDesign[]): TraceEntry[] {
  return metrics.map((metric) => {
    const sources = parseSources(metric.sources) ?? []
    const primary = sources[0]
    return {
      code: metric.code,
      name: metric.name,
      domain: metric.domain,
      table: primary ? `${primary.db}.${primary.table}` : "",
      fields: sources.flatMap((source) => source.columns.map((column) => `${source.db}.${source.table}:${column}`)),
      datasource: metric.datasource,
    }
  })
}

export function validateTrace(reqNames: string[], metrics: MetricDesign[], trace: TraceEntry[]): Issue[] {
  const issues: Issue[] = []
  const names = new Set(metrics.map((metric) => metric.name))
  for (const name of reqNames) {
    if (!names.has(name)) {
      add(issues, "W14", "W14_METRIC_COVERAGE", `metric:${name}`, `需求指标「${name}」在设计指标表中缺失`)
      continue
    }
    const entry = trace.find((item) => item.name === name)
    if (!entry || !entry.table || entry.fields.length === 0) {
      add(issues, "W25", "W25_TRACE_MISSING", `metric:${name}`, `指标「${name}」无法反查到表与字段`)
    }
  }
  return issues
}

/** 代码阶段：作业里的目标表/源表必须存在。 */
export function validateJobObjects(job: JobSpec, tables: TableDesign[], meta: MetaIndex): Issue[] {
  const issues: Issue[] = []
  const unit = `job:${job.name}`
  const known = (full: string): boolean => {
    const ref = parseRef(full)
    if (!ref) return false
    return Boolean(tableByName(tables, ref.db, ref.table)) || hasTableEvidence(meta, ref.db, ref.table)
  }
  if (!known(job.targetTable)) {
    add(issues, "W33", "W33_UNKNOWN_OBJECT", unit, `目标表 ${job.targetTable} 既不在设计中，也没有 metadata 证据`)
  }
  for (const source of job.sourceTables) {
    if (!known(source)) add(issues, "W33", "W33_UNKNOWN_OBJECT", unit, `源表 ${source} 既不在设计中，也没有 metadata 证据`)
  }
  return issues
}

export function targetTableOf(tables: TableDesign[], full: string): TableDesign | undefined {
  const ref = parseRef(full)
  if (!ref) return undefined
  return tableByName(tables, ref.db, ref.table)
}
