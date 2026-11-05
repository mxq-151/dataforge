import { describe, it, expect } from 'vitest';
import {
  createParamRow,
  extractProgramParams,
  findDuplicateKeys,
  findRowsMissingKey,
  mergeExtractedKeys,
  paramsFromItems,
  parseParamKeys,
  parseSqlVarKeys,
  stripSqlComments,
  toParamRows,
} from './programArgs';

/**
 * 「程序运行参数」键值对 → runParams 的换算规则。
 * 这里钉住的是**会被丢掉或覆盖**的三种情况，它们是唯一容易出错的地方：
 * 空参数名的行整行丢弃、值按字符串下发、同名后者生效。
 */
describe('paramsFromItems', () => {
  it('键值对原样映射为 runParams', () => {
    expect(paramsFromItems([
      { key: 'env', value: 'prod' },
      { key: 'dry-run', value: 'true' },
    ])).toEqual({ env: 'prod', 'dry-run': 'true' });
  });

  it('参数名首尾空白被去掉', () => {
    expect(paramsFromItems([{ key: '  env  ', value: 'prod' }])).toEqual({ env: 'prod' });
  });

  it('空参数名的行整行丢弃（值也一起丢，不产生匿名参数）', () => {
    expect(paramsFromItems([
      { key: '', value: 'orphan' },
      { key: '   ', value: 'orphan' },
      { key: 'env', value: 'prod' },
    ])).toEqual({ env: 'prod' });
  });

  it('同名参数后者覆盖前者', () => {
    expect(paramsFromItems([
      { key: 'env', value: 'prod' },
      { key: 'env', value: 'gray' },
    ])).toEqual({ env: 'gray' });
  });

  it('值可以留空，按空字符串下发（不当作 true）', () => {
    expect(paramsFromItems([{ key: 'flag', value: '' }])).toEqual({ flag: '' });
  });

  it('空列表 / null 都得到空对象', () => {
    expect(paramsFromItems([])).toEqual({});
    expect(paramsFromItems(null)).toEqual({});
    expect(paramsFromItems(undefined)).toEqual({});
  });
});

describe('findRowsMissingKey', () => {
  it('返回「填了值却没填参数名」的行下标', () => {
    expect(findRowsMissingKey([
      { key: '', value: 'orphan' },
      { key: 'env', value: 'prod' },
      { key: '', value: 'orphan2' },
    ])).toEqual([0, 2]);
  });

  it('空行（名与值都空）不算问题，不打扰用户', () => {
    expect(findRowsMissingKey([{ key: '', value: '' }])).toEqual([]);
  });
});

describe('findDuplicateKeys', () => {
  it('返回重复的参数名（去重、保持首次出现顺序）', () => {
    expect(findDuplicateKeys([
      { key: 'b', value: '1' },
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: 'a', value: '2' },
      { key: 'b', value: '3' },
    ])).toEqual(['b', 'a']);
  });

  it('空参数名不参与判重', () => {
    expect(findDuplicateKeys([
      { key: '', value: '1' },
      { key: '', value: '2' },
    ])).toEqual([]);
  });
});

describe('createParamRow / toParamRows', () => {
  it('每行都有唯一 id，值可给初值', () => {
    const a = createParamRow();
    const b = createParamRow('env', 'prod');
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(b).toMatchObject({ key: 'env', value: 'prod' });
  });

  it('toParamRows 复制内容并为每行生成新 id（不共享外部对象）', () => {
    const saved = [{ id: 'old-1', key: 'env', value: 'prod' }];
    const rows = toParamRows(saved);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'env', value: 'prod' });
    expect(rows[0].id).not.toBe('old-1');
    expect(rows[0]).not.toBe(saved[0]);
  });

  it('toParamRows 对 null / undefined 返回空数组', () => {
    expect(toParamRows(null)).toEqual([]);
    expect(toParamRows(undefined)).toEqual([]);
  });
});

describe('stripSqlComments / parseSqlVarKeys', () => {
  it('取出 ${var}：去重并保持出现顺序', () => {
    const sql = "insert overwrite table t partition(dt = '${day}') "
      + "select * from s where dt = '${day}' and hour = '${hour}'";
    expect(parseSqlVarKeys(sql)).toEqual(['day', 'hour']);
  });

  it('stripSqlComments 保留字符串字面量与正常语句，只删注释', () => {
    const sql = "select '--not comment' as a -- comment\n/* block\nspan */ from t";
    expect(stripSqlComments(sql)).toBe("select '--not comment' as a \n from t");
  });

  it('行注释与块注释里的变量不算参数', () => {
    const sql = [
      "-- where dt = '${old}'",
      '/* ${alsoComment} */',
      "select 1 from t where dt = '${day}'",
    ].join('\n');
    expect(parseSqlVarKeys(sql)).toEqual(['day']);
  });

  it('字符串里的 -- 不是注释起点', () => {
    expect(parseSqlVarKeys("select '${a}--${b}' as x")).toEqual(['a', 'b']);
  });

  it('非标识符的模板表达式被跳过；$[yyyyMMdd] 这类内置日期参数不算', () => {
    const sql = 'select ${fn(a, b)}, $[yyyyMMdd], $[yyyy-MM-dd] from t where dt = $[yyyyMMdd]';
    expect(parseSqlVarKeys(sql)).toEqual([]);
  });
});

/**
 * 代码头 `@程序参数` 声明里的参数名：兼容 `--键 值`（命令行形态）与 `${变量名}`（纯变量形态），
 * 时间类参数的取值写 `${变量名}`，与正文同名。
 */
describe('parseParamKeys — 代码头 @程序参数 声明里的参数名', () => {
  it('命令行形态取键名、跳过字面取值', () => {
    expect(parseParamKeys('--day 20260501 -checkpoint 60000')).toEqual(['day', 'checkpoint']);
  });

  it('时间类参数的取值写成 ${变量名} 时按声明顺序取到', () => {
    expect(parseParamKeys('--day ${day} --hour ${hour}')).toEqual(['day', 'hour']);
  });

  it('纯变量形态（无 --键 前缀）也能取到变量名', () => {
    expect(parseParamKeys('${day} ${city}')).toEqual(['day', 'city']);
  });

  it('--key=value 与重复声明都去重', () => {
    expect(parseParamKeys('--env=prod --env gray')).toEqual(['env']);
  });

  it('「无」/ 空值 / null / undefined 都得到空数组', () => {
    expect(parseParamKeys('无')).toEqual([]);
    expect(parseParamKeys('')).toEqual([]);
    expect(parseParamKeys(null)).toEqual([]);
    expect(parseParamKeys(undefined)).toEqual([]);
  });

  it('取值里的短横线不会被当成参数名（--offset -1）', () => {
    expect(parseParamKeys('--offset -1')).toEqual(['offset']);
  });

  it('夹带的说明文字被忽略，只取声明里的参数名', () => {
    expect(parseParamKeys('运行需要 --day ${day} 才能跑')).toEqual(['day']);
  });
});

/**
 * 代码头只承载 `@程序参数`（历史 @用法 / @资源参数 / @任务参数 已废弃，不再解析）。
 * 「运行程序」弹窗的预填来源：代码头 `@程序参数` 声明 + SQL 正文的 `${day}` 变量，
 * 两者同名合并去重；Java / Scala / Python 的运行参数是命令行入参，正文里的 `${}` 通常是
 * 日志/模板而非运行参数，故不扫描，参数名只来自代码头。
 */
describe('extractProgramParams — 代码头 @程序参数 与 SQL 正文变量合并', () => {
  it('SQL：代码头声明在前、正文变量在后，去重合并；已废弃字段被忽略', () => {
    const sql = [
      '/*',
      ' * @引擎: kyuubi',
      ' * @程序参数: --day ${day} --hour ${hour}',
      ' * @资源参数: --num-executors 4',
      ' * @任务参数: --master yarn',
      ' * @用法: --day 20260501',
      ' */',
      "insert overwrite table t partition(dt = '${day}')",
      "select * from s where dt = '${day}' and city = '${city}';",
    ].join('\n');
    expect(extractProgramParams(sql, 'sql')).toEqual({
      keys: ['day', 'hour', 'city'],
      programArgs: '--day ${day} --hour ${hour}',
    });
  });

  it('Java / Scala / Python：正文 ${} 不算参数，参数名只来自代码头 @程序参数', () => {
    const java = [
      '/*',
      ' * @引擎: spark',
      ' * @程序参数: --day ${day} -checkpoint 60000',
      ' */',
      'package TEST.java.ods;',
      'class Test { String tpl = "${notAParam}"; String flag = "--nope"; }',
    ].join('\n');
    const expected = { keys: ['day', 'checkpoint'], programArgs: '--day ${day} -checkpoint 60000' };
    expect(extractProgramParams(java, 'java')).toEqual(expected);
    expect(extractProgramParams(java, 'scala')).toEqual(expected);
    expect(extractProgramParams(java, 'python')).toEqual(expected);
  });

  it('codeType 省略时按 SQL 处理（未知扩展名在 getFileInfo 里也默认 sql）', () => {
    expect(extractProgramParams("select 1 from t where dt = '${day}'"))
      .toEqual({ keys: ['day'], programArgs: '' });
  });

  it('未声明 @程序参数 且正文无变量 → 空（弹窗只给一行空白）', () => {
    expect(extractProgramParams('select 1;', 'sql')).toEqual({ keys: [], programArgs: '' });
    expect(extractProgramParams('/*\n * @程序参数: 无\n */\nselect 1;', 'sql'))
      .toEqual({ keys: [], programArgs: '无' });
  });
});

describe('mergeExtractedKeys', () => {
  it('已有的参数名保持原样，缺少的补成空白行', () => {
    const merged = mergeExtractedKeys(
      [{ id: 'r1', key: 'env', value: 'prod' }],
      ['env', 'day', 'city'],
    );
    expect(merged.map(r => [r.key, r.value])).toEqual([
      ['env', 'prod'],
      ['day', ''],
      ['city', ''],
    ]);
    expect(merged[0].id).toBe('r1');
  });

  it('参数名比较忽略首尾空白，不重复追加', () => {
    const merged = mergeExtractedKeys([{ key: '  day ', value: '1' }], ['day']);
    expect(merged).toHaveLength(1);
  });

  it('空行（参数名为空）不会被当成已存在，也不会被覆盖', () => {
    const merged = mergeExtractedKeys([{ key: '', value: 'orphan' }], ['day']);
    expect(merged.map(r => r.key)).toEqual(['', 'day']);
  });

  it('键列表为空时原样返回现有行', () => {
    const rows = [{ key: 'env', value: 'prod' }];
    expect(mergeExtractedKeys(rows, [])).toBe(rows);
  });
});