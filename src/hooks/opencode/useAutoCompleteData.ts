/**
 * useAutoCompleteData — 收集自动补全候选数据
 *
 * 数据来源：
 * - 库表名：从 DataSourceContext 获取所有数据源下的表名和列名
 * - 文件名：从 DevAssistantView 传入的 fileTree 中提取文件节点
 *
 * 触发方式：用户输入 @ 时弹出候选列表，继续输入过滤匹配项。
 */

import { useMemo } from 'react';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import type { FileNode } from '../../types';

export interface AutoCompleteItem {
  label: string;       // 显示名称
  detail?: string;     // 附加信息（如列类型、文件路径）
  kind: 'table' | 'column' | 'file';
  insertText: string;  // 插入到输入框的文本
}

/**
 * 计算相对于工作空间的路径，用于自动补全显示。
 * 例：fullPath="/Users/mxq/.dataforge/warehouse/test_project/docs/readme.md"
 *    workspacePath="/Users/mxq/.dataforge/warehouse/test_project"
 *    → "docs/readme.md"
 * 若无 workspacePath 或不匹配前缀，返回原 fullPath。
 */
function relativeToWorkspace(fullPath: string, workspacePath?: string): string {
  if (!workspacePath) return fullPath;
  const base = workspacePath.replace(/\/+$/, '');
  if (fullPath.startsWith(base + '/')) {
    return fullPath.slice(base.length + 1);
  }
  return fullPath;
}

/** 从 FileNode 树中递归提取所有文件节点 */
function collectFiles(nodes: FileNode[], workspacePath?: string): AutoCompleteItem[] {
  const items: AutoCompleteItem[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      // label 和 insertText 均使用工作空间后的相对路径（如 docs/readme.md）
      const relative = relativeToWorkspace(node.path, workspacePath);
      items.push({
        label: relative,
        kind: 'file' as const,
        insertText: relative,
      });
    }
    if (node.type === 'folder' && node.children) {
      items.push(...collectFiles(node.children, workspacePath));
    }
  }
  return items;
}

/**
 * 收集自动补全候选数据
 * @param fileTree 文件树（仅开发助手模块传入）
 * @param workspacePath 工作空间路径（用于文件显示时截取相对路径）
 */
export function useAutoCompleteData(fileTree?: FileNode[], workspacePath?: string): AutoCompleteItem[] {
  const { dataSources, tablesMap } = useDataSourceCache();

  return useMemo(() => {
    const items: AutoCompleteItem[] = [];

    // 1. 收集所有表名和列名
    for (const ds of dataSources) {
      // tablesMap 的 key 格式为 `${userId}:${datasourceId}`，遍历所有匹配的 key
      for (const [key, tables] of Object.entries(tablesMap)) {
        if (!key.endsWith(`:${ds.id}`)) continue;
        for (const table of tables) {
          // 表的补全文本带库名（databaseName.tableName），便于智能体定位表
          const qualifiedName = table.databaseName
            ? `${table.databaseName}.${table.tableName}`
            : table.tableName;
          // 添加表名
          items.push({
            label: qualifiedName,
            detail: table.tableComment || ds.datasourceName,
            kind: 'table' as const,
            insertText: qualifiedName,
          });
          // 添加列名
          if (table.columns) {
            for (const col of table.columns) {
              items.push({
                label: col.columnName,
                detail: col.columnType || col.columnComment || qualifiedName,
                kind: 'column' as const,
                insertText: col.columnName,
              });
            }
          }
        }
      }
    }

    // 2. 收集文件名（仅开发助手模块）
    if (fileTree && fileTree.length > 0) {
      items.push(...collectFiles(fileTree, workspacePath));
    }

    return items;
  }, [dataSources, tablesMap, fileTree, workspacePath]);
}

export default useAutoCompleteData;
