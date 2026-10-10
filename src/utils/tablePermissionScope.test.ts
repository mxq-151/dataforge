import { describe, it, expect } from 'vitest';
import {
  WHOLE_DATABASE_TABLE,
  isWholeDatabaseSelection,
  wholeDatabaseSelection,
  supportsWholeDatabase,
  splitPerTableNames,
  describeTableSelection,
  validateTableSelection,
  normalizeScopeSelection,
} from './tablePermissionScope';

/**
 * 库表授权「整库」语义测试。
 *
 * 这层约定的唯一真值在后端 `DataAccessPermissionService.matchesTablePermission`
 * （空值=整库可见 / 含 `*`=命中任意表），前端只要保证「写进去的 `*` 与后端认的一致」
 * 以及「不让 `*` 溜进需要逐表配置的权限范围」即可。
 */
describe('isWholeDatabaseSelection', () => {
  it('识别单独一个 *', () => {
    expect(isWholeDatabaseSelection(['*'])).toBe(true);
  });

  it('忽略首尾空白', () => {
    expect(isWholeDatabaseSelection([' * '])).toBe(true);
  });

  it('混在具体表名里也算整库', () => {
    expect(isWholeDatabaseSelection(['ods_user', '*'])).toBe(true);
  });

  it('空数组、null、undefined 都不算整库', () => {
    expect(isWholeDatabaseSelection([])).toBe(false);
    expect(isWholeDatabaseSelection(null)).toBe(false);
    expect(isWholeDatabaseSelection(undefined)).toBe(false);
  });

  it('不把表名里含 * 的通配写法误判为整库占位符', () => {
    expect(isWholeDatabaseSelection(['ods_*'])).toBe(false);
    expect(isWholeDatabaseSelection(['**'])).toBe(false);
  });
});

describe('wholeDatabaseSelection', () => {
  it('返回后端可识别的整库占位取值', () => {
    expect(wholeDatabaseSelection()).toEqual([WHOLE_DATABASE_TABLE]);
    expect(WHOLE_DATABASE_TABLE).toBe('*');
  });
});

describe('supportsWholeDatabase', () => {
  it('只有「整表」(1) 支持整库授权', () => {
    expect(supportsWholeDatabase(1)).toBe(true);
  });

  it('指定字段/指定行/组合都不支持', () => {
    expect(supportsWholeDatabase(2)).toBe(false);
    expect(supportsWholeDatabase(3)).toBe(false);
    expect(supportsWholeDatabase(4)).toBe(false);
  });

  it('缺省值不视为支持', () => {
    expect(supportsWholeDatabase(null)).toBe(false);
    expect(supportsWholeDatabase(undefined)).toBe(false);
  });
});

describe('splitPerTableNames', () => {
  it('剔除整库占位符，保留真实表名', () => {
    expect(splitPerTableNames(['*'])).toEqual([]);
    expect(splitPerTableNames(['ods_user', '*', 'ods_order'])).toEqual(['ods_user', 'ods_order']);
  });

  it('空值返回空数组', () => {
    expect(splitPerTableNames(null)).toEqual([]);
    expect(splitPerTableNames(undefined)).toEqual([]);
  });
});

describe('describeTableSelection', () => {
  it('整库显示「全部表（整库）」', () => {
    expect(describeTableSelection(['*'])).toBe('全部表（整库）');
  });

  it('逐表授权用顿号连接', () => {
    expect(describeTableSelection(['ods_user', 'ods_order'])).toBe('ods_user、ods_order');
  });
});

describe('validateTableSelection', () => {
  it('未选择任何库表时提示选择', () => {
    expect(validateTableSelection({ permissionScope: 1, tableNames: [] })).toBe('请选择库表');
  });

  it('整表 + 整库授权通过', () => {
    expect(validateTableSelection({ permissionScope: 1, tableNames: ['*'] })).toBeNull();
  });

  it('整表 + 逐表授权通过', () => {
    expect(validateTableSelection({ permissionScope: 1, tableNames: ['ods_user'] })).toBeNull();
  });

  it('指定字段/指定行/组合 配整库授权被拒绝', () => {
    for (const scope of [2, 3, 4]) {
      const message = validateTableSelection({ permissionScope: scope, tableNames: ['*'] });
      expect(message).toContain('不支持整库授权');
    }
  });

  it('指定字段 + 逐表授权通过（逐表非空由调用方另行校验）', () => {
    expect(validateTableSelection({ permissionScope: 2, tableNames: ['ods_user'] })).toBeNull();
  });
});

describe('normalizeScopeSelection', () => {
  it('从整库切到指定字段时清空选择，避免留下配不出列的占位符', () => {
    expect(
      normalizeScopeSelection({ permissionScope: 2, tableNames: ['*'], tableMetadataIds: [] }),
    ).toEqual({ tableNames: [], tableMetadataIds: [] });
  });

  it('保留「整表」范围内的整库选择', () => {
    expect(
      normalizeScopeSelection({ permissionScope: 1, tableNames: ['*'], tableMetadataIds: [] }),
    ).toEqual({ tableNames: ['*'], tableMetadataIds: [] });
  });

  it('逐表授权原样保留表名与元数据 id', () => {
    expect(
      normalizeScopeSelection({
        permissionScope: 2,
        tableNames: ['ods_user'],
        tableMetadataIds: [11],
      }),
    ).toEqual({ tableNames: ['ods_user'], tableMetadataIds: [11] });
  });

  it('输入为 null 时返回空数组而不是抛错', () => {
    expect(normalizeScopeSelection({ permissionScope: 1, tableNames: null })).toEqual({
      tableNames: [],
      tableMetadataIds: [],
    });
  });
});
