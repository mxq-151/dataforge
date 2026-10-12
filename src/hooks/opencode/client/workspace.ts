/**
 * client/workspace.ts — 「工作空间」策略契约：两个模块的智能体差异的唯一落点
 *
 * 背景：开发助手与数据探索的智能体对工作空间的管理机制完全不同 ——
 *
 * - 开发助手：**固定工作目录**。一个项目 = 一个目录（project cwd），Provider 的
 *   directory 就是最终目录，会话之间共享同一个工作目录；AI 的读写、SSE 事件、
 *   会话全部发生在该目录下。因此它对下面所有钩子都是空操作。
 *
 * - 数据探索：**会话 = 独立工作目录**。「新建会话」会新建 individual/{timestamp}
 *   目录并把它设为 AI 的工作目录，会话与其目录一一对应（映射持久化在 localStorage）。
 *   发消息前必须先把连接切到该会话的目录，否则 SSE 事件发往会话目录、前端按
 *   「事件目录 == 订阅目录」过滤后整条丢弃（用户消息有本地回显、智能体回复不上屏）。
 *
 * 把这套差异收敛成 WorkspaceStrategy 的 5 个钩子，公共运行时（useOpencodeClientCore）
 * 只按钩子调用，不再出现 `if (moduleId === 'data-explore')` 的散点分支。
 *
 * ── 调用时序 ──
 * 钩子只在异步动作里被调用（发送消息 / 新建会话 / 删除会话 / 连接状态变化），
 * 不会在渲染期调用，因此策略内部一律通过 ctxRef 读取当前值，避免闭包读到旧快照。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { LogEntry } from '../../../types/opencode-backend';
import type { OpencodeClientBackend, TaskRecord } from './types';

/**
 * 公共运行时暴露给工作空间策略的能力。
 * 由 useOpencodeClientCore 在每次渲染时刷新（挂在一个 ref 上），
 * 策略只读它的当前值，因此策略自身的 useCallback 依赖是稳定的（不会随渲染抖动）。
 */
export interface WorkspaceContext {
  moduleId: string;
  username?: string;
  /** 当前连接的工作目录（策略判断「是否需要切目录」的基准） */
  readonly currentDirectory: string | null;
  /** 切换连接的工作目录（内部会重建客户端并清理会话态） */
  setWorkingDirectory: (cwd: string) => Promise<void>;
  /** 当前会话（策略在切目录后判断是否需要恢复） */
  readonly currentSessionId: string | null;
  /** 恢复会话标识（切目录会清空会话态，数据探索续聊时用它切回来） */
  restoreSession: (sessionId: string | null) => void;
  /** 清空当前会话（含子代理标记） */
  clearCurrentSession: () => void;
  /** 任务列表（本地会话历史） */
  readonly tasks: TaskRecord[];
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  /** 会话历史存储 key：{host}/{user}/{module}/{project} */
  readonly sessionHistoryKey: string;
  /** 当前 SDK 客户端（未连接时为 null） */
  readonly clientRef: MutableRefObject<OpencodeClient | null>;
  /** 删除服务端会话（fire-and-forget：不阻塞 UI、失败不回滚本地结果） */
  deleteSessionRemote: (sessionId: string) => void;
  /** 写应用内日志面板 */
  addLog: (entry: LogEntry) => void;
}

/**
 * 工作空间策略：开发助手与数据探索各自实现一份。
 * 所有钩子都必须幂等且容忍「未连接 / 无服务」场景（内部自行 return）。
 */
export interface WorkspaceStrategy {
  /** 模块标识（日志与调试用） */
  readonly moduleId: string;

  /**
   * 首条消息且尚无会话时调用：确保 opencode 工作目录已经落到
   * 「本次对话应当使用的目录」。
   * 开发助手：固定目录，无需处理。数据探索：确保 individual/{ts} 已建好并切过去。
   */
  prepareNewSessionDirectory: () => Promise<void>;

  /**
   * 续聊「已存在的会话」前调用：把连接切回该会话所属的工作目录。
   * 开发助手：固定目录，无需处理。
   */
  ensureSessionDirectory: (sessionId: string) => Promise<void>;

  /** 「新建会话」按钮：开发助手只清空会话态；数据探索另建目录并切过去 */
  onNewSession: () => Promise<void>;

  /** opencode 会话创建成功后调用（数据探索在此建立 会话 ↔ 目录 关联） */
  onSessionCreated: (sessionId: string) => void;

  /** 会话被删除时调用（在删除服务端会话之前；数据探索在此清理目录与标签页） */
  onSessionDeleted: (sessionId: string) => void;

  /** 模块特有的额外对外字段（数据探索的 dirs / 标签页 / 任务文件等） */
  extras?: Partial<OpencodeClientBackend>;
}

/** 固定工作目录（开发助手）的策略：除标识外全部为空操作 */
export function createFixedDirectoryStrategy(moduleId: string): WorkspaceStrategy {
  return {
    moduleId,
    prepareNewSessionDirectory: async () => { /* 固定目录：无需处理 */ },
    ensureSessionDirectory: async () => { /* 固定目录：无需处理 */ },
    onNewSession: async () => { /* 固定目录：仅由运行时清空会话态 */ },
    onSessionCreated: () => { /* 固定目录：无需关联 */ },
    onSessionDeleted: () => { /* 固定目录：无目录可清理 */ },
  };
}
