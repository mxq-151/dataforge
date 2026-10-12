/**
 * useOpencodeClient — OpenCode 业务通信门面
 *
 * 对外只暴露三样东西：Context 读取入口、按模块分派的 Provider、以及共享类型。
 * 实现按「公共运行时 + 模块工作空间」拆到 ./client/ 目录下：
 *
 * - client/types.ts                 共享类型与模块常量（OpencodeClientBackend 等）
 * - client/context.ts               Context 与 useOpencodeClient()
 * - client/workspace.ts             工作空间策略契约（两个模块差异的唯一落点）
 * - client/useConnectionRuntime.ts  连接 / 客户端 / 目录切换 / 闸门 / SSE 订阅 / 崩溃监听
 * - client/useModelContextLimit.ts  模型上下文窗口（SDK 查询 + 重试 + 兜底）
 * - client/useFileReview.ts         文件变更提取与审批
 * - client/useSessionHistory.ts     任务历史（本地优先 + 墓碑 + 服务端播种）
 * - client/useOpencodeClientCore.ts 公共运行时组装
 * - client/useOpencodeClientActions.ts 公共会话动作 + 对外实例组装
 * - client/devAssistantClient.tsx   开发助手智能体：固定工作目录
 * - client/dataExploreClient.tsx    数据探索智能体：会话 = 独立工作目录
 *
 * 两个模块的工作空间管理机制不同（见 client/workspace.ts 顶部说明），因此各自实现
 * 一个 Provider；这里只按 moduleId 分派。分派到不同组件类型还顺带保证了 moduleId
 * 变化时整棵子树重建，不会串用上一个模块的目录状态。
 */

import { DevAssistantClientProvider } from './client/devAssistantClient';
import { DataExploreClientProvider } from './client/dataExploreClient';
import { useOpencodeClient } from './client/context';
import { DATA_EXPLORE_MODULE_ID, type OpencodeClientProviderProps } from './client/types';

export { useOpencodeClient };
export type { OpencodeClientBackend, OpencodeClientProviderProps, TaskRecord } from './client/types';

/**
 * OpencodeClientProvider — 为单个 (moduleId, projectId) 创建并维护独立的 client 实例
 *
 * 每个 Provider 挂载一次对应模块的 client hook，保持 hook 状态不丢失。
 * 即使项目当前未激活（未显示），只要 Provider 仍在组件树中，状态就会被保留。
 */
export function OpencodeClientProvider(props: OpencodeClientProviderProps) {
  return props.moduleId === DATA_EXPLORE_MODULE_ID
    ? <DataExploreClientProvider {...props} />
    : <DevAssistantClientProvider {...props} />;
}

export default useOpencodeClient;
