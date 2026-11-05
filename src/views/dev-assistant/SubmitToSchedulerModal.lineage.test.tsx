import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import { ToastProvider } from '../../components/Toast';
import type { CodeFileMapping } from '../../utils/schedulerMapping';
import type { DolphinSchedulerApi } from '../../types/dolphinscheduler';

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
 * 单文件「提交调度」的**数据血缘参数**注入闸门。
 *
 * 需求：用户选择**非生产环境**（灰度 / 测试）提交时，提交的任务**不带任何数据血缘相关参数**；
 * 只有生产环境才注入 `spark.openlineage.*`。
 *
 * 这条链路的坑在于：OpenLineage 参数与 `--jars`（自定义依赖）、用户手填的「其他参数」挤在
 * 同一个 `taskParams.others` 字段里，所以环境闸门必须只掐血缘那一段 —— 非生产环境仍然要保住
 * `--jars` 和用户自己的命令，否则「测试环境提交」会静默丢掉依赖。
 */

vi.mock('../../services/unifiedCompile', () => ({
  unifiedCompile: vi.fn(),
}));

const pageOf = (totalList: any[]) => ({
  code: 0, msg: '', data: { totalList, total: totalList.length, totalPage: 1, pageSize: 100, currentPage: 1 },
});

const makeDsApi = () => ({
  project: { list: vi.fn(async () => pageOf([{ code: 11, name: 'demo' }])) },
  workflowDefinition: {
    list: vi.fn(async () => pageOf([])),
    detail: vi.fn(async () => ({ code: 0, msg: '', data: null })),
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

/** SPARK + .py：不要求数据源、也不参与编译，便于聚焦 others 拼装链路 */
const makeMapping = (others: string): CodeFileMapping => ({
  recommendedTaskType: 'SPARK',
  recommendationReason: '',
  taskType: 'SPARK',
  taskName: 'ods_ecom_customer',
  workflowName: 'olist_code_ods',
  taskParams: {
    programType: 'PYTHON',
    mainClass: '',
    mainJar: '',
    rawScript: 'print(1)',
    appName: '',
    mainArgs: '',
    others,
    localParams: [],
    resourceList: [],
  },
  description: '',
  filePath: '/proj/TEST/code/ods/ods_ecom_customer.py',
  relativePath: 'code/ods/ods_ecom_customer.py',
  dirPath: 'code/ods',
  dataSource: null,
  dataDependencies: [],
  headerDependencies: [],
});

/** 自定义依赖：验证非生产环境仍拼出 --jars（血缘闸门不能顺手把它掐掉） */
const CUSTOM_JAR_CONFIG = {
  dependencies: [{
    id: 'd1', name: 'mysql-connector', version: '8.0.33', source: 'custom',
    jarPath: 'mysql-connector-8.0.33.jar', basePath: '/resources/jars',
  }],
  programParams: [],
  taskParams: [],
};

const TRANSPORT_URL = 'http://openlineage.test:5000';

const envRadio = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"] input`) as HTMLInputElement;

const renderModal = (
  dsApi: ReturnType<typeof makeDsApi>,
  opts: { others?: string; savedConfig?: any } = {},
) => {
  const utils = render(
    <ToastProvider>
      <SubmitToSchedulerModal
        visible
        fileName="ods_ecom_customer.py"
        codeContent="print(1)"
        mapping={makeMapping(opts.others ?? '')}
        savedConfig={opts.savedConfig ?? null}
        projectCode="demo"
        openlineageTransportUrl={TRANSPORT_URL}
        dsApi={dsApi as unknown as DolphinSchedulerApi}
        isRealApi
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    </ToastProvider>
  );
  return { ...utils, dsApi };
};

/**
 * 走完「校验 → 提交」，把最终落到调度系统的 SPARK 节点 taskParams 取回来。
 * 底部两个按钮挂在 onMouseDown 上；项目列表异步回填后校验结果会被清空，
 * 因此反复点「校验」直到提交按钮可用（与 appName 用例同法）。
 */
const submitAndGetSparkParams = async (dsApi: ReturnType<typeof makeDsApi>) => {
  const validateBtn = () => screen.getByText('校验').closest('button')!;
  const submitBtn = () => screen.getByText('提交').closest('button') as HTMLButtonElement;
  await waitFor(() => {
    fireEvent.mouseDown(validateBtn());
    expect(submitBtn().disabled).toBe(false);
  }, { timeout: 6000 });

  fireEvent.mouseDown(submitBtn());
  await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));

  const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
  const node = payload.nodes.find((n: any) => n.taskType === 'SPARK');
  return JSON.parse(node.taskParams) as Record<string, any>;
};

describe('SubmitToSchedulerModal — 血缘参数只在生产环境提交', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('生产环境：注入 spark.openlineage.*（含 transport.url 与命名空间）', async () => {
    const dsApi = makeDsApi();
    renderModal(dsApi, { others: '--master yarn' });

    fireEvent.click(envRadio('prod'));
    const params = await submitAndGetSparkParams(dsApi);

    const others = String(params.others || '');
    expect(others).toContain('--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener');
    expect(others).toContain('--conf spark.openlineage.transport.type=http');
    expect(others).toContain(`--conf spark.openlineage.transport.url=${TRANSPORT_URL}`);
    expect(others).toContain('--conf spark.openlineage.namespace=demo');
    // 用户手填的命令不被覆盖
    expect(others).toContain('--master yarn');
  });

  it('测试环境（默认）：提交的任务不带任何血缘参数，用户参数原样保留', async () => {
    const dsApi = makeDsApi();
    renderModal(dsApi, { others: '--master yarn' });
    // 默认就是测试环境，刻意不点环境单选

    const params = await submitAndGetSparkParams(dsApi);

    const others = String(params.others || '');
    expect(others.toLowerCase()).not.toContain('openlineage');
    expect(others).not.toContain('spark.extraListeners');
    expect(others).toContain('--master yarn');
  });

  it('灰度环境：同样不注入血缘参数', async () => {
    const dsApi = makeDsApi();
    renderModal(dsApi, { others: '--master yarn' });

    fireEvent.click(envRadio('gray'));
    const params = await submitAndGetSparkParams(dsApi);

    expect(String(params.others || '').toLowerCase()).not.toContain('openlineage');
  });

  it('非生产环境不注入血缘；「其他参数」里节点生成时写入的自定义 jar 原样保留、不重复拼接', async () => {
    const dsApi = makeDsApi();
    // `--jars` 现在由生成任务节点时写入 others（见 schedulerMapping.applyCustomJarsToOthers），
    // 提交阶段只补血缘那一段 —— 这里用带 jar 的 others 模拟生成结果，并传 savedConfig 证明不会重复拼一次
    const jarArg = '--jars /resources/jars/mysql-connector-8.0.33.jar';
    renderModal(dsApi, { others: jarArg, savedConfig: CUSTOM_JAR_CONFIG });

    fireEvent.click(envRadio('gray'));
    const params = await submitAndGetSparkParams(dsApi);

    const others = String(params.others || '');
    expect(others).toContain(jarArg);
    expect(others.match(/--jars/g)).toHaveLength(1);
    expect(others.toLowerCase()).not.toContain('openlineage');
  });

  it('生产环境下文件级 lineage.enabled=false 仍然能关掉血缘（环境闸门不夺走单任务开关）', async () => {
    const dsApi = makeDsApi();
    renderModal(dsApi, {
      savedConfig: {
        dependencies: [],
        programParams: [],
        taskParams: [{ id: 't1', key: 'lineage.enabled', value: 'false' }],
      },
    });

    fireEvent.click(envRadio('prod'));
    const params = await submitAndGetSparkParams(dsApi);

    expect(String(params.others || '').toLowerCase()).not.toContain('openlineage');
  });

  it('界面提示随环境变化，明确说明非生产不带血缘参数', async () => {
    const dsApi = makeDsApi();
    const { container } = renderModal(dsApi);

    await waitFor(() =>
      expect(container.textContent).toContain('不注入数据血缘参数')
    );

    fireEvent.click(envRadio('prod'));
    await waitFor(() =>
      expect(container.textContent).toContain('提交时注入数据血缘参数')
    );
  });
});
