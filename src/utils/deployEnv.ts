/**
 * 提交调度「部署环境」单选。
 *
 * 两个提交入口（单文件 `SubmitToSchedulerModal` / 文件夹 `FolderSubmitScheduleModal`）共用同一套
 * 环境定义与命名口径：环境**拼在工作流名称末尾**作为后缀，例如
 * `olist_code_ods` + 测试 → `olist_code_ods_test`。
 *
 * 为什么放在名称上：DolphinScheduler 里工作流名称就是身份标识，同名即视为同一个工作流
 * （提交时按名称查重决定 create / update）。把环境拼进名称，同一份代码才能在不同环境
 * 各自拥有一份独立工作流，而不会互相覆盖。
 *
 * 注意：原先按「同前缀工作流的定时调度状态」自动生成 `_v{N}` 版本后缀的逻辑已被环境后缀取代，
 * 见 `SubmitToSchedulerModal` 的说明。
 */

/** 环境取值：生产 / 灰度 / 测试。后缀直接用它（`_prod` / `_gray` / `_test`） */
export type DeployEnv = 'prod' | 'gray' | 'test';

export interface DeployEnvOption {
  value: DeployEnv;
  label: string;
}

/** 选项顺序即界面展示顺序（用户指定：生产 / 灰度 / 测试） */
export const DEPLOY_ENV_OPTIONS: readonly DeployEnvOption[] = [
  { value: 'prod', label: '生产' },
  { value: 'gray', label: '灰度' },
  { value: 'test', label: '测试' },
];

/** 默认环境：测试（风险最低的一档，每次打开弹窗都回到它，不做记忆） */
export const DEFAULT_DEPLOY_ENV: DeployEnv = 'test';

/** 环境取值是否合法（用于回填外部传入值时的防御） */
export function isDeployEnv(value: unknown): value is DeployEnv {
  return DEPLOY_ENV_OPTIONS.some(o => o.value === value);
}

/** 环境的中文名，用于提示文案 */
export function deployEnvLabel(env: DeployEnv): string {
  return DEPLOY_ENV_OPTIONS.find(o => o.value === env)?.label ?? env;
}

/**
 * 把环境后缀拼到工作流名称末尾：`olist_code_ods` + test → `olist_code_ods_test`。
 *
 * - 只做后缀拼接、**不做 sanitizeDsName**：与 `deriveFolderWorkflowName` 同口径，
 *   清洗只发生在真正提交给调度系统时（否则含特殊字符的名称两处显示会不一致）。
 * - 基础名末尾的下划线先去掉，避免出现 `name__test`。
 * - 基础名为空（如路径推导失败）时退化为纯环境后缀，不产生前导下划线。
 */
export function withDeployEnvSuffix(baseName: string, env: DeployEnv): string {
  const base = (baseName || '').trim().replace(/[\\/]+$/, '').replace(/_+$/, '');
  return base ? `${base}_${env}` : env;
}
