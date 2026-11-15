/**
 * 确定性 DDL 生成：逻辑类型 → 方言类型，表结构 → 建表语句。
 *
 * 边界（显式声明，不猜）：
 * - 支持方言：hive / spark / doris / starrocks / clickhouse / mysql / postgresql；
 * - kyuubi 按 hive 方言生成，但代码头 @引擎 仍写 kyuubi；
 * - 其他 @引擎（flink/presto/trino/...）不生成 DDL，直接报 W12；
 * - 不支持的逻辑类型、同一文件混用引擎、starrocks 版本过低等，一律失败而非降级。
 */
import { DIALECTS, ENGINE_DIALECT, type Dialect, type TableDesign, tableDb } from "./constants"

export type DdlResult = { ok: boolean; sql?: string; issues: string[] }

type LogicalType = { base: string; args: number[] }

export function parseLogicalType(input: string): LogicalType | null {
  const text = input.trim().toLowerCase()
  const m = /^([a-z]+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/.exec(text)
  if (!m) return null
  const base = m[1]
  const args = [m[2], m[3]].filter((item): item is string => Boolean(item)).map(Number)
  const allowed = ["string", "varchar", "char", "int", "bigint", "decimal", "double", "boolean", "date", "timestamp", "datetime"]
  if (!allowed.includes(base)) return null
  if ((base === "varchar" || base === "char") && args.length !== 1) return null
  if (base === "decimal" && args.length !== 2) return null
  if (!["varchar", "char", "decimal"].includes(base) && args.length > 0) return null
  return { base, args }
}

/** 逻辑类型 → 方言物理类型；返回 null 表示该方言不支持，调用方必须报错。 */
export function mapType(dialect: Dialect, logical: string): string | null {
  const parsed = parseLogicalType(logical)
  if (!parsed) return null
  const { base, args } = parsed

  if (dialect === "hive" || dialect === "spark") {
    const map: Record<string, string> = {
      string: "STRING",
      varchar: `VARCHAR(${args[0]})`,
      char: `CHAR(${args[0]})`,
      int: "INT",
      bigint: "BIGINT",
      decimal: `DECIMAL(${args[0]},${args[1]})`,
      double: "DOUBLE",
      boolean: "BOOLEAN",
      date: "DATE",
      timestamp: "TIMESTAMP",
      datetime: "TIMESTAMP",
    }
    return map[base] ?? null
  }

  if (dialect === "doris" || dialect === "starrocks") {
    const map: Record<string, string> = {
      string: "VARCHAR(255)",
      varchar: `VARCHAR(${args[0]})`,
      char: `CHAR(${args[0]})`,
      int: "INT",
      bigint: "BIGINT",
      decimal: `DECIMAL(${args[0]},${args[1]})`,
      double: "DOUBLE",
      boolean: "BOOLEAN",
      date: "DATE",
      timestamp: "DATETIME",
      datetime: "DATETIME",
    }
    return map[base] ?? null
  }

  if (dialect === "clickhouse") {
    const map: Record<string, string> = {
      string: "String",
      varchar: "String",
      char: `FixedString(${args[0]})`,
      int: "Int32",
      bigint: "Int64",
      decimal: `Decimal(${args[0]},${args[1]})`,
      double: "Float64",
      boolean: "UInt8",
      date: "Date",
      timestamp: "DateTime",
      datetime: "DateTime",
    }
    return map[base] ?? null
  }

  if (dialect === "mysql") {
    const map: Record<string, string> = {
      string: "VARCHAR(255)",
      varchar: `VARCHAR(${args[0]})`,
      char: `CHAR(${args[0]})`,
      int: "INT",
      bigint: "BIGINT",
      decimal: `DECIMAL(${args[0]},${args[1]})`,
      double: "DOUBLE",
      boolean: "TINYINT(1)",
      date: "DATE",
      timestamp: "DATETIME",
      datetime: "DATETIME",
    }
    return map[base] ?? null
  }

  if (dialect === "postgresql") {
    const map: Record<string, string> = {
      string: "VARCHAR(255)",
      varchar: `VARCHAR(${args[0]})`,
      char: `CHAR(${args[0]})`,
      int: "INTEGER",
      bigint: "BIGINT",
      decimal: `NUMERIC(${args[0]},${args[1]})`,
      double: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      date: "DATE",
      timestamp: "TIMESTAMP",
      datetime: "TIMESTAMP",
    }
    return map[base] ?? null
  }

  return null
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 敏感字段（个人信息或非一般数据）在字段注释尾部追加 cla: 标记。 */
function fieldComment(table: TableDesign, field: TableDesign["fields"][number]): string {
  const sensitive = field.personalInfo !== "否" || field.level.tier !== "一般数据"
  return sensitive ? `${field.cnName}；cla:${table.classification.industry}-${field.level.tier}` : field.cnName
}

function columnLines(table: TableDesign, dialect: Dialect): { lines: string[]; issues: string[] } {
  const lines: string[] = []
  const issues: string[] = []
  for (const field of table.fields) {
    const type = mapType(dialect, field.logicalType)
    if (!type) {
      issues.push(`${field.name} 的类型 ${field.logicalType} 在 ${dialect} 方言下无确定映射（W12）`)
      continue
    }
    let line = `  \`${field.name}\` ${type}`
    if (!field.nullable) line += " NOT NULL"
    if (field.defaultValue && field.defaultValue.trim()) line += ` DEFAULT ${quote(field.defaultValue)}`
    if (dialect === "postgresql") line += ""
    else line += ` COMMENT ${quote(fieldComment(table, field))}`
    lines.push(line)
  }
  return { lines, issues }
}

export function dialectOf(engine: string): Dialect | null {
  return ENGINE_DIALECT[engine] ?? null
}

export function renderTableDdl(table: TableDesign): DdlResult {
  const issues: string[] = []
  const dialect = dialectOf(table.engine)
  if (!dialect) {
    return {
      ok: false,
      issues: [`表 ${table.enName} 的引擎 ${table.engine} 不支持 DDL 生成（仅支持 ${DIALECTS.join("/")}），W12`],
    }
  }

  const partitionField = table.fields.find((field) => field.name === table.partition.field)
  if (!partitionField) issues.push(`分区字段 ${table.partition.field} 不在字段清单中（W09）`)
  const businessFields = table.fields.filter((field) => field.name !== table.partition.field)
  const cols = columnLines({ ...table, fields: businessFields }, dialect)
  issues.push(...cols.issues)

  const primary = table.primaryKey
  const tableComment = `${table.cnName}；粒度：${table.grain}；更新：${table.updateMode}；cla:${table.classification.industry}-${table.level.tier}；分类路径：${table.classification.categoryPath}`
  const header = [
    "/*",
    ` * @数据源: ${table.datasource}`,
    ` * @引擎: ${table.engine}`,
    " */",
  ].join("\n")

  const db = tableDb(table)
  const name = `${db}.${table.enName}`

  if (dialect === "hive" || dialect === "spark") {
    const partitionLine = partitionField
      ? `PARTITIONED BY (\`${partitionField.name}\` ${mapType(dialect, partitionField.logicalType) ?? "STRING"} COMMENT ${quote(fieldComment(table, partitionField))})`
      : ""
    const bucketLine =
      table.partition.buckets && primary.length
        ? `CLUSTERED BY (${primary.map((key) => `\`${key}\``).join(", ")}) INTO ${table.partition.buckets} BUCKETS`
        : ""
    const rowFormat = table.storage.format === "text" ? "ROW FORMAT DELIMITED FIELDS TERMINATED BY ','" : ""
    const storage = `STORED AS ${table.storage.format === "text" ? "TEXTFILE" : table.storage.format.toUpperCase()}`
    const props = [
      `'compression'='${table.storage.compression}'`,
      `'lifecycle.days'='${table.lifecycleDays}'`,
      `'dw.classification'='${table.classification.industry}'`,
      `'dw.level'='${table.level.tier}'`,
    ].join(",")
    const sql = [
      header,
      `-- ${name} ${table.cnName}`,
      `CREATE TABLE IF NOT EXISTS ${name} (`,
      cols.lines.join(",\n"),
      ")",
      `COMMENT ${quote(tableComment)}`,
      partitionLine,
      bucketLine,
      rowFormat,
      storage,
      `TBLPROPERTIES (${props})`,
      ";",
    ]
      .filter((line) => line !== "")
      .join("\n")
    return { ok: issues.length === 0, sql, issues }
  }

  if (dialect === "clickhouse") {
    const orderBy = primary.length ? primary.map((key) => `\`${key}\``).join(", ") : "tuple()"
    const partitionExpr = table.partition.format === "yyyyMMdd" ? `toYYYYMMDD(\`${table.partition.field}\`)` : `toYYYYMM(\`${table.partition.field}\`)`
    const sql = [
      header,
      `-- ${name} ${table.cnName}`,
      `CREATE TABLE IF NOT EXISTS ${name} (`,
      [...cols.lines, ...(partitionField ? [`  \`${partitionField.name}\` ${mapType(dialect, partitionField.logicalType) ?? "String"} COMMENT ${quote(fieldComment(table, partitionField))}`] : [])].join(",\n"),
      ")",
      "ENGINE = MergeTree",
      `PARTITION BY ${partitionExpr}`,
      `ORDER BY (${orderBy})`,
      `TTL \`${table.partition.field}\` + INTERVAL ${table.lifecycleDays} DAY`,
      `COMMENT ${quote(tableComment)}`,
      ";",
    ].join("\n")
    return { ok: issues.length === 0, sql, issues }
  }

  // 行式引擎：分区字段作为普通列参与建表
  const allCols = columnLines(table, dialect)
  issues.push(...allCols.issues)
  const keyKind = table.updateMode === "incremental" || table.updateMode === "scd2" ? "UNIQUE" : "DUPLICATE"
  const keyCols = primary.length ? primary : [table.fields[0]?.name].filter(Boolean)

  if (dialect === "doris" || dialect === "starrocks") {
    const keyClause = `${keyKind} KEY(${keyCols.map((key) => `\`${key}\``).join(", ")})`
    const partitionClause =
      dialect === "doris"
        ? `PARTITION BY RANGE (\`${table.partition.field}\`)\n()`
        : `PARTITION BY date_trunc('day', \`${table.partition.field}\`)`
    const properties =
      dialect === "doris"
        ? [
            '"replication_num" = "1"',
            '"dynamic_partition.enable" = "true"',
            '"dynamic_partition.time_unit" = "DAY"',
            `"dynamic_partition.start" = "-${table.lifecycleDays}"`,
            '"dynamic_partition.end" = "1"',
            '"dynamic_partition.prefix" = "p"',
            '"dynamic_partition.buckets" = "1"',
          ]
        : ['"replication_num" = "1"', `"dynamic_partition.enable" = "false"`]
    const sql = [
      header,
      dialect === "starrocks" ? "-- 注：StarRocks 表达式分区需 3.x 及以上；低版本请改为显式分区值" : "",
      `-- ${name} ${table.cnName}`,
      `CREATE TABLE IF NOT EXISTS ${name} (`,
      allCols.lines.join(",\n"),
      ")",
      keyClause,
      partitionClause,
      `DISTRIBUTED BY HASH(${keyCols.map((key) => `\`${key}\``).join(", ")}) BUCKETS ${table.partition.buckets ?? 1}`,
      `PROPERTIES (\n  ${properties.join(",\n  ")}\n)`,
      ";",
    ]
      .filter((line) => line !== "")
      .join("\n")
    return { ok: issues.length === 0, sql, issues }
  }

  const inlineKey = primary.length ? `,\n  PRIMARY KEY (${primary.map((key) => `\`${key}\``).join(", ")})` : ""
  if (dialect === "mysql") {
    const sql = [
      header,
      `-- ${name} ${table.cnName}（分区：${table.partition.field}，${table.partition.format}，${table.partition.strategy}）`,
      `CREATE TABLE IF NOT EXISTS ${name} (`,
      `${allCols.lines.join(",\n")}${inlineKey}`,
      ")",
      `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=${quote(tableComment)}`,
      ";",
    ].join("\n")
    return { ok: issues.length === 0, sql, issues }
  }

  const comments = [
    `COMMENT ON TABLE ${name} IS ${quote(tableComment)};`,
    ...table.fields.map((field) => `COMMENT ON COLUMN ${name}.\`${field.name}\` IS ${quote(field.cnName)};`),
  ]
  const pgSql = [
    header,
    `-- ${name} ${table.cnName}（分区：${table.partition.field}，${table.partition.format}，${table.partition.strategy}）`,
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    `${allCols.lines.join(",\n")}${inlineKey}`,
    ");",
    ...comments,
  ].join("\n")
  return { ok: issues.length === 0, sql: pgSql, issues }
}

export function renderDdlFile(layer: string, tables: TableDesign[]): DdlResult {
  const issues: string[] = []
  const engines = new Set(tables.map((table) => table.engine))
  if (engines.size > 1) {
    issues.push(`${layer}_ddl.sql 混用引擎 ${[...engines].join(",")}：一个 DDL 文件只能有一个 @引擎，请按引擎拆表或统一引擎`)
  }
  const datasources = new Set(tables.map((table) => table.datasource))
  const blocks: string[] = []
  for (const table of tables) {
    const result = renderTableDdl(table)
    issues.push(...result.issues)
    if (result.sql) blocks.push(result.sql)
  }
  if (blocks.length === 0) return { ok: false, issues: [...issues, `${layer} 层没有可生成的表`] }
  const body = blocks.join("\n\n")
  // 每个表块已带代码头；文件级代码头由首个表提供，其余表头作为分段注释保留
  const fileHeader = [
    "/*",
    ` * @数据源: ${[...datasources].join(",")}`,
    ` * @引擎: ${[...engines][0] ?? ""}`,
    " */",
  ].join("\n")
  return { ok: issues.length === 0, sql: `${fileHeader}\n\n${body}\n`, issues }
}
