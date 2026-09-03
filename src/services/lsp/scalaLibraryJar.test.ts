import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveScalaLibraryJar, compareVersions } from '../../../electron/backend/lspPom';

/**
 * scala-library 补挂选取逻辑（JDT.LS 类路径补挂）。
 *
 * 背景：Spark 等 Scala 写的库（SparkConf extends scala.Cloneable）在 JDT.LS（Java）
 * 下解析方法签名需要 scala-library.jar。它不在依赖目录（是传递依赖），需要从
 * .m2 / coursier 自动补挂，且版本要与 Spark 的 _2.12/_2.13 后缀匹配。
 */

/** 在 repoRoot 下造一个 fake scala-library 版本目录 */
function fakeVersion(repoRoot: string, version: string, withSources = false): void {
  const dir = path.join(repoRoot, 'org', 'scala-lang', 'scala-library', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `scala-library-${version}.jar`), 'fake');
  if (withSources) {
    fs.writeFileSync(path.join(dir, `scala-library-${version}-sources.jar`), 'fake');
  }
}

describe('resolveScalaLibraryJar（scala-library 补挂选取）', () => {
  let m2Root: string;
  let coursierRoot: string;

  beforeAll(() => {
    m2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-m2-'));
    coursierRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coursier-'));
    // .m2 里有 2.12.13 / 2.12.18 / 2.13.8（无 sources）
    fakeVersion(m2Root, '2.12.13');
    fakeVersion(m2Root, '2.12.18');
    fakeVersion(m2Root, '2.13.8');
    // coursier 里只有 2.13.18，且带 sources
    fakeVersion(coursierRoot, '2.13.18', true);
  });
  afterAll(() => {
    fs.rmSync(m2Root, { recursive: true, force: true });
    fs.rmSync(coursierRoot, { recursive: true, force: true });
  });

  it('类路径上有 _2.12 的 Spark → 选 2.12 系列最新（2.12.18），不混挂 2.13', () => {
    const hit = resolveScalaLibraryJar(
      ['C:/deps/spark-core_2.12-3.5.9.jar', 'C:/deps/other.jar'],
      undefined,
      [m2Root, coursierRoot],
    );
    expect(hit?.version).toBe('2.12.18');
  });

  it('类路径上有 _2.13 的库 → 选 2.13 系列最新（含 coursier 2.13.18）且附带 sources', () => {
    const hit = resolveScalaLibraryJar(
      ['C:/deps/spark-sql_2.13-4.0.0.jar'],
      undefined,
      [m2Root, coursierRoot],
    );
    expect(hit?.version).toBe('2.13.18');
    expect(hit?.sourcesJar).toBeTruthy();
    expect(hit?.sourcesJar).toContain('scala-library-2.13.18-sources.jar');
  });

  it('无 Scala 库后缀时 → 精确匹配项目 scalaVersion', () => {
    const hit = resolveScalaLibraryJar(['C:/deps/guava.jar'], '2.13.8', [m2Root, coursierRoot]);
    expect(hit?.version).toBe('2.13.8');
  });

  it('scalaVersion 精确版本不存在 → 同二进制系列取最新（2.13.99 → 2.13.18）', () => {
    const hit = resolveScalaLibraryJar(['C:/deps/guava.jar'], '2.13.99', [m2Root, coursierRoot]);
    expect(hit?.version).toBe('2.13.18');
  });

  it('完全无版本线索 → 任意可用最新', () => {
    const hit = resolveScalaLibraryJar(['C:/deps/guava.jar'], undefined, [m2Root, coursierRoot]);
    expect(hit?.version).toBe('2.13.18');
  });

  it('依赖目录已登记 scala-library → 不重复补挂', () => {
    const hit = resolveScalaLibraryJar(
      ['C:/deps/scala-library-2.12.18.jar', 'C:/deps/spark-core_2.12-3.5.9.jar'],
      undefined,
      [m2Root, coursierRoot],
    );
    expect(hit).toBeNull();
  });

  it('仓库根不存在 / 无可用版本 → 返回 null（不抛错，保持旧行为）', () => {
    expect(resolveScalaLibraryJar(['C:/deps/a.jar'], undefined, [])).toBeNull();
    expect(
      resolveScalaLibraryJar(['C:/deps/a.jar'], undefined, [path.join(os.tmpdir(), 'df-not-exist-xyz')]),
    ).toBeNull();
  });

  it('半成品版本目录（无 jar 文件）被忽略', () => {
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'df-broken-'));
    const dir = path.join(brokenRoot, 'org', 'scala-lang', 'scala-library', '9.9.9');
    fs.mkdirSync(dir, { recursive: true }); // 只有目录没有 jar
    fs.mkdirSync(path.join(brokenRoot, 'org', 'scala-lang', 'scala-library', 'not-a-version'), { recursive: true });
    expect(resolveScalaLibraryJar(['C:/deps/a.jar'], undefined, [brokenRoot])).toBeNull();
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  });
});

describe('compareVersions', () => {
  it('按数字段比较（非字符串比较）', () => {
    expect(compareVersions('2.13.18', '2.13.9')).toBeGreaterThan(0);
    expect(compareVersions('2.12.18', '2.13.1')).toBeLessThan(0);
    expect(compareVersions('2.12.18', '2.12.18')).toBe(0);
  });
});
