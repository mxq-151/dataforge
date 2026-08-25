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
