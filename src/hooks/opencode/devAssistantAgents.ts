/**
 * 开发助手子代理名称（渲染进程侧入口）。
 *
 * 名称与定义的单一事实源在 electron/backend/devAssistantAgents.ts（服务端注册表，
 * 零依赖纯常量）。历史约束是 electron 的 tsconfig rootDir 锁在 electron/、不能
 * import src；反向没有限制——渲染侧由 vite 构建、无 rootDir，可以直接 import 这个
 * 纯常量文件。因此这里不再重复定义名称，只做 re-export：两侧一致性由编译期保证，
 * 不再依赖测试断言兜底。
 *
 * 本文件额外维护 DEV_ASSISTANT_SUBAGENT_NAMES 字面量元组与派生类型，
 * 供提示词插值、类型标注与注册完整性断言使用。
 */

import {
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
} from '../../../electron/backend/devAssistantAgents';

export {
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
};

/** 全部已注册子代理名称（顺序无意义，仅供一致性断言与提示词列举） */
export const DEV_ASSISTANT_SUBAGENT_NAMES = [
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_ANALYSIS_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
  AGENT_REQUIREMENT_VERIFIER,
] as const;

export type DevAssistantSubagentName = (typeof DEV_ASSISTANT_SUBAGENT_NAMES)[number];
