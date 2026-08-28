export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export * from './opencode-backend';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  path: string;
}

export type ActiveTab = 'devAssist' | 'dataExplore' | 'indicatorManagement' | 'knowledgeBase' | 'fileBrowser' | 'scheduleManagement' | 'dataLineage' | 'systemManagement' | 'settings';

/**
 * 一级菜单 TabId → 后端权限码 的映射。
 *
 * 原定义在 components/layout/ActivityBar.tsx，但 AuthContext 需要用它判断超级管理员
 * 的默认菜单权限，导致 contexts 层反向依赖具体 UI 组件，并构成
 * ActivityBar ↔ AuthContext 的模块级循环依赖。下沉到 types 供各层共用，
 * ActivityBar 仍 re-export 以保持既有引用可用。
 */
export const MENU_CODE_MAP: Record<string, string> = {
  devAssist: 'dev_assist',
  dataExplore: 'data_explore',
  indicatorManagement: 'indicator_management',
  knowledgeBase: 'knowledge_base',
  fileBrowser: 'file_browser',
  scheduleManagement: 'schedule_management',
  dataLineage: 'data_lineage',
  systemManagement: 'system_management',
  settings: 'settings',
};

/** 全部一级菜单权限码（由 MENU_CODE_MAP 派生，避免两处各写一份字符串） */
export const FIRST_LEVEL_MENU_CODES: string[] = Object.values(MENU_CODE_MAP);

export interface StatusBarInfo {
  line: number;
  column: number;
  encoding: string;
  spaces: number;
  eol: string;
}

export interface Tab {
  id: string;
  name: string;
  path: string;
  isModified: boolean;
  /** 正在保存到磁盘 */
  isSaving?: boolean;
}

/**
 * 编辑器对外暴露的命令式句柄（forwardRef 暴露给父组件 / hook 调用）。
 *
 * 原定义在 components/editor/EditorArea.tsx，但 hooks/useProgramRunner 需要它，
 * 导致 hooks 层反向依赖具体组件。下沉到 types 供各层共用，EditorArea 仍 re-export
 * 以保持既有引用可用。
 */
export interface EditorAreaHandle {
  validateDataSource: () => { valid: boolean; message: string | null };
  blurEditor: () => void;
}
