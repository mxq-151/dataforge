import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import { ToastProvider } from '../../components/Toast';
import type { CodeFileMapping } from '../../utils/schedulerMapping';
import type { DolphinSchedulerApi, DSWorkflowTaskNode, DSWorkflowEdge } from '../../types/dolphinscheduler';

/**
 * 单文件「提交调度」不得改动工作流已有的依赖关系（只增不删）：
 * - 本次任务在工作流中**已存在**：只更新该节点自身内容，依赖边一律原样保留；
 * - 本次任务为**新增节点**：工作流全部原有依赖边照旧，仅按代码头 @依赖 补齐尚不存在的依赖边。
 *
 * 这里钉住的是「提交到调度系统的 nodes / edges 载荷」——即改动前会被
 * scanLocalHeaderDependencies + reconcileWorkflowDependencies 整体重建、从而抹掉
 * 其他任务既有依赖的那条链路。
 */

vi.mock('../../services/unifiedCompile', () => ({ unifiedCompile: vi.fn() }));

const pageOf = (totalList: unknown[]) => ({
  code: 0, msg: '', data: { totalList, total: totalList.length, totalPage: 1, pageSize: 100, currentPage: 1 },
});

const WF_CODE = 500;
const WF_NAME = 'olist_code_ods_test';

function mkNode(code: number, name: string, taskType = 'SHELL'): DSWorkflowTaskNode {
  return {
    code,
    name,
    taskType: taskType as DSWorkflowTaskNode['taskType'],
    description: '',
    taskParams: '{"rawScript":"echo 1","localParams":[]}',
    flag: 'YES',
    taskPriority: 'MEDIUM',
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: 100,
    y: 100,
  };
}

const mkEdge = (src: number, dst: number): DSWorkflowEdge => ({ id: `e_${src}_${dst}`, sourceCode: src, targetCode: dst });

const makeDsApi = (nodes: DSWorkflowTaskNode[], edges: DSWorkflowEdge[]) => ({
  project: { list: vi.fn(async () => pageOf([{ code: 11, name: 'demo' }])) },
  workflowDefinition: {
    // 返回同名工作流 → 提交走「更新已有工作流」分支
    list: vi.fn(async () => pageOf([{ code: WF_CODE, name: WF_NAME, version: 1, releaseState: 'OFFLINE' }])),
    detail: vi.fn(async () => ({
      code: 0,
      msg: '',
      data: {
        workflowDefinition: {
          id: 1, code: WF_CODE, name: WF_NAME, version: 1,
          executionType: 'PARALLEL', timeout: 0,
        },
        taskNodes: nodes,
        edges,
        globalParams: [],
      },
    })),
    createWithTasks: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    update: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    trigger: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    release: vi.fn(async () => ({ code: 0, msg: '', data: null })),
  },
  workerGroup: { list: vi.fn(async () => pageOf([])) },
  environment: { list: vi.fn(async () => pageOf([])) },
  datasource: { list: vi.fn(async () => pageOf([])) },
  resource: {
    queryBaseDir: vi.fn(async () => ({ code: 0, msg: '', data: '/resources' })),
    createDir: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    upload: vi.fn(async () => ({ code: 0, msg: '', data: null })),
  },
});

/** SHELL 任务：不需要数据源、不参与编译，便于聚焦依赖载荷 */
const MAPPING = (headerDependencies: CodeFileMapping['headerDependencies']): CodeFileMapping => ({
  recommendedTaskType: 'SHELL',
  recommendationReason: '',
  taskType: 'SHELL',
  taskName: 'olist_orders',
  workflowName: 'olist_code_ods',
  taskParams: { rawScript: 'echo 1', localParams: [] },
  description: '',
  filePath: '/proj/TEST/code/ods/olist_orders.sh',
  relativePath: 'code/ods/olist_orders.sh',
  dirPath: 'code/ods',
  dataSource: null,
  dataDependencies: [],
  headerDependencies,
});

const renderModal = (dsApi: ReturnType<typeof makeDsApi>, mapping: CodeFileMapping) => {
  const utils = render(
    <ToastProvider>
      <SubmitToSchedulerModal
        visible
        fileName="olist_orders.sh"
        codeContent="echo 1"
        mapping={mapping}
        savedConfig={null}
        projectCode="demo"
        dsApi={dsApi as unknown as DolphinSchedulerApi}
        isRealApi
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    </ToastProvider>
  );
  return { ...utils, dsApi };
};

/** 走完「校验通过 → 点击提交 → update 落定」，返回提交给调度系统的工作流载荷 */
async function submitAndGetPayload(dsApi: ReturnType<typeof makeDsApi>, container: HTMLElement) {
  const submitBtn = container.querySelector('.submit-scheduler__submit-btn') as HTMLButtonElement;

  fireEvent.mouseDown(screen.getByText('校验'));
  await waitFor(() => expect(container.textContent).toContain('校验通过'));
  await waitFor(() => expect(submitBtn.disabled).toBe(false));

  fireEvent.mouseDown(submitBtn);
  await waitFor(() => expect(dsApi.workflowDefinition.update).toHaveBeenCalled());

  return dsApi.workflowDefinition.update.mock.calls[0][2] as {
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
  };
}

describe('SubmitToSchedulerModal — 单文件提交不改动工作流已有依赖关系', () => {
  it('已有任务：只更新该节点内容，依赖边一条不变', async () => {
    // 工作流里 A->其他任务、以及 olist_orders 的既有入边；这些边都不属于「本次提交文件声明的依赖」
    const nodes = [mkNode(1, 'ods_upstream'), mkNode(2, 'olist_orders'), mkNode(3, 'ods_other')];
    const edges = [mkEdge(1, 3), mkEdge(2, 3)];
    const dsApi = makeDsApi(nodes, edges);

    const { container } = renderModal(dsApi, MAPPING([]));
    // 等同名工作流 + 同名任务 → 走「更新已有工作流」分支
    await waitFor(() => expect(container.textContent).toContain('工作流中已存在任务'));

    const payload = await submitAndGetPayload(dsApi, container);

    expect(payload.edges).toEqual(edges);
    expect(payload.nodes.map(n => n.code)).toEqual([1, 2, 3]);
    expect(payload.nodes.find(n => n.code === 2)?.name).toBe('olist_orders');
    // 已有节点只改自身内容：不重排全图，其他节点坐标保持原样
    expect(payload.nodes.map(n => ({ x: n.x, y: n.y }))).toEqual([
      { x: 100, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 100 },
    ]);
  });

  it('新增节点：保留工作流全部原有边，仅补齐代码头 @依赖 声明的新边', async () => {
    // olist_orders 在工作流中不存在（新增节点）；A->C 是与本次无关的既有依赖
    const nodes = [mkNode(1, 'ods_upstream'), mkNode(3, 'ods_other')];
    const edges = [mkEdge(1, 3)];
    const dsApi = makeDsApi(nodes, edges);

    const { container } = renderModal(dsApi, MAPPING([{ projectCode: '', taskName: 'ods_upstream' }]));
    await waitFor(() => expect(container.textContent).toContain('工作流中将自动创建任务'));

    const payload = await submitAndGetPayload(dsApi, container);

    const created = payload.nodes.find(n => n.name === 'olist_orders');
    expect(created).toBeTruthy();
    // 原有边保留 + 新增 代码头 @依赖 声明的那条边
    expect(payload.edges).toContainEqual(mkEdge(1, 3));
    expect(payload.edges).toContainEqual(mkEdge(1, created!.code));
    expect(payload.edges).toHaveLength(2);
    // 依赖未指向工作流内任务时不建 DEPENDENT 节点
    expect(payload.nodes.some(n => n.taskType === 'DEPENDENT')).toBe(false);
  });
});
