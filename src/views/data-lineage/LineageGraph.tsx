import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
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

function computeLayout(graph: Lineage['graph']): { nodes: Node[]; edges: Edge[] } {
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

  const HORIZONTAL_SPACING = 260;
  const VERTICAL_SPACING = 80;

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

  for (const n of graph) {
    for (const edge of n.outEdges) {
      const sourceId = buildNodeId(edge.origin);
      const targetId = buildNodeId(edge.destination);
      const edgeKey = `${sourceId}->${targetId}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      rfEdges.push({
        id: edgeKey,
        source: sourceId,
        target: targetId,
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: '#555',
        },
        style: { stroke: '#555', strokeWidth: 1.5 },
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
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'job') return '#d4915e';
            if (node.type === 'field') return '#9b7ed8';
            return '#4ec9b0';
          }}
          maskColor="rgba(0, 0, 0, 0.6)"
          style={{ background: '#1e1e1e', border: '1px solid #444', borderRadius: '6px' }}
        />
      </ReactFlow>
    </div>
  );
};

export default LineageGraph;
