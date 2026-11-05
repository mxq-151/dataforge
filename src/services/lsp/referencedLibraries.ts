/**
 * JDT.LS `java.project.referencedLibraries` 设置的构造工具。
 *
 * 背景：JDT.LS 对「定义跳转」到第三方库类时，若该二进制 jar 没有源码附件，
 * 只会返回 jdt://…jar/….class，前端只能用 FernFlower 反编译字节码（表现为
 * 「跳到 .class 反编译内容」而不是 source jar 里的 .java）。要让跳转直接命中
 * 源码，必须通过 referencedLibraries 的 `sources` 字段把「二进制 jar → 源码 jar」
 * 的映射传给 JDT.LS（官方格式：`sources: { "/path/lib.jar": "/path/lib-sources.jar" }`）。
 *
 * 本模块只负责把「include 列表 + 已解析出的源码映射」组装成符合 JDT.LS 期望的
 * 设置对象，不涉及任何文件系统访问（源码 jar 的解析在主进程 resolve_jar_sources
 * 完成），因此可被单元测试纯逻辑覆盖。
 */

export interface ReferencedLibrariesSources {
  /** 二进制 jar 路径 → 对应 -sources.jar 路径 */
  [binaryJar: string]: string;
}

export interface ReferencedLibrariesSetting {
  include: string[];
  /** 仅当存在「确实可用的源码 jar」时才携带；值为空则不输出该字段 */
  sources?: ReferencedLibrariesSources;
}

/**
 * 组装 referencedLibraries 设置。
 *
 * @param include 二进制 jar 路径列表（已由主进程 resolve_jar_sources 展开为真实 jar 文件）
 * @param sources 二进制 jar → 源码 jar 的映射（可能为空）
 * @returns include 为空时返回 `[]`（与原语义一致：不携带 referencedLibraries）；
 *          否则返回 `{ include }`（无源码）或 `{ include, sources }`（有源码）。
 *          源码映射会过滤掉键或值为空的条目，避免把无效路径塞给 JDT.LS。
 */
export function buildReferencedLibraries(
  include: string[],
  sources?: ReferencedLibrariesSources,
): ReferencedLibrariesSetting | string[] {
  if (include.length === 0) return [];

  const cleanSources: ReferencedLibrariesSources = {};
  if (sources) {
    for (const [binaryJar, sourceJar] of Object.entries(sources)) {
      if (binaryJar && sourceJar) {
        cleanSources[binaryJar] = sourceJar;
      }
    }
  }

  if (Object.keys(cleanSources).length === 0) {
    return { include };
  }
  return { include, sources: cleanSources };
}
