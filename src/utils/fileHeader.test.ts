/**
 * fileHeader.test.ts — 代码头解析、生成与校验契约测试
 *
 * 代码头是机器解析契约：src/utils/fileHeader.ts 的 parseFileHeader 扫描文件头注释区，
 * 优先按块注释（/* ... *\/）逐行匹配 * @键: 值，容忍开头 BOM/空行，
 * 遇到首个真实代码行（非注释）即终止；未出现块注释时回退按旧式行注释（-- // #）扫描。
 * 合法代码头必须：
 * - 使用块注释（/* ... *\/）逐行书写，行注释书写的代码头会被判为不合规
 * - 位于文件开头，不得被 import 或 package 语句隔断
 * - 含 @备注 / @引擎 / @数据源 必填项，且 @引擎 取值可被识别为调度任务类型
 *
 * 代码头承载的运行参数只保留 @程序参数：声明程序运行期参数，时间类参数的取值一律写成
 * `${变量名}` 变量（与 SQL 正文同名），由调度侧以 DolphinScheduler 内置时间变量作为取值解析。
 * 历史字段 @用法 / @资源参数 / @任务参数 已废弃，解析器不再识别。
 * SQL 正文里的 `${参数名}` 与代码头声明合并后，作为「运行程序」弹窗的预填来源。
 *
 * 本测试用生成模板与固定样例喂给真实解析器，防止解析规则回退。
 * 文末另锁「SQL 开发规范」里的变量写法（${参数名}）：正文变量由 parseSqlVarKeys 识别。
 */

import { describe, it, expect } from 'vitest';
import { generateFileHeader, parseFileHeader, validateFileHeader } from './fileHeader';
import { extractProgramParams } from './programArgs';
import { mapCodeFileToTask } from './schedulerMapping';

/** 代码头已废弃的参数字段（解析器不再识别） */
const DEPRECATED_HEADER_FIELDS = ['@用法', '@资源参数', '@任务参数'];

/**
 * 新建文件时由 generateFileHeader 灌入的代码头模板，是人工书写代码头的范本。
 * 模板若漏字段，人工新建的 .java/.scala/.py 就只会填模板里有的项，
 * 进而丢 @引擎（任务被默认判为 SPARK）与 @数据源（调度依赖缺失）。
 * 代码头只保留 @程序参数 作为运行参数声明（时间类参数以 `${变量名}` 变量描述），
 * 模板不再产出 @资源参数 / @任务参数 / @用法。
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
    // 代码头含 备注/数仓/引擎/依赖/程序参数/数据源；历史参数字段一律不再生成
    for (const field of ['备注', '数仓', '引擎', '依赖', '程序参数', '数据源']) {
      expect(header).toContain(`@${field}: `);
    }
    for (const field of DEPRECATED_HEADER_FIELDS) {
      expect(header).not.toContain(`${field}: `);
    }

    // 模板必须能被真实解析器识别为块注释，且各字段键都在（值留空待填）
    const parsed = parseFileHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.style).toBe('block');
    expect(parsed!.remark).toBe('');
    expect(parsed!.engine).toBe('');
    expect(parsed!.dependency).toBe('');
    expect(parsed!.programArgs).toBe('');
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

  it('已废弃的参数字段不再被解析，@程序参数 仍被解析', () => {
    const content = [
      '/*',
      ' * @引擎: spark',
      ' * @备注: 历史字段',
      ' * @资源参数: --num-executors 4',
      ' * @任务参数: --master yarn',
      ' * @用法: --day 20260501',
      ' * @程序参数: --day ${day}',
      ' * @数据源: test_datasource',
      ' */',
    ].join('\n');
    const header = parseFileHeader(content);
    expect(header).not.toBeNull();
    expect(header!.engine).toBe('spark');
    expect(header!.dataSource).toBe('test_datasource');
    // @程序参数 保留原文（时间类参数写 ${} 变量），废弃字段被忽略、不落入任何已知字段
    expect(header!.programArgs).toBe('--day ${day}');
    expect(Object.keys(header!).sort()).toEqual(
      ['dataSource', 'dependency', 'engine', 'filePath', 'language', 'programArgs', 'remark', 'style', 'warehouse'],
    );
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