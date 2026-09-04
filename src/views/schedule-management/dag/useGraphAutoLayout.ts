/**
 * 画布自动布局（从 dolphinscheduler-ui 的 use-graph-auto-layout.ts 移植）。
 * 支持 DagreLayout（LR 有向分层）与 GridLayout（网格）。
 */
import type { Graph } from '@antv/x6';
import { DagreLayout, GridLayout } from '@antv/layout';
import { X6_NODE_NAME, X6_EDGE_NAME } from './dag-config';

export enum LAYOUT_TYPE {
  GRID = 'grid',
  DAGRE = 'dagre'
}

export interface LayoutConfig {
  cols: number;
  nodesep: number;
  padding: number;
  ranksep: number;
  rows: number;
  type: LAYOUT_TYPE;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  cols: 0,
  nodesep: 50,
  padding: 50,
  ranksep: 50,
  rows: 0,
  type: LAYOUT_TYPE.DAGRE
};

/** 取节点出边标签的实际宽度，用于动态扩大分层间距，避免边标签重叠。 */
function getMaxLabelWidth(graph: Graph, nodeId: string, ranksep: number): number {
  const edges = graph.getOutgoingEdges(nodeId);
  let max = 0;
  if (edges && edges.length > 0) {
    edges.forEach((edge) => {
      const edgeView = graph.findViewByCell(edge);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labelSelectors = (edgeView as any)?.labelSelectors;
      const body = labelSelectors?.['0']?.body;
      let width = 0;
      if (body) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const attrs = (body as any).attrs;
        width = Number(attrs?.width ?? attrs?.refWidth ?? 0);
      }
      max = Math.max(max, width);
    });
  }
  return ranksep + max;
}

/**
 * 对 graph 执行自动布局。
 * @param graph 目标 graph
 * @param layoutConfig 布局配置（为空时使用默认）
 */
export function formatGraph(graph: Graph, layoutConfig: LayoutConfig): void {
  if (!graph) return;
  graph.cleanSelection();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layoutFunc: { layout: (model: any) => any } | null = null;
  if (layoutConfig.type === LAYOUT_TYPE.DAGRE) {
    layoutFunc = new DagreLayout({
      type: LAYOUT_TYPE.DAGRE,
      rankdir: 'LR',
      align: 'UL',
      ranksepFunc: (d) => getMaxLabelWidth(graph, d.id, layoutConfig.ranksep),
      nodesep: layoutConfig.nodesep,
      controlPoints: true
    });
  } else if (layoutConfig.type === LAYOUT_TYPE.GRID) {
    layoutFunc = new GridLayout({
      type: LAYOUT_TYPE.GRID,
      preventOverlap: true,
      preventOverlapPadding: layoutConfig.padding,
      sortBy: '_index',
      rows: layoutConfig.rows || undefined,
      cols: layoutConfig.cols || undefined,
      nodeSize: 220
    });
  }
  if (!layoutFunc) return;

  const json = graph.toJSON();
  const nodes = json.cells
    .filter((cell) => cell.shape === X6_NODE_NAME)
    .map((item) => ({
      ...item,
      // 按 code 降序排序（越大越靠前）
      _index: -(item.id as string)
    }));
  const edges = json.cells.filter((cell) => cell.shape === X6_EDGE_NAME);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newModel: any = layoutFunc.layout({
    nodes,
    edges
  });
  graph.fromJSON(newModel);
}
