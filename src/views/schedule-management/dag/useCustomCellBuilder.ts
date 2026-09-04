/**
 * x6 自定义节点/边的构建器（从 dolphinscheduler-ui 的 use-custom-cell-builder.ts 移植，适配 dataforge）。
 * 负责 DSWorkflowTaskNode / DSWorkflowEdge ↔ x6 cell 元数据互转。
 */
import type { Node, Edge } from '@antv/x6';
import { X6_NODE_NAME, X6_EDGE_NAME } from './dag-config';
import { Priority } from '../../../types/dolphinscheduler';
import type { DSWorkflowTaskNode, DSWorkflowEdge, DSTaskType } from '../../../types/dolphinscheduler';

/** 任务类型 → 图标文件名（不含扩展名）。FLINK_STREAM 与 SUB_PROCESS 有特殊映射。 */
export function getTaskTypeIconName(taskType: DSTaskType): string {
  const type =
    taskType === 'FLINK_STREAM'
      ? 'FLINK'
      : taskType === 'SUB_PROCESS'
        ? 'SUB_WORKFLOW'
        : taskType;
  return type.toLowerCase();
}

/** 生成任务类型图标的 URL（可指定 hover 态）。 */
export function getTaskTypeIcon(taskType: DSTaskType, hover = false): string {
  return `${import.meta.env.BASE_URL}images/task-icons/${getTaskTypeIconName(
    taskType
  )}${hover ? '_hover' : ''}.png`;
}

/** 超长文本截断（dolphinscheduler utils.truncateText 的简化实现）。 */
export function truncateText(text: string, maxLength = 18): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export interface Coordinate {
  x: number;
  y: number;
}

/**
 * 构建边元数据
 */
export function buildEdge(
  sourceId: string,
  targetId: string,
  label = ''
): Edge.Metadata {
  return {
    shape: X6_EDGE_NAME,
    source: {
      cell: sourceId
    },
    target: {
      cell: targetId
    },
    labels: label ? [label] : undefined
  };
}

/**
 * 构建节点元数据。x6 node 的 data 中保存完整 task，便于保存时回写。
 */
export function buildNode(
  task: DSWorkflowTaskNode,
  coordinate: Coordinate = { x: 100, y: 100 }
): Node.Metadata {
  const id = String(task.code);
  const name = task.name || id;
  return {
    id,
    shape: X6_NODE_NAME,
    x: coordinate.x,
    y: coordinate.y,
    data: {
      task,
      taskType: task.taskType,
      taskName: name,
      flag: task.flag
    },
    attrs: {
      image: {
        // 使用 href 而非 xlink:href，避免下载 PNG 时丢失图标
        href: getTaskTypeIcon(task.taskType)
      },
      title: {
        text: truncateText(name)
      }
    }
  };
}

/**
 * 由 DS 节点/边数组构建 graph JSON（供 graph.fromJSON 使用）
 */
export function buildGraph(nodes: DSWorkflowTaskNode[], edges: DSWorkflowEdge[]) {
  const nodeMetas: Node.Metadata[] = nodes.map((node) =>
    buildNode(node, { x: node.x, y: node.y })
  );
  const edgeMetas: Edge.Metadata[] = edges
    .filter((edge) => edge.sourceCode !== 0)
    .map((edge) => buildEdge(String(edge.sourceCode), String(edge.targetCode)));
  return {
    nodes: nodeMetas,
    edges: edgeMetas
  };
}

/**
 * 从 graph 提取 DS 节点/边数据（保存时调用）。
 * 节点的 x/y 使用 x6 中的当前位置。
 */
export function extractNodes(nodes: Node[]): DSWorkflowTaskNode[] {
  return nodes.map((node) => {
    const data = node.getData() as { task: DSWorkflowTaskNode } | undefined;
    const task: DSWorkflowTaskNode = data?.task
      ? { ...data.task }
      : {
          code: Number(node.id),
          name: node.id,
          taskType: 'SHELL',
          description: '',
          taskParams: '{}',
          flag: 'YES',
          taskPriority: Priority.MEDIUM,
          workerGroup: 'default',
          environmentCode: -1,
          failRetryTimes: 0,
          failRetryInterval: 1,
          timeoutFlag: 'CLOSE',
          timeout: 0,
          delayTime: 0,
          x: 0,
          y: 0
        };
    const { x, y } = node.getPosition();
    return { ...task, x: Math.round(x), y: Math.round(y) };
  });
}

/**
 * 从 graph 提取 DS 边数据（保存时调用）。
 */
export function extractEdges(edges: Edge[]): DSWorkflowEdge[] {
  return edges.map((edge, index) => ({
    id: edge.id || `edge_${index}`,
    sourceCode: Number(edge.getSourceCellId()),
    targetCode: Number(edge.getTargetCellId())
  }));
}
