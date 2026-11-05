import { describe, it, expect, vi } from 'vitest';
import type { Graph } from '@antv/x6';
import { replaceGraphEdges } from './useCustomCellBuilder';

/**
 * `replaceGraphEdges` 是「保存任务配置后重建画布边」的唯一入口。
 *
 * 它存在的理由是修一个数据丢失缺陷：原先用
 * `graph.clearCells({ edges: true, nodes: false })`，而 x6 的 `Model.clear(options)`
 * 只识别内部的 `clear` 标记，会把 `getCells()` 返回的全部 cell（边 + 节点）无差别移除，
 * `nodes: false` 完全不起作用 —— 表现为「编辑一个任务节点并保存后，工作流所有节点被清空」。
 *
 * 这里用桩图钉住三件事：只删现有边、不调用 clearCells、按新列表重建边。
 */

interface FakeCell {
  id: string;
  isEdge: () => boolean;
  isNode: () => boolean;
}

function makeGraph(edgeIds: string[]) {
  const edges: FakeCell[] = edgeIds.map((id) => ({
    id,
    isEdge: () => true,
    isNode: () => false,
  }));
  const removed: FakeCell[] = [];
  const added: unknown[] = [];
  const graph = {
    getEdges: () => edges,
    removeCells: vi.fn((cells: FakeCell[]) => {
      removed.push(...cells);
      return graph;
    }),
    addEdge: vi.fn((meta: unknown) => {
      added.push(meta);
      return graph;
    }),
    // 故意提供：若实现回退到 clearCells，这条断言会立刻失败
    clearCells: vi.fn(() => graph),
  };
  return { graph, removed, added };
}

describe('replaceGraphEdges', () => {
  it('删除的正是现有边，且从不调用 clearCells（节点必须保住）', () => {
    const { graph, removed } = makeGraph(['e1', 'e2']);

    replaceGraphEdges(graph as unknown as Graph, [{ id: 'n1', sourceCode: 11, targetCode: 12 }]);

    expect(removed.map((c) => c.id).sort()).toEqual(['e1', 'e2']);
    // 回归防线：clearCells 会连节点一起清空，绝不能再被调用
    expect(graph.clearCells).not.toHaveBeenCalled();
    // 被删的都是边，没有节点
    expect(removed.every((c) => c.isEdge() && !c.isNode())).toBe(true);
  });

  it('按新的边列表重建边，source/target 指向节点 id', () => {
    const { graph, added } = makeGraph([]);

    replaceGraphEdges(graph as unknown as Graph, [
      { id: 'a', sourceCode: 11, targetCode: 12 },
      { id: 'b', sourceCode: 12, targetCode: 13 },
    ]);

    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ source: { cell: '11' }, target: { cell: '12' } });
    expect(added[1]).toMatchObject({ source: { cell: '12' }, target: { cell: '13' } });
  });

  it('新边列表为空时只删不增（节点仍然保留）', () => {
    const { graph, removed, added } = makeGraph(['e1']);

    replaceGraphEdges(graph as unknown as Graph, []);

    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(0);
    expect(graph.clearCells).not.toHaveBeenCalled();
  });
});
