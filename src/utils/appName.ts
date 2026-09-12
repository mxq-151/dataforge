/**
 * 任务节点的「应用名称」（appName）口径。
 *
 * 背景：Spark / Flink / MapReduce 类任务在 DolphinScheduler 里有一个「应用名称」字段，
 * 它会作为 YARN / Spark 上的 Application 名出现。为了在调度系统里一眼看出
 * 「这条应用属于哪个项目的哪个工作流的哪个任务」，统一按
 * `{project}.{workflow}.{task}` 自动生成，且**与工作流基本信息保持一致**：
 * 项目名、工作流名（含环境后缀）、任务节点名任一变化，应用名称都随之变化。
 *
 * 该值由提交入口（单文件 / 文件夹提交调度）派生后**只读**展示，不允许手改，
 * 避免同一条工作流里出现口径不一的应用名。
 */
import type { DSTaskType, DSWorkflowTaskNode } from '../types/dolphinscheduler';

/**
 * 表单里带「应用名称」项的任务类型。
 * 与 `views/schedule-management/components/task-configs/task-forms.tsx` 的
 * SparkForm / FlinkForm / MrForm（以及单文件提交调度的 TASK_TYPE_PARAMS_CONFIG）保持一致，
 * 这些表单新增/移除「应用名称」时必须同步维护这里。
 */
export const APP_NAME_TASK_TYPES: DSTaskType[] = ['SPARK', 'FLINK', 'MR'];

/** 该任务类型是否有「应用名称」项（没有则不做自动填充，也不应该写入该参数） */
export function taskTypeHasAppName(taskType: DSTaskType | string | null | undefined): boolean {
  return !!taskType && (APP_NAME_TASK_TYPES as string[]).includes(taskType);
}

/**
 * 单段名称的规范化：去掉首尾空白、把空白与 `.` 换成 `_`。
 * 换掉 `.` 是为了保证结果恒为「三段」（段内再出现点号会让 {@link buildTaskAppName} 的分段含义失真）。
 */
function normalizeSegment(part: string | null | undefined): string {
  return (part ?? '').trim().replace(/[\s.]+/g, '_');
}

/**
 * 生成任务节点的应用名称：`{project}.{workflow}.{task}`。
 *
 * 任意一段为空时该段被省略（例如项目名未知 → `{workflow}.{task}`），
 * 而不是留下 `..` 这类空洞；三段都为空时返回空串（调用方据此不写入参数）。
 *
 * @param parts.project  调度项目名称（= 项目编码，与弹窗头部展示口径一致）
 * @param parts.workflow 提交到调度系统的最终工作流名称（**含环境后缀**，如 `olist_code_ods_test`）
 * @param parts.task     任务节点名称
 */
export function buildTaskAppName(parts: {
  project?: string | null;
  workflow?: string | null;
  task?: string | null;
}): string {
  return [
    normalizeSegment(parts.project),
    normalizeSegment(parts.workflow),
    normalizeSegment(parts.task),
  ].filter(Boolean).join('.');
}

/**
 * 把应用名称写进单个任务节点的 taskParams（仅对带「应用名称」的任务类型生效）。
 *
 * 返回**新**节点对象（不改原对象），值未变化时原样返回，便于在 setState / map 中安全使用。
 * taskParams 不是合法 JSON 时原样返回，不阻断保存链路。
 */
export function applyAppNameToNode(
  node: DSWorkflowTaskNode,
  parts: { project?: string | null; workflow?: string | null; task?: string | null },
): DSWorkflowTaskNode {
  if (!taskTypeHasAppName(node.taskType)) return node;

  let params: Record<string, unknown>;
  try {
    const parsed = JSON.parse(node.taskParams || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return node;
    params = parsed as Record<string, unknown>;
  } catch {
    return node;
  }

  const appName = buildTaskAppName({ ...parts, task: parts.task ?? node.name });
  if (!appName || params.appName === appName) return node;

  return { ...node, taskParams: JSON.stringify({ ...params, appName }) };
}

/**
 * 批量版本：对整份节点列表套用同一「项目 + 工作流」上下文（任务名逐节点取 `node.name`）。
 * 用于提交前把整份工作流草稿的应用名称对齐到最终的工作流名称（含环境后缀）。
 */
export function applyAppNameToNodes(
  nodes: DSWorkflowTaskNode[],
  parts: { project?: string | null; workflow?: string | null },
): DSWorkflowTaskNode[] {
  let changed = false;
  const next = nodes.map(node => {
    const updated = applyAppNameToNode(node, { ...parts, task: node.name });
    if (updated !== node) changed = true;
    return updated;
  });
  return changed ? next : nodes;
}
