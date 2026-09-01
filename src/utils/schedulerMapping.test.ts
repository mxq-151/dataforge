import { describe, it, expect } from 'vitest';
import { buildJarsArg, mapCodeFileToTask, type SavedConfig } from './schedulerMapping';

describe('buildJarsArg', () => {
  it('jarPath 为目录时拼接 jarPath(去尾斜杠) + jarName', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', jarName: 'my-udf.jar' },
    ])).toBe('/opt/jars/my-udf.jar');
  });

  it('jarPath 无尾斜杠时正常拼接', () => {
    expect(buildJarsArg([
      { jarPath: 'hdfs:///jars', jarName: 'lib-a.jar' },
    ])).toBe('hdfs:///jars/lib-a.jar');
  });

  it('jarPath 以 .jar 结尾时视为完整文件路径直接使用', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/custom/lib-b.jar', jarName: 'lib-b.jar' },
    ])).toBe('/opt/custom/lib-b.jar');
  });

  it('jarName 缺失时回退到 name', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', name: 'fallback.jar' },
    ])).toBe('/opt/jars/fallback.jar');
  });

  it('多个依赖以逗号连接', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', jarName: 'a.jar' },
      { jarPath: 'hdfs:///jars', jarName: 'b.jar' },
      { jarPath: '/full/c.jar', jarName: 'c.jar' },
    ])).toBe('/opt/jars/a.jar,hdfs:///jars/b.jar,/full/c.jar');
  });

  it('无 jarPath 或无文件名的条目被忽略', () => {
    expect(buildJarsArg([
      { jarPath: '', jarName: 'a.jar' },
      { jarPath: '/opt/jars/', jarName: '' },
      { jarPath: '/opt/jars/', jarName: '  ' },
      {},
    ])).toBe('');
  });

  it('空输入返回空字符串', () => {
    expect(buildJarsArg([])).toBe('');
  });
});

describe('buildJarsArg — basePath/jarPath 组成', () => {
  it('basePath + jarPath 拼接（jarPath 为相对路径含文件名）', () => {
    expect(buildJarsArg([
      { basePath: '/opt/dataforge/jars', jarPath: 'udf/my-udf.jar' },
    ])).toBe('/opt/dataforge/jars/udf/my-udf.jar');
  });

  it('basePath 已带尾斜杠时不重复加 /', () => {
    expect(buildJarsArg([
      { basePath: 'hdfs:///user/jars/', jarPath: 'a.jar' },
    ])).toBe('hdfs:///user/jars/a.jar');
  });

  it('jarPath 带前导斜杠时去掉，避免 basePath 双斜杠', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: '/my-udf.jar' },
    ])).toBe('/opt/jars/my-udf.jar');
  });

  it('多个依赖 basePath/jarPath 以逗号连接', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: 'a.jar' },
      { basePath: 'hdfs:///jars', jarPath: 'udf/b.jar' },
    ])).toBe('/opt/jars/a.jar,hdfs:///jars/udf/b.jar');
  });

  it('有 basePath 时 jarPath 以 .jar 结尾同样按 basePath 拼接（而非当完整路径）', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: 'lib-b.jar' },
    ])).toBe('/opt/jars/lib-b.jar');
  });

  it('有 basePath 但无 jarPath 的条目被忽略', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: '' },
      { basePath: '/opt/jars' },
    ])).toBe('');
  });
});

describe('mapCodeFileToTask — 配置依赖通过 --jars 跟随提交', () => {
  const sparkScalaContent = `/*
 * @备注: 测试 Spark 任务
 * @引擎: spark
 * @数据源: test_datasource
 */
object TestApp {
  def main(args: Array[String]): Unit = {}
}`;

  const mkConfig = (dependencies: SavedConfig['dependencies']): SavedConfig => ({
    dependencies,
    programParams: [],
    taskParams: [],
  });

  it('SPARK 任务：依赖带 jarPath 时注入 --jars 到 others（basePath/jarPath 组成）', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'my-udf', version: '1.0', source: 'custom', basePath: '/opt/dataforge/jars', jarPath: 'udf/my-udf.jar' },
    ]));
    expect(mapping.taskType).toBe('SPARK');
    expect(mapping.taskParams.others).toBe('--jars /opt/dataforge/jars/udf/my-udf.jar');
    // 原有行为保持：依赖名仍进 resourceList
    expect(mapping.taskParams.resourceList).toContain('my-udf');
  });

  it('SPARK 任务：多个 custom jar 以逗号连接成单个 --jars', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'a', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'a.jar' },
      { id: 'd2', name: 'b', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'udf/b.jar' },
    ]));
    expect(mapping.taskParams.others).toBe('--jars /opt/jars/a.jar,/opt/jars/udf/b.jar');
  });

  it('SPARK 任务：custom 但无 jarPath（仅 Maven 坐标）时不注入 --jars', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'org.apache.spark:spark-sql_2.12:3.5.0', version: '', source: 'custom' },
    ]));
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });

  it('SPARK 任务：非 custom 来源（即使带 jarPath）不注入 --jars', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'spark-sql', version: '3.5.0', source: 'maven', jarPath: '/opt/jars/', jarName: 'spark-sql.jar' },
    ]));
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });

  it('FLINK 任务：即使依赖带 jarPath 也不注入 --jars', () => {
    const flinkJavaContent = `/*
 * @备注: 测试 Flink 任务
 * @引擎: flink
 * @数据源: test_datasource
 */
public class TestJob {
  public static void main(String[] args) {}
}`;
    const mapping = mapCodeFileToTask('TestJob.java', flinkJavaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'my-udf', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'my-udf.jar' },
    ]));
    expect(mapping.taskType).toBe('FLINK');
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });
});
