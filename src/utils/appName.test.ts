import { describe, it, expect } from 'vitest';
import {
  APP_NAME_TASK_TYPES, buildTaskAppName, taskTypeHasAppName,
  applyAppNameToNode, applyAppNameToNodes,
} from './appName';
import type { DSWorkflowTaskNode } from '../types/dolphinscheduler';

/**
 * 「应用名称」= `{project}.{workflow}.{task}` 的口径测试。
 *
 * 该值要保证：三段与工作流基本信息同源、缺段不产生空洞、只作用于带「应用名称」项的任务类型
 * （SPARK / FLINK / MR），并且不破坏任务参数里的其他字段。
 */

const node = (over: Partial<DSWorkflowTaskNode> = {}): DSWorkflowTaskNode => ({
  code: 1,
  name: 'ods_ecom_customer',
  taskType: 'SPARK',
  description: '',
  taskParams: JSON.stringify({ programType: 'SCALA', mainClass: 'X', appName: '旧值' }),
  flag: 'YES',
  taskPriority: 'MEDIUM' as DSWorkflowTaskNode['taskPriority'],
  workerGroup: 'default',
  environmentCode: -1,
  failRetryTimes: 0,
  failRetryInterval: 1,
  timeoutFlag: 'CLOSE',
  timeout: 0,
  delayTime: 0,
  x: 0,
  y: 0,
  ...over,
});

describe('buildTaskAppName', () => {
  it('按 项目.工作流.任务 拼接', () => {
    expect(buildTaskAppName({
      project: 'test_project', workflow: 'olist_code_ods_test', task: 'ods_ecom_customer',
    })).toBe('test_project.olist_code_ods_test.ods_ecom_customer');
  });

  it('某一段缺失时省略该段，不留下空洞', () => {
    expect(buildTaskAppName({ project: '', workflow: 'wf_test', task: 'a' })).toBe('wf_test.a');
    expect(buildTaskAppName({ project: 'demo', workflow: null, task: 'a' })).toBe('demo.a');
    expect(buildTaskAppName({ project: null, workflow: undefined, task: 'a' })).toBe('a');
  });

  it('三段都为空时返回空串（调用方据此不写入参数）', () => {
    expect(buildTaskAppName({ project: '  ', workflow: '', task: null })).toBe('');
  });

  it('段内的空白与点号换成下划线，保证结果恒为三段', () => {
    expect(buildTaskAppName({ project: 'my project', workflow: 'ods.v2', task: 'a b' }))
      .toBe('my_project.ods_v2.a_b');
  });

  it('保留中文（与 sanitizeDsName 口径一致，不额外清洗）', () => {
    expect(buildTaskAppName({ project: '项目', workflow: '工作流', task: '任务' }))
      .toBe('项目.工作流.任务');
  });
});

describe('taskTypeHasAppName', () => {
  it('只有 SPARK / FLINK / MR 有「应用名称」项', () => {
    expect(APP_NAME_TASK_TYPES).toEqual(['SPARK', 'FLINK', 'MR']);
    expect(taskTypeHasAppName('SPARK')).toBe(true);
    expect(taskTypeHasAppName('FLINK')).toBe(true);
    expect(taskTypeHasAppName('MR')).toBe(true);
  });

  it('其余任务类型（含 FLINK_STREAM / JAVA / SQL）为 false', () => {
    expect(taskTypeHasAppName('FLINK_STREAM')).toBe(false);
    expect(taskTypeHasAppName('JAVA')).toBe(false);
    expect(taskTypeHasAppName('SQL')).toBe(false);
    expect(taskTypeHasAppName('DEPENDENT')).toBe(false);
    expect(taskTypeHasAppName(null)).toBe(false);
    expect(taskTypeHasAppName(undefined)).toBe(false);
  });
});

describe('applyAppNameToNode', () => {
  it('改写 SPARK 节点的 appName，且不影响其他参数', () => {
    const next = applyAppNameToNode(node(), { project: 'demo', workflow: 'demo_test', task: 'a' });
    expect(next).not.toBe(node);
    const params = JSON.parse(next.taskParams);
    expect(params.appName).toBe('demo.demo_test.a');
    expect(params.mainClass).toBe('X');
    expect(params.programType).toBe('SCALA');
  });

  it('未传 task 时用节点名兜底', () => {
    const next = applyAppNameToNode(node({ name: 'h' }), { project: 'demo', workflow: 'demo_test' });
    expect(JSON.parse(next.taskParams).appName).toBe('demo.demo_test.h');
  });

  it('值没变时原样返回（便于 setState 里判等）', () => {
    const n = node({ taskParams: JSON.stringify({ appName: 'demo.demo_test.a' }) });
    expect(applyAppNameToNode(n, { project: 'demo', workflow: 'demo_test', task: 'a' })).toBe(n);
  });

  it('没有「应用名称」项的任务类型不动', () => {
    const n = node({ taskType: 'SQL', taskParams: JSON.stringify({ sql: 'select 1' }) });
    expect(applyAppNameToNode(n, { project: 'demo', workflow: 'wf', task: 'a' })).toBe(n);
  });

  it('taskParams 非法 JSON 时不动（不阻断保存链路）', () => {
    const n = node({ taskParams: 'not-json' });
    expect(applyAppNameToNode(n, { project: 'demo', workflow: 'wf', task: 'a' })).toBe(n);
  });

  it('派生出空值时不动', () => {
    const n = node({ name: '' });
    expect(applyAppNameToNode(n, { project: '', workflow: '', task: '' })).toBe(n);
  });
});

describe('applyAppNameToNodes', () => {
  const spark = node({ code: 1, name: 'a', taskType: 'SPARK' });
  const sql = node({ code: 2, name: 'b', taskType: 'SQL', taskParams: JSON.stringify({ sql: 'select 1' }) });
  const dependent = node({ code: 3, name: '前置依赖_h', taskType: 'DEPENDENT', taskParams: JSON.stringify({ dependence: {} }) });

  it('逐个节点按各自任务名生成，非「应用名称」类型保持不变', () => {
    const next = applyAppNameToNodes([spark, sql, dependent], { project: 'demo', workflow: 'demo_test' });
    expect(JSON.parse(next[0].taskParams).appName).toBe('demo.demo_test.a');
    expect(next[1]).toBe(sql);
    expect(next[2]).toBe(dependent);
  });

  it('没有任何节点需要改时原样返回原数组', () => {
    const nodes = [sql, dependent];
    expect(applyAppNameToNodes(nodes, { project: 'demo', workflow: 'demo_test' })).toBe(nodes);
  });

  it('应用名已一致时也原样返回', () => {
    const n = node({ code: 1, name: 'a', taskParams: JSON.stringify({ appName: 'demo.demo_test.a' }) });
    const nodes = [n];
    expect(applyAppNameToNodes(nodes, { project: 'demo', workflow: 'demo_test' })).toBe(nodes);
  });
});
