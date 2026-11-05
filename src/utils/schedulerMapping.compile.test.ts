import { describe, it, expect } from 'vitest';
import { isCompilableFile, buildTaskNameToFilePathMap } from './schedulerMapping';

/**
 * 「文件夹提交调度」编译链路的两个纯函数单测：
 * - isCompilableFile：仅 Java/Scala 且映射为需要主 Jar 包的引擎任务类型才编译；
 * - buildTaskNameToFilePathMap：按「任务名(净化) -> 文件绝对路径」建立映射，
 *   与 buildWorkflowFromFolder 的任务名口径一致、同名文件以先出现者为准。
 */
describe('isCompilableFile', () => {
  it('Java/Scala 文件映射为 SPARK/FLINK/FLINK_STREAM/MR/JAVA 时参与编译', () => {
    const compilableTypes = ['SPARK', 'FLINK', 'FLINK_STREAM', 'MR', 'JAVA'] as const;
    for (const t of compilableTypes) {
      expect(isCompilableFile('a.scala', t)).toBe(true);
      expect(isCompilableFile('a.java', t)).toBe(true);
    }
  });

  it('脚本型任务类型（SQL/PYTHON/SHELL 等）不参与编译', () => {
    expect(isCompilableFile('a.scala', 'SQL')).toBe(false);
    expect(isCompilableFile('a.java', 'PYTHON')).toBe(false);
    expect(isCompilableFile('a.scala', 'SHELL')).toBe(false);
    expect(isCompilableFile('a.java', 'DATAX')).toBe(false);
  });

  it('非 Java/Scala 文件（sql/py/sh）即使映射为 SPARK 也不编译', () => {
    expect(isCompilableFile('a.sql', 'SPARK')).toBe(false);
    expect(isCompilableFile('a.py', 'FLINK')).toBe(false);
    expect(isCompilableFile('a.sh', 'MR')).toBe(false);
  });

  it('扩展名大小写与缺失扩展名的情况', () => {
    expect(isCompilableFile('A.SCALA', 'SPARK')).toBe(true);
    expect(isCompilableFile('A.Java', 'JAVA')).toBe(true);
    expect(isCompilableFile('nofile', 'SPARK')).toBe(false);
    expect(isCompilableFile('a.scala', 'spark' as never)).toBe(false);
  });
});

describe('buildTaskNameToFilePathMap', () => {
  it('任务名取文件名（不含扩展名）并净化，值为绝对路径', () => {
    const map = buildTaskNameToFilePathMap(['/proj/src/a.scala', '/proj/src/b.sql']);
    expect(map.get('a')).toBe('/proj/src/a.scala');
    expect(map.get('b')).toBe('/proj/src/b.sql');
  });

  it('跨目录同名文件以先出现者为准（对齐 buildWorkflowFromFolder）', () => {
    const map = buildTaskNameToFilePathMap([
      '/proj/src/one/util.scala',
      '/proj/src/two/util.scala',
    ]);
    expect(map.get('util')).toBe('/proj/src/one/util.scala');
    expect(map.size).toBe(1);
  });

  it('文件名中的非法字符被 sanitizeDsName 净化（空格/点号转下划线）', () => {
    const map = buildTaskNameToFilePathMap(['/proj/src/my job.scala']);
    expect(map.get('my_job')).toBe('/proj/src/my job.scala');
  });

  it('空数组返回空映射；净化后为空的任务名被跳过', () => {
    expect(buildTaskNameToFilePathMap([]).size).toBe(0);
    // 文件名全为非法字符时净化后为空，应跳过而非写入空 key
    expect(buildTaskNameToFilePathMap(['/proj/....scala']).size).toBe(0);
  });
});
