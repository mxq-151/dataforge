/**
 * client/types.ts — OpencodeClient 的公共类型与模块常量
 *
 * 这里是「所有模块共享的对外契约」：OpencodeClientBackend 是界面层唯一依赖的接口，
 * 各模块 client（devAssistantClient / dataExploreClient）都返回同一形状。
 * 模块之间的差异不体现在这个接口上，而体现在 workspace 策略上（见 ./workspace.ts）。
 */

import type { ReactNode } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { DataExploreSessionService } from '../dataExploreSessionService';
import type { ContextUsage } from '../useOpencodeEvents';
import type {
  FileChange,
  LogEntry,
  MessageEntry,
  ModalRequest,
  OpenCodeConfig,
  Part,
  RetryState,
  Todo,
} from '../../../types/opencode-backend';

/** 数据探索模块标识（与 App.tsx 里 Provider 的 moduleId 一致） */
export const DATA_EXPLORE_MODULE_ID = 'data-explore';

/** 开发助手模块标识 */
export const DEV_ASSISTANT_MODULE_ID = 'dev-assistant';

/**
 * 各模块默认任务类型（决定系统指令）。
 * 数据探索默认数据分析，其他模块默认数仓设计。
 */
export const DEFAULT_TASK_TYPE_BY_MODULE: Record<string, string> = {
  [DATA_EXPLORE_MODULE_ID]: 'DATA_ANALYST',
  [DEV_ASSISTANT_MODULE_ID]: 'DATA_ARCHITECT',
};

/** 任务历史记录（从 SDK Session 映射） */
export interface TaskRecord {
  /** OpenCode session ID */
  sessionId: string;
  /** 任务名称 */
  title: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
}

export interface OpencodeClientBackend {
  messages: MessageEntry[];
  busy: boolean;
  busyLabel: string | undefined;
  /** retry 状态（session.status 事件 type==='retry' 时设置） */
  retry: RetryState | null;
  ready: boolean;
  connected: boolean;
  error: string | null;
  modals: ModalRequest[];
  logs: LogEntry[];
  currentSessionId: string | null;
  /**
   * 当前会话是否为子代理会话（opencode 会话树中带 parentID 的子会话）。
   * 为 true 时，其首条用户消息是主会话注入的子代理任务 prompt，
   * 时间线需把它标注为「子代理任务」而不是用户输入。
   */
  currentSessionIsSubagent: boolean;
  lastFileChangeSeq: number;
  lastFileChangePaths: string[];
  todos: Todo[];
  /** 文件变更列表（来自 edit/write/apply_patch 工具） */
  fileChanges: FileChange[];
  /** 审批文件变更（按 partID 标识具体变更） */
  approveFileChange: (partID: string) => void;
  /** 拒绝文件变更（含变更详情，用于调用 SDK revert API 回退文件） */
  rejectFileChange: (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => void | Promise<void>;
  /** 全部审批通过 */
  approveAllFileChanges: () => void;
  /** 当前会话的 token 使用情况 */
  contextUsage: ContextUsage;
  /** 本地任务历史列表 */
  tasks: TaskRecord[];

  /** 数据探索：会话工作目录标签页列表（会话=标签页，仅"已打开"的目录） */
  dataExploreDirs?: Array<{ dir: string; filePath: string }>;
  /** 数据探索：会话目录版本号（打开/关闭/新建/删除会话时递增，驱动编辑器标签页同步） */
  dataExploreDirsVersion?: number;
  /** 数据探索：删除会话（同时删除其 individual/{timestamp} 目录与 opencode 会话） */
  dataExploreDeleteSession?: (dir: string) => Promise<void>;
  /** 数据探索：任务（用户对话）→ 工作目录 SQL 文件（供任务下拉勾选打开，仅已关联会话） */
  dataExploreTaskFiles?: Array<{ sessionId: string; dir: string; filePath: string; title: string }>;
  /** 数据探索：勾选/取消勾选任务 → 打开/关闭对应文件标签（不动 AI 工作目录） */
  dataExploreToggleSession?: (sessionId: string) => void;
  /** 数据探索：关闭指定目录的文件标签（编辑器关标签用，不删会话/目录） */
  dataExploreCloseFile?: (dir: string) => void;

  sendMessage: (line: string) => Promise<void>;
  sendInterrupt: () => Promise<void>;
  sendRollback: (messageId: string) => Promise<{ success: boolean }>;
  sendPermissionResponse: (requestId: string, response: 'once' | 'always' | 'reject') => void;
  /** 回复提问请求 */
  sendQuestionReply: (requestId: string, answers: string[][]) => void;
  /** 拒绝提问请求 */
  sendQuestionReject: (requestId: string) => void;
  /**
   * 压缩当前会话的历史消息。
   * 调用 OpenCode session.summarize API；操作开始/结束会在对话区显示系统提示。
   * 压缩进行中返回 true 表示请求已发出（实际结果会通过 session.compacted 事件回传）。
   */
  compressSession: () => Promise<{ success: boolean }>;
  /** 当前是否正在执行压缩操作（按钮 disabled / loading 状态） */
  compressing: boolean;
  clearLogs: () => void;

  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: () => Promise<import('../../../types/opencode-backend').Session[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** 重命名任务（通过 SDK session.update 更新标题） */
  renameTask: (sessionId: string, newTitle: string) => Promise<void>;

  /** 启动服务并连接（使用 provider 的 directory） */
  start: (cwd?: string) => Promise<void>;
  /** 连接到已运行的服务（使用 provider 的 directory） */
  connect: (serverUrl?: string) => Promise<void>;
  /** 断开连接 */
  disconnect: () => void;

  /** 切换工作目录（重建客户端连接） */
  setWorkingDirectory: (cwd: string | undefined | null) => Promise<void>;
  /** 当前工作目录 */
  currentDirectory: string | null;
  /** 是否正在启动中（防止 start() 过程中的 connected 状态翻转触发重复调用） */
  starting: boolean;
  /**
   * 设置当前激活的 LLM 模型（用于运行时切换）。
   * 后续 sendMessage / compressSession 调用将使用该模型，覆盖服务端默认配置。
   * 传入 null 清除覆盖，回退到服务端配置。
   */
  setActiveLLMModel: (model: { providerID: string; modelID: string } | null) => void;
  /** 当前激活的 LLM 模型（null 表示使用服务端默认配置） */
  activeLLMModel: { providerID: string; modelID: string } | null;

  /** 任务类型（覆盖角色，决定系统指令；默认 DATA_ARCHITECT 数仓设计） */
  taskType: string;
  /** 切换任务类型 */
  setTaskType: (t: string) => void;

  /** 当前 OpencodeClient 实例（连接后可用，供时间线和 SubagentTaskCard 调用 API） */
  client: OpencodeClient | null;
  /**
   * 读取 part 的流式文本（对齐桌面版 part_text_accum_delta）。
   * 流式过程中返回 delta 累积值，流式结束后返回 part.text 全量值。
   */
  readPartText: (partID: string, part: Part) => string;
  /**
   * 订阅指定 part 的流式文本变化。
   * 用于把逐字增长的重渲染范围收缩到该 part 自身（见 useOpencodeEvents）。
   */
  subscribePartText: (partID: string, listener: () => void) => () => void;
}

export interface OpencodeClientProviderProps {
  children: ReactNode;
  config: OpenCodeConfig;
  username?: string;
  moduleId: string;
  roleType?: string;
  projectId: string;
  /** 工作目录（项目路径），用于创建 OpencodeClient 时指定 directory */
  directory?: string | null;
  /** 数据探索会话目录服务（各模块计算好独立工作目录路径后注入，实现解耦） */
  dataExploreService?: DataExploreSessionService | null;
}
