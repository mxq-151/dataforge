import { describe, it, expect } from 'vitest';
import { buildReferencedLibraries } from './referencedLibraries';

// 验证 JDT.LS referencedLibraries 设置的组装逻辑。
//
// 背景：第三方库「定义跳转」到 .class 反编译（而非 source jar 的 .java），根因是
// 推送 referencedLibraries 时只给了 include（裸 jar），没给 sources 映射。JDT.LS
// 只有在拿到 `sources: { 二进制jar: -sources.jar }` 时才会把源码附件挂到类路径条目上，
// 使 textDocument/definition 返回 jdt://…/xxx.jar/….java（源码）而非 ….class（反编译）。
// 本测试锁住 buildReferencedLibraries 的三种形态，防止回退成「只挂裸 jar」。

describe('buildReferencedLibraries（JDT.LS sources 映射组装）', () => {
  it('有源码映射时，输出 { include, sources }（跳转命中源码的关键）', () => {
    const include = ['/libs/guava-31.0.jar', '/libs/spark-sql_2.12-3.5.0.jar'];
    const sources = {
      '/libs/guava-31.0.jar': '/libs/guava-31.0-sources.jar',
    };
    const out = buildReferencedLibraries(include, sources);
    expect(out).toEqual({
      include,
      sources: {
        '/libs/guava-31.0.jar': '/libs/guava-31.0-sources.jar',
      },
    });
  });

  it('过滤掉键或值为空的无效源码映射', () => {
    const include = ['/libs/a.jar', '/libs/b.jar', '/libs/c.jar'];
    const out = buildReferencedLibraries(include, {
      '/libs/a.jar': '',          // 空值 → 过滤
      '': '/libs/x-sources.jar',  // 空键 → 过滤
      '/libs/b.jar': '/libs/b-sources.jar', // 有效 → 保留
    }) as { include: string[]; sources?: Record<string, string> };
    expect(out.sources).toEqual({ '/libs/b.jar': '/libs/b-sources.jar' });
  });

  it('无源码映射时，只输出 { include }，不携带 sources 字段', () => {
    const include = ['/libs/b.jar'];
    expect(buildReferencedLibraries(include, undefined)).toEqual({ include });
    expect(buildReferencedLibraries(include, {})).toEqual({ include });
  });

  it('include 为空时返回 []（与原语义一致，不携带 referencedLibraries）', () => {
    expect(buildReferencedLibraries([], { '/x.jar': '/x-sources.jar' })).toEqual([]);
  });
});
