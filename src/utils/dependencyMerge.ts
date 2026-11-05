/**
 * 依赖合并工具。
 *
 * 项目级依赖作为「默认」依赖集合，逐文件依赖在其基础上追加；相同 name（artifactId）
 * 的依赖按集合去重（版本统一由后端依赖目录解析，此处仅按名字合并）。
 */

export interface DependencyItemLite {
  id: string;
  name: string;
  version?: string;
  source?: string;
}

/**
 * 将项目级依赖与逐文件依赖合并为去重后的 name 列表。
 * 顺序：先项目级后逐文件，逐文件可覆盖/追加同名依赖。
 */
export function mergeDependencyNames(
  projectDeps: DependencyItemLite[] = [],
  fileDeps: DependencyItemLite[] = []
): string[] {
  const names = new Set<string>();
  for (const d of projectDeps) {
    if (d.name) names.add(d.name);
  }
  for (const d of fileDeps) {
    if (d.name) names.add(d.name);
  }
  return Array.from(names);
}
