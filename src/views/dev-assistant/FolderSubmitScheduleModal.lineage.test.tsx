import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import FolderSubmitScheduleModal from './FolderSubmitScheduleModal';
import { ToastProvider } from '../../components/Toast';
import { ExecutionType, type DolphinSchedulerApi } from '../../types/dolphinscheduler';

/**
 * 当前 vitest/jsdom 环境未注入全局 localStorage（Node 22+ 实验性全局未启用，
 * 缺失时 localStorage 为 undefined）。这些用例需要清空 localStorage，提供内存版实现。
 */
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    removeItem: (k: string) => { storage.delete(k); },
    clear: () => { storage.clear(); },
  },
});

/**
 * 文件夹「提交调度」的数据血缘参数注入（生产环境）与闸门。
 *
 * 需求：生产环境批量提交时，与单文件入口一样给 Spark 节点带上 `spark.openlineage.*`；
 * 灰度 / 测试环境**一个血缘参数都不带**（也不为此去后端查配置）。
 *
 * 配置来源的差别是这里的关键：文件夹入口没有逐文件配置的内存态，所以只在「确实要注入」
 * 时才按文件去后端查 `lineage.*`；文件级 `lineage.enabled=false` 要能真正关掉，
 * 否则用户在「配置参数」里关掉血缘的开关会被批量提交静默推翻。
 *
 * 工作流定义编辑器（x6 画布，jsdom 下不可渲染）与 unifiedCompile / bridge.fs 一律替换为桩。
 */

const fetchProjectConfigByFilePath = vi.fn();

vi.mock('../schedule-management/components/WorkflowDefinitionEditor', () => ({
  default: (props: any) => (
    <div
      data-testid="wf-editor"
      data-workflow-name={props.workflowName}
      data-node-names={props.existingNodes.map((n: any) => n.name).join(',')}
    >
      <button
        data-testid="wf-save"
        onClick={() => {
          props.onSave({
            name: props.workflowName,
            description: 'desc',
            executionType: ExecutionType.PARALLEL,
            timeout: 0,
            globalParams: [],
            nodes: props.existingNodes,
            edges: props.existingEdges,
            release: true,
          });
        }}
      >
        save
      </button>
    </div>
  ),
}));

vi.mock('../../services/unifiedCompile', () => ({
  unifiedCompile: vi.fn(),
}));

vi.mock('../../bridge/fs', () => ({
  readFile: vi.fn(async () => new Uint8Array([0x50, 0x4b])),
}));

// 逐文件血缘配置来自后端 /params（hook useDevProjectConfig 的底层接口）
vi.mock('../../api/devProject', () => ({
  fetchProjectConfigByFilePath: (...args: unknown[]) => fetchProjectConfigByFilePath(...args),
  saveProjectConfig: vi.fn(async () => ({ code: 200, message: '', data: null })),
}));

const ROOT = '/proj/src';
const FOLDER = `${ROOT}/demo`;

const header = (fields: Record<string, string>) =>
  `/*\n${Object.entries(fields).map(([k, v]) => ` * @${k}: ${v}`).join('\n')}\n */\n`;

/** 一个 SPARK（.py + @引擎:spark，不需要编译）+ 一个 SQL（不该被注入血缘） */
const FILES: Record<string, string> = {
  [`${FOLDER}/ods_a.py`]: header({ 引擎: 'spark' }) + 'print(1)\n',
  [`${FOLDER}/ods_b.sql`]: header({ 引擎: 'mysql' }) + 'select 1;\n',
};

const TRANSPORT_URL = 'http://openlineage.test:5000';

const pageOf = (totalList: any[]) => ({
  code: 0, msg: '', data: { totalList, total: totalList.length, totalPage: 1, pageSize: 200, currentPage: 1 },
});

const makeDsApi = () => {
  const workflows: { code: number; name: string }[] = [];
  let nextCode = 500;
  const api = {
    project: { list: vi.fn(async () => pageOf([{ code: 11, name: 'demo' }])) },
    workflowDefinition: {
      list: vi.fn(async (_pc: number, params?: { searchVal?: string }) =>
        pageOf(params?.searchVal ? workflows.filter(w => w.name === params.searchVal) : workflows)),
      detail: vi.fn(async () => ({
        code: 0, msg: '',
        data: { workflowDefinition: { code: 1, name: 'wf' } as any, taskNodes: [], edges: [], globalParams: [] },
      })),
      createWithTasks: vi.fn(async (_pc: number, payload: { name: string }) => {
        workflows.push({ code: nextCode++, name: payload.name });
        return { code: 0, msg: '', data: null };
      }),
      update: vi.fn(async () => ({ code: 0, msg: '', data: null })),
      release: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    },
    workerGroup: { list: vi.fn(async () => pageOf([])) },
    environment: { list: vi.fn(async () => pageOf([])) },
    resource: {
      queryBaseDir: vi.fn(async () => ({ code: 0, msg: '', data: '/resources' })),
      createDir: vi.fn(async () => ({ code: 0, msg: '', data: null })),
      upload: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    },
  };
  return api as unknown as DolphinSchedulerApi & typeof api;
};

const readFileContent = vi.fn(async (p: string) => FILES[p] ?? '');

const renderModal = (overrides: Record<string, any> = {}) => {
  const dsApi = overrides.dsApi ?? makeDsApi();
  const props = {
    visible: true,
    folderPath: FOLDER,
    codeFilePaths: Object.keys(FILES),
    rootPath: ROOT,
    projectCode: 'demo',
    readFileContent,
    dsApi,
    isRealApi: true,
    openlineageTransportUrl: TRANSPORT_URL,
    devProjectId: 7,
    onClose: vi.fn(),
    ...overrides,
    dsApi,
  };
  const utils = render(
    <ToastProvider>
      <FolderSubmitScheduleModal {...props} />
    </ToastProvider>
  );
  return { ...utils, props, dsApi };
};

const envRadio = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"] input`) as HTMLInputElement;

/** 点保存并取回提交给调度系统的节点 taskParams（按任务名索引） */
const saveAndGetNodeParams = async (dsApi: ReturnType<typeof makeDsApi>, findByTestId: any) => {
  fireEvent.click(await findByTestId('wf-save'));
  await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));

  const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
  const byName = new Map<string, Record<string, any>>();
  payload.nodes.forEach((n: any) => byName.set(n.name, JSON.parse(n.taskParams)));
  return byName;
};

beforeEach(() => {
  readFileContent.mockClear();
  fetchProjectConfigByFilePath.mockReset();
  fetchProjectConfigByFilePath.mockResolvedValue({ code: 200, message: '', data: null });
  localStorage.clear();
});

describe('FolderSubmitScheduleModal — 生产环境批量提交注入血缘参数', () => {
  it('生产环境：SPARK 节点带上 spark.openlineage.*（含全局 transport.url 与项目命名空间）', async () => {
    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    const spark = params.get('ods_a')!;
    const others = String(spark.others || '');
    // 该文件没有其他参数声明，注入结果就是四个 --conf 拼成的一行
    expect(others).toBe(
      '--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener'
      + ' --conf spark.openlineage.transport.type=http'
      + ` --conf spark.openlineage.transport.url=${TRANSPORT_URL}`
      + ' --conf spark.openlineage.namespace=demo'
    );
  });

  it('生产环境：非 SPARK 节点（SQL）不受影响', async () => {
    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_b')?.others || '')).not.toContain('openlineage');
  });

  it('生产环境：文件级 lineage.enabled=false 能关掉该文件的血缘（不被批量提交推翻）', async () => {
    fetchProjectConfigByFilePath.mockImplementation(async (_pid: number, filePath: string) => ({
      code: 200,
      message: '',
      data: {
        projectId: 7,
        filePath,
        engine: 'spark',
        datasources: [],
        jarDependencyCatalogs: [],
        runParams: {},
        computeResources: { 'lineage.enabled': 'false' },
        remark: '',
      },
    }));

    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_a')?.others || '')).not.toContain('openlineage');
    // 反向证明这次确实走了「查配置」这条链路（否则用例可能因为没查到而假绿）
    expect(fetchProjectConfigByFilePath).toHaveBeenCalledWith(7, 'demo/ods_a.py');
  });

  it('生产环境：文件级 transportUrl 覆盖设置页的全局值', async () => {
    fetchProjectConfigByFilePath.mockImplementation(async (_pid: number, filePath: string) => ({
      code: 200,
      message: '',
      data: {
        projectId: 7,
        filePath,
        engine: 'spark',
        datasources: [],
        jarDependencyCatalogs: [],
        runParams: {},
        computeResources: { 'lineage.transportUrl': 'http://file-level:5000' },
        remark: '',
      },
    }));

    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_a')?.others || ''))
      .toContain('--conf spark.openlineage.transport.url=http://file-level:5000');
  });

  it('后端查不到配置时按「未显式关闭」处理，用全局设置注入（与单文件兜底同口径）', async () => {
    fetchProjectConfigByFilePath.mockResolvedValue({ code: 200, message: '', data: null });

    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_a')?.others || '')).toContain(`transport.url=${TRANSPORT_URL}`);
  });
});

describe('FolderSubmitScheduleModal — 非生产环境不提交血缘参数', () => {
  it('测试环境（默认）：不带血缘参数，且不为血缘去后端查配置', async () => {
    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    // 默认就是测试环境，刻意不点环境单选
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_a')?.others || '').toLowerCase()).not.toContain('openlineage');
    expect(fetchProjectConfigByFilePath).not.toHaveBeenCalled();
  });

  it('灰度环境：同样不带血缘参数，也不查配置', async () => {
    const dsApi = makeDsApi();
    const { findByTestId } = renderModal({ dsApi });
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('gray'));
    const params = await saveAndGetNodeParams(dsApi, findByTestId);

    expect(String(params.get('ods_a')?.others || '').toLowerCase()).not.toContain('openlineage');
    expect(fetchProjectConfigByFilePath).not.toHaveBeenCalled();
  });

  it('界面提示随环境变化，明确说明非生产不带血缘参数', async () => {
    const { findByTestId, container } = renderModal();
    await findByTestId('wf-editor');

    await waitFor(() => expect(container.textContent).toContain('不注入数据血缘参数'));

    fireEvent.click(envRadio('prod'));
    await waitFor(() => expect(container.textContent).toContain('提交时注入数据血缘参数'));
  });
});
