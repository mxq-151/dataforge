/**
 * 工作流任务节点参数校验。
 *
 * 保存工作流前的最后一道闸门：逐个节点检查「任务名称 + 任务参数（taskParams）」是否完整，
 * 只要有任一节点不通过，就拒绝保存（由 WorkflowDefinitionEditor 在「打开保存弹窗」与
 * 「确认保存」两处调用，双重防护）。
 *
 * 校验规则与任务配置表单 `views/schedule-management/components/task-configs/task-forms.tsx`
 * 中标注 `sm-required` 的必填项一一对应（含 DATAX / CHUNJUN / SEATUNNEL / LINKIS 这类
 * 「勾选自定义模式后才出现」的条件必填）。表单新增必填项时这里要同步维护，
 * 对应单测 `workflowNodeValidation.test.ts` 覆盖各任务类型的必填分支。
 *
 * 注意：`mainJar`（主 Jar 包）**刻意不在这里校验** —— 它是编译成功后由上传产物自动
 * 回填的派生值（见 `views/dev-assistant/SubmitToSchedulerModal`，编译 → 上传 jar →
 * 回填 `taskParams.mainJar`），不是用户填写的参数。把它当必填会误拦提交。
 */
import {
  TASK_TYPE_LABELS,
  type DSTaskType,
  type DSWorkflowTaskNode,
} from '../types/dolphinscheduler';

/** 单条校验失败记录 */
export interface TaskNodeIssue {
  /** 所属任务节点 code */
  taskCode: number;
  /** 任务名（用于展示，可能已被兜底成「任务#code」） */
  taskName: string;
  taskType: DSTaskType;
  /** 出问题的参数字段（整体性问题时为空） */
  field?: string;
  /** 中文错误提示 */
  message: string;
}

/** 按节点聚合后的失败信息，便于界面按任务罗列 */
export interface FailedTaskNode {
  taskCode: number;
  taskName: string;
  taskType: DSTaskType;
  /** 任务类型中文名 */
  taskTypeLabel: string;
  messages: string[];
}

export interface WorkflowNodeValidationResult {
  /** 全部节点均通过校验时为 true */
  ok: boolean;
  issues: TaskNodeIssue[];
  failedNodes: FailedTaskNode[];
}

/** 视为「未填写」的值：null/undefined、纯空白字符串、空数组、非有限数字 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 单条必填规则 */
interface ParamRule {
  /** taskParams 里的字段名 */
  field: string;
  /** 中文展示名，用于拼提示语 */
  label: string;
  /** 仅在该条件成立时才校验（默认恒校验） */
  when?: (params: Record<string, unknown>) => boolean;
  /** 数字型必填：0 / 负数视为「未选择」（DS 下拉框用 0 表示空选项） */
  positive?: boolean;
}

/**
 * 各任务类型的必填参数表。
 * 与 task-forms.tsx 中的 `sm-required` 标注保持一致。
 */
const REQUIRED_PARAMS: Partial<Record<DSTaskType, ParamRule[]>> = {
  SHELL: [{ field: 'rawScript', label: '脚本' }],
  PYTHON: [{ field: 'rawScript', label: '脚本' }],
  SQL: [{ field: 'sql', label: 'SQL语句' }],
  PROCEDURE: [{ field: 'method', label: '存储过程语句' }],
  DATAX: [
    { field: 'json', label: 'JSON模板', when: p => !!p.customConfig },
    { field: 'sql', label: 'SQL抽取语句', when: p => !p.customConfig },
    { field: 'targetTable', label: '目标表名', when: p => !p.customConfig },
  ],
  FLINK: [{ field: 'rawScript', label: 'SQL脚本', when: p => p.programType === 'SQL' }],
  HTTP: [{ field: 'url', label: '请求地址' }],
  SUB_PROCESS: [{ field: 'workflowDefinitionCode', label: '子工作流', positive: true }],
  SEATUNNEL: [{ field: 'rawScript', label: 'SeaTunnel配置(HOCON)', when: p => !!p.useCustom }],
  K8S: [
    { field: 'namespace', label: '命名空间' },
    { field: 'image', label: '镜像地址' },
  ],
  GRPC: [{ field: 'url', label: '请求地址' }],
  ZEPPELIN: [
    { field: 'restEndpoint', label: 'RestEndpoint' },
    { field: 'noteId', label: 'Note ID' },
  ],
  JUPYTER: [{ field: 'rawScript', label: '脚本' }],
  OPENMLDB: [
    { field: 'zk', label: 'ZooKeeper地址' },
    { field: 'sql', label: 'SQL语句' },
  ],
  DINKY: [{ field: 'dinkyTaskId', label: 'Dinky任务ID', positive: true }],
  CHUNJUN: [{ field: 'json', label: 'JSON配置', when: p => !!p.customConfig }],
  HIVECLI: [{ field: 'hiveSql', label: 'HiveSQL' }],
  DMS: [{ field: 'dmsTaskId', label: 'DMS任务ID' }],
  DATASYNC: [{ field: 'datasyncTaskId', label: 'DataSync任务ID' }],
  KUBEFLOW: [{ field: 'kubeflowPipelineYaml', label: 'Pipeline YAML' }],
  LINKIS: [{ field: 'rawScript', label: '脚本', when: p => !!p.useCustom }],
  DATA_FACTORY: [{ field: 'factoryName', label: '工厂名称' }],
  REMOTESHELL: [{ field: 'rawScript', label: '脚本' }],
  ALIYUN_SERVERLESS_SPARK: [{ field: 'restEndpoint', label: 'RestEndpoint' }],
};

/** 需要逐行校验「参数名不能为空」的 DSLocalParam 列表字段 */
const LOCAL_PARAM_FIELDS = ['localParams', 'paramScript', 'kubeflowParameters'];

interface SimpleIssue {
  field?: string;
  message: string;
}

/** 解析节点上的 taskParams（JSON 字符串） */
function parseTaskParams(node: DSWorkflowTaskNode): { params: Record<string, unknown> | null; error?: string } {
  if (isBlank(node.taskParams)) return { params: null, error: '任务参数为空，请先打开任务配置补全' };
  try {
    const parsed = JSON.parse(node.taskParams);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { params: null, error: '任务参数必须是 JSON 对象' };
    }
    return { params: parsed as Record<string, unknown> };
  } catch {
    return { params: null, error: '任务参数不是合法的 JSON，请重新打开任务配置保存' };
  }
}

/** 按必填表逐项检查 */
function checkRequiredParams(taskType: DSTaskType, params: Record<string, unknown>): SimpleIssue[] {
  const rules = REQUIRED_PARAMS[taskType];
  if (!rules || rules.length === 0) return [];
  const issues: SimpleIssue[] = [];
  for (const rule of rules) {
    if (rule.when && !rule.when(params)) continue;
    const value = params[rule.field];
    const missing = rule.positive
      ? !(typeof value === 'number' && value > 0)
      : isBlank(value);
    if (missing) {
      issues.push({
        field: rule.field,
        message: rule.positive ? `请选择${rule.label}` : `请填写${rule.label}`,
      });
    }
  }
  return issues;
}

/** 依赖（DEPENDENT）任务：依赖组与依赖项必须完整 */
function checkDependentParams(params: Record<string, unknown>): SimpleIssue[] {
  const issues: SimpleIssue[] = [];
  const dependence = params.dependence as { dependTaskList?: unknown } | undefined;
  const groups = Array.isArray(dependence?.dependTaskList)
    ? (dependence!.dependTaskList as { dependItemList?: unknown }[])
    : [];
  if (groups.length === 0) {
    return [{ field: 'dependence.dependTaskList', message: '请至少添加一个依赖组' }];
  }
  groups.forEach((group, gi) => {
    const items = Array.isArray(group?.dependItemList)
      ? (group.dependItemList as Record<string, unknown>[])
      : [];
    if (items.length === 0) {
      issues.push({ field: `dependence.dependTaskList[${gi}]`, message: `依赖组 ${gi + 1} 中没有依赖项` });
      return;
    }
    items.forEach((item, ii) => {
      const at = `依赖组 ${gi + 1} 第 ${ii + 1} 个依赖项`;
      if (!(typeof item.projectCode === 'number' && item.projectCode > 0)) {
        issues.push({ field: 'projectCode', message: `${at}未选择项目` });
      }
      if (!(typeof item.definitionCode === 'number' && item.definitionCode > 0)) {
        issues.push({ field: 'definitionCode', message: `${at}未选择工作流` });
      }
      if (!(typeof item.depTaskCode === 'number' && item.depTaskCode > 0)) {
        issues.push({ field: 'depTaskCode', message: `${at}未选择任务` });
      }
      if (isBlank(item.cycle)) {
        issues.push({ field: 'cycle', message: `${at}未选择时间周期` });
      }
    });
  });
  return issues;
}

/** 条件分支（CONDITIONS）任务：前置任务检查条件不能为空 */
function checkConditionsParams(params: Record<string, unknown>): SimpleIssue[] {
  const list = Array.isArray(params.dependTaskList)
    ? (params.dependTaskList as Record<string, unknown>[])
    : [];
  if (list.length === 0) {
    return [{ field: 'dependTaskList', message: '请至少添加一个前置任务检查条件' }];
  }
  const issues: SimpleIssue[] = [];
  list.forEach((item, i) => {
    if (!(typeof item.depTaskCode === 'number' && item.depTaskCode > 0)) {
      issues.push({ field: 'depTaskCode', message: `第 ${i + 1} 个前置条件未选择前置任务` });
    }
  });
  return issues;
}

/** 开关分支（SWITCH）任务：每个条件分支都要有表达式与分支任务 */
function checkSwitchParams(params: Record<string, unknown>): SimpleIssue[] {
  const switchResult = params.switchResult as { dependTaskList?: unknown } | undefined;
  const list = Array.isArray(switchResult?.dependTaskList)
    ? (switchResult!.dependTaskList as Record<string, unknown>[])
    : [];
  if (list.length === 0) {
    return [{ field: 'switchResult.dependTaskList', message: '请至少添加一个条件分支' }];
  }
  const issues: SimpleIssue[] = [];
  list.forEach((branch, i) => {
    if (isBlank(branch.condition)) {
      issues.push({ field: 'condition', message: `条件 ${i + 1} 未填写条件表达式` });
    }
    if (!(typeof branch.nextNode === 'number' && branch.nextNode > 0)) {
      issues.push({ field: 'nextNode', message: `条件 ${i + 1} 未选择分支任务` });
    }
  });
  return issues;
}

/** 结构型任务参数（依赖/条件分支/开关分支） */
function checkStructuredParams(taskType: DSTaskType, params: Record<string, unknown>): SimpleIssue[] {
  switch (taskType) {
    case 'DEPENDENT':
      return checkDependentParams(params);
    case 'CONDITIONS':
      return checkConditionsParams(params);
    case 'SWITCH':
      return checkSwitchParams(params);
    default:
      return [];
  }
}

/** 自定义参数行必须填写参数名（DS 不接受空 prop） */
function checkLocalParams(params: Record<string, unknown>): SimpleIssue[] {
  const issues: SimpleIssue[] = [];
  for (const field of LOCAL_PARAM_FIELDS) {
    const list = params[field];
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => {
      const prop = (item as { prop?: unknown } | null)?.prop;
      if (isBlank(prop)) {
        issues.push({ field, message: `自定义参数第 ${i + 1} 行缺少参数名` });
      }
    });
  }
  return issues;
}

/**
 * 校验工作流全部任务节点的参数。
 *
 * 检查项：
 * 1. 任务名称非空、且同一工作流内不重名；
 * 2. taskParams 是可解析的 JSON 对象；
 * 3. 该任务类型的必填参数已填写（含条件必填）；
 * 4. 结构型参数（依赖组/条件分支/开关分支）完整；
 * 5. 自定义参数行的参数名非空；
 * 6. 开启超时告警时超时时间大于 0。
 */
export function validateWorkflowNodes(nodes: DSWorkflowTaskNode[]): WorkflowNodeValidationResult {
  const issues: TaskNodeIssue[] = [];
  const push = (node: DSWorkflowTaskNode, message: string, field?: string) => {
    issues.push({
      taskCode: node.code,
      taskName: node.name?.trim() || `任务#${node.code}`,
      taskType: node.taskType,
      field,
      message,
    });
  };

  // 任务名重复：DS 要求同一工作流内任务名唯一
  const nameCount = new Map<string, number>();
  for (const node of nodes) {
    const key = (node.name || '').trim();
    if (!key) continue;
    nameCount.set(key, (nameCount.get(key) || 0) + 1);
  }

  for (const node of nodes) {
    const name = (node.name || '').trim();
    if (!name) {
      push(node, '任务名称不能为空');
    } else if ((nameCount.get(name) || 0) > 1) {
      push(node, `任务名称「${name}」重复，同一工作流内任务名必须唯一`);
    }

    const { params, error } = parseTaskParams(node);
    if (!params) {
      push(node, error || '任务参数不合法');
      continue;
    }

    for (const issue of checkRequiredParams(node.taskType, params)) push(node, issue.message, issue.field);
    for (const issue of checkStructuredParams(node.taskType, params)) push(node, issue.message, issue.field);
    for (const issue of checkLocalParams(params)) push(node, issue.message, issue.field);

    if (node.timeoutFlag === 'OPEN' && !(typeof node.timeout === 'number' && node.timeout > 0)) {
      push(node, '已开启超时告警，超时时间必须大于 0 分钟', 'timeout');
    }
  }

  // 按节点聚合（保持首次出现的顺序，便于界面按画布顺序展示）
  const failedNodes: FailedTaskNode[] = [];
  const byCode = new Map<number, FailedTaskNode>();
  for (const issue of issues) {
    let entry = byCode.get(issue.taskCode);
    if (!entry) {
      entry = {
        taskCode: issue.taskCode,
        taskName: issue.taskName,
        taskType: issue.taskType,
        taskTypeLabel: TASK_TYPE_LABELS[issue.taskType] || issue.taskType,
        messages: [],
      };
      byCode.set(issue.taskCode, entry);
      failedNodes.push(entry);
    }
    entry.messages.push(issue.message);
  }

  return { ok: issues.length === 0, issues, failedNodes };
}
