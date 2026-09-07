import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Lineage, NodeType } from '../../types/marquez';
import { nodeTypes } from './LineageNodes';
import { shouldHideNode } from './lineageFilter';
import { Database } from 'lucide-react';

interface LineageGraphProps {
  lineage: Lineage | null;
  onNodeClick?: (nodeId: string, nodeType: NodeType) => void;
}

function buildNodeId(rawId: string): string {
  return rawId.replace(/[:#]/g, '_');
}

function getNodeType(type: NodeType): string {
  switch (type) {
    case 'DATASET':
      return 'dataset';
    case 'JOB':
      return 'job';
    case 'DATASET_FIELD':
      return 'field';
    case 'RUN':
      return 'job';
    default:
      return 'dataset';
  }
}

/** 连线配色：指向同一目标节点的连线（输入到同一下游）共用同一种颜色，不同目标之间颜色明显区分 */
// 明暗、冷暖交错排列，确保相邻（连续分配）的目标节点颜色差异也足够明显
const EDGE_COLORS = [
  '#ff4d4f', // 亮红
  '#00d2ff', // 亮青
  '#ffd43b', // 亮黄
  '#7c5cff', // 亮紫
  '#34d399', // 亮绿
  '#ff7ac3', // 亮粉
  '#ff922b', // 亮橙
  '#4dabf7', // 蓝
  '#f9f871', // 荧光黄
  '#2de0b4', // 青绿
  '#ff6b6b', // 柔红
  '#a3e635', // 荧光绿
];

function buildEdgeColor(groupId: string, paletteCursor: Map<string, number>): string {
  if (!paletteCursor.has(groupId)) {
    paletteCursor.set(groupId, paletteCursor.size % EDGE_COLORS.length);
  }
  return EDGE_COLORS[paletteCursor.get(groupId)!];
}

function computeLayout(rawGraph: Lineage['graph']): { nodes: Node[]; edges: Edge[] } {
  // 过滤需要隐藏的中间节点（如以 .adaptive_spark_plan、.deserialize_to_object 结尾），不渲染其关系图
  const graph = rawGraph.filter((n) => !shouldHideNode(n.id));
  const adjacency = new Map<string, string[]>();

  for (const n of graph) {
    const id = buildNodeId(n.id);
    adjacency.set(id, []);
  }

  for (const n of graph) {
    const id = buildNodeId(n.id);
    for (const edge of n.outEdges) {
      const targetId = buildNodeId(edge.destination);
      if (adjacency.has(id) && adjacency.has(targetId)) {
        adjacency.get(id)!.push(targetId);
      }
    }
  }

  const levels = new Map<string, number>();
  const visited = new Set<string>();

  function assignLevel(nodeId: string, level: number) {
    if (visited.has(nodeId)) {
      levels.set(nodeId, Math.max(levels.get(nodeId) || 0, level));
      return;
    }
    visited.add(nodeId);
    levels.set(nodeId, level);
    for (const child of adjacency.get(nodeId) || []) {
      assignLevel(child, level + 1);
    }
  }

  const roots: string[] = [];
  for (const n of graph) {
    const id = buildNodeId(n.id);
    const hasIncoming = n.inEdges.some(e => adjacency.has(buildNodeId(e.origin)));
    if (!hasIncoming) {
      roots.push(id);
    }
  }

  if (roots.length === 0 && graph.length > 0) {
    roots.push(buildNodeId(graph[0].id));
  }

  for (const root of roots) {
    assignLevel(root, 0);
  }

  for (const n of graph) {
    const id = buildNodeId(n.id);
    if (!levels.has(id)) {
      levels.set(id, 0);
    }
  }

  const levelGroups = new Map<number, string[]>();
  for (const [nodeId, level] of levels) {
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level)!.push(nodeId);
  }

  const HORIZONTAL_SPACING = 400;
  const VERTICAL_SPACING = 120;

  const rfNodes: Node[] = graph.map((n) => {
    const id = buildNodeId(n.id);
    const level = levels.get(id) || 0;
    const group = levelGroups.get(level) || [id];
    const indexInGroup = group.indexOf(id);
    const groupSize = group.length;

    return {
      id,
      type: getNodeType(n.type),
      position: {
        x: level * HORIZONTAL_SPACING + 40,
        y: indexInGroup * VERTICAL_SPACING + 40 + (3 - groupSize) * (VERTICAL_SPACING / 2),
      },
      data: {
        nodeData: n.data,
        nodeType: n.type,
      },
    };
  });

  const edgeSet = new Set<string>();
  const rfEdges: Edge[] = [];
  const edgeColorByTarget = new Map<string, string>();
  const edgeColorCursor = new Map<string, number>();

  for (const n of graph) {
    for (const edge of n.outEdges) {
      const sourceId = buildNodeId(edge.origin);
      const targetId = buildNodeId(edge.destination);
      const edgeKey = `${sourceId}->${targetId}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      // 指向同一目标节点（destination）的连线采用同一种颜色，不同目标之间颜色明显区分
      let color = edgeColorByTarget.get(targetId);
      if (!color) {
        color = buildEdgeColor(targetId, edgeColorCursor);
        edgeColorByTarget.set(targetId, color);
      }

      rfEdges.push({
        id: edgeKey,
        source: sourceId,
        target: targetId,
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color,
        },
        style: { stroke: color, strokeWidth: 1.5 },
      });
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

const LineageGraph: React.FC<LineageGraphProps> = ({ lineage, onNodeClick }) => {
  const { initialNodes, initialEdges } = useMemo(() => {
    if (!lineage || !lineage.graph || lineage.graph.length === 0) {
      return { initialNodes: [], initialEdges: [] };
    }
    const result = computeLayout(lineage.graph);
    return { initialNodes: result.nodes, initialEdges: result.edges };
  }, [lineage]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (onNodeClick && (node.data as Record<string, unknown>)?.nodeType) {
      onNodeClick(node.id, (node.data as Record<string, unknown>).nodeType as NodeType);
    }
  }, [onNodeClick]);

  if (!lineage || !lineage.graph || lineage.graph.length === 0) {
    return (
      <div className="lineage-graph__empty">
        <Database size={48} strokeWidth={1} />
        <p>暂无血缘数据</p>
        <span>请搜索并选择一个数据集或作业来查看血缘关系</span>
      </div>
    );
  }

  return (
    <div className="lineage-graph__container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#333" />
        <Controls
          showInteractive={false}
          style={{ background: '#2d2d2d', borderRadius: '6px', border: '1px solid #444' }}
        />
      </ReactFlow>
    </div>
  );
};

export default LineageGraph;
