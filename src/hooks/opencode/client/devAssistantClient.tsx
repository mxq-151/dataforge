/**
 * client/devAssistantClient.tsx — 开发助手智能体的 opencode client
 *
 * ── 工作空间模型：固定工作目录 ──
 * 一个项目 = 一个工作目录（project cwd）。Provider 传入的 directory 就是最终目录，
 * 所有会话共享同一个工作目录；AI 的读写、SSE 事件、会话都发生在该目录下。
 * 因此「新建会话」只在同一目录内开一个新会话，不涉及任何目录创建或切换，
 * 也就不需要数据探索那套「会话 ↔ 独立工作目录」的映射与清理逻辑。
 *
 * 该模型下策略的 5 个钩子全部为空操作（见 createFixedDirectoryStrategy），
 * 模块特有字段（dataExplore*）一律不下发 —— 界面层对它们的判断都是
 * `chatBackend.dataExploreXxx` 存在与否 / 空数组等价，因此行为与重构前一致。
 */

import { OpencodeClientContext } from './context';
import { useOpencodeClientCore } from './useOpencodeClientCore';
import { useOpencodeClientActions, useOpencodeClientValue } from './useOpencodeClientActions';
import { createFixedDirectoryStrategy, type WorkspaceStrategy } from './workspace';
import {
  DEFAULT_TASK_TYPE_BY_MODULE,
  DEV_ASSISTANT_MODULE_ID,
  type OpencodeClientProviderProps,
} from './types';

/** 固定工作目录策略无内部状态，可作模块级常量复用 */
const DEV_ASSISTANT_WORKSPACE: WorkspaceStrategy = createFixedDirectoryStrategy(DEV_ASSISTANT_MODULE_ID);

export function DevAssistantClientProvider({
  children,
  config,
  username,
  moduleId,
  roleType,
  projectId,
  directory,
}: OpencodeClientProviderProps) {
  const core = useOpencodeClientCore({
    config,
    username,
    moduleId,
    roleType,
    projectId,
    directory,
    defaultTaskType: DEFAULT_TASK_TYPE_BY_MODULE[DEV_ASSISTANT_MODULE_ID],
  });

  const workspace = DEV_ASSISTANT_WORKSPACE;
  const actions = useOpencodeClientActions(core, workspace);
  const value = useOpencodeClientValue(core, workspace, actions);

  return (
    <OpencodeClientContext.Provider value={value}>
      {children}
    </OpencodeClientContext.Provider>
  );
}
