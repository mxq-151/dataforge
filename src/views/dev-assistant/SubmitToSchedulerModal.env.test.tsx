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

const renderModal = (dsApi: ReturnType<typeof makeDsApi> = makeDsApi(), overrides: Record<string, unknown> = {}) => {
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
        {...overrides}
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

describe('SubmitToSchedulerModal — 角色准入（生产仅运维/超管）', () => {
  const submitBtn = (container: HTMLElement) =>
    container.querySelector('.submit-scheduler__submit-btn') as HTMLButtonElement;

  it('无生产权限时「生产」置灰不可点，灰度/测试仍可选', async () => {
    renderModal(makeDsApi(), { canSubmitProd: false });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));

    expect(envRadio('prod').disabled).toBe(true);
    expect(envOption('prod').getAttribute('data-disabled')).toBe('true');
    expect(envOption('prod').getAttribute('title')).toContain('运维工程师');
    expect(envRadio('gray').disabled).toBe(false);
    expect(envRadio('test').disabled).toBe(false);
  });

  it('无提交调度权限时校验拦截并提示，提交按钮保持禁用', async () => {
    const { container } = renderModal(makeDsApi(), { canSubmitSchedule: false, canSubmitProd: false });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));

    fireEvent.mouseDown(screen.getByText('校验'));

    await waitFor(() => expect(container.textContent).toContain('当前角色无权提交调度'));
    expect(container.textContent).toContain('数据开发工程师');
    expect(submitBtn(container).disabled).toBe(true);
  });

  it('数据开发工程师（无生产权限）在测试/灰度环境照常校验通过', async () => {
    const { container } = renderModal(makeDsApi(), { canSubmitProd: false });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));
    // 等名称检查等异步装饰落定，避免校验通过后被后续 effect 重置（validationPassed 会随环境/名称变更复位）
    await waitFor(() => expect(container.textContent).not.toContain('正在检查工作流名称'));

    fireEvent.mouseDown(screen.getByText('校验'));
    await waitFor(() => expect(container.textContent).toContain('校验通过'));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));

    // 灰度同样可提交（名称换成 _gray 后缀后再次校验仍通过）
    fireEvent.click(envRadio('gray'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_gray'));
    fireEvent.mouseDown(screen.getByText('校验'));
    await waitFor(() => expect(container.textContent).toContain('校验通过'));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
  });

  it('越权把环境切到生产（绕过置灰）时校验按角色拦截', async () => {
    const { container } = renderModal(makeDsApi(), { canSubmitProd: false });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));

    // 置灰只是 UX 层。这里手动摘掉 disabled 属性再点击，模拟「绕过界面直接切到生产」，
    // 钉住的是第二道拦截（校验 / 提交里的角色闸门）必须生效。
    const prodRadio = envRadio('prod');
    prodRadio.disabled = false;
    fireEvent.click(prodRadio);
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_prod'));

    fireEvent.mouseDown(screen.getByText('校验'));

    await waitFor(() => expect(container.textContent).toContain('生产环境提交调度仅「运维工程师」可发起'));
    expect(submitBtn(container).disabled).toBe(true);
  });
});

describe('SubmitToSchedulerModal — 生产环境的库环境闸门', () => {
  const submitBtn = (container: HTMLElement) =>
    container.querySelector('.submit-scheduler__submit-btn') as HTMLButtonElement;

  it('生产环境 + 代码引用了非生产库：校验拦截，提交按钮保持禁用', async () => {
    const { container } = renderModal(makeDsApi(), {
      codeContent: 'select * from ods_olist_test.ods_olist_order_d;',
    });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));
    fireEvent.click(envRadio('prod'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_prod'));

    fireEvent.mouseDown(screen.getByText('校验'));

    await waitFor(() => expect(container.textContent).toContain('非生产库「ods_olist_test」'));
    expect(container.textContent).toContain('第 1 行');
    expect(submitBtn(container).disabled).toBe(true);
  });

  it('生产环境 + 代码全部引用生产库：校验通过，可以提交', async () => {
    const { container } = renderModal(makeDsApi(), {
      codeContent: 'select * from ods_olist_prod.ods_olist_order_d;',
    });
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_test'));
    fireEvent.click(envRadio('prod'));
    await waitFor(() => expect(nameInput().value).toBe('olist_code_ods_prod'));

    fireEvent.mouseDown(screen.getByText('校验'));

    await waitFor(() => expect(container.textContent).toContain('校验通过'));
    expect(container.textContent).not.toContain('非生产库');
    expect(submitBtn(container).disabled).toBe(false);
  });
});
