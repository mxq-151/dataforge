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
 * 质量规则模板不再内嵌进提示词：S3 在实现校验逻辑前用 quality-template 工具按规则类型现拉，
 * 模板永远是最新版（见 ./prompts/dataDevEngineer.ts 的 QUALITY_TEMPLATE_TOOL_SPEC）。
 */
export function getDeveloperInstructions(
  roleType: RoleType | string,
  username: string,
  moduleName: string
): string {
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
