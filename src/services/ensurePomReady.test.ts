import { describe, it, expect } from 'vitest';
import { detectScalaBinary, SCALA_LIBRARY_BY_BINARY } from './ensurePomReady';

/**
 * scala-library 版本推导（ensurePomReady 用）。
 *
 * 根因：pom 里 scala-library 版本若与 Spark 的二进制版本（_2.12/_2.13）不匹配，
 * 例如 Spark 3.5.9(_2.12) + scala-library 2.13.18，JDT.LS 悬停 Spark API 报
 * "The type scala.Cloneable cannot be resolved. It is indirectly referenced from ..."。
 * 必须按 Spark 的 `_2.12` 后缀把 scala-library 校正到 2.12.x。
 */

describe('detectScalaBinary（从依赖记录推断 Scala 二进制版本）', () => {
  it('spark-core_2.12 → 2.12', () => {
    expect(detectScalaBinary([{ artifactId: 'spark-core_2.12' }])).toBe('2.12');
  });
  it('spark-sql_2.13 → 2.13', () => {
    expect(detectScalaBinary([{ artifactId: 'spark-sql_2.13', jarName: 'spark-sql_2.13-4.1.1.jar' }])).toBe('2.13');
  });
  it('带版本后缀的 jarName（spark-core_2.12-3.5.9.jar）→ 2.12', () => {
    expect(detectScalaBinary([{ jarName: 'spark-core_2.12-3.5.9.jar' }])).toBe('2.12');
  });
  it('scala-library-2.13.18（无下划线二进制后缀）不误判', () => {
    expect(detectScalaBinary([{ artifactId: 'scala-library', jarName: 'scala-library-2.13.18.jar' }])).toBeUndefined();
  });
  it('纯 Java 依赖（mysql/postgresql）→ undefined', () => {
    expect(detectScalaBinary([{ artifactId: 'mysql-connector-j' }, { artifactId: 'postgresql' }])).toBeUndefined();
  });
  it('空列表 → undefined', () => {
    expect(detectScalaBinary([])).toBeUndefined();
  });
});

describe('SCALA_LIBRARY_BY_BINARY 版本映射', () => {
  it('2.12 → 2.12.18（Spark 3.5 官方构建版本）', () => {
    expect(SCALA_LIBRARY_BY_BINARY['2.12']).toBe('2.12.18');
  });
  it('2.13 → 2.13.18', () => {
    expect(SCALA_LIBRARY_BY_BINARY['2.13']).toBe('2.13.18');
  });
});
