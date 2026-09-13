import { describe, it, expect } from 'vitest';
import {
  createParamRow,
  extractProgramParams,
  findDuplicateKeys,
  findRowsMissingKey,
  mergeExtractedKeys,
  paramsFromItems,
  parseSqlVarKeys,
  parseParamKeys,
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

/**
 * 参数声明文本（代码头 `@程序参数` / `@任务参数`，旧格式 `@用法`）的原文形式：
 * `--day 20260501 -checkpoint 60000`
 */
describe('parseParamKeys', () => {
  it('只取参数名、跳过取值', () => {
    expect(parseParamKeys('--day 20260501 -checkpoint 60000')).toEqual(['day', 'checkpoint']);
  });

  it('支持 --key=value 与去重', () => {
    expect(parseParamKeys('--env=prod --env gray')).toEqual(['env']);
  });

  it('「无」/空值与 undefined 都得到空数组', () => {
    expect(parseParamKeys('无')).toEqual([]);
    expect(parseParamKeys('')).toEqual([]);
    expect(parseParamKeys(null)).toEqual([]);
    expect(parseParamKeys(undefined)).toEqual([]);
  });

  it('取值里的短横线不会被当成参数名（--offset -1）', () => {
    expect(parseParamKeys('--offset -1')).toEqual(['offset']);
  });

  it('夹带的说明文字被忽略', () => {
    expect(parseParamKeys('运行需要 --day 20260501 才能跑')).toEqual(['day']);
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

describe('extractProgramParams — v3 新格式：@程序参数 / @任务参数', () => {
  const SQL_V3 = [
    '/*',
    ' * @引擎: kyuubi',
    ' * @程序参数: --day 20260501',
    ' * @任务参数: 无',
    ' */',
    "insert overwrite table t partition(dt = '${day}')",
    "select * from s where dt = '${day}' and city = '${city}';",
  ].join('\n');

  it('SQL：@程序参数 在前，正文变量在后（合并去重）', () => {
    expect(extractProgramParams(SQL_V3, 'sql')).toEqual({
      keys: ['day', 'city'],
      taskParamKeys: [],
      programArgs: '--day 20260501',
      taskArgs: '无',
      usage: '',
    });
  });

  it('@任务参数 原样收进 taskParamKeys（不进预填行）；Java/Scala 不看正文的 ${} 与 --x', () => {
    const scala = [
      '/*',
      ' * @引擎: flink',
      ' * @程序参数: --day 20260501 -checkpoint 60000',
      ' * @任务参数: -m yarn-cluster -p 4 -yjm 1024',
      ' */',
      'object Test { val tpl = "${notAParam}"; val flag = "--nope" }',
    ].join('\n');
    expect(extractProgramParams(scala, 'scala')).toEqual({
      keys: ['day', 'checkpoint'],
      taskParamKeys: ['-m', '-p', '-yjm'],
      programArgs: '--day 20260501 -checkpoint 60000',
      taskArgs: '-m yarn-cluster -p 4 -yjm 1024',
      usage: '',
    });
  });

  it('显式声明即分类结果：@程序参数 里的名字不再按引擎表二次剔除', () => {
    const java = [
      '/*',
      ' * @引擎: spark',
      ' * @程序参数: --class MyJob --day 20260501',
      ' * @任务参数: 无',
      ' */',
      'package TEST.java.ods;',
    ].join('\n');
    const result = extractProgramParams(java, 'java');
    expect(result.keys).toEqual(['class', 'day']);
    expect(result.taskParamKeys).toEqual([]);
  });

  it('未声明 / 写「无」→ 两类参数都为空（弹窗只给一行空白）', () => {
    expect(extractProgramParams('select 1;', 'sql')).toEqual({
      keys: [], taskParamKeys: [], programArgs: '', taskArgs: '', usage: '',
    });
    expect(extractProgramParams('/*\n * @程序参数: 无\n * @任务参数: 无\n */\nselect 1;', 'sql')).toEqual({
      keys: [], taskParamKeys: [], programArgs: '无', taskArgs: '无', usage: '',
    });
  });

  it('codeType 省略时按 SQL 处理（未知扩展名在 getFileInfo 里也默认 sql）', () => {
    expect(extractProgramParams(SQL_V3).keys).toEqual(['day', 'city']);
  });
});

/**
 * v2 兼容：旧文件只有一个 `@用法`，两类参数混写，此时仍按 `@引擎` 查表拆分，
 * 保证老工作空间的「运行程序」行为不因代码头拆字段而改变。
 */
describe('extractProgramParams — 旧格式 @用法 兼容', () => {
  const SQL = [
    '/*',
    ' * @引擎: kyuubi',
    ' * @用法: --day 20260501',
    ' */',
    "insert overwrite table t partition(dt = '${day}')",
    "select * from s where dt = '${day}' and city = '${city}';",
  ].join('\n');

  it('SQL：代码头 @用法 在前，正文变量在后（合并去重）', () => {
    expect(extractProgramParams(SQL, 'sql')).toEqual({
      keys: ['day', 'city'],
      taskParamKeys: [],
      programArgs: '',
      taskArgs: '',
      usage: '--day 20260501',
    });
  });

  it('Java/Scala：只认代码头 @用法，正文里的 ${} 与 --x 都不算', () => {
    const java = [
      '/*',
      ' * @引擎: spark',
      ' * @用法: --day 20260501 -checkpoint 60000',
      ' */',
      'package TEST.java.ods;',
      'class Test { String tpl = "${notAParam}"; String flag = "--nope"; }',
    ].join('\n');
    expect(extractProgramParams(java, 'java')).toEqual({
      keys: ['day', 'checkpoint'],
      taskParamKeys: [],
      programArgs: '',
      taskArgs: '',
      usage: '--day 20260501 -checkpoint 60000',
    });
  });

  it('迁移期新旧字段并存：一并解析，两类都不丢', () => {
    const mixed = [
      '/*',
      ' * @引擎: kyuubi',
      ' * @用法: --day 20260501',
      ' * @程序参数: --hour 08',
      ' * @任务参数: --num-executors 4',
      ' */',
      'select 1;',
    ].join('\n');
    const result = extractProgramParams(mixed, 'sql');
    // @程序参数 先解析，旧 @用法 里的业务参数追加在后
    expect(result.keys).toEqual(['hour', 'day']);
    expect(result.taskParamKeys).toEqual(['--num-executors']);
    expect(result.usage).toBe('--day 20260501');
  });

  it('旧格式里既有 @用法 又没有任何参数 → 空（弹窗只给一行空白）', () => {
    expect(extractProgramParams('select 1;', 'sql')).toEqual({
      keys: [], taskParamKeys: [], programArgs: '', taskArgs: '', usage: '',
    });
  });
});

/**
 * 旧格式（v2）的 `@用法` 常写成 spark / flink 提交命令形态，框架参数与业务入参混在一起。
 * 框架参数属于「任务参数」（见 schedulerMapping 的 driverMemory/executorCores/parallelism 映射），
 * 不能当成 runParams 下发 —— 这里钉住「剔哪些、留哪些」。
 * v3 起改用 `@任务参数` 显式声明，本组用例只覆盖老文件的兼容路径。
 */
describe('extractProgramParams — 旧格式 @用法 的引擎参数剔除', () => {
  const header = (engine: string, usage: string) =>
    ['/*', ` * @引擎: ${engine}`, ` * @用法: ${usage}`, ' */'].join('\n');

  it('spark：提交参数被剔到 taskParamKeys，只留业务参数', () => {
    const usage = '--master yarn --deploy-mode cluster --class com.x.Y '
      + '--num-executors 4 --driver-memory 2g app.jar --day 20260501';
    const result = extractProgramParams(header('spark', usage), 'java');
    expect(result.keys).toEqual(['day']);
    expect(result.taskParamKeys).toEqual([
      '--master', '--deploy-mode', '--class', '--num-executors', '--driver-memory',
    ]);
  });

  it('flink：单字母短选项与 YARN 简写同样剔除', () => {
    const usage = '-m yarn-cluster -p 4 -yjm 1024 -ytm 2048 -c com.x.Y app.jar --day 20260501';
    const result = extractProgramParams(header('flink', usage), 'scala');
    expect(result.keys).toEqual(['day']);
    expect(result.taskParamKeys).toEqual(['-m', '-p', '-yjm', '-ytm', '-c']);
  });

  it('flink_stream 按 flink 处理；-D 动态配置也算引擎参数', () => {
    const usage = '-Dyarn.application.name=demo -p 2 --day 20260501';
    const result = extractProgramParams(header('flink_stream', usage), 'scala');
    expect(result.keys).toEqual(['day']);
    expect(result.taskParamKeys).toEqual(['-Dyarn.application.name=demo', '-p']);
  });

  it('规范样例里的 -checkpoint 是程序入参，不能被当引擎参数剔掉', () => {
    const result = extractProgramParams(header('flink', '--day 20260501 -checkpoint 60000'), 'java');
    expect(result.keys).toEqual(['day', 'checkpoint']);
    expect(result.taskParamKeys).toEqual([]);
  });

  it('--env=prod 这种写法同样能比对出引擎参数（--conf spark.app.name=x）', () => {
    const result = extractProgramParams(
      header('spark', '--conf spark.app.name=demo --day=20260501'),
      'java',
    );
    expect(result.keys).toEqual(['day']);
    expect(result.taskParamKeys).toEqual(['--conf']);
  });

  it('引擎参数不重复收集（--master yarn --master local）', () => {
    const result = extractProgramParams(header('spark', '--master yarn --master local --day 1'), 'java');
    expect(result.taskParamKeys).toEqual(['--master']);
  });

  it('非 spark/flink 引擎（kyuubi）不做剔除，--master 照旧算业务参数', () => {
    const result = extractProgramParams(header('kyuubi', '--master yarn --day 20260501'), 'sql');
    expect(result.keys).toEqual(['master', 'day']);
    expect(result.taskParamKeys).toEqual([]);
  });

  it('未声明 @引擎 时不做剔除（@引擎 必填，缺了在代码头校验就被拦下）', () => {
    const sql = ['/*', ' * @用法: --master yarn --day 20260501', ' */', 'select 1;'].join('\n');
    const result = extractProgramParams(sql, 'sql');
    expect(result.keys).toEqual(['master', 'day']);
    expect(result.taskParamKeys).toEqual([]);
  });

  it('spark 引擎的 SQL：引擎参数剔除，正文 ${} 照常并入', () => {
    const sql = [
      header('spark', '--master yarn --conf spark.app.name=demo'),
      "insert overwrite table t partition(dt = '${day}') select 1;",
    ].join('\n');
    const result = extractProgramParams(sql, 'sql');
    expect(result.keys).toEqual(['day']);
    expect(result.taskParamKeys).toEqual(['--master', '--conf']);
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
