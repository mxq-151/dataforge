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

export type ActiveTab = 'devAssist' | 'dataExplore' | 'indicatorManagement' | 'knowledgeBase' | 'fileBrowser' | 'scheduleManagement' | 'dataLineage' | 'assetCatalog' | 'systemManagement' | 'settings';

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
  assetCatalog: 'asset_catalog',
  systemManagement: 'system_management',
  settings: 'settings',
};

/** 全部一级菜单权限码（由 MENU_CODE_MAP 派生，避免两处各写一份字符串） */
export const FIRST_LEVEL_MENU_CODES: string[] = Object.values(MENU_CODE_MAP);

/**
 * 一级菜单 Tab 的挂载与展示顺序。
 *
 * 由 MENU_CODE_MAP 的键派生，而不是另写一份字面量数组 —— 原先 App.tsx 里有一份
 * FIRST_LEVEL_TAB_IDS 字面量，与 MENU_CODE_MAP 是「两个列表描述同一件事」：
 * 新增 tab 时只要漏改其中一处，就会走到 `MENU_CODE_MAP[tab.id] === undefined`
 * 的分支，入口被静默过滤掉（界面无报错、代码看起来也对）。
 * 派生后这个失效模式在结构上不再可能发生，顺序即 MENU_CODE_MAP 的键书写顺序。
 */
export const FIRST_LEVEL_TAB_IDS: ActiveTab[] = Object.keys(MENU_CODE_MAP) as ActiveTab[];

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
