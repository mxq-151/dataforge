import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import { ToastProvider } from '../../components/Toast';
import type { CodeFileMapping } from '../../utils/schedulerMapping';
import type { DolphinSchedulerApi } from '../../types/dolphinscheduler';

/**
 * 单文件「提交调度」的任务节点「应用名称」。
 *
 * 需求：应用名称不再由代码推导，而是与工作流基本信息保持一致 ——
 * `{项目}.{工作流}.{任务}`，其中工作流名是**含环境后缀**的最终名称；
 * 该字段只读，且提交到调度系统的 taskParams.appName 就是同一个值。
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

/** SPARK + .py：有「应用名称」项，且既不需要数据源也不参与编译，便于聚焦应用名称链路 */
const MAPPING: CodeFileMapping = {
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
    // 旧口径（由代码/主类推导）的值，应被自动生成值覆盖
    appName: 'OdsEcomCustomer',
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
};

const envRadio = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"] input`) as HTMLInputElement;
const appNameInput = () =>
  screen.getByTestId('submit-scheduler-app-name') as HTMLInputElement;

const renderModal = (dsApi: ReturnType<typeof makeDsApi> = makeDsApi()) => {
  const utils = render(
    <ToastProvider>
      <SubmitToSchedulerModal
        visible
        fileName="ods_ecom_customer.py"
        codeContent="print(1)"
        mapping={MAPPING}
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

describe('SubmitToSchedulerModal — 应用名称 = 项目.工作流.任务', () => {
  it('只读展示 {项目}.{工作流}.{任务}，工作流名含环境后缀', () => {
    renderModal();

    const input = appNameInput();
    expect(input.value).toBe('demo.olist_code_ods_test.ods_ecom_customer');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it('切换环境后应用名称同步换成对应后缀', async () => {
    renderModal();

    fireEvent.click(envRadio('prod'));
    await waitFor(() =>
      expect(appNameInput().value).toBe('demo.olist_code_ods_prod.ods_ecom_customer')
    );

    fireEvent.click(envRadio('gray'));
    await waitFor(() =>
      expect(appNameInput().value).toBe('demo.olist_code_ods_gray.ods_ecom_customer')
    );
  });

  it('提交时写入的 taskParams.appName 与界面展示一致', async () => {
    const { dsApi } = renderModal();

    // 等调度项目列表回来（应用名称里的项目段就绪），否则校验会报「请选择目标项目」
    await waitFor(() =>
      expect(appNameInput().value).toBe('demo.olist_code_ods_test.ods_ecom_customer')
    );

    // 底部两个按钮的点击都挂在 onMouseDown 上。
    // 项目 / 工作流等选择项一旦变化会清空上一次校验结果，而项目列表是异步回填的，
    // 所以这里反复点「校验」，直到提交按钮真正可用（等价于用户再点一次校验）。
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
    const params = JSON.parse(node.taskParams);
    expect(params.appName).toBe('demo.olist_code_ods_test.ods_ecom_customer');
    // 其他参数不受影响
    expect(params.programType).toBe('PYTHON');
  });
});
