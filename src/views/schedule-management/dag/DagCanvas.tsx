/**
 * x6 工作流画布 React 组件（从 dolphinscheduler-ui 的 use-canvas-init.ts + dag-canvas.tsx 移植）。
 * 负责 Graph 初始化、自定义 cell 注册、悬停/连线交互与 resize 自适应。
 * 父组件通过 onGraphReady 拿到 graph 实例，作为节点/边的唯一数据源。
 */
import React, { useEffect, useRef } from 'react';
import { Graph } from '@antv/x6';
import type { Markup, Node } from '@antv/x6';
import '@antv/x6/dist/x6.css';
import { NODE, EDGE, X6_NODE_NAME, X6_EDGE_NAME } from './dag-config';
import './x6-style.css';

interface DagCanvasProps {
  readonly?: boolean;
  onGraphReady: (graph: Graph) => void;
  /** 追加到画布容器内的覆盖层（如图例） */
  children?: React.ReactNode;
  /** 悬停节点时显示完整任务名的浮层（实例详情有状态徽标时建议关闭，避免与徽标重叠） */
  showHoverLabel?: boolean;
}

const DagCanvas: React.FC<DagCanvasProps> = ({
  readonly = false,
  onGraphReady,
  children,
  showHoverLabel = true,
}) => {
  const paperRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  const onGraphReadyRef = useRef(onGraphReady);
  onGraphReadyRef.current = onGraphReady;
  const showHoverLabelRef = useRef(showHoverLabel);
  showHoverLabelRef.current = showHoverLabel;

  useEffect(() => {
    const container = containerRef.current;
    const paper = paperRef.current;
    const minimap = minimapRef.current;
    if (!container || !paper || !minimap) return;

    // 注册自定义 cell（先反注册再注册，保证 StrictMode 双挂载安全）
    Graph.unregisterNode(X6_NODE_NAME);
    Graph.unregisterEdge(X6_EDGE_NAME);
    Graph.registerNode(X6_NODE_NAME, { ...NODE });
    Graph.registerEdge(X6_EDGE_NAME, { ...EDGE });

    const graph = new Graph({
      container: paper,
      selecting: {
        enabled: true,
        multiple: true,
        rubberband: true,
        rubberEdge: true,
        movable: true,
        showNodeSelectionBox: false
      },
      scaling: {
        min: 0.2,
        max: 2
      },
      mousewheel: {
        enabled: true,
        modifiers: ['ctrl', 'meta']
      },
      scroller: true,
      grid: {
        size: 10,
        visible: true
      },
      snapline: true,
      minimap: {
        enabled: true,
        container: minimap,
        scalable: true,
        width: 250,
        height: 150
      },
      interacting: {
        edgeLabelMovable: false,
        nodeMovable: !readonlyRef.current,
        magnetConnectable: !readonlyRef.current
      },
      connecting: {
        // 同一对起止节点之间不允许创建多条边
        allowMulti: false,
        // 不允许连接到画布空白处
        allowBlank: false,
        // 起止节点为同一节点时不创建边
        allowLoop: false,
        // 不允许边连边
        allowEdge: false,
        // 允许边连节点
        allowNode: true,
        // 不允许边连端口
        allowPort: false,
        // 拖边时高亮所有可用端口/节点
        highlight: true,
        createEdge() {
          return graph.createEdge({ shape: X6_EDGE_NAME });
        },
        validateConnection(data) {
          const { sourceCell, targetCell } = data;
          if (
            sourceCell &&
            targetCell &&
            sourceCell.isNode() &&
            targetCell.isNode()
          ) {
            const sourceData = sourceCell.getData();
            if (!sourceData) return true;
            // CONDITIONS 节点最多允许 2 条出边
            if (sourceData.taskType !== 'CONDITIONS') return true;
            const edges = graph.getConnectedEdges(sourceCell);
            if (!edges || edges.length < 2) return true;
            let len = 0;
            return !edges.some((edge) => {
              if (edge.getSourceCellId() === sourceCell.id) {
                len++;
              }
              return len > 2;
            });
          }
          return true;
        },
        validateEdge({ edge }) {
          const sourceData = edge.getSourceNode()?.getData();
          const targetData = edge.getTargetNode()?.getData();
          edge.setAttrs({
            line: {
              strokeDasharray:
                sourceData?.taskExecuteType === 'STREAM' ||
                targetData?.taskExecuteType === 'STREAM'
                  ? '5 5'
                  : 'none'
            }
          });
          return true;
        }
      },
      highlighting: {
        nodeAvailable: {
          name: 'className',
          args: {
            className: 'available'
          }
        },
        magnetAvailable: {
          name: 'className',
          args: {
            className: 'available'
          }
        },
        magnetAdsorbed: {
          name: 'className',
          args: {
            className: 'adsorbed'
          }
        }
      }
    });
    graphRef.current = graph;

    // 让边从节点（而非端口）出发
    graph.on('edge:connected', ({ isNew, edge }) => {
      if (isNew) {
        const sourceNode = edge.getSourceNode() as Node;
        edge.setSource(sourceNode);
      }
    });

    // 鼠标悬停时在节点上方显示任务名
    graph.on('node:mouseenter', ({ node }) => {
      if (!showHoverLabelRef.current) return;
      const data = node.getData() as { taskName?: string } | undefined;
      const nodeName = data?.taskName || node.id;
      const markup = node.getMarkup() as Markup.JSONMarkup[];
      const fo = markup.find((m) => m.tagName === 'foreignObject');
      node.addTools({
        name: 'button',
        args: {
          markup: [
            {
              tagName: 'text',
              textContent: nodeName,
              attrs: {
                fill: '#868686',
                'font-size': 16,
                'text-anchor': 'center'
              }
            }
          ],
          x: 0,
          y: 0,
          offset: { x: 0, y: fo ? -28 : -10 }
        }
      });
    });

    graph.on('node:mouseleave', ({ node }) => {
      node.removeTool('button');
    });

    // 页面尺寸变化时重绘
    const resize = () => {
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      graph.resize(w, h);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    onGraphReadyRef.current(graph);

    return () => {
      resizeObserver.disconnect();
      graph.dispose();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dag-canvas" ref={containerRef}>
      <div className="dag-paper" ref={paperRef} />
      <div className="dag-minimap" ref={minimapRef} />
      {children}
    </div>
  );
};

export default DagCanvas;
