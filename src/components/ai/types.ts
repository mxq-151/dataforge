/**
 * AI 组件类型定义
 *
 * 从 useOpencodeClient 重新导出 OpencodeClientBackend 接口，
 * 供 DevAssistantView / DataExploreView 等消费方使用。
 */

export type { OpencodeClientBackend } from '../../hooks/opencode/useOpencodeClient';
export type { LLMModelConfig } from '../../types/opencode-backend';

export interface AIPanelProps {
  chatBackend: import('../../hooks/opencode/useOpencodeClient').OpencodeClientBackend;
  /** 用户配置的 LLM 模型列表（用于运行时切换） */
  llmModels?: import('../../types/opencode-backend').LLMModelConfig[];
  onRollback?: (messageId: string) => Promise<void>;
  /** 打开文件到编辑器（用于 FileReviewPanel 的跳转按钮） */
  onOpenFile?: (filePath: string) => void;
  /** 在编辑器中查看变更 diff */
  onViewDiff?: (filePath: string, patch: string) => void;
  moduleId: string;
  projectId: string;
  /** 文件树（仅开发助手模块传入，用于输入框文件名自动补全） */
  fileTree?: import('../../types').FileNode[];
}
