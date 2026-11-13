/**
 * OpenCode 系统指令入口。
 *
 * 提示词已按任务类型拆分到 ./prompts/ 下，公共契约集中在 ./prompts/shared.ts。
 * 本文件只保留导出面与按角色/模块分发，不再承载任何提示词正文。
 *
 * 子代理名称常量来自 ./devAssistantAgents.ts（单一事实源在
 * electron/backend/devAssistantAgents.ts，此处经 re-export 引用），
 * 提示词插值与服务端注册表因此共享同一份名称，不存在双份定义。
 */

import { BUSINESS_REQUESTER_INSTRUCTIONS } from './prompts/businessRequester';
import { DATA_ARCHITECT_INSTRUCTIONS } from './prompts/dataArchitect';
import { DATA_DEV_ENGINEER_INSTRUCTIONS } from './prompts/dataDevEngineer';
import { DATA_WAREHOUSE_DEV_INSTRUCTIONS } from './prompts/warehouseDev';
import { getDataAnalystInstructions } from './prompts/dataAnalyst';
import { SUPER_ADMIN_INSTRUCTIONS } from './prompts/systemOps';
import {
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
} from './devAssistantAgents';

export { BUSINESS_REQUESTER_INSTRUCTIONS } from './prompts/businessRequester';
export { DATA_ARCHITECT_INSTRUCTIONS } from './prompts/dataArchitect';
export { DATA_DEV_ENGINEER_INSTRUCTIONS } from './prompts/dataDevEngineer';
export { DATA_WAREHOUSE_DEV_INSTRUCTIONS } from './prompts/warehouseDev';
export { getDataAnalystInstructions } from './prompts/dataAnalyst';
export { SUPER_ADMIN_INSTRUCTIONS } from './prompts/systemOps';

export type RoleType =
  | 'SUPER_ADMIN'
  | 'DATA_ARCHITECT'
  | 'DATA_DEV_ENGINEER'
  | 'DATA_WAREHOUSE_DEV'
  | 'BUSINESS_REQUESTER'
  | 'DATA_ANALYST';

/** 可在设置页配置提示词的任务类型（与任务类型下拉框的可选项一致） */
export interface TaskPromptDefinition {
  /** 任务类型 key，与 RoleType 一致，也是自定义提示词的存储 key */
  key: RoleType;
  /** 设置页展示名 */
  label: string;
  /** 适用场景说明 */
  description: string;
  /** 该任务会派生的子代理（按编排顺序），用于设置页按 agent 名称分块配置 */
  subagents: readonly string[];
  /** 内置默认提示词；传入 '{{username}}' 可保留用户名占位符 */
  defaultPrompt: (username: string) => string;
}

/**
 * 任务提示词清单：设置页「智能体提示词」标签页的单一数据源。
 * 默认正文直接引用各任务模块的常量，避免设置页内置一份、发送时另一份。
 */
export const TASK_PROMPT_DEFINITIONS: readonly TaskPromptDefinition[] = [
  {
    key: 'BUSINESS_REQUESTER',
    label: '需求编写',
    description: '开发助手 · 需求文档编写 → 文档校验 → 重写 → 复验',
    subagents: [AGENT_DATA_RETRIEVER, AGENT_REQUIREMENT_WRITER, AGENT_REQUIREMENT_VERIFIER],
    defaultPrompt: () => BUSINESS_REQUESTER_INSTRUCTIONS,
  },
  {
    key: 'DATA_WAREHOUSE_DEV',
    label: '数仓开发',
    description: '开发助手 · 数仓设计 → 设计校验 → 代码开发 → 代码校验闭环',
    subagents: [AGENT_DATA_ARCHITECT, AGENT_DESIGN_VERIFIER, AGENT_DATA_DEV, AGENT_DATA_VERIFIER],
    defaultPrompt: () => DATA_WAREHOUSE_DEV_INSTRUCTIONS,
  },
  {
    key: 'DATA_ANALYST',
    label: '数据分析',
    description: '数据探索 · 即席查询与分析（支持 {{username}} 占位符）',
    subagents: [AGENT_ANALYSIS_VERIFIER],
    defaultPrompt: username => getDataAnalystInstructions(username),
  },
  {
    key: 'SUPER_ADMIN',
    label: '运维管理',
    description: '数据探索 · 系统运维与故障排查',
    subagents: [],
    defaultPrompt: () => SUPER_ADMIN_INSTRUCTIONS,
  },
];

/**
 * 各角色的指令工厂。类型取 Record<RoleType, ...>：新增 RoleType 时漏登记
 * 会在编译期报错，不再依赖分发函数里的 if-else 逐个对齐。
 */
const ROLE_INSTRUCTION_FACTORIES: Record<RoleType, (username: string) => string> = {
  SUPER_ADMIN: () => SUPER_ADMIN_INSTRUCTIONS,
  DATA_ARCHITECT: () => DATA_ARCHITECT_INSTRUCTIONS,
  DATA_DEV_ENGINEER: () => DATA_DEV_ENGINEER_INSTRUCTIONS,
  DATA_WAREHOUSE_DEV: () => DATA_WAREHOUSE_DEV_INSTRUCTIONS,
  BUSINESS_REQUESTER: () => BUSINESS_REQUESTER_INSTRUCTIONS,
  DATA_ANALYST: (username) => getDataAnalystInstructions(username || '用户'),
};

/**
 * 根据用户角色类型生成对应的系统指令
 *
 * moduleName 为 "data-explore" 时固定返回数据分析师指令（短路优先于角色判断），
 * 其余模块按角色分发；roleType 缺省或未登记时兜底为数据开发工程师。
 *
 * taskPrompts 为用户在设置页按任务类型配置的提示词覆盖表：命中且正文非空时优先使用，
 * 其中的 {{username}} 占位符替换为当前用户名；未命中的任务类型仍走内置默认。
 *
 * 质量规则模板不再内嵌进提示词：S3 在实现校验逻辑前用 quality-template 工具按规则类型现拉，
 * 模板永远是最新版（见 ./prompts/dataDevEngineer.ts 的 QUALITY_TEMPLATE_TOOL_SPEC）。
 */
export function getDeveloperInstructions(
  roleType: RoleType | string,
  username: string,
  moduleName: string,
  taskPrompts?: Record<string, string>
): string {
  // 自定义提示词按「当前任务类型」命中：即使 data-explore 会短路到分析师默认指令，
  // 用户显式改过的任务类型提示词也应生效，否则设置页里的配置等于无效。
  // 空白正文视为未配置，落回内置默认，保证旧配置升级后行为不变。
  const customPrompt = taskPrompts?.[(roleType || '').trim().toUpperCase()];
  if (customPrompt && customPrompt.trim()) {
    return customPrompt.replace(/\{\{username\}\}/g, username || '用户');
  }

  // 数据探索模块固定走数据分析师视角，与角色配置无关，须最先短路判断
  if (moduleName === 'data-explore') {
    return getDataAnalystInstructions(username || '用户');
  }

  if (!roleType) {
    return DATA_DEV_ENGINEER_INSTRUCTIONS;
  }

  // roleType 形参放宽为 string（调用方传任意值），查表前先收窄到登记过的角色；
  // 未登记的角色 factory 为 undefined，由兜底分支处理。
  const factory = (ROLE_INSTRUCTION_FACTORIES as Record<string, (u: string) => string>)[
    roleType.toUpperCase()
  ];
  return factory ? factory(username) : DATA_DEV_ENGINEER_INSTRUCTIONS;
}
