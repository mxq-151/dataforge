/**
 * extractMetrics.test.ts — 指标提取逻辑测试
 *
 * 测试覆盖两种提示词规范的表格格式（见 src/hooks/opencode/opencodeInstructions.ts）：
 * - 8 列数仓设计文档格式（数据架构师，含数据源列）
 * - 4 列业务需求文档格式（业务需求方）
 * 以及章节提取、列识别（含"指定含义"/"指标编码"修复）、模糊匹配、兜底拼接等。
 */

import { describe, it, expect } from 'vitest';
import {
  extractSection,
  parseMarkdownTables,
  findColumn,
  extractMetricsFromMarkdown,
  expandCalcExpr,
  expandCalcExprBatch,
  parseFieldSource,
} from './extractMetrics';

// ── 8 列数仓设计文档（数据架构师）──────────────────────────────

const DESIGN_DOC_8COL = `# 用户域数仓设计

## 技术架构说明
略

## 数据指标

| 指标编码 | 指标名称 | 主题域 | 指定含义 | 计算表达式 | 过滤条件 | 字段来源 | 数据源 |
|--------|------|----------|------------|----------|----------|----------|----------|
| USR_0001 | 日活用户数 | 用户域 | 统计当日活跃的去重用户数 | count(distinct user_id) | status=1 且 channel in ('app','web') | ods_user.login:user_id,login_time | test_dbs |
| USR_0002 | 新增用户数 | 用户域 | 当日新增注册用户数 | count(distinct user_id) | | dws_user.register:user_id | test_dbs |

## 分层库表设计
略
`;

// ── 4 列业务需求文档（业务需求方）──────────────────────────────

const BUSINESS_DOC_4COL = `# 用户增长业务需求

## 数据源定义
略

## 数据指标

| 业务定义 | 计算口径 | 过滤条件 | 应用场景 |
|----------|----------|----------|----------|
| 当日活跃的去重用户数 | 登录且产生有效行为的用户去重计数 | 仅统计正式渠道的活跃用户 | 日常运营日报 |
| 当日新增注册用户数 | 当日完成注册的用户去重计数 | | 增长趋势分析 |

## 注意事项
略
`;

describe('extractMetricsFromMarkdown — 8 列数仓设计文档', () => {
  it('提取指标并正确映射 8 列字段（含字段来源与数据源解析）', () => {
    const result = extractMetricsFromMarkdown(DESIGN_DOC_8COL, 'USR');
    expect(result).toHaveLength(2);

    const [ind1, ind2] = result;

    // 指标编码 → code
    expect(ind1.code).toBe('USR_0001');
    // 指标名称 → name
    expect(ind1.name).toBe('日活用户数');
    // 主题域 → topic
    expect(ind1.topic).toBe('用户域');
    // 指定含义 → businessDefinition（作为业务含义主体）
    expect(ind1.businessDefinition).toContain('统计当日活跃的去重用户数');
    // 计算表达式 → calcExpr（独立字段，不再拼入 businessDefinition）
    expect(ind1.calcExpr).toBe('count(distinct user_id)');
    expect(ind1.businessDefinition).not.toContain('计算表达式');
    // 过滤条件 → defaultFilter
    expect(ind1.defaultFilter).toBe("status=1 且 channel in ('app','web')");
    // projectCode 取传入的项目编码
    expect(ind1.projectCode).toBe('USR');
    // 字段来源 → fields，数据源 → 每个字段的 datasourceName
    expect(ind1.fields).toHaveLength(2);
    expect(ind1.fields![0]).toEqual({
      datasourceName: 'test_dbs', dbName: 'ods_user', tblName: 'login', fieldName: 'user_id', fieldType: '',
    });
    expect(ind1.fields![1]).toEqual({
      datasourceName: 'test_dbs', dbName: 'ods_user', tblName: 'login', fieldName: 'login_time', fieldType: '',
    });

    // 第二行过滤条件为空 → defaultFilter 为 undefined
    expect(ind2.code).toBe('USR_0002');
    expect(ind2.name).toBe('新增用户数');
    expect(ind2.defaultFilter).toBeUndefined();
    // 第二行字段来源只有一个字段，数据源同样写入
    expect(ind2.fields).toHaveLength(1);
    expect(ind2.fields![0]).toEqual({
      datasourceName: 'test_dbs', dbName: 'dws_user', tblName: 'register', fieldName: 'user_id', fieldType: '',
    });
  });

  it('指标编码不污染 businessDefinition（修复回归）', () => {
    const result = extractMetricsFromMarkdown(DESIGN_DOC_8COL, 'USR');
    // 指标编码应映射到 alias，不应作为兜底 "指标编码: ..." 拼入 businessDefinition
    expect(result[0].businessDefinition).not.toContain('指标编码');
    expect(result[0].businessDefinition).not.toContain('USR_0001');
  });

  it('"指定含义"列被识别为业务含义（修复回归）', () => {
    const result = extractMetricsFromMarkdown(DESIGN_DOC_8COL, 'USR');
    // "指定含义"的内容应作为 businessDefinition 主体（非"指定含义: xxx"前缀兜底）
    expect(result[0].businessDefinition).toContain('统计当日活跃的去重用户数');
    expect(result[0].businessDefinition).not.toMatch(/^指定含义:/);
  });

  it('章节在下一个二级标题处终止，不越界提取', () => {
    const result = extractMetricsFromMarkdown(DESIGN_DOC_8COL, 'USR');
    // "分层库表设计"章节内容不应被纳入
    expect(result).toHaveLength(2);
  });

  it('数据源列的值写入每个字段的 datasourceName', () => {
    const result = extractMetricsFromMarkdown(DESIGN_DOC_8COL, 'USR');
    expect(result[0].fields).toHaveLength(2);
    // 两个字段均携带数据源名称
    expect(result[0].fields!.every(f => f.datasourceName === 'test_dbs')).toBe(true);
  });

  it('旧文档无"数据源"列时 datasourceName 为空串（向后兼容）', () => {
    const doc = `# 文档

## 数据指标

| 指标编码 | 指标名称 | 主题域 | 指定含义 | 计算表达式 | 过滤条件 | 字段来源 |
|--------|------|----------|------------|----------|----------|----------|
| A_0001 | 指标A | 域A | 含义A | exprA | | db.tbl:field1 |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].fields).toHaveLength(1);
    expect(result[0].fields![0].datasourceName).toBe('');
  });
});

describe('extractMetricsFromMarkdown — 4 列业务需求文档', () => {
  it('无"指标名"列时以"业务定义"作为指标名', () => {
    const result = extractMetricsFromMarkdown(BUSINESS_DOC_4COL, 'BIZ');
    expect(result).toHaveLength(2);

    const [ind1, ind2] = result;
    // 业务定义 → name
    expect(ind1.name).toBe('当日活跃的去重用户数');
    // 计算口径 → calcExpr（独立字段，不再拼入 businessDefinition）
    expect(ind1.calcExpr).toBe('登录且产生有效行为的用户去重计数');
    expect(ind1.businessDefinition).not.toContain('计算口径');
    // 应用场景 → 拼入 businessDefinition
    expect(ind1.businessDefinition).toContain('应用场景: 日常运营日报');
    // 过滤条件 → defaultFilter（业务语言）
    expect(ind1.defaultFilter).toBe('仅统计正式渠道的活跃用户');
    // 4 列格式无指标编码 → code 为 undefined
    expect(ind1.code).toBeUndefined();
    // 无主题域列 → 默认"未分类"
    expect(ind1.topic).toBe('未分类');

    // 第二行过滤条件为空
    expect(ind2.defaultFilter).toBeUndefined();
    expect(ind2.businessDefinition).toContain('应用场景: 增长趋势分析');
  });

  it('过长的业务定义作为名称时会被截断', () => {
    const longDef = '当日活跃的去重用户数'.repeat(20);
    const doc = `# 文档

## 数据指标

| 业务定义 | 计算口径 | 过滤条件 | 应用场景 |
|----------|----------|----------|----------|
| ${longDef} | 口径A | | 场景A |
`;
    const result = extractMetricsFromMarkdown(doc, 'BIZ');
    expect(result).toHaveLength(1);
    expect(result[0].name.length).toBeLessThanOrEqual(63); // 60 + "..."
    expect(result[0].name.endsWith('...')).toBe(true);
    // businessDefinition 仍保留完整业务定义
    expect(result[0].businessDefinition).toContain(longDef);
  });
});

describe('extractMetricsFromMarkdown — 边界与异常', () => {
  it('无"数据指标"章节返回空数组', () => {
    const doc = `# 文档\n\n## 其他章节\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    expect(extractMetricsFromMarkdown(doc, 'P')).toEqual([]);
  });

  it('章节存在但表格无"指标名"和"业务定义"列时跳过', () => {
    const doc = `# 文档\n\n## 数据指标\n\n| 字段 | 说明 |\n|---|---|\n| a | b |\n`;
    expect(extractMetricsFromMarkdown(doc, 'P')).toEqual([]);
  });

  it('章节内含多张表格均被解析', () => {
    const doc = `# 文档

## 数据指标

| 指标编码 | 指标名称 | 主题域 | 指定含义 | 计算表达式 | 过滤条件 | 字段来源 |
|--------|------|----------|------------|----------|----------|----------|
| A_0001 | 指标A | 域A | 含义A | exprA | | |

| 指标编码 | 指标名称 | 主题域 | 指定含义 | 计算表达式 | 过滤条件 | 字段来源 |
|--------|------|----------|------------|----------|----------|----------|
| B_0001 | 指标B | 域B | 含义B | exprB | | |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('指标A');
    expect(result[1].name).toBe('指标B');
  });

  it('支持三级标题下的数据指标章节（不与二级标题混用）', () => {
    const doc = `# 文档

### 数据指标

| 业务定义 | 计算口径 | 过滤条件 | 应用场景 |
|----------|----------|----------|----------|
| 指标X | 口径X | | 场景X |

## 其他
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('指标X');
  });

  it('模糊匹配非标准列名（业务说明 / 计算公式 / 筛选条件）', () => {
    const doc = `# 文档

## 数据指标

| 指标名 | 主题域 | 业务说明 | 计算公式 | 筛选条件 |
|--------|------|----------|----------|----------|
| 指标Y | 域Y | 说明Y | 公式Y | 条件Y |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('指标Y');
    expect(result[0].topic).toBe('域Y');
    expect(result[0].businessDefinition).toContain('说明Y');
    expect(result[0].calcExpr).toBe('公式Y');
    expect(result[0].businessDefinition).not.toContain('计算公式');
    expect(result[0].defaultFilter).toBe('条件Y');
  });

  it('未识别列按"列名: 值"兜底拼入业务定义', () => {
    const doc = `# 文档

## 数据指标

| 指标名称 | 备注 |
|--------|------|
| 指标Z | 备注Z |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('指标Z');
    expect(result[0].businessDefinition).toContain('备注: 备注Z');
  });

  it('名称为空的行被跳过', () => {
    const doc = `# 文档

## 数据指标

| 指标名称 | 主题域 |
|--------|------|
|  | 域A |
| 指标B | 域B |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('指标B');
  });
});

// ── 纯函数单元测试 ──────────────────────────────────────────

describe('extractSection', () => {
  it('提取关键词命中的首个章节', () => {
    const text = `# T\n\n## A\n\n内容A\n\n## B\n\n内容B\n`;
    expect(extractSection(text, 'A').trim()).toBe('内容A');
  });

  it('未命中返回空串', () => {
    expect(extractSection('# T\n\n## A\n内容', 'X')).toBe('');
  });
});

describe('parseMarkdownTables', () => {
  it('解析单个表格的表头与数据行', () => {
    const text = `| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |`;
    const tables = parseMarkdownTables(text);
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['a', 'b']);
    expect(tables[0].rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('跳过非表格行并切分多张表', () => {
    const text = `| a | b |\n|---|---|\n| 1 | 2 |\n\n文字\n\n| c | d |\n|---|---|\n| 3 | 4 |`;
    const tables = parseMarkdownTables(text);
    expect(tables).toHaveLength(2);
    expect(tables[1].headers).toEqual(['c', 'd']);
  });
});

describe('findColumn', () => {
  it('精确匹配优先于模糊匹配', () => {
    const headers = ['指标名称', '名称'];
    const used = new Set<number>();
    // 精确命中"指标名称"而非模糊命中的"名称"
    expect(findColumn(headers, ['指标名称'], ['名称'], used)).toBe(0);
  });

  it('已用列不再参与匹配', () => {
    const headers = ['指标名称', '主题域'];
    const used = new Set<number>([0]);
    expect(findColumn(headers, ['主题域'], ['主题'], used)).toBe(1);
    // 0 已用 → 不应被再次命中
    used.add(1);
    expect(findColumn(headers, ['主题域'], ['主题'], used)).toBe(-1);
  });

  it('无匹配返回 -1', () => {
    expect(findColumn(['a', 'b'], ['c'], ['d'], new Set())).toBe(-1);
  });
});

// ── expandCalcExpr / expandCalcExprBatch ──────────────────

describe('expandCalcExpr', () => {
  it('替换 calcExpr 中引用的指标编码为实际计算公式', () => {
    const lookup = new Map([
      ['TEST_0001', 'sum(order_amount)'],
      ['TEST_0002', 'count(distinct user_id)'],
    ]);
    expect(expandCalcExpr('TEST_0002 / TEST_0001 * 100%', lookup))
      .toBe('count(distinct user_id) / sum(order_amount) * 100%');
  });

  it('未找到的编码保留原样', () => {
    const lookup = new Map([['TEST_0001', 'sum(order_amount)']]);
    expect(expandCalcExpr('TEST_0002 / TEST_0001', lookup))
      .toBe('TEST_0002 / sum(order_amount)');
  });

  it('calcExpr 为 undefined 时返回 undefined', () => {
    expect(expandCalcExpr(undefined, new Map())).toBeUndefined();
  });

  it('calcExpr 无指标编码时原样返回', () => {
    expect(expandCalcExpr('count(distinct user_id)', new Map()))
      .toBe('count(distinct user_id)');
  });

  it('支持嵌套展开（A引用B，B引用C）', () => {
    const lookup = new Map([
      ['B_0001', 'C_0001 + 1'],
      ['C_0001', 'sum(amount)'],
    ]);
    // B_0001 → "C_0001 + 1"，然后 C_0001 → "sum(amount)"，结果为 "sum(amount) + 1"
    expect(expandCalcExpr('B_0001 * 2', lookup))
      .toBe('sum(amount) + 1 * 2');
  });

  it('循环引用时在最大深度截断', () => {
    const lookup = new Map([
      ['A_0001', 'A_0001 + 1'],  // 自引用
    ]);
    // maxDepth=1 时只展开一次，结果仍含 A_0001
    const result = expandCalcExpr('A_0001', lookup, 1);
    expect(result).toBe('A_0001 + 1');
  });
});

describe('expandCalcExprBatch', () => {
  it('批量展开并叠加同批次指标', () => {
    const indicators = [
      { projectCode: 'P', topic: 'T', name: '指标1', code: 'X_0001', calcExpr: 'sum(amount)' },
      { projectCode: 'P', topic: 'T', name: '指标2', code: 'X_0002', calcExpr: 'X_0001 / 100' },
    ] as import('../types/indicator').IndicatorDTO[];

    const existingLookup = new Map<string, string>();
    const result = expandCalcExprBatch(indicators, existingLookup);

    expect(result[0].calcExpr).toBe('sum(amount)');
    expect(result[1].calcExpr).toBe('sum(amount) / 100');
  });

  it('已有指标查找表与当前批次合并', () => {
    const indicators = [
      { projectCode: 'P', topic: 'T', name: '指标3', code: 'Y_0003', calcExpr: 'Y_0001 + Y_0002' },
    ] as import('../types/indicator').IndicatorDTO[];

    const existingLookup = new Map([
      ['Y_0001', 'count(*)'],
      ['Y_0002', 'sum(price)'],
    ]);

    const result = expandCalcExprBatch(indicators, existingLookup);
    expect(result[0].calcExpr).toBe('count(*) + sum(price)');
  });

  it('无 calcExpr 的指标不受影响', () => {
    const indicators = [
      { projectCode: 'P', topic: 'T', name: '指标1', code: 'Z_0001' },
    ] as import('../types/indicator').IndicatorDTO[];

    const result = expandCalcExprBatch(indicators, new Map());
    expect(result[0].calcExpr).toBeUndefined();
  });
});

// ── parseFieldSource ──────────────────────────────────────

describe('parseFieldSource', () => {
  it('解析单库单表多字段', () => {
    const result = parseFieldSource('ods_user.login:user_id,login_time');
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      datasourceName: '', dbName: 'ods_user', tblName: 'login', fieldName: 'user_id', fieldType: '',
    });
    expect(result![1]).toEqual({
      datasourceName: '', dbName: 'ods_user', tblName: 'login', fieldName: 'login_time', fieldType: '',
    });
  });

  it('解析多库多表（分号分隔）', () => {
    const result = parseFieldSource('ods_user.login:user_id,login_time;dws_order.order:order_id,amount');
    expect(result).toHaveLength(4);
    expect(result![0].dbName).toBe('ods_user');
    expect(result![0].tblName).toBe('login');
    expect(result![2].dbName).toBe('dws_order');
    expect(result![2].tblName).toBe('order');
    expect(result![3].fieldName).toBe('amount');
  });

  it('单字段无逗号', () => {
    const result = parseFieldSource('db.tbl:field1');
    expect(result).toHaveLength(1);
    expect(result![0].fieldName).toBe('field1');
  });

  it('undefined 或空串返回 undefined', () => {
    expect(parseFieldSource(undefined)).toBeUndefined();
    expect(parseFieldSource('')).toBeUndefined();
    expect(parseFieldSource('   ')).toBeUndefined();
  });

  it('格式不合法时跳过该组（无冒号/无点号仍可解析）', () => {
    // 无冒号 → 跳过
    expect(parseFieldSource('nocolon')).toBeUndefined();
    // 无点号 → tblName 取整段
    const result = parseFieldSource('tblname:field1');
    expect(result).toHaveLength(1);
    expect(result![0].dbName).toBe('');
    expect(result![0].tblName).toBe('tblname');
  });

  it('无字段来源列的指标 fields 为 undefined', () => {
    const doc = `# 文档

## 数据指标

| 指标编码 | 指标名称 | 主题域 | 指定含义 | 计算表达式 | 过滤条件 |
|--------|------|----------|------------|----------|----------|
| A_0001 | 指标A | 域A | 含义A | exprA | |
`;
    const result = extractMetricsFromMarkdown(doc, 'P');
    expect(result).toHaveLength(1);
    expect(result[0].fields).toBeUndefined();
  });
});
