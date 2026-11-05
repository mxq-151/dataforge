/**
 * 开发助手子代理名称（渲染进程侧）。
 *
 * 提示词里要按名字指挥主智能体用 task 工具分派子代理，名字写错等于分派失败，
 * 而真正的 agent 定义在 electron 侧（opencode 配置注入，见
 * electron/backend/devAssistantAgents.ts）。两处无法共享同一份代码
 * （electron 的 tsconfig rootDir 锁在 electron/，import src 会让编译产物路径错乱），
 * 因此这里只保留**名称**，并用 devAssistantAgents.test.ts 断言两侧逐字一致。
 */

/** 数仓设计子代理：一张表一份设计片段，不写文件 */
export const AGENT_DATA_ARCHITECT = 'data-architect';

/** 数据开发子代理：一张目标表的处理程序 + 质检程序，直接落盘 */
export const AGENT_DATA_DEV = 'data-dev';

/** 全部已注册子代理名称（顺序无意义，仅供一致性断言与提示词列举） */
export const DEV_ASSISTANT_SUBAGENT_NAMES = [
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
] as const;

export type DevAssistantSubagentName = (typeof DEV_ASSISTANT_SUBAGENT_NAMES)[number];
