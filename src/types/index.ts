export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export * from './opencode-backend';

export interface EditorState {
  language: string;
  value: string;
  cursorPosition: { line: number; column: number };
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  path: string;
}

export interface PanelConfig {
  aiPanel: {
    isOpen: boolean;
    width: number;
  };
  editorPanel: {
    isMinimapVisible: boolean;
    fontSize: number;
  };
  explorerPanel: {
    isOpen: boolean;
    width: number;
  };
}

export type ActiveTab = 'devAssist' | 'dataExplore' | 'indicatorManagement' | 'knowledgeBase' | 'fileBrowser' | 'scheduleManagement' | 'dataLineage' | 'systemManagement' | 'settings';

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
