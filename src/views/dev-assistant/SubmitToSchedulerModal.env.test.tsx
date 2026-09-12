import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import { ToastProvider } from '../../components/Toast';
import type { CodeFileMapping } from '../../utils/schedulerMapping';
import type { DolphinSchedulerApi } from '../../types/dolphinscheduler';

/**
 * 单文件「提交调度」的「环境」单选接线（生产 / 灰度 / 测试，默认测试）。
 *
 * 需求：弹窗内提供环境单选，选中的环境拼在**工作流名称末尾**作为后缀
 * （`olist_code_ods` → `olist_code_ods_test`）；
 * 同时**移除原有的 `_v{N}` 版本链**——版本不再按同前缀工作流的定时调度状态自动生成，
 * 改由环境区分同名工作流。
 *
 * 这里只钉住「名称如何随环境变化」这一条链路：提交/编译/依赖重建等重链路不在本用例范围，
 * 因此用 SHELL 任务（不需要数据源）并 mock 掉 unifiedCompile，避免拉起主进程编译器。
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

/** SHELL 任务：不要求数据源，且不参与编译，便于聚焦名称链路 */
const MAPPING: CodeFileMapping = {
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
  headerDependencies: [],
};

const envRadio = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"] input`) as HTMLInputElement;
const envOption = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"]`) as HTMLElement;
const nameInput = () =>
  screen.getByTestId('submit-scheduler-workflow-name') as HTMLInputElement;

const renderModal = (dsApi: ReturnType<typeof makeDsApi> = makeDsApi()) => {
  const utils = render(
    <ToastProvider>
      <SubmitToSchedulerModal
        visible
        fileName="olist_orders.sh"
        codeContent="echo 1"
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

describe('SubmitToSchedulerModal — 环境单选决定工作流名称后缀', () => {
  it('默认选中「测试」，工作流名称自动带 _test 后缀', async () => {
    const { container } = renderModal();

    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));
    expect(envOption('test').getAttribute('data-active')).toBe('true');
    expect(envOption('gray').getAttribute('data-active')).toBe('false');
    expect(envOption('prod').getAttribute('data-active')).toBe('false');
    // 三个选项齐全
    expect(envOption('prod').textContent).toContain('生产');
    expect(envOption('gray').textContent).toContain('灰度');
    // 不再有任何「版本」相关提示
    expect(container.textContent).not.toContain('新版本');
    expect(container.textContent).not.toContain('同前缀工作流');
  });

  it('切换环境后工作流名称换成对应后缀', async () => {
    renderModal();
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));

    fireEvent.click(envRadio('prod'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_prod'));

    fireEvent.click(envRadio('gray'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_gray'));

    fireEvent.click(envRadio('test'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));
  });

  it('名称里不再追加 _v{N} 版本后缀', async () => {
    renderModal();
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));

    fireEvent.click(envRadio('prod'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_prod'));
    expect(nameInput().value).toMatch(/^olist_code_ods_(prod|gray|test)$/);
  });
});
