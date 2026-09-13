/**
 * fileHeader.test.ts — 代码头解析与数据开发提示词的一致性测试
 *
 * 代码头是机器解析契约：src/utils/index.ts 的 parseFileHeader 扫描文件头注释区，
 * 优先按块注释（/* ... *\/）逐行匹配 * @键: 值，容忍开头 BOM/空行，
 * 遇到首个真实代码行（非注释）即终止；未出现块注释时回退按旧式行注释（-- // #）扫描。
 * 因此 opencodeInstructions.ts 中数据开发提示词的代码头样例必须：
 * - 使用块注释（/* ... *\/）逐行书写，行注释书写的代码头会被判为不合规
 * - 位于文件开头，不得被 import 或 package 语句隔断
 * - 含 @备注 / @引擎 / @数据源 必填项，且 @引擎 取值可被识别为调度任务类型
 * - 参数声明用 @程序参数 / @资源参数 / @任务参数（无则「无」），不再使用旧字段 @用法
 *
 * 本测试直接从提示词中抽取样例代码块并喂给真实解析器，防止改提示词时破坏解析。
 * 文末另锁「SQL 开发规范」里的变量写法（${参数名}）：正文变量由 parseSqlVarKeys 识别，
 * 须与 @程序参数 同名且为合法标识符。
 */

import { describe, it, expect } from 'vitest';
import { generateFileHeader, parseFileHeader, validateFileHeader } from './fileHeader';
import { extractProgramParams } from './programArgs';
import { mapCodeFileToTask } from './schedulerMapping';
import { deriveTaskParamsFromHeader } from './headerTaskParams';
import { DATA_DEV_ENGINEER_INSTRUCTIONS } from '../hooks/opencode/opencodeInstructions';

interface PromptSample {
  lang: string;
  content: string;
}

/**
 * 从数据开发提示词中抽取 ```语言 ... ``` 代码块。
 * 提示词中的代码块为了排版整体缩进了两格，解析前需还原。
 */
function promptSamples(): PromptSample[] {
  const re = /```(sql|java|scala|python|py)\n([\s\S]*?)```/g;
  const samples: PromptSample[] = [];
  for (const m of DATA_DEV_ENGINEER_INSTRUCTIONS.matchAll(re)) {
    samples.push({
      lang: m[1],
      content: m[2].split('\n').map(l => l.replace(/^ {2}/, '')).join('\n'),
    });
  }
  return samples;
}

function sampleOf(lang: string): PromptSample {
  const found = promptSamples().find(s => s.lang === lang);
  if (!found) throw new Error(`数据开发提示词中未找到 ${lang} 样例`);
  return found;
}

describe('数据开发提示词样例 — 代码头可被解析', () => {
  it('提示词给出了 SQL 与 Java 两个样例', () => {
    const langs = promptSamples().map(s => s.lang);
    expect(langs).toContain('sql');
    expect(langs).toContain('java');
  });

  it('每个样例都解析出 备注 / 引擎 / 数据源，且为块注释', () => {
    for (const s of promptSamples()) {
      const header = parseFileHeader(s.content);
      expect(header, `.${s.lang} 样例的代码头未被解析（须用块注释且位于文件开头）`).not.toBeNull();
      expect(header!.remark).toBeTruthy();
      expect(header!.engine).toBeTruthy();
      expect(header!.dataSource).toBeTruthy();
      expect(header!.style).toBe('block');
    }
  });

  it('每个样例都声明了 @程序参数 / @资源参数 / @任务参数（无参数时写「无」），且不再出现旧字段 @用法', () => {
    for (const s of promptSamples()) {
      const header = parseFileHeader(s.content);
      expect(header!.programArgs, `.${s.lang} 样例缺少 @程序参数`).toBeTruthy();
      expect(header!.resourceArgs, `.${s.lang} 样例缺少 @资源参数`).toBeTruthy();
      expect(header!.taskArgs, `.${s.lang} 样例缺少 @任务参数`).toBeTruthy();
      expect(header!.usage, `.${s.lang} 样例仍在使用旧字段 @用法`).toBe('');
    }
  });

  it('样例的三个参数字段被正确分流：@程序参数 → 预填行，@资源参数 / @任务参数 → 只告知', () => {
    const { content } = sampleOf('java');
    const { keys, taskParamKeys, resourceParamKeys } = extractProgramParams(content, 'java');
    expect(keys).toEqual(['day', 'checkpoint']);
    expect(resourceParamKeys).toEqual(['-p', '-yjm', '-ytm']);
    expect(taskParamKeys).toEqual(['-m', '-Dyarn.application.name=ods_trade_order_load_r']);
  });

  it('SQL 样例的资源参数（kyuubi/spark 形态）只进资源参数、不混进预填行', () => {
    const { content } = sampleOf('sql');
    const { keys, resourceParamKeys, taskParamKeys } = extractProgramParams(content, 'sql');
    expect(keys).toEqual(['day']);
    expect(resourceParamKeys).toEqual(['--num-executors', '--driver-memory', '--executor-cores']);
    expect(taskParamKeys).toEqual([]);
  });

  it('提示词给出了三个参数字段的区别说明（三者互斥的判定口径）', () => {
    for (const key of [
      '三个参数字段的区别',
      '@资源参数',
      '回答"这次给多少资源"',
      '判定顺序',
      // 取值语义与落到节点的字段对照：提示词与「提交调度」的换算口径必须一致
      '真实取值',
      '落到节点字段的对照',
      'Executor数量',
    ]) {
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `S3 提示词缺少三者区别说明片段: ${key}`).toContain(key);
    }
  });

  it('Java 样例（flink）的三类声明能落到调度节点参数：资源/任务字段 + 主参数 + 其他参数', () => {
    const { content } = sampleOf('java');
    const { params } = deriveTaskParamsFromHeader(content, 'FLINK');
    expect(params).toMatchObject({
      parallelism: 4,
      jobManagerMemory: '1024',
      taskManagerMemory: '2048',
      // -m yarn-cluster 收敛成节点「部署模式」的合法取值
      deployMode: 'cluster',
      mainArgs: '--day 20260501 -checkpoint 60000',
    });
    // -Dyarn.application.name 在节点参数里没有对应字段 → 原样进「其他参数」
    expect(params.others).toBe('-Dyarn.application.name=ods_trade_order_load_r');
  });

  it('SQL 样例（kyuubi）的资源参数不写进 SQL 节点，逐条回报给用户（不静默丢弃）', () => {
    const { content } = sampleOf('sql');
    const { supported, params, unmapped } = deriveTaskParamsFromHeader(content, 'SQL');
    expect(supported).toBe(false);
    expect(params).toEqual({});
    expect(unmapped.map(h => h.raw)).toEqual([
      '--num-executors 4',
      '--driver-memory 2g',
      '--executor-cores 2',
    ]);
  });

  it('SQL 样例被识别为 SQL 任务，数据源取自 @数据源', () => {
    const { content } = sampleOf('sql');
    const mapping = mapCodeFileToTask('dwd_user_login_etl_d.sql', content);
    expect(mapping.recommendedTaskType).toBe('SQL');
    expect(mapping.dataSource).toBe('test_datasource');
  });

  it('Java 样例依据 @引擎 识别为 FLINK，而非默认的 SPARK', () => {
    const { content } = sampleOf('java');
    const mapping = mapCodeFileToTask('ods_trade_order_load_r.java', content);
    // .java 文件漏写 @引擎 时会被默认判为 SPARK，故该断言同时守住"必填 @引擎"的规范
    expect(mapping.recommendedTaskType).toBe('FLINK');
    expect(mapping.recommendationReason).toContain('flink');
  });

  it('Java 样例通过包声明与类名校验（块注释代码头不下发包校验）', () => {
    const { content } = sampleOf('java');
    const result = validateFileHeader(content, 'test.java', 'java/ods/test.java', 'TEST');
    expect(result.packageErrors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

/**
 * 「SQL 开发规范」里的变量写法同样是机器解析契约：src/utils/programArgs.ts::parseSqlVarKeys
 * 先剥离注释，再扫 SQL 正文的 ${} 取纯标识符名，最后与代码头 @程序参数 合并、按名去重，
 * 作为「运行程序」弹窗的预填兜底。提示词写错（用 $[yyyyMMdd]、变量与声明不同名、
 * 只在注释里写变量）都会让参数漏配，这里钉住口径。
 */
describe('数据开发提示词 — SQL 变量规范与解析器口径一致', () => {
  it('提示词声明了变量的写法约束', () => {
    for (const key of ['变量编写规范', '${参数名}', '@程序参数', '$[yyyyMMdd]', '同名']) {
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `S3 提示词缺少 SQL 变量规范片段: ${key}`).toContain(key);
    }
  });

  it('SQL 样例的正文变量与 @程序参数 同名（合并去重后只剩一个 day）', () => {
    const { content } = sampleOf('sql');
    const { keys, programArgs } = extractProgramParams(content, 'sql');
    expect(programArgs).toContain('--day');
    expect(keys).toEqual(['day']);
  });

  it('提示词里的错误写法不会被解析器误收：$[yyyyMMdd] 与带默认值的模板表达式', () => {
    // 取自提示词的反例说明：这两种写法都不是合法参数名，写进正文也不会被识别
    const sql = "select 1 from t where dt = '$[yyyyMMdd]' and d = '${day:20260501}' limit 1";
    expect(extractProgramParams(sql, 'sql').keys).toEqual([]);
  });

  it('只在注释里出现的变量不算参数（注释先被剥离）', () => {
    const sql = [
      '/*',
      ' * @备注: 示例 ${notParam} 只是注释里的说明',
      ' */',
      'select 1 from t;',
    ].join('\n');
    expect(extractProgramParams(sql, 'sql').keys).toEqual([]);
  });
});

/**
 * 新建文件时由 generateFileHeader 灌入的代码头模板，是人工书写代码头的范本。
 * 模板若漏字段，人工新建的 .java/.scala/.py 就只会填模板里有的项，
 * 进而丢 @引擎（任务被默认判为 SPARK）与 @数据源（调度依赖缺失）。
 * v3 起模板含 @程序参数 / @任务参数（原 @用法 已拆分），v4 起补 @资源参数，
 * 漏掉会导致「运行程序」识别不到参数。
 */
describe('generateFileHeader — 模板字段完整性', () => {
  const cases: Array<{ file: string }> = [
    { file: 'dwd_user_login_etl_d.sql' },
    { file: 'ods_trade_order_load_r.java' },
    { file: 'ods_trade_order_load_r.scala' },
    { file: 'ods_trade_order_load_r.py' },
  ];

  it.each(cases)('$file 的模板为块注释且含全部字段', ({ file }) => {
    const header = generateFileHeader(`/workspace/TEST/sql/dwd/${file}`);

    expect(header).toBeTruthy();
    expect(header.startsWith('/*')).toBe(true);
    expect(header.endsWith(' */')).toBe(true);
    // 原 @用法 已拆成 @程序参数 / @资源参数 / @任务参数（无则「无」），生成器不得再产出 @用法
    for (const field of ['备注', '数仓', '引擎', '依赖', '程序参数', '资源参数', '任务参数', '数据源']) {
      expect(header).toContain(`@${field}: `);
    }
    expect(header).not.toContain('@用法: ');

    // 模板必须能被真实解析器识别为块注释，且各字段键都在（值留空待填）
    const parsed = parseFileHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.style).toBe('block');
    expect(parsed!.remark).toBe('');
    expect(parsed!.engine).toBe('');
    expect(parsed!.dependency).toBe('');
    expect(parsed!.programArgs).toBe('');
    expect(parsed!.resourceArgs).toBe('');
    expect(parsed!.taskArgs).toBe('');
    expect(parsed!.usage).toBe('');
    expect(parsed!.dataSource).toBe('');
  });

  it('不支持的扩展名不生成代码头', () => {
    expect(generateFileHeader('README.md')).toBe('');
    expect(generateFileHeader('pom.xml')).toBe('');
  });

  it('模板填写后 .java 可识别出 FLINK 而非默认的 SPARK', () => {
    const filled = generateFileHeader('/workspace/TEST/java/ods/ods_trade_order_load_r.java')
      .replace(' * @备注: ', ' * @备注: 实时消费订单 Kafka 消息写入 ODS 层订单表')
      .replace(' * @引擎: ', ' * @引擎: flink')
      .replace(' * @数据源: ', ' * @数据源: test_datasource');

    const mapping = mapCodeFileToTask('ods_trade_order_load_r.java', filled);
    expect(mapping.recommendedTaskType).toBe('FLINK');
    expect(mapping.dataSource).toBe('test_datasource');
  });
});

describe('parseFileHeader — 边界与回归', () => {
  it('块注释包裹的代码头可被解析（v2 规范）', () => {
    const blocked = `/*
 * @引擎: kyuubi
 * @备注: 这是一个SQL样例
 * @数据源: test_datasource
 */
 select * from test where name='xxx'`;
    const header = parseFileHeader(blocked);
    expect(header).not.toBeNull();
    expect(header!.style).toBe('block');
    expect(header!.engine).toBe('kyuubi');
    expect(header!.dataSource).toBe('test_datasource');
  });

  it('单行块注释 /** @备注: xxx */ 也能解析', () => {
    const header = parseFileHeader('/** @引擎: spark */\nSELECT 1;');
    expect(header).not.toBeNull();
    expect(header!.style).toBe('block');
    expect(header!.engine).toBe('spark');
  });

  it('代码头之前出现空行仍可正常解析', () => {
    const withBlankLine = `\n/*
 * @引擎: kyuubi
 * @备注: 前面有空行
 */`;
    const header = parseFileHeader(withBlankLine);
    expect(header).not.toBeNull();
    expect(header!.engine).toBe('kyuubi');
  });

  it('块注释代码头被普通代码行截断后不误收正文 @依赖', () => {
    const broken = [
      '/*',
      ' * @备注: 备注内容',
      ' * @引擎: spark',
      ' */',
      'SELECT 1;',
      '/* @数据源: test_datasource */',
    ].join('\n');
    const header = parseFileHeader(broken);
    expect(header?.engine).toBe('spark');
    expect(header?.dataSource).toBe('');
  });

  it('旧式行注释代码头仍能被识别为 style=line（用于校验提示不合规）', () => {
    const legacy = '-- @引擎: kyuubi\n-- @备注: 旧格式\n-- @数据源: test_datasource\n';
    const header = parseFileHeader(legacy);
    expect(header).not.toBeNull();
    expect(header!.style).toBe('line');
    expect(header!.engine).toBe('kyuubi');
  });

  it('解析 @依赖 前置依赖任务格式：{调度项目}.{前置任务名称} 逗号分隔且不含文件扩展名', () => {
    const content = [
      '/*',
      ' * @备注: 测试前置依赖',
      ' * @引擎: kyuubi',
      ' * @依赖: test_project.ods_load_user_f,test_project.ods_load_events_f',
      ' * @数据源: test_datasource',
      ' */',
    ].join('\n');
    const header = parseFileHeader(content);
    expect(header).not.toBeNull();
    expect(header!.dependency).toBe('test_project.ods_load_user_f,test_project.ods_load_events_f');
  });

  it('未声明 @依赖 时 dependency 为空串', () => {
    const header = parseFileHeader('/*\n * @引擎: spark\n * @备注: 无前置依赖\n */');
    expect(header?.dependency).toBe('');
  });
});

describe('validateFileHeader — 块注释规范校验', () => {
  it('行注释书写的代码头被判为不符合规范', () => {
    const lineHeader = '// @备注: 实时消费\n// @引擎: flink\n// @数据源: test_datasource\npackage TEST.java.ods;\n';
    const result = validateFileHeader(lineHeader, 'ods_trade_order_load_r.java', 'java/ods/test.java', 'TEST');
    expect(result.valid).toBe(false);
    expect(result.packageErrors.join('；')).toContain('块注释');
  });

  it('块注释书写的合法代码头通过校验', () => {
    const blockHeader = [
      '/*',
      ' * @备注: 实时消费',
      ' * @引擎: flink',
      ' * @数据源: test_datasource',
      ' */',
      'package TEST.java.ods;',
    ].join('\n');
    const result = validateFileHeader(blockHeader, 'test.java', 'java/ods/test.java', 'TEST');
    expect(result.valid).toBe(true);
  });
});
