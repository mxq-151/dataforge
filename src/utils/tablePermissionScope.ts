/**
 * 库表授权「整库」语义。
 *
 * 后端把授权范围存成 `sys_table_permission.table_names`（逗号分隔的字符串），
 * `DataAccessPermissionService.matchesTablePermission` 对三种形态分别判定：
 *
 * - 空值            → 该库全部表可见
 * - 含 `*`          → 命中该库任意表（即「整库授权」）
 * - 具体表名列表    → 精确匹配
 *
 * 所以「整库」既不需要前端枚举所有表名，也不需要后端改动：把 `table_names` 写成 `*` 即可。
 * 本模块把这条约定收敛到一处，供表单校验、编辑回显、列表展示复用，避免各处再各写一遍判断。
 */

/** 整库授权在 `table_names` 中的占位取值，必须与后端 `parseTableNames` 的口径一致。 */
export const WHOLE_DATABASE_TABLE = '*';

/** `tableNames` 是否表示整库授权。 */
export function isWholeDatabaseSelection(
  tableNames: readonly string[] | null | undefined,
): boolean {
  if (!tableNames || tableNames.length === 0) return false;
  return tableNames.some((name) => typeof name === 'string' && name.trim() === WHOLE_DATABASE_TABLE);
}

/** 整库授权对应的 `tableNames` 取值。 */
export function wholeDatabaseSelection(): string[] {
  return [WHOLE_DATABASE_TABLE];
}

/**
 * 该权限范围是否允许整库授权。
 *
 * 只有「整表」（scope = 1）可以：列白名单（scope 2/4）与行过滤 SQL（scope 3/4）都是按
 * **真实表名**写进 `sys_table_permission_column` / `sys_table_permission_row`，
 * 匹配时用真实表名反查（`selectByPermissionIdAndTable`），存 `*` 永远命中不了。
 */
export function supportsWholeDatabase(permissionScope: number | null | undefined): boolean {
  return permissionScope === 1;
}

/** 剔除整库占位符，只保留可参与列/行配置的具体表名。 */
export function splitPerTableNames(tableNames: readonly string[] | null | undefined): string[] {
  if (!tableNames) return [];
  return tableNames.filter((name) => name !== WHOLE_DATABASE_TABLE);
}

/** 列表/回显用的表名展示文案：整库显示「全部表（整库）」，其余用顿号连接。 */
export function describeTableSelection(tableNames: readonly string[] | null | undefined): string {
  if (isWholeDatabaseSelection(tableNames)) return '全部表（整库）';
  return (tableNames ?? []).filter(Boolean).join('、');
}

/**
 * 提交前的「授权范围」校验。
 *
 * 只覆盖与授权范围本身有关的规则；列白名单逐表非空、行过滤 SQL 语法这两条仍由调用方
 * 各自校验（它们需要按表给出定位到具体输入框的错误）。
 *
 * @returns 通过返回 `null`，否则返回给用户看的提示文案。
 */
export function validateTableSelection(params: {
  permissionScope: number | null | undefined;
  tableNames: readonly string[] | null | undefined;
}): string | null {
  const names = params.tableNames ?? [];
  if (names.length === 0) return '请选择库表';
  if (isWholeDatabaseSelection(names) && !supportsWholeDatabase(params.permissionScope)) {
    return '「指定字段」「指定行」「组合」权限范围不支持整库授权，请逐张选择库表';
  }
  return null;
}

/**
 * 权限范围切换后规整选中的库表。
 *
 * 从「整表」的整库授权切到需要逐表配置的范围时，`*` 已经不可能命中任何列/行子表配置，
 * 因此直接清空选择，让用户重新挑表，而不是留下一个配不出列/行规则的占位符。
 */
export function normalizeScopeSelection(params: {
  permissionScope: number | null | undefined;
  tableNames: readonly string[] | null | undefined;
  tableMetadataIds?: readonly number[] | null;
}): { tableNames: string[]; tableMetadataIds: number[] } {
  if (!supportsWholeDatabase(params.permissionScope) && isWholeDatabaseSelection(params.tableNames)) {
    return { tableNames: [], tableMetadataIds: [] };
  }
  return {
    tableNames: [...(params.tableNames ?? [])],
    tableMetadataIds: [...(params.tableMetadataIds ?? [])],
  };
}
