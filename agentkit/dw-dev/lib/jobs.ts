/**
 * 作业命名与依赖推导（唯一实现）。
 *
 * 设计文档第 7 章与 dw-extract-design 都从这里取作业名，避免「文档写一套、工具算一套」。
 * 作业名由目标表推导：{分层}_{业务域}_{实体}_{操作}_{周期}；表名严格四段，所以实体就是第 3 段。
 * 依赖只表达到作业名这一层；调度项目名前缀由平台在调度接入阶段生成，设计阶段不定义。
 */
import {
  type Layer,
  type QualityRuleDesign,
  type TableDesign,
  tableFullName,
} from "./constants"

export type JobPlan = {
  name: string
  layer: Layer
  domain: string
  entity: string
  op: string
  cycle: string
  filePath: string
  targetTable: string
  sourceTables: string[]
  dependencies: string[]
  isCheck: boolean
}

/**
 * 表名分段。临时表首段是 `tmp`，只表达临时性，不参与分层判定；
 * `layer` 一律取表设计声明的真实分层，作业目录也按它落。
 */
export function tableSegments(table: TableDesign): {
  /** 表名首段：正式表为真实分层，临时表为 tmp */
  namePrefix: string
  /** 真实分层，用于作业 layer 与 sql|code/{layer} 目录 */
  layer: string
  domain: string
  entity: string
  cycle: string
} {
  const parts = table.enName.split("_")
  const isTemp = table.tableType === "临时表" || parts[0] === "tmp"
  return {
    namePrefix: isTemp ? "tmp" : parts[0] ?? table.layer,
    layer: table.layer,
    domain: parts[1] ?? table.domain,
    entity: parts[2] ?? "data",
    cycle: parts[3] ?? "d",
  }
}

export function opOfLayer(layer: Layer): string {
  if (layer === "ods") return "load"
  if (layer === "dws" || layer === "ads") return "calc"
  return "etl"
}

export function jobNameOf(table: TableDesign, op = opOfLayer(table.layer)): string {
  const { namePrefix, domain, entity, cycle } = tableSegments(table)
  return `${namePrefix}_${domain}_${entity}_${op}_${cycle}`
}

export function tableHasRules(table: TableDesign, rules: QualityRuleDesign[]): boolean {
  const full = tableFullName(table)
  return rules.some((rule) => rule.table === full || rule.target.startsWith(`${full}.`))
}

/**
 * 一个目标表一个处理作业；有稽核规则的表再加一个质检作业。
 * 处理作业依赖设计内的上游表作业（源系统无作业，不产生依赖）。
 */
export function deriveJobPlan(tables: TableDesign[], rules: QualityRuleDesign[]): JobPlan[] {
  const byFull = new Map(tables.map((table) => [tableFullName(table).toLowerCase(), table]))
  const plans: JobPlan[] = []

  for (const table of tables) {
    const { namePrefix, layer, domain, entity, cycle } = tableSegments(table)
    const op = opOfLayer(table.layer)
    const name = jobNameOf(table, op)
    const dependencies: string[] = []
    for (const upstream of table.upstream) {
      const target = byFull.get(upstream.toLowerCase())
      if (!target) continue
      dependencies.push(jobNameOf(target))
    }
    plans.push({
      name,
      layer: table.layer,
      domain,
      entity,
      op,
      cycle,
      filePath: `sql/${table.layer}/${name}.sql`,
      targetTable: tableFullName(table),
      sourceTables: table.upstream,
      dependencies: [...new Set(dependencies)],
      isCheck: false,
    })

    if (tableHasRules(table, rules)) {
      const checkName = `${namePrefix}_${domain}_${entity}_check_${cycle}`
      plans.push({
        name: checkName,
        layer: table.layer,
        domain,
        entity,
        op: "check",
        cycle,
        filePath: `sql/${table.layer}/${checkName}.sql`,
        targetTable: tableFullName(table),
        sourceTables: [tableFullName(table)],
        dependencies: [name],
        isCheck: true,
      })
    }
  }
  return plans
}
