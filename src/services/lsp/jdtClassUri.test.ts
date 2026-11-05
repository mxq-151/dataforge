import { describe, it, expect } from 'vitest';
import { parseJdtClassUri, classNameToScalaPath } from './jdtClassUri';

describe('parseJdtClassUri（jdt:// URI 解析）', () => {
  it('解析第三方库 jar 的类文件 URI', () => {
    const r = parseJdtClassUri(
      'jdt://contents/spark-sql_2.12-3.5.9.jar/org.apache.spark.sql/SparkSession.class?=myproj',
    );
    expect(r).not.toBeNull();
    expect(r!.jarName).toBe('spark-sql_2.12-3.5.9.jar');
    expect(r!.className).toBe('org.apache.spark.sql.SparkSession');
    expect(r!.isJar).toBe(true);
  });

  it('解析 JDK 模块（java.base 等非 .jar 目标）', () => {
    const r = parseJdtClassUri('jdt://contents/java.base/java.lang/String.class?=myproj');
    expect(r).not.toBeNull();
    expect(r!.jarName).toBe('java.base');
    expect(r!.className).toBe('java.lang.String');
    expect(r!.isJar).toBe(false);
  });

  it('无 query 部分也能解析', () => {
    const r = parseJdtClassUri('jdt://contents/a.jar/x/Y.class');
    expect(r!.jarName).toBe('a.jar');
    expect(r!.className).toBe('x.Y');
    expect(r!.isJar).toBe(true);
  });

  it('非 jdt: scheme 返回 null', () => {
    expect(parseJdtClassUri('file:///home/u/Foo.java')).toBeNull();
    expect(parseJdtClassUri('')).toBeNull();
  });

  it('格式异常（无 jarName 或无类路径）返回 null', () => {
    expect(parseJdtClassUri('jdt://contents//Foo.class')).toBeNull();
    expect(parseJdtClassUri('jdt://contents/a.jar/')).toBeNull();
    expect(parseJdtClassUri('jdt://notcontents/a.jar/x/Y.class')).toBeNull();
  });
});

describe('classNameToScalaPath（类名 → sources jar 内 .scala 路径）', () => {
  it('顶层类名直接映射', () => {
    expect(classNameToScalaPath('org.apache.spark.sql.SparkSession')).toBe(
      'org/apache/spark/sql/SparkSession.scala',
    );
  });

  it('内部类（含 $）归到外部类的 .scala 文件', () => {
    expect(classNameToScalaPath('org.apache.spark.sql.Dataset$RowEncoder')).toBe(
      'org/apache/spark/sql/Dataset.scala',
    );
  });

  it('空类名返回 null', () => {
    expect(classNameToScalaPath('')).toBeNull();
  });
});
