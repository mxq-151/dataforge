/**
 * 根据文件名获取对应的编辑器语言标识
 */
export const getLanguageFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    md: 'markdown',
    py: 'python',
    java: 'java',
    scala: 'scala',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sh: 'shell',
    bash: 'shell',
    txt: 'plaintext',
  };

  return languageMap[ext || ''] || 'plaintext';
};

/**
 * 判断是否为 Markdown 文件
 */
export const isMarkdownFile = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
};

/**
 * 判断当前 Tab 是否支持「重命名符号」。
 *
 * 与 VS Code 的 editor.action.rename 前置条件（writable && hasRenameProvider）对齐：
 * - 仅 Java / Scala（分别由 JDT.LS / Metals 提供 renameProvider，其余语言无 LSP 重命名能力）
 * - 依赖源码只读 Tab（metals:/jdt:/.metals/readonly）不可写，不可重命名
 */
export const supportsRename = (language: string, isVirtualSourceTab: boolean): boolean => {
  if (isVirtualSourceTab) return false;
  return language === 'java' || language === 'scala';
};

/**
 * 重命名输入框键盘兜底：把 keydown 映射为要触发的编辑器命令。
 *
 * 背景：本应用的 overflowWidgetsDomNode 被放到 body 级容器，导致 rename widget
 * （allowEditorOverflow=true）脱离编辑器 DOM 树，Monaco keybinding 服务的
 * findContextAttr(target) 沿 parentElement 查不到编辑器 scoped context，Enter/Escape
 * 的 keybinding 无法触发。这里在捕获阶段兜底，与 VS Code 的重命名回车确认/Escape 取消一致：
 * - Enter（非 Shift）→ acceptRenameInput（确认重命名并关闭输入框）
 * - Escape → cancelRenameInput（取消重命名并关闭输入框）
 * - 其他按键 → null（不干预，交给编辑器/输入框默认处理）
 */
export type RenameKeyAction = 'accept' | 'cancel' | null;

export const resolveRenameKeyAction = (key: string, shiftKey: boolean): RenameKeyAction => {
  if (key === 'Enter' && !shiftKey) return 'accept';
  if (key === 'Escape') return 'cancel';
  return null;
};
