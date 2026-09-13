import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import { ToastProvider } from '../../components/Toast';
import { mapCodeFileToTask } from '../../utils/schedulerMapping';
import type { DolphinSchedulerApi } from '../../types/dolphinscheduler';

/**
 * 「提交调度」的节点任务参数来自源代码头。
 *
 * 需求：代码头用 @程序参数 / @资源参数 / @任务参数 声明参数（取值即真实值，见
 * hooks/opencode/opencodeInstructions.ts「代码头格式规范」），提交调度时必须自动填进
 * 任务节点对应字段，且**优先级最高** —— 压过引擎默认值与「上次记住的取值」；
 * 映射不到字段的声明不许静默丢弃，要在界面上说明去向。
 *
 * 本用例走真实链路：mapCodeFileToTask（含 headerTaskParams 换算）→ 弹窗回填。
 * 顺带充当别名表与 TASK_TYPE_PARAMS_CONFIG 的一致性守卫：断言的是**界面上真实渲染出的
 * 输入框取值**，一旦换算表写出本任务类型不存在的参数名，这里就会红。
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

/** spark 引擎的代码头：三类参数齐全，含必须回报的自动生成项（--jars）与无对应字段的 --master */
const SPARK_CONTENT = [
  '/*',
  ' * @备注: 测试代码头驱动的节点参数',
  ' * @引擎: spark',
  ' * @程序参数: --day 20260501',
  ' * @资源参数: --num-executors 4 --driver-memory 2g --executor-cores 2 --queue root.default',
  ' * @任务参数: --master yarn --deploy-mode cluster --class com.demo.OdsLoad --jars dep.jar',
  ' * @数据源: test_datasource',
  ' */',
  'package TEST.java.ods;',
].join('\n');

const FLINK_CONTENT = [
  '/*',
  ' * @备注: 测试 flink 短选项',
  ' * @引擎: flink',
  ' * @程序参数: --day 20260501',
  ' * @资源参数: -p 4 -yjm 1024 -ytm 2048 -ys 2 -yn 3 -yqu root.default',
  ' * @任务参数: -m yarn-cluster -Dyarn.application.name=ods_load',
  ' * @数据源: test_datasource',
  ' */',
  'package TEST.java.ods;',
].join('\n');

/** 界面上渲染出的「配置项标签 → 输入值」；标签里的单位括注（如「最大内存(MB)」）会被去掉 */
const paramValues = (): Record<string, string> => {
  const out: Record<string, string> = {};
  document.querySelectorAll('.submit-scheduler__param-item').forEach(item => {
    const raw = item.querySelector('.submit-scheduler__param-label')?.textContent || '';
    const label = raw.replace(/\(.*$/, '').trim();
    const field = item.querySelector('input, select, textarea') as HTMLInputElement | null;
    if (label) out[label] = field ? String(field.value) : '';
  });
  return out;
};

const renderModal = (
  fileName: string,
  codeContent: string,
  dsApi: ReturnType<typeof makeDsApi> = makeDsApi(),
) => {
  const mapping = mapCodeFileToTask(
    fileName,
    codeContent,
    `/proj/TEST/code/ods/${fileName}`,
    '/proj',
  );
  const utils = render(
    <ToastProvider>
      <SubmitToSchedulerModal
        visible
        fileName={fileName}
        codeContent={codeContent}
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
  return { ...utils, mapping };
};

/** 写入「上次记住的取值」（localStorage），验证代码头能把它压过去 */
const rememberValues = (taskType: string, values: Record<string, string | number>) => {
  localStorage.setItem(
    'ds-submit-remember-v1',
    JSON.stringify({ taskTypes: { [taskType]: values } }),
  );
};

describe('SubmitToSchedulerModal — 节点任务参数来自代码头', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('SPARK：@资源参数 / @任务参数 的真实取值填进对应节点字段', () => {
    renderModal('OdsLoad.java', SPARK_CONTENT);

    const values = paramValues();
    expect(values['Executor数量']).toBe('4');
    expect(values['Driver内存']).toBe('2g');
    expect(values['Executor核心数']).toBe('2');
    expect(values['YARN队列']).toBe('root.default');
    expect(values['部署模式']).toBe('cluster');
    expect(values['主Class']).toBe('com.demo.OdsLoad');
  });

  it('SPARK：@程序参数 的取值写进「主参数」，映射不到字段的声明原样进「其他参数」', () => {
    renderModal('OdsLoad.java', SPARK_CONTENT);

    const values = paramValues();
    expect(values['主参数']).toBe('--day 20260501');
    expect(values['其他参数']).toBe('--master yarn');
  });

  it('代码头优先级最高：压过「上次记住的取值」', () => {
    rememberValues('SPARK', { numExecutors: 9, driverMemory: '8g' });
    renderModal('OdsLoad.java', SPARK_CONTENT);

    const values = paramValues();
    expect(values['Executor数量']).toBe('4');
    expect(values['Driver内存']).toBe('2g');
  });

  it('界面显式说明：哪些参数来自代码头、哪些声明没能落到节点字段（--jars 由依赖自动拼装）', () => {
    renderModal('OdsLoad.java', SPARK_CONTENT);

    const applied = document.querySelector('[data-testid="submit-scheduler-header-params-applied"]');
    expect(applied?.textContent).toContain('已按代码头填充');
    expect(applied?.textContent).toContain('numExecutors');
    expect(applied?.textContent).toContain('mainArgs');

    const unmapped = document.querySelectorAll('[data-testid="submit-scheduler-header-params-unmapped"]');
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0].textContent).toContain('--jars dep.jar');
    expect(unmapped[0].textContent).toContain('自动');
  });

  it('FLINK：短选项 / YARN 简写落到对应字段（含 -m yarn-cluster → 部署模式 cluster）', () => {
    renderModal('OdsLoad.java', FLINK_CONTENT);

    const values = paramValues();
    expect(values['并行度']).toBe('4');
    expect(values['JobManager内存']).toBe('1024');
    expect(values['TaskManager内存']).toBe('2048');
    expect(values['Slot数']).toBe('2');
    expect(values['TaskManager数']).toBe('3');
    expect(values['YARN队列']).toBe('root.default');
    expect(values['部署模式']).toBe('cluster');
    expect(values['主参数']).toBe('--day 20260501');
    expect(values['其他参数']).toBe('-Dyarn.application.name=ods_load');
  });

  it('没有代码头声明时不显示提示块', () => {
    const plain = ['/*', ' * @引擎: spark', ' * @程序参数: 无', ' * @数据源: ds', ' */', 'package a.b;'].join('\n');
    renderModal('Plain.java', plain);

    expect(document.querySelector('[data-testid="submit-scheduler-header-params"]')).toBeNull();
  });
});
