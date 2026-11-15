/**
 * agentKitTasks — 「开发助手 / 数据探索」的 AgentKit 工作流入口定义与发送前校验。
 *
 * 这一层只负责：任务类型 ↔ command / agent 的映射，以及发送前检查产物文件是否存在。
 * 真正的路由在 useOpencodeChat：命中这里的工作流时走 session.command（而不是 session.prompt），
 * 请求里会显式带上 command 与 agent，确保落到 agentkit 的 primary agent。
 */

/** 任务下拉里的 AgentKit 工作流（经典内存子代理已下线）。 */
export const AGENTKIT_TASK_IDS = {
  REQ_DOC: 'AGENTKIT_REQ_DOC',
  DW_DEV: 'AGENTKIT_DW_DEV',
  DIAG: 'AGENTKIT_DIAG',
  ANALYSIS: 'AGENTKIT_ANALYSIS',
} as const;

export type AgentKitTaskId = typeof AGENTKIT_TASK_IDS[keyof typeof AGENTKIT_TASK_IDS];

export interface AgentKitTaskDef {
  id: AgentKitTaskId;
  /** 下拉框展示名 */
  label: string;
  /** opencode command 名（不含前导 /） */
  command: string;
  /** agentkit primary agent 名（与 command frontmatter 一致，显式传入做双保险） */
  agent: string;
  /** 输入框占位提示 */
  inputHint: string;
  /**
   * 产物文件后缀（用于发送前校验与候选文档提示）。
   * 诊断不依赖工作区里已有的产物文件，因此该字段可选。
   */
  artifactSuffix?: '_开发需求.md' | '_数仓设计.md';
}

export const AGENTKIT_TASKS: Record<AgentKitTaskId, AgentKitTaskDef> = {
  [AGENTKIT_TASK_IDS.REQ_DOC]: {
    id: AGENTKIT_TASK_IDS.REQ_DOC,
    label: '需求编写',
    command: 'write-req',
    agent: 'doc-orchestrator',
    inputHint: '输入业务名称，例如：订单域（将生成 docs/订单域_开发需求.md）',
    artifactSuffix: '_开发需求.md',
  },
  [AGENTKIT_TASK_IDS.DW_DEV]: {
    id: AGENTKIT_TASK_IDS.DW_DEV,
    label: '数仓开发',
    command: 'dw-dev',
    agent: 'dw-orchestrator',
    inputHint: '输入业务名称，例如：订单域（需已存在 docs/订单域_开发需求.md，将完成设计到代码）',
    artifactSuffix: '_开发需求.md',
  },
  [AGENTKIT_TASK_IDS.DIAG]: {
    id: AGENTKIT_TASK_IDS.DIAG,
    label: '任务智能诊断',
    command: 'diag-task',
    agent: 'diag-orchestrator',
    inputHint: '输入任务实例 ID / applicationId / jobId，或一段现象描述（例如：订单同步任务今天比平时慢 3 倍）',
  },
  [AGENTKIT_TASK_IDS.ANALYSIS]: {
    id: AGENTKIT_TASK_IDS.ANALYSIS,
    label: '数据分析',
    command: 'ana-analyze',
    agent: 'ana-orchestrator',
    inputHint: '输入分析问题与目标，例如：订单表最近 7 天分区是否完整（可带数据源、库表、时间窗）',
  },
};

/** 判断任务类型是否为 AgentKit 工作流；旧任务类型返回 undefined。 */
export function resolveAgentKitTask(taskType: string | null | undefined): AgentKitTaskDef | undefined {
  if (!taskType) return undefined;
  return AGENTKIT_TASKS[taskType as AgentKitTaskId];
}

export type AgentKitPreflightResult =
  | { ok: true; args: string }
  | { ok: false; message: string };

interface DirEntry {
  name: string;
  isFile?: boolean;
  isDirectory?: boolean;
}

/** 读取工作区 docs/ 下的文件；目录不存在或读取失败时返回空数组（由调用方给出引导）。 */
async function listDocFiles(workspacePath: string): Promise<DirEntry[]> {
  try {
    const entries = await window.dataforge.fs('readDir', {
      path: `${workspacePath.replace(/[\\/]+$/, '')}/docs`,
    });
    return Array.isArray(entries) ? (entries as DirEntry[]) : [];
  } catch {
    return [];
  }
}

/** 把用户输入规整成业务名：去掉误填的产物后缀，拒绝路径分隔符与上跳。 */
function normalizeBusinessName(raw: string, suffix?: string): string {
  let name = raw.trim();
  if (suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  name = name.trim();
  return name;
}

function invalidName(name: string): string | null {
  if (!name) return '请输入业务名称';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return '业务名称不能包含路径分隔符或 ".."';
  }
  return null;
}

function candidateHint(names: string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, 5).join('、');
  return `可用的业务名称：${shown}${names.length > 5 ? ' 等' : ''}。`;
}

/**
 * 发送前校验：保证用户点下去时已经具备该工作流的输入/产物，避免只看到一句失败。
 * 返回 ok 时 args 为最终传给 command 的 arguments（可能是去掉后缀后的业务名）。
 */
export async function validateAgentKitTaskInput(
  task: AgentKitTaskDef,
  rawArgs: string,
  workspacePath: string | undefined,
): Promise<AgentKitPreflightResult> {
  // 任务智能诊断：输入是任务引用或现象描述，不依赖工作区里已有的产物文件。
  if (task.id === AGENTKIT_TASK_IDS.DIAG) {
    const value = rawArgs.trim();
    if (!value) {
      return { ok: false, message: '请输入任务引用（任务实例 ID / applicationId / jobId）或一段现象描述' };
    }
    return { ok: true, args: value };
  }

  // 数据分析：输入是分析问题与目标，不依赖工作区里已有的产物文件。
  if (task.id === AGENTKIT_TASK_IDS.ANALYSIS) {
    const value = rawArgs.trim();
    if (!value) {
      return { ok: false, message: '请输入分析问题与目标（可带数据源、库表、时间窗）' };
    }
    return { ok: true, args: value };
  }

  const businessName = normalizeBusinessName(rawArgs, task.artifactSuffix);
  const nameError = invalidName(businessName);
  if (nameError) return { ok: false, message: nameError };

  // 需求文档编写只要求业务名，产物由命令自己生成。
  if (task.id === AGENTKIT_TASK_IDS.REQ_DOC) {
    return { ok: true, args: businessName };
  }

  if (!workspacePath) {
    return { ok: false, message: '尚未打开工作区，无法校验产物文件。请先在开发助手中打开项目。' };
  }

  // 走到这里的工作流都依赖 docs/ 下的产物，必须有后缀。
  const suffix = task.artifactSuffix;
  if (!suffix) {
    return { ok: false, message: '该工作流未配置产物后缀，无法校验输入。' };
  }

  const docs = await listDocFiles(workspacePath);
  const fileNames = docs.filter(d => d.isFile !== false).map(d => d.name);
  const bases = fileNames
    .filter(n => n.endsWith(suffix))
    .map(n => n.slice(0, -suffix.length));

  const requiredPath = `docs/${businessName}${suffix}`;
  if (!fileNames.includes(`${businessName}${suffix}`)) {
    const missingHint = candidateHint(bases);
    return {
      ok: false,
      message: `未找到 ${requiredPath}。请先选择「需求编写」生成需求文档。${missingHint}`,
    };
  }

  return { ok: true, args: businessName };
}
